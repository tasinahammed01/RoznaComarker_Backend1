'use strict';

const crypto = require('crypto');
const semanticWriting = require('./semanticWritingCorrections.service');
const canonical = require('./correctionCanonical.service');
const { getAssessmentAIConfig: getSemanticAIConfig } = require('./semanticAIClient.service');
const teacherPolicy = require('./teacherEvaluationPolicy.service');
const executionPolicy = require('./assessmentExecutionPolicy.service');
const { CORRECTION_CATEGORIES } = require('./structuredOutputSchemas.service');
const logger = require('../utils/logger');
const VERSION = 'semantic-chunk-coordinator-v8-compact-wire';

function auditPlan(enabledCategories, baseReviewCoverage, suspiciousCategories, recoveryUsed, canRun) {
  const coverageRepairCategories = enabledCategories.filter(category => !baseReviewCoverage[category]);
  const qualityAuditCategories = enabledCategories.filter(category => baseReviewCoverage[category] && suspiciousCategories.includes(category));
  const state = categories => ({ required: categories.length > 0, categories,
    status: !categories.length ? 'not_required' : recoveryUsed ? 'skipped_recovery_bound' : !canRun ? 'skipped_budget' : 'pending' });
  return { baseReviewCoverage, coverageRepairCategories, qualityAuditCategories,
    coverageRepair: state(coverageRepairCategories), qualityAudit: state(qualityAuditCategories) };
}
function settleAudit(plan, coverage, error = null) {
  for (const kind of ['coverageRepair', 'qualityAudit']) {
    const item = plan[kind];
    if (item.status !== 'pending') continue;
    item.status = error ? 'failed' : item.categories.every(category => coverage[category]) ? 'completed' : 'review_incomplete';
    if (error) item.errorCode = error.code || 'SEMANTIC_CATEGORY_AUDIT_FAILED';
  }
}

function categoryReviewCoverage(result, categories) {
  if (result?.recoverySubchunks) return Object.fromEntries(categories.map(category => [category,
    result.recoverySubchunks.every(child => categoryReviewCoverage(child, [category])[category])]));
  const d = result?.diagnostics || {};
  return Object.fromEntries(categories.map(category => [category, d.schemaValidated === true
    && d.categoryReviews?.some(review => review.category === category && review.reviewed === true) === true
    && d.symbolReviewCoverage?.[category]?.complete === true
    && d.sourceHashMatches !== false && result?.coverage?.sourceHashMatches !== false
    && d.categoryCoverageComplete?.[category] !== false]));
}

const integer = (value, fallback, minimum = 1) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
};

function config(env = process.env) {
  return {
    enabled: String(env.SEMANTIC_AI_CHUNKING_ENABLED || 'true').toLowerCase() !== 'false',
    singleRequestThresholdTokens: integer(env.SEMANTIC_AI_SINGLE_REQUEST_THRESHOLD_TOKENS, 5000),
    chunkInputTokens: integer(env.SEMANTIC_AI_CHUNK_INPUT_TOKENS, 2500),
    overlapTokens: integer(env.SEMANTIC_AI_CHUNK_OVERLAP_TOKENS, 150, 0),
    chunkMaxOutputTokens: integer(env.SEMANTIC_AI_CHUNK_MAX_OUTPUT_TOKENS, 2500),
    maxConcurrency: integer(env.SEMANTIC_AI_MAX_CONCURRENCY, 2),
    failedChunkRetries: integer(env.SEMANTIC_AI_FAILED_CHUNK_RETRIES, 1, 0),
    maxChunks: integer(env.SEMANTIC_AI_MAX_CHUNKS, 12),
    totalBudgetMs: integer(env.SEMANTIC_AI_CHUNK_TOTAL_BUDGET_MS, 180000, 1000),
    outputRiskMinWords: integer(env.SEMANTIC_AI_OUTPUT_RISK_MIN_WORDS, 550),
    outputRiskMinSentences: integer(env.SEMANTIC_AI_OUTPUT_RISK_MIN_SENTENCES, 24),
    outputRiskMinCandidates: integer(env.SEMANTIC_AI_OUTPUT_RISK_MIN_CANDIDATES, 6),
    outputRiskOutputBudgetPercent: integer(env.SEMANTIC_AI_OUTPUT_RISK_BUDGET_PERCENT, 72)
  };
}

const hash = (text) => crypto.createHash('sha256').update(String(text || '')).digest('hex');

function preferredBoundary(text, from, ideal, maximum, pageEnds = []) {
  const minimumEnd = from + (ideal - from) * 0.65;
  const candidates = pageEnds.filter((end) => end > from && end <= maximum && end >= minimumEnd);
  if (candidates.length) return candidates[candidates.length - 1];
  const window = text.slice(from, maximum);
  const minimumLocal = Math.max(1, Math.floor((ideal - from) * 0.65));
  for (const pattern of [/\n\s*\n/gu, /[.!?][\s\n]+/gu, /\s+/gu]) {
    let match; let last = null;
    while ((match = pattern.exec(window))) if (match.index + match[0].length >= minimumLocal) last = match.index + match[0].length;
    if (last) return from + last;
  }
  return maximum;
}

function buildChunks(transcript, pages = [], options = {}) {
  const text = String(transcript || '');
  if (!text) return [];
  const overlapChars = Math.min(integer(options.overlapTokens, 150, 0) * 4, Math.max(0, text.length - 1));
  let targetChars = integer(options.chunkInputTokens, 2500) * 4;
  const maxChunks = integer(options.maxChunks, 12);
  if (Math.ceil(text.length / Math.max(1, targetChars - overlapChars)) > maxChunks) {
    targetChars = Math.ceil((text.length + overlapChars * (maxChunks - 1)) / maxChunks);
  }
  const pageEnds = pages.map((page) => Number(page?.endChar)).filter((end) => Number.isFinite(end) && end > 0 && end < text.length);
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const maximum = Math.min(text.length, start + targetChars);
    const preferred = maximum === text.length ? text.length
      : preferredBoundary(text, start, start + targetChars, maximum, pageEnds);
    const remainingSlots = maxChunks - chunks.length - 1;
    const minimumForRemaining = remainingSlots > 0
      ? text.length - remainingSlots * Math.max(1, targetChars - overlapChars) : text.length;
    const end = Math.min(text.length, Math.max(preferred, minimumForRemaining));
    chunks.push({ index: chunks.length, startChar: start, endChar: end, text: text.slice(start, end) });
    if (end >= text.length) break;
    const next = Math.max(start + 1, end - overlapChars);
    start = next;
  }
  return chunks;
}

function localSpans(spans, chunk) {
  return (spans || []).filter((span) => span.start < chunk.endChar && span.end > chunk.startChar)
    .map((span) => ({ ...span, start: span.start - chunk.startChar, end: span.end - chunk.startChar }));
}

function localPages(pages, chunk) {
  return (pages || []).filter((page) => Number(page.endChar) > chunk.startChar && Number(page.startChar) < chunk.endChar)
    .map((page) => ({ ...page, startChar: Math.max(0, Number(page.startChar) - chunk.startChar),
      endChar: Math.min(chunk.text.length, Number(page.endChar) - chunk.startChar) }));
}

function remapCorrections(items, chunk, input) {
  return (items || []).map((item) => canonical.normalizeCorrection({ ...item,
    startChar: Number(item.startChar) + chunk.startChar,
    endChar: Number(item.endChar) + chunk.startChar
  }, input.transcript, input.spans || [], input.legend, 'AI')).filter(Boolean);
}

function chunkIdentity(input, chunk, suffix = '') {
  return hash([input.transcriptHash, chunk.startChar, chunk.endChar,
    semanticWriting.SEMANTIC_PROMPT_VERSION, semanticWriting.SEMANTIC_SCHEMA_VERSION, suffix].join('|'));
}

function splitChunk(chunk) {
  if (!chunk?.text || chunk.text.length < 2) return [];
  const localMidpoint = preferredBoundary(chunk.text, 0, Math.floor(chunk.text.length / 2),
    Math.floor(chunk.text.length / 2));
  const midpoint = Math.max(1, Math.min(chunk.text.length - 1, localMidpoint));
  return [
    { ...chunk, index: `${chunk.index}a`, endChar: chunk.startChar + midpoint, text: chunk.text.slice(0, midpoint) },
    { ...chunk, index: `${chunk.index}b`, startChar: chunk.startChar + midpoint, text: chunk.text.slice(midpoint) }
  ];
}

function recoverableFailure(error) {
  const code = String(error?.finalFailureCode || error?.attempts?.at(-1)?.code || error?.code || '');
  const finishReason = String(error?.finishReason || '');
  return code.includes('TIMEOUT') || code.includes('TRUNCATED')
    || ['AI_PROVIDER_UNAVAILABLE', 'AI_OUTPUT_VALIDATION_FAILED'].includes(code)
    || ['length', 'max_tokens', 'MAX_TOKENS'].includes(finishReason);
}

function deterministicLanguageCandidateCount(transcript) {
  return executionPolicy.languageCandidateCount(transcript);
}

function assessOutputRisk(input, { requestEstimate, maxOutputTokens, settings }) {
  const transcript = String(input?.transcript || '');
  const wordCount = transcript.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu)?.length || 0;
  const sentenceCount = transcript.match(/(?:[.!?]+(?=\s|$)|\n{2,})/gu)?.length || (transcript.trim() ? 1 : 0);
  const pageCount = Math.max(1, Array.isArray(input?.pageManifest) ? input.pageManifest.length : 0);
  const deterministicCandidates = deterministicLanguageCandidateCount(transcript);
  // A schema-valid correction carries category/symbol/evidence/message and
  // replacement fields. This conservative estimate is only a routing signal;
  // it never creates, removes, or scores a correction.
  const estimatedCorrections = deterministicCandidates
    + Math.floor(wordCount / 35) + Math.floor(sentenceCount / 4);
  const estimatedOutputTokens = 250 + estimatedCorrections * 55;
  const outputBudget = Math.max(256, Number(maxOutputTokens) || 2500);
  const budgetPercent = Math.min(95, Math.max(25, Number(settings.outputRiskOutputBudgetPercent) || 72));
  const indicators = {
    wordVolume: wordCount >= settings.outputRiskMinWords,
    sentenceVolume: sentenceCount >= settings.outputRiskMinSentences,
    deterministicCandidateDensity: deterministicCandidates >= settings.outputRiskMinCandidates,
    multiPageVolume: pageCount >= 2 && wordCount >= Math.floor(settings.outputRiskMinWords * 0.7),
    promptNearSingleLimit: requestEstimate >= Math.floor(settings.singleRequestThresholdTokens * 0.72),
    estimatedOutputPressure: estimatedOutputTokens >= Math.floor(outputBudget * budgetPercent / 100)
  };
  const volumeSignals = [indicators.wordVolume, indicators.sentenceVolume,
    indicators.multiPageVolume, indicators.promptNearSingleLimit].filter(Boolean).length;
  const highRisk = (indicators.estimatedOutputPressure
      && (indicators.deterministicCandidateDensity || volumeSignals >= 2))
    || (indicators.deterministicCandidateDensity && volumeSignals >= 1)
    || wordCount >= settings.outputRiskMinWords * 2;
  return { highRisk, wordCount, sentenceCount, pageCount, deterministicCandidates,
    estimatedCorrections, estimatedOutputTokens, outputBudgetTokens: outputBudget, indicators };
}

async function runBounded(tasks, concurrency) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try { results[index] = { status: 'fulfilled', value: await tasks[index]() }; }
      catch (reason) { results[index] = { status: 'rejected', reason }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

function aggregateMetrics(results, chunks, startedAt, mode) {
  const successful = results.filter((result) => result.status === 'fulfilled');
  const failed = results.filter((result) => result.status === 'rejected');
  const attempts = successful.flatMap((result) => result.value.metrics?.attempts || [])
    .concat(failed.flatMap((result) => result.reason?.attempts || []));
  const inputTokens = attempts.reduce((sum, attempt) => sum + Number(attempt.promptTokenCount || 0), 0)
    || successful.reduce((sum, result) => sum + Number(result.value.metrics?.promptInputTokenEstimate || 0), 0);
  const outputTokens = attempts.reduce((sum, attempt) => sum + Number(attempt.candidateTokenCount || 0), 0)
    || successful.reduce((sum, result) => sum + Number(result.value.metrics?.outputTokenCount || 0), 0);
  const fallbackCalls = attempts.filter((attempt) => Number(attempt.fallbackIndex || 0) > 0).length;
  const timeoutCount = attempts.filter((attempt) => attempt.code === 'AI_ATTEMPT_TIMEOUT').length;
  const truncationCount = attempts.filter((attempt) => ['length', 'max_tokens', 'MAX_TOKENS']
    .includes(attempt.finishReason) || ['AI_OUTPUT_TRUNCATED', 'AI_RESPONSE_TRUNCATED', 'GOOGLE_OUTPUT_TRUNCATED']
    .includes(attempt.code)).length;
  const providerCallCount = results.reduce((total, result) => {
    const record = result.status === 'fulfilled' ? result.value.metrics : result.reason;
    return total + (Number.isInteger(record?.attemptCount) ? record.attemptCount
      : record?.attempts?.length || 1 + Number(record?.categoryAuditRequestCount || 0));
  }, 0);
  return { mode, chunkCount: chunks.length, numberOfChunks: chunks.length,
    correctionValidationMs: successful.reduce((n,r)=>n+Number(r.value.metrics?.semanticValidationMs||0),0),
    correctionGroundingMs: successful.reduce((n,r)=>n+Number(r.value.metrics?.semanticGroundingMs||0),0),
    correctionPrimaryMs: results.filter(r=>r.role==='main').reduce((n,r)=>n+(r.durationMs||0),0),
    correctionRecoveryMs: results.filter(r=>r.role==='recovery').reduce((n,r)=>n+(r.durationMs||0),0),
    coverageRepairMs: results.filter(r=>r.role==='coverageRepair').reduce((n,r)=>n+(r.durationMs||0),0),
    qualityAuditMs: results.filter(r=>r.role==='audit').reduce((n,r)=>n+(r.durationMs||0),0),
    requestCount: results.length + successful.reduce((n, result) => n + Number(result.value.metrics?.categoryAuditRequestCount || 0), 0),
    providerCallCount,
    semanticInputTokens: inputTokens || null, semanticOutputTokens: outputTokens || null,
    semanticFallbackCalls: fallbackCalls, timeoutCount, truncationCount,
    successfulRequestCount: successful.length,
    failedRequestCount: failed.length, maxChunkCharacters: Math.max(0, ...chunks.map((chunk) => chunk.text.length)),
    coveredCharacters: chunks.reduce((ranges, chunk) => {
      const previous = ranges[ranges.length - 1];
      if (previous && chunk.startChar <= previous.end) previous.end = Math.max(previous.end, chunk.endChar);
      else ranges.push({ start: chunk.startChar, end: chunk.endChar });
      return ranges;
    }, []).reduce((sum, range) => sum + range.end - range.start, 0),
    attempts, attemptCount: providerCallCount, semanticDurationMs: Date.now() - startedAt,
    totalDurationMs: Date.now() - startedAt };
}

function aggregateValidationDiagnostics(successful, merged) {
  const diagnostics = successful.map((result) => result.value.diagnostics || {});
  const sum = (key) => diagnostics.reduce((total, item) => total + Number(item[key] || 0), 0);
  const addCounts = (key) => diagnostics.reduce((out, item) => {
    for (const [name, count] of Object.entries(item[key] || {})) out[name] = Number(out[name] || 0) + Number(count || 0);
    return out;
  }, {});
  const addCategoryCounts = (key) => Object.fromEntries(CORRECTION_CATEGORIES.map((category) => [category,
    diagnostics.reduce((total, item) => total + Number(item[key]?.[category] || 0), 0)]));
  const categoryRemaps = diagnostics.flatMap((item) => item.categoryRemaps || []);
  return {
    rawCorrectionCount: sum('rawCorrectionCount'),
    acceptedCorrectionCount: merged.corrections.length,
    rejectedCorrectionCount: sum('rejectedCorrectionCount'),
    categoryRemapCount: categoryRemaps.length,
    categoryRemaps,
    rejectionReasons: addCounts('rejectionReasons'),
    returnedByCategory: addCategoryCounts('returnedByCategory'),
    acceptedByCategory: addCategoryCounts('acceptedByCategory'),
    rejectedByCategory: addCategoryCounts('rejectedByCategory'),
    duplicateCount: Number(merged.diagnostics?.duplicateCount || 0),
    conflictCount: Number(merged.diagnostics?.conflictCount || 0)
  };
}

function coveredCharactersForSuccessfulChunks(results, chunks) {
  return results.slice(0, chunks.length).flatMap((result, index) => result.status === 'fulfilled'
    ? [{ start: chunks[index].startChar, end: chunks[index].endChar }] : [])
    .sort((a, b) => a.start - b.start).reduce((ranges, range) => {
      const previous = ranges[ranges.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else ranges.push({ ...range });
      return ranges;
    }, []).reduce((sum, range) => sum + range.end - range.start, 0);
}

async function analyze(input, dependencies = {}) {
  input = { ...input, policy: teacherPolicy.normalizeTeacherEvaluationPolicy(input.policy) };
  const enabledCategories = teacherPolicy.enabledCorrectionCategories(input.policy);
  const structuralCategories = enabledCategories.filter(category => ['CONTENT', 'ORGANIZATION'].includes(category));
  const now = dependencies.now || Date.now;
  const startedAt = now();
  const env = dependencies.env || process.env;
  const settings = { ...config(env), ...(dependencies.settings || {}) };
  const semanticService = dependencies.semanticService || semanticWriting;
  const profiledRequest = typeof semanticService.buildSemanticRequest === 'function'?semanticService.buildSemanticRequest(input):null;
  const requestEstimate = profiledRequest?.promptInputTokenEstimate||Math.ceil(String(input.transcript || '').length / 4);
  const baseConfig = dependencies.config || getSemanticAIConfig(env);
  const deadlineAt = executionPolicy.stageDeadline(startedAt,
    Math.min(settings.totalBudgetMs, executionPolicy.budgets(env).correctionBudgetMs), input.deadlineAt);
  input = { ...input, deadlineAt };
  const capabilities = executionPolicy.modelCapabilities(baseConfig.model, env);
  const primaryConfig = { ...baseConfig, primaryRetries: 0, fallbackRetries: 0, maxRetries: 0, retriesPerModel: 0,
    maxOutputTokens: capabilities ? Math.min(Number(baseConfig.maxOutputTokens) || capabilities.safeOutputBudget,
      capabilities.safeOutputBudget) : baseConfig.maxOutputTokens };
  const outputBudget=executionPolicy.correctionOutputBudget({transcript:input.transcript,pageCount:Math.max(1,input.pageManifest?.length||0),
    categoryCount:enabledCategories.length,symbolCount:(input.legend?.groups||[]).filter(g=>enabledCategories.includes(g.key)).reduce((n,g)=>n+g.symbols.length,0)||28,
    ceiling:primaryConfig.maxOutputTokens||8000});
  if(capabilities)primaryConfig.maxOutputTokens=outputBudget.requestedOutputTokenBudget;
  // Do not start another full expensive pass with only a token amount of time.
  const canFundAdditionalRequest = () => deadlineAt - now() >= Math.min(Number(primaryConfig.attemptTimeoutMs) || 1, 30000);
  const singleBudget = capabilities
    ? (dependencies.settings?.preferredSingleRequestTokens || capabilities.preferredSingleRequestTokens)
    : settings.singleRequestThresholdTokens;
  const outputRisk = assessOutputRisk(input, { requestEstimate,
    maxOutputTokens: primaryConfig.maxOutputTokens || settings.chunkMaxOutputTokens,
    settings: { ...settings, singleRequestThresholdTokens: singleBudget } });
  const envelopeExceeded = capabilities && (requestEstimate > capabilities.safeInputBudget
    || requestEstimate + Math.min(outputRisk.estimatedOutputTokens,
      Number(baseConfig.maxOutputTokens) || capabilities.safeOutputBudget) + capabilities.safetyReserve > capabilities.safeRequestBudget);
  const inputRequiresChunking = requestEstimate > singleBudget || envelopeExceeded;
  const useChunking = settings.enabled && (inputRequiresChunking || outputRisk.highRisk);
  const routingReason = !settings.enabled ? 'chunking_disabled'
    : envelopeExceeded ? 'safe_request_envelope' : inputRequiresChunking ? 'input_threshold' : outputRisk.highRisk ? 'output_risk' : 'single_efficient';
  logger.info({ event: 'semantic_routing_decision', submissionId: input.submissionId || null,
    assessmentRunId: input.assessmentRunId || null, mode: useChunking ? 'chunked' : 'single',
    routingReason, routingMode: useChunking ? 'chunked' : 'single', requestInputTokenEstimate: requestEstimate,
    modelCapabilities: capabilities, preferredSingleRequestTokens: singleBudget,
    outputRisk: { ...outputRisk, indicators: outputRisk.indicators } });
  if (!useChunking) {
    const shortAstraReview=Boolean(capabilities && outputRisk.pageCount === 1 && outputRisk.wordCount <= 250);
    const shortPolicy=executionPolicy.shortCorrectionPolicy({env,attemptTimeoutMs:Number(primaryConfig.attemptTimeoutMs)||90000});
    if (shortAstraReview) primaryConfig.attemptTimeoutMs=shortPolicy.shortCorrectionAttemptTimeoutMs;
    const requests = []; let result;
    let recoveryStrategy='none',recoveryOutcome='not_required';
    const run = async (request, role,requestConfig=primaryConfig) => {
      executionPolicy.assertRemaining(deadlineAt, now());
      const requestStarted=now();
      const actualProfile=semanticWriting.buildSemanticRequest(request);
      const requestPolicy=require('./aiGateway.service').correctionRequestPolicy({provider:requestConfig.provider,
        model:requestConfig.model,feature:'semantic_corrections',responseFormat:'json',responseSchema:true}).diagnostics;
      try {
        const value = await require('./providerAttemptAccounting.service').withRole(role,()=>semanticService.analyze({ ...request, deadlineAt, disableCategoryAudit: true },
          { ...dependencies, config: requestConfig }));
        logger.info({event:'correction_request_performance',role,model:requestConfig.model,...requestPolicy,
          correctionPrimaryOutcome:role==='main'?'completed':null,
          correctionReasoningTokens:value.usage?.thoughts_tokens??null,
          correctionPromptInputTokens:actualProfile.promptInputTokenEstimate,
          correctionSchemaEstimatedTokens:actualProfile.tokenProfile.responseSchemaTokens,
          correctionRequestedOutputTokens:requestConfig.maxOutputTokens,
          correctionProviderMs:value.metrics?.semanticProviderMs??now()-requestStarted,
          correctionValidationMs:value.metrics?.semanticValidationMs??null,correctionGroundingMs:value.metrics?.semanticGroundingMs??null,
          correctionAcceptedCount:value.diagnostics?.acceptedCorrectionCount??value.corrections?.length??0,
          correctionRejectedCount:value.diagnostics?.rejectedCorrectionCount??0,
          reviewedCategories:value.diagnostics?.reviewedCategories||[],categoryCoverageComplete:value.diagnostics?.categoryCoverageComplete||{},
          prompt_tokens:value.usage?.prompt_tokens??null,completion_tokens:value.usage?.completion_tokens??null,
          reasoning_tokens:value.usage?.thoughts_tokens??null,total_tokens:value.usage?.total_tokens??null,
          finish_reason:value.metrics?.attempts?.at(-1)?.finishReason??null});
        requests.push({ status: 'fulfilled', value, role, durationMs:now()-requestStarted }); return value;
      } catch (reason) {
        logger.info({event:'correction_request_performance',role,model:requestConfig.model,...requestPolicy,
          correctionPrimaryOutcome:role==='main'?(reason.finalFailureCode||reason.code||'failed'):null,
          correctionPromptInputTokens:actualProfile.promptInputTokenEstimate,
          correctionSchemaEstimatedTokens:actualProfile.tokenProfile.responseSchemaTokens,
          correctionRequestedOutputTokens:requestConfig.maxOutputTokens,correctionProviderMs:now()-requestStarted,
          primaryOutcome:reason.finalFailureCode||reason.code||'failed',reviewedCategories:[],categoryCoverageComplete:{}});
        requests.push({ status: 'rejected', reason, role, durationMs:now()-requestStarted }); throw reason; }
    };
    let recoveryUsed = false;
    try { result = await run({ ...input, categories: enabledCategories }, 'main'); }
    catch (error) {
      error.correctionRequestCounts = { mainCorrectionRequestCount: requests.length, recoveryRequestCount: 0,
        structuralRequestCount: 0, auditRequestCount: 0 };
      const failWithMetrics=(reason)=>{
        const metrics=aggregateMetrics(requests,[],startedAt,'single');
        const root=requests[0]?.reason?.finalFailureCode||requests[0]?.reason?.attempts?.at(-1)?.code||requests[0]?.reason?.code;
        if(root==='AI_ATTEMPT_TIMEOUT')reason.code='AI_ATTEMPT_TIMEOUT';
        Object.assign(reason,{correctionMetrics:{...metrics,...outputBudget,requestInputTokenEstimate:requestEstimate,
          promptTokenProfile:profiledRequest?.tokenProfile,correctionRecoveryStrategy:recoveryStrategy,
          correctionPrimaryOutcome:root||'failed',correctionRecoveryOutcome:recoveryOutcome},
          attempts:metrics.attempts,attemptCount:metrics.attemptCount,
          correctionRequestCounts:{mainCorrectionRequestCount:1,recoveryRequestCount:recoveryUsed?1:0,structuralRequestCount:0,auditRequestCount:0}});
        throw reason;
      };
      const failureCode=error.finalFailureCode||error.attempts?.at(-1)?.code||error.code;
      if(shortAstraReview && failureCode==='AI_ATTEMPT_TIMEOUT' && !shortPolicy.shortCorrectionAutoRecoveryEnabled){
        recoveryStrategy='short_timeout_no_auto_recovery';recoveryOutcome='not_attempted';failWithMetrics(error);
      }
      if (!recoverableFailure(error) || deadlineAt-now()<Math.min((Number(primaryConfig.attemptTimeoutMs)||90000)/3,30000))failWithMetrics(error);
      const compactInput={...input,categories:enabledCategories,analysisMode:'compact_recovery'};
      const originalRequest=semanticWriting.buildSemanticRequest({...input,categories:enabledCategories});
      const compactRequest=semanticWriting.buildSemanticRequest(compactInput);
      const sourceCharacters = JSON.stringify(String(input.transcript||'')).length;
      if(compactRequest.promptCharacters-sourceCharacters >= (originalRequest.promptCharacters-sourceCharacters)*.85){
        recoveryStrategy='withheld_not_materially_smaller';recoveryOutcome='not_attempted';failWithMetrics(error);
      }
      recoveryUsed = true;
      recoveryStrategy='compact_same_model';recoveryOutcome='processing';
      const truncated=/TRUNCAT|MAX_TOKENS/.test(String(error.finalFailureCode||error.code||''));
      try { result = await run(compactInput, 'recovery',{...primaryConfig,
        ...(truncated?{maxOutputTokens:Math.min(baseConfig.maxOutputTokens||8000,capabilities?.safeOutputBudget||8000)}:{}),
        attemptTimeoutMs:executionPolicy.correctionRecoveryTimeout(Number(primaryConfig.attemptTimeoutMs)||90000,deadlineAt-now())});
        recoveryOutcome='completed'; }
      catch (reason) {
        recoveryOutcome=reason.finalFailureCode||reason.attempts?.at(-1)?.code||reason.code||'failed';
        failWithMetrics(reason);
      }
    }
    const reviewed = categoryReviewCoverage(result, enabledCategories);
    const suspicious = semanticWriting.suspiciousCoverageCategories(result, input.transcript, env);
    const plan = auditPlan(enabledCategories, reviewed, suspicious, recoveryUsed, canFundAdditionalRequest());
    // A complete short whole-document review is authoritative. Repeating its
    // valid zero cannot repair hard coverage and delays the corrections-aware rubric.
    const shortDocument = outputRisk.wordCount < 550 && outputRisk.pageCount === 1;
    if (shortDocument && plan.qualityAudit.status === 'pending') plan.qualityAudit.status = 'skipped_complete_review';
    const auditCategories = [...plan.coverageRepairCategories,
      ...(shortDocument ? [] : plan.qualityAuditCategories)];
    let audit = { required: false, categories: [], status: 'not_required' };
    let auditCoverage = {};
    let corrections = result.corrections || [];
    if (auditCategories.length) {
      audit = { required: true, categories: auditCategories,
        status: recoveryUsed ? 'skipped_recovery_bound' : 'skipped_budget' };
      if (!recoveryUsed && canFundAdditionalRequest()) try {
        const checked = await run({ ...input, analysisMode: 'zero_result_audit', categories: auditCategories }, plan.coverageRepairCategories.length?'coverageRepair':'audit');
        auditCoverage = categoryReviewCoverage(checked, auditCategories);
        corrections = canonical.mergeCanonicalCorrections({ aiCorrections: [...corrections, ...(checked.corrections || [])] }).corrections;
        settleAudit(plan, auditCoverage);
        audit.status = auditCategories.every(category => auditCoverage[category]) ? 'completed' : 'review_incomplete';
      } catch (error) { audit.status = 'audit_failed'; audit.errorCode = error.code; settleAudit(plan, {}, error); }
    }
    const coordinatorMetrics = aggregateMetrics(requests,
      [{ text: input.transcript, startChar: 0, endChar: input.transcript.length }], startedAt, 'single');
    const categoryCoverageComplete = Object.fromEntries(CORRECTION_CATEGORIES.map(category => [category,
      enabledCategories.includes(category) && (reviewed[category] === true
        || plan.coverageRepairCategories.includes(category) && auditCoverage[category] === true)]));
    const complete = enabledCategories.every(category => categoryCoverageComplete[category]);
    const categoryReviewStatus = Object.fromEntries(enabledCategories.map(category => [category,
      !categoryCoverageComplete[category] ? 'CATEGORY_PASS_FAILED'
        : corrections.some(item => item.category === category) ? 'REVIEWED_WITH_FINDINGS' : 'ZERO_AFTER_REVIEW']));
    return { ...result, corrections, diagnostics: { ...result.diagnostics,
      reviewedCategories: enabledCategories.filter(category => categoryCoverageComplete[category]),
      ...plan, qualityAuditStatus: plan.qualityAudit.status, coverageRepairStatus: plan.coverageRepair.status,
      categoryCoverageComplete, categoryReviewStatus, categoryAudit: audit, allCategoriesReviewed: complete },
    status: complete ? 'completed' : 'partial', coverage: { complete, coverageComplete: complete,
      coveredCharacters: input.transcript.length, totalCharacters: input.transcript.length,
      totalChunks: 1, successfulChunks: 1, failedChunks: 0, structuralPassStatus: 'not_required',
      sourceHashMatches: true, expectedTextRangesCovered: true, finalMergeCompleted: true,
      categoryCoverageComplete }, metrics: { ...(result.metrics || {}), ...coordinatorMetrics,
        ...outputBudget,promptTokenProfile:profiledRequest?.tokenProfile,correctionRecoveryStrategy:recoveryStrategy,correctionRecoveryOutcome:recoveryOutcome,
        correctionPrimaryOutcome:requests[0].status==='fulfilled'?'completed':requests[0].reason?.finalFailureCode||requests[0].reason?.attempts?.at(-1)?.code||requests[0].reason?.code||'failed',
        routingReason, requestInputTokenEstimate: requestEstimate, outputRisk, correctionDeadlineAt: deadlineAt,
        mainCorrectionRequestCount: requests.filter(request => request.role === 'main').length,
        recoveryRequestCount: requests.filter(request => request.role === 'recovery').length,
        auditRequestCount: requests.filter(request => ['audit','coverageRepair'].includes(request.role)).length, structuralRequestCount: 0 } };
  }

  const requestHistory = [];
  const runRequest = async (request, requestConfig, role) => {
    executionPolicy.assertRemaining(deadlineAt, now());
    const requestStarted=now();
    try {
      const value = await semanticService.analyze(request, { ...dependencies, config: requestConfig });
      requestHistory.push({ status: 'fulfilled', value, role, durationMs:now()-requestStarted }); return value;
    } catch (reason) { requestHistory.push({ status: 'rejected', reason, role, durationMs:now()-requestStarted }); throw reason; }
  };
  // Keep established long-document chunk boundaries/concurrency unchanged.
  // The lean wire request saves tokens inside each already planned chunk.
  const localPromptOverheadTokens = semanticWriting.buildVerboseSemanticRequest({ ...input, transcript: '',
    analysisMode: 'local_chunk', categories: enabledCategories }).promptInputTokenEstimate;
  const chunks = buildChunks(input.transcript, input.pageManifest || [], { ...settings,
    chunkInputTokens: Math.max(400, settings.chunkInputTokens - localPromptOverheadTokens) });
  const chunkConfig = { ...primaryConfig, maxOutputTokens: Math.min(Number(baseConfig.maxOutputTokens) || settings.chunkMaxOutputTokens,
    settings.chunkMaxOutputTokens) };
  const executeChunk = async (chunk, stage = 'initial') => {
    executionPolicy.assertRemaining(deadlineAt, now());
    const chunkHash = chunkIdentity(input, chunk, stage === 'initial' ? '' : stage);
    const result = await runRequest({ ...input, transcript: chunk.text, transcriptHash: chunkHash,
      spans: localSpans(input.spans, chunk), pageManifest: localPages(input.pageManifest, chunk),
      analysisMode: stage==='initial'?'local_chunk':'compact_recovery', transcriptComplete: false, categories: enabledCategories, disableCategoryAudit: true, deadlineAt },
    stage === 'initial' ? chunkConfig : { ...chunkConfig, maxOutputTokens: Math.min(
      Number(primaryConfig.maxOutputTokens) || settings.chunkMaxOutputTokens, settings.chunkMaxOutputTokens * 2),
      attemptTimeoutMs:executionPolicy.correctionRecoveryTimeout(Number(primaryConfig.attemptTimeoutMs)||90000,deadlineAt-now()) },
    stage === 'initial' ? 'main' : 'recovery');
    return { ...result, corrections: remapCorrections(result.corrections, chunk, input), chunk,
      chunkId: chunkIdentity(input, chunk) };
  };
  const tasks = chunks.map((chunk) => async () => executeChunk(chunk));
  if (structuralCategories.length) tasks.push(async () => {
    executionPolicy.assertRemaining(deadlineAt, now());
    return runRequest({ ...input, analysisMode: 'document_structure',
    categories: structuralCategories, disableCategoryAudit: true, deadlineAt },
    chunkConfig, 'structural'); });
  const results = await runBounded(tasks, settings.maxConcurrency);
  let recoveryRequestCount = 0;
  for (let index = 0; index < chunks.length; index += 1) {
    if (results[index]?.status === 'fulfilled') continue;
    const originalFailure = results[index].reason;
    let recovered = null;
    for (let retry = 1; retry <= Math.min(1, settings.failedChunkRetries) && !recovered
      && recoveryRequestCount < 1 && recoverableFailure(originalFailure) && canFundAdditionalRequest(); retry += 1) {
      recoveryRequestCount += 1;
      try { recovered = await executeChunk(chunks[index], `retry-${retry}`); }
      catch (error) { results[index] = { status: 'rejected', reason: error }; }
    }
    const splitUsed = false;
    if (recovered) {
      recovered.recovery = { retryCount: splitUsed ? settings.failedChunkRetries : 1,
        splitUsed, originalFailureCode: originalFailure?.code || 'SEMANTIC_CHUNK_FAILED' };
      results[index] = { status: 'fulfilled', value: recovered };
    }
    logger.info({ event: 'semantic_chunk_recovery', submissionId: input.submissionId || null,
      assessmentRunId: input.assessmentRunId || null, chunkId: chunkIdentity(input, chunks[index]),
      retryStage: recovered ? (splitUsed ? 'split_recovered' : 'retry_recovered') : 'recovery_exhausted',
      originalFailureCode: originalFailure?.code || 'SEMANTIC_CHUNK_FAILED',
      provider: recovered?.provider || null, model: recovered?.model || null, splitUsed,
      resultingCoverage: recovered ? 'recovered' : 'failed' });
  }
  let successful = results.filter((result) => result.status === 'fulfilled');
  let merged = canonical.mergeCanonicalCorrections({ aiCorrections: successful.flatMap((result) => result.value.corrections || []) });
  const deterministicCandidates = deterministicLanguageCandidateCount(input.transcript);
  const localResults = results.slice(0, chunks.length);
  const structuralResult = structuralCategories.length ? results[chunks.length] : null;
  const requiredPassesSucceeded = localResults.every(result => result.status === 'fulfilled')
    && (!structuralResult || structuralResult.status === 'fulfilled');
  const initialCoverage = Object.fromEntries(enabledCategories.map(category => [category,
    localResults.every(result => result.status === 'fulfilled' && categoryReviewCoverage(result.value, [category])[category])
    && (!structuralCategories.includes(category) || (structuralResult?.status === 'fulfilled'
      && categoryReviewCoverage(structuralResult.value, [category])[category]))]));
  const suspicious = enabledCategories.filter(category => String(input.transcript || '').length >= 400
    && !merged.corrections.some(item => item.category === category));
  const plan = auditPlan(enabledCategories, initialCoverage, suspicious, recoveryRequestCount > 0,
    requiredPassesSucceeded && canFundAdditionalRequest());
  const auditCategories = [...plan.coverageRepairCategories, ...plan.qualityAuditCategories];
  let zeroResultAudit = { required: false, categories: [], status: 'not_required', deterministicCandidates };
  let auditCoverage = {};
  let auditRequestCount = 0;
  if (auditCategories.length && requiredPassesSucceeded) {
    zeroResultAudit = { required: true, categories: auditCategories,
      status: recoveryRequestCount ? 'skipped_recovery_bound' : 'skipped_budget', deterministicCandidates };
  }
  if (zeroResultAudit.required && canFundAdditionalRequest() && recoveryRequestCount === 0) {
    auditRequestCount += 1;
    zeroResultAudit = { required: true, categories: auditCategories, status: 'processing', deterministicCandidates };
    try {
      const auditResult = await runRequest({ ...input, analysisMode: 'zero_result_audit',
        categories: auditCategories, disableCategoryAudit: true, deadlineAt },
      primaryConfig, plan.coverageRepairCategories.length?'coverageRepair':'audit');
      auditCoverage = categoryReviewCoverage(auditResult, auditCategories);
      settleAudit(plan, auditCoverage);
      const auditCorrections = Array.isArray(auditResult.corrections) ? auditResult.corrections : [];
      merged = canonical.mergeCanonicalCorrections({ aiCorrections: [...merged.corrections, ...auditCorrections] });
      results.push({ status: 'fulfilled', value: auditResult });
      zeroResultAudit = { required: true, categories: auditCategories,
        status: !auditCategories.every(category => auditCoverage[category]) ? 'review_incomplete'
          : auditCorrections.length ? 'findings_recovered' : 'zero_confirmed', deterministicCandidates,
        provider: auditResult.provider || null, model: auditResult.model || null };
    } catch (error) {
      results.push({ status: 'rejected', reason: error });
      settleAudit(plan, {}, error);
      zeroResultAudit = { required: true, categories: auditCategories, status: 'audit_failed',
        deterministicCandidates, errorCode: error?.code || 'SEMANTIC_ZERO_FIND_SUSPICIOUS' };
    }
  }
  successful = results.filter(result => result.status === 'fulfilled');
  const localSuccessCount = results.slice(0, chunks.length).filter((result) => result.status === 'fulfilled').length;
  const structuralSucceeded = !structuralCategories.length || structuralResult?.status === 'fulfilled';
  const localCoverageComplete = localSuccessCount === chunks.length;
  const expectedTextRangesCovered = localCoverageComplete && chunks[0]?.startChar === 0
    && chunks[chunks.length - 1]?.endChar === input.transcript.length
    && chunks.every((chunk, index) => index === 0 || chunk.startChar <= chunks[index - 1].endChar);
  const categoryCoverageComplete = Object.fromEntries(CORRECTION_CATEGORIES.map(category => [category,
    expectedTextRangesCovered && (initialCoverage[category] === true
      || requiredPassesSucceeded && plan.coverageRepairCategories.includes(category) && auditCoverage[category] === true)]));
  const coverageComplete = enabledCategories.every(category => categoryCoverageComplete[category]);
  const categoryReviewStatus = Object.fromEntries(CORRECTION_CATEGORIES.map(category => [category,
    !enabledCategories.includes(category) ? 'DISABLED_BY_POLICY'
      : !categoryCoverageComplete[category] ? 'CATEGORY_PASS_FAILED'
        : merged.corrections.some(item => item.category === category) ? 'REVIEWED_WITH_FINDINGS' : 'ZERO_AFTER_REVIEW']));
  const status = coverageComplete ? 'completed'
    : successful.length ? 'partial' : 'failed';
  const errors = results.slice(0, chunks.length).map((result, index) => ({ result, index }))
    .filter(({ result }) => result.status === 'rejected').map(({ result, index }) => ({ index,
      chunkId: chunkIdentity(input, chunks[index]), code: result.reason?.code || 'SEMANTIC_CHUNK_FAILED' }));
  const metrics = { ...aggregateMetrics(requestHistory, chunks, startedAt, 'chunked'),
    correctionDeadlineAt: deadlineAt, mainCorrectionRequestCount: requestHistory.filter(request => request.role === 'main').length,
    structuralRequestCount: requestHistory.filter(request => request.role === 'structural').length,
    auditRequestCount, recoveryRequestCount,
    configuredChunkInputTokens: settings.chunkInputTokens, localPromptOverheadTokens,
    routingReason, requestInputTokenEstimate: requestEstimate, outputRisk };
  const coveredCharacters = coveredCharactersForSuccessfulChunks(results, chunks);
  const chunkOutcomes = results.slice(0, chunks.length).map((result, index) => {
    const value = result.status === 'fulfilled' ? result.value : null;
    const attempts = value?.metrics?.attempts || result.reason?.attempts || [];
    const last = attempts[attempts.length - 1] || {};
    return { chunkIndex: index, totalChunks: chunks.length, chunkId: chunkIdentity(input, chunks[index]),
      startChar: chunks[index].startChar, endChar: chunks[index].endChar,
      status: result.status === 'fulfilled' ? 'completed' : 'failed', provider: value?.provider || last.provider || null,
      model: value?.model || last.model || null,
      inputTokenEstimate: Number(value?.metrics?.promptInputTokenEstimate || last.promptTokenCount) || null,
      outputTokenCount: Number(value?.metrics?.outputTokenCount || last.candidateTokenCount) || null,
      durationMs: Number(value?.metrics?.totalDurationMs || last.durationMs) || null,
      timeoutMs: Number(last.attemptTimeoutMs) || null, finishReason: last.finishReason || result.reason?.finishReason || null,
      validationStatus: result.status === 'fulfilled' ? 'passed' : (last.validationCode ? 'failed' : null),
      retryCount: Number(value?.recovery?.retryCount || 0), splitUsed: value?.recovery?.splitUsed === true,
      failureCode: result.status === 'rejected' ? (result.reason?.code || 'SEMANTIC_CHUNK_FAILED') : null };
  });
  return { status, corrections: merged.corrections, provider: successful[0]?.value.provider || null,
    model: successful[0]?.value.model || null, diagnostics: { ...aggregateValidationDiagnostics(successful, merged),
      reviewedCategories: enabledCategories.filter(category => categoryCoverageComplete[category]),
      ...plan, qualityAuditStatus: plan.qualityAudit.status, coverageRepairStatus: plan.coverageRepair.status,
      categoryCoverageComplete, categoryReviewStatus, categoryAudit: zeroResultAudit,
      allCategoriesReviewed: coverageComplete, policyHash: teacherPolicy.evaluationPolicyHash(input.policy),
      chunking: { localChunkCount: chunks.length, localSuccessCount,
        localFailureCount: chunks.length - localSuccessCount, structuralSucceeded, errors,
        chunks: chunkOutcomes, zeroResultAudit, mergeDiagnostics: merged.diagnostics } }, metrics,
    coverage: { complete: coverageComplete, coverageComplete, coveredCharacters,
      totalCharacters: input.transcript.length, successfulChunks: localSuccessCount, totalChunks: chunks.length,
      failedChunks: chunks.length - localSuccessCount,
      structuralPassStatus: !structuralCategories.length ? 'not_required' : structuralSucceeded ? 'completed' : 'failed', sourceHashMatches: true,
      expectedTextRangesCovered, finalMergeCompleted: true, categoryCoverageComplete } };
}

module.exports = { VERSION, config, preferredBoundary, buildChunks, localSpans, localPages, remapCorrections,
  categoryReviewCoverage,
  chunkIdentity, splitChunk, recoverableFailure, deterministicLanguageCandidateCount, runBounded, aggregateMetrics,
  aggregateValidationDiagnostics, coveredCharactersForSuccessfulChunks, assessOutputRisk, analyze };
