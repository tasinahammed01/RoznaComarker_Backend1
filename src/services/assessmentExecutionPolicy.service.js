'use strict';

// Operational envelopes, not claims about a provider's advertised context limit.
const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0
  ? Math.floor(Number(value)) : fallback;
function budgets(env = process.env) {
  return {
    attemptTimeoutMs: positive(env.ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS, 90000),
    overallBudgetMs: positive(env.ASSESSMENT_AI_TOTAL_BUDGET_MS, 300000),
    correctionBudgetMs: positive(env.ASSESSMENT_CORRECTION_BUDGET_MS, 180000),
    rubricBudgetMs: positive(env.ASSESSMENT_RUBRIC_BUDGET_MS, 120000),
    rubricReservedBudgetMs: positive(env.ASSESSMENT_RUBRIC_RESERVED_BUDGET_MS, 90000)
  };
}
function plan({ startedAt = Date.now(), env = process.env, overallDeadlineAt = null } = {}) {
  const settings = budgets(env);
  const assessmentDeadlineAt = Math.min(startedAt + settings.overallBudgetMs,
    Number(overallDeadlineAt) > 0 ? Number(overallDeadlineAt) : Infinity);
  const correctionDeadlineAt = Math.min(startedAt + settings.correctionBudgetMs,
    assessmentDeadlineAt - settings.rubricReservedBudgetMs);
  return Object.freeze({ ...settings, assessmentDeadlineAt, correctionDeadlineAt,
    correctionStageBudgetMs: Math.max(0, correctionDeadlineAt - startedAt) });
}
function stageDeadline(startedAt, budgetMs, inheritedDeadlineAt) {
  return Math.min(startedAt + budgetMs, Number(inheritedDeadlineAt) > 0 ? Number(inheritedDeadlineAt) : Infinity);
}
function assertRemaining(deadlineAt, now, code = 'ASSESSMENT_CORRECTION_STAGE_BUDGET_EXHAUSTED') {
  if (deadlineAt <= now) throw Object.assign(new Error('Assessment stage budget was exhausted.'),
    { code, attemptCount: 0, attempts: [] });
}
function modelCapabilities(model, env = process.env) {
  if (!['openai/gpt-6-astra','anthropic/claude-haiku-5.5','google/gemini-3.8-flash','openai/gpt-5.4-mini','openai/gpt-4.1-mini','deepseek/deepseek-v4.1-flash'].includes(model)) return null;
  return {
    model, safeRequestBudget: positive(env.ASSESSMENT_AI_SAFE_REQUEST_TOKENS, 32000),
    safeInputBudget: positive(env.ASSESSMENT_AI_SAFE_INPUT_TOKENS, 24000),
    safeOutputBudget: positive(env.ASSESSMENT_AI_SAFE_OUTPUT_TOKENS, 8000),
    preferredSingleRequestTokens: positive(env.ASSESSMENT_AI_SINGLE_REQUEST_TOKENS, 16000),
    safetyReserve: positive(env.ASSESSMENT_AI_ROUTING_RESERVE_TOKENS, 2000)
  };
}
function languageCandidateCount(transcript) {
  const patterns = [/\s{2,}/g, /\s+[,.!?;:]/g, /[.!?]\s+[a-z]/g,
    /\b(?:he|she|it)\s+(?:are|were|have|do)\b/gi, /\b(?:they|we|you)\s+(?:is|was|has|does)\b/gi,
    /\b(?:a)\s+[aeiou]\w*/gi, /\b(?:an)\s+[^aeiou\W]\w*/gi];
  return patterns.reduce((count, pattern) => count + (String(transcript || '').match(pattern)?.length || 0), 0);
}
function correctionOutputBudget({transcript='',pageCount=1,categoryCount=5,symbolCount=28,ceiling=8000,model}={}) {
  const wordCount=String(transcript).match(/\S+/gu)?.length||0;
  const sentenceCount=String(transcript).match(/[.!?]+(?=\s|$)/gu)?.length||1;
  // Compact findings contain only seven decision fields; messages and review
  // prose are server-owned. Keep dense-error capacity, not the sparse routing estimate.
  const reviewOverhead=192+categoryCount*24+symbolCount*3;
  const estimatedCorrectionCount=Math.min(80,Math.ceil(wordCount/3)+sentenceCount*2);
  const explanationTokens=['deepseek/deepseek-v4.1-flash','google/gemini-3.8-flash'].includes(model)?64:0;
  const estimatedRequiredOutputTokens=reviewOverhead+estimatedCorrectionCount*(56+explanationTokens);
  const short=pageCount===1&&wordCount<=250;
  const requestedOutputTokenBudget=short?Math.min(ceiling,Math.max(1536,Math.ceil((estimatedRequiredOutputTokens
    +Math.max(256,estimatedRequiredOutputTokens*.20))/256)*256)):ceiling;
  return {requestedOutputTokenBudget,estimatedRequiredOutputTokens,estimatedCorrectionCount,
    outputBudgetReason:short?'compact_review_plus_dense_findings_reserve':'long_or_multipage_ceiling'};
}
function correctionRecoveryTimeout(attemptTimeoutMs,remainingMs) {
  // One compact recovery gets at most a third of a normal attempt. Never
  // reset the inherited stage deadline or consume the reserved rubric window.
  return Math.max(1,Math.min(Math.floor(attemptTimeoutMs/3),remainingMs));
}
function shortCorrectionPolicy({env=process.env,attemptTimeoutMs=budgets(env).attemptTimeoutMs}={}) {
  const settings=budgets(env);
  const correctionStageBudgetMs=Math.max(0,Math.min(settings.correctionBudgetMs,
    settings.overallBudgetMs-settings.rubricReservedBudgetMs));
  // Reuse the former 45s+15s envelope as one uninterrupted generation.
  // The gateway additionally clips this to the live inherited deadline.
  return {shortCorrectionAttemptTimeoutMs:Math.min(60000,attemptTimeoutMs,correctionStageBudgetMs),
    shortCorrectionAutoRecoveryEnabled:false,correctionStageBudgetMs};
}
function validateConfiguration(env=process.env) {
  const settings=budgets(env),errors=[];
  for(const key of ['ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS','ASSESSMENT_AI_TOTAL_BUDGET_MS','ASSESSMENT_CORRECTION_BUDGET_MS',
    'ASSESSMENT_RUBRIC_BUDGET_MS','ASSESSMENT_RUBRIC_RESERVED_BUDGET_MS','SEMANTIC_AI_MAX_OUTPUT_TOKENS','ASSESSMENT_AI_SAFE_OUTPUT_TOKENS'])
    if(env[key]!==undefined&&(!Number.isInteger(Number(env[key]))||Number(env[key])<=0))errors.push('INVALID_'+key);
  if(settings.rubricReservedBudgetMs>=settings.overallBudgetMs)errors.push('RUBRIC_RESERVE_EXHAUSTS_OVERALL');
  const usable=Math.min(settings.correctionBudgetMs,settings.overallBudgetMs-settings.rubricReservedBudgetMs);
  if(settings.attemptTimeoutMs>usable)errors.push('ATTEMPT_EXCEEDS_CORRECTION_WINDOW');
  if(usable-settings.attemptTimeoutMs<Math.min(30000,settings.attemptTimeoutMs/3))errors.push('COMPACT_RECOVERY_WINDOW_UNFUNDED');
  if(Math.min(Number(env.SEMANTIC_AI_MAX_OUTPUT_TOKENS||8000),Number(env.ASSESSMENT_AI_SAFE_OUTPUT_TOKENS||8000))<1536)errors.push('OUTPUT_LIMIT_BELOW_REVIEW_SAFE_FLOOR');
  return {settings:{...settings,...shortCorrectionPolicy({env}),compactRecoveryTimeoutMs:Math.floor(settings.attemptTimeoutMs/3),minimumCorrectionOutputTokens:1536,
    maximumCorrectionOutputTokens:Math.min(Number(env.SEMANTIC_AI_MAX_OUTPUT_TOKENS||8000),Number(env.ASSESSMENT_AI_SAFE_OUTPUT_TOKENS||8000))},errors};
}
module.exports = { budgets, plan, stageDeadline, assertRemaining, modelCapabilities, languageCandidateCount,
  correctionOutputBudget,correctionRecoveryTimeout,shortCorrectionPolicy,validateConfiguration };
