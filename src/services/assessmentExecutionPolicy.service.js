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
  if (model !== 'openai/gpt-6-astra') return null;
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
module.exports = { budgets, plan, stageDeadline, assertRemaining, modelCapabilities, languageCandidateCount };
