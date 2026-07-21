const crypto = require('crypto');
const writing = require('./writingCorrections.service');
const semantic = require('./semanticWritingCorrections.service');
const canonical = require('./correctionCanonical.service');
const { normalizeOcrWordsFromStored, buildTranscriptAndSpans } = require('./ocrCorrections.service');
const { buildCanonicalSubmissionTranscript, CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const logger = require('../utils/logger');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const canonicalEvaluation = require('./canonicalEvaluation.service');
const { safeErrorCode } = require('./canonicalResultState.service');
const { getSemanticAIConfig } = require('./semanticAIClient.service');
const semanticMetrics = require('./semanticMetrics.service');

function wordsFromSubmission(doc) {
  const all = [];
  for (const page of doc.ocrPages || []) {
    const fileId = String(page.fileId || 'legacy');
    const words = normalizeOcrWordsFromStored(page.words || [], { fileId });
    for (const word of words) all.push({ ...word, page: Number(page.pageNumber || word.page || 1), fileId });
  }
  return all;
}

function buildCorrectionSourceHash({ transcript, assignment = {}, transcriptLayoutVersion = CANONICAL_TRANSCRIPT_LAYOUT_VERSION }) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalEvaluation.stable({ transcript, assignment,
    version: canonical.VERSION, transcriptLayoutVersion }))).digest('hex');
}

async function generateAndPersist(doc, { assignment = {}, force = false } = {}) {
  const totalStartedAt = Date.now();
  const canonicalTranscript = buildCanonicalSubmissionTranscript(doc);
  if (!canonicalTranscript.isComplete) {
    await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId }, { $set: {
      correctionStatus: Array.isArray(doc.writingCorrections) && doc.writingCorrections.length ? 'partial' : 'processing',
      correctionError: 'OCR is incomplete for one or more uploaded files.'
    }});
    return;
  }
  const transcript = canonicalTranscript.text;
  const spans = [];
  for (const page of canonicalTranscript.pages) {
    const words = normalizeOcrWordsFromStored(page.words, { fileId: page.fileId }).map((word) => ({ ...word, page: page.pageNumber, fileId: page.fileId }));
    const local = buildTranscriptAndSpans(words);
    if (local.text !== page.text) continue;
    spans.push(...local.spans.map((span) => ({ ...span, start: span.start + page.startChar, end: span.end + page.startChar })));
  }
  if (!transcript) return;
  const hash = buildCorrectionSourceHash({ transcript, assignment });
  const semanticConfig = getSemanticAIConfig();
  const semanticSourceKey = semantic.semanticSourceKey({ correctionSourceHash: hash, config: semanticConfig });
  if (!force && doc.correctionSourceHash === hash && doc.correctionVersion === canonical.VERSION
    && doc.correctionTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION && doc.correctionStatus === 'completed'
    && doc.semanticSourceKey === semanticSourceKey) {
    semanticMetrics.increment('semanticJobsReused');
    return { reused: true, semanticSourceKey };
  }
  const jobId = crypto.randomUUID();
  const semanticMaxAttempts = semanticConfig.maxRetries + 1;
  const locked = await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId,
    semanticStatus: { $nin: ['processing', 'retry_wait'] } }, { $set: { correctionStatus: 'processing', correctionJobId: jobId, correctionError: null,
    semanticStatus: 'processing', semanticAttempt: 0, semanticMaxAttempts, semanticNextRetryAt: null, semanticErrorCode: null,
    semanticSourceKey, semanticProvider: semanticConfig.provider, semanticModel: semanticConfig.model,
    semanticPromptVersion: semantic.SEMANTIC_PROMPT_VERSION } });
  if (!locked.modifiedCount) {
    semanticMetrics.increment('semanticJobsRejectedAsDuplicate');
    logger.info({ message: 'Semantic job rejected as duplicate', submissionId: String(doc._id), sourceHashMatch: doc.correctionSourceHash === hash });
    return { reused: true, duplicate: true, semanticSourceKey };
  }
  semanticMetrics.increment('semanticJobsStarted');
  const legend = await writing.getLegend();
  let ltRaw = []; let languageToolError = null;
  const languageToolStartedAt = Date.now();
  try { ltRaw = (await writing.check({ text: transcript, language: 'en-US' })).issues || []; }
  catch (error) { languageToolError = error; }
  const lt = ltRaw.map((issue) => canonical.normalizeCorrection({ category: issue.groupKey, symbol: issue.symbol,
    quotedText: transcript.slice(issue.start, issue.end), message: issue.message || issue.description,
    suggestedText: issue.suggestion, startChar: issue.start, endChar: issue.end, confidence: 1 }, transcript, spans, legend, 'LANGUAGETOOL')).filter(Boolean);
  const languageToolMs = Date.now() - languageToolStartedAt;
  const partialWrite = await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
    writingCorrections: lt, correctionStatistics: canonical.statistics(lt), correctionStatus: 'processing',
    correctionSourceHash: hash, correctionVersion: canonical.VERSION,
    correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, correctionUpdatedAt: new Date()
  }});
  if (!partialWrite.modifiedCount) {
    logger.info({ message: 'Canonical correction job superseded before semantic analysis', submissionId: String(doc._id), stage: 'languageToolCompleted' });
    return;
  }
  await SubmissionFeedback.updateOne({ submissionId: doc._id, overriddenByTeacher: { $ne: true } },
    { $unset: { evaluationSourceHash: 1 } }).catch(() => {});
  let ai = []; let semanticError = null; let semanticReturnedCount = 0; let semanticRun = null;
  const rejectionReasons = { lowConfidence: 0, invalidCategoryOrSymbol: 0, invalidQuotation: 0, duplicate: 0 };
  let semanticValidationMs = 0; let semanticMappingMs = 0;
  const semanticStartedAt = Date.now();
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'semanticStarted', languageToolCount: lt.length, durationMs: languageToolMs });
  try {
    semanticRun = await semantic.analyze({ transcript, assignment, languageToolCorrections: lt, transcriptHash: hash,
      pageManifest: canonicalTranscript.pages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber, startChar: page.startChar, endChar: page.endChar })),
      onAttempt: async ({ attempt, maxAttempts, provider, model, attemptTimeoutMs, remainingBudgetMs }) => {
        await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
          semanticStatus: 'processing', semanticAttempt: attempt, semanticMaxAttempts: maxAttempts, semanticNextRetryAt: null
        }});
        logger.info({ message: 'Semantic analysis attempt', submissionId: String(doc._id), provider, model, attempt, maxAttempts,
          attemptTimeoutMs, remainingBudgetMs, jobIdPresent: true, sourceHashMatch: true });
      },
      onRetry: async ({ attempt, maxAttempts, delayMs, code, remainingBudgetMs, nextProvider, nextModel }) => {
        const nextRetryAt = new Date(Date.now() + delayMs);
        await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
          semanticStatus: 'retry_wait', semanticAttempt: attempt, semanticMaxAttempts: maxAttempts, semanticNextRetryAt: nextRetryAt, semanticErrorCode: code
        }});
        logger.info({ message: 'Semantic analysis retry scheduled', submissionId: String(doc._id), attempt, maxAttempts, retryDelayMs: delayMs,
          timeoutClassification: code, remainingBudgetMs, nextProvider, nextModel, jobIdPresent: true, sourceHashMatch: true });
      } });
    const raw = semanticRun.corrections;
    semanticReturnedCount = raw.length;
    const legendItems = canonical.legendIndex(legend);
    for (const item of raw) {
      if (Number(item?.confidence) < 0.65) { rejectionReasons.lowConfidence += 1; continue; }
      const validationStartedAt = Date.now();
      const meta = legendItems.get(String(item?.symbol || '').toUpperCase());
      if (!meta || meta.category !== item?.category || !['CONTENT', 'ORGANIZATION', 'VOCABULARY'].includes(item?.category)) {
        semanticValidationMs += Date.now() - validationStartedAt; rejectionReasons.invalidCategoryOrSymbol += 1; continue;
      }
      const quote = String(item?.quotedText || '');
      const range = canonical.locateQuote(transcript, quote, item?.occurrence);
      semanticValidationMs += Date.now() - validationStartedAt;
      if (!range) { rejectionReasons.invalidQuotation += 1; continue; }
      const mappingStartedAt = Date.now();
      const normalized = canonical.normalizeCorrection({ ...item, startChar: range.start, endChar: range.end }, transcript, spans, legend, 'AI');
      semanticMappingMs += Date.now() - mappingStartedAt;
      if (normalized) ai.push(normalized); else rejectionReasons.invalidQuotation += 1;
    }
  } catch (err) {
    semanticError = err;
    // Safe diagnostic logging for semantic failures (without exposing secrets)
    const errorCode = err?.code || 'UNKNOWN';
    const isConfigError = errorCode === 'AI_PROVIDER_NOT_CONFIGURED';
    const isTimeout = errorCode === 'AI_PROVIDER_TIMEOUT';
    const isBudgetError = errorCode === 'SEMANTIC_BUDGET_EXHAUSTED';
    const isInvalidResponse = errorCode === 'SEMANTIC_RESPONSE_INVALID' || errorCode === 'AI_PROVIDER_RESPONSE_INVALID';
    logger.warn({
      message: 'Semantic analysis failure',
      submissionId: String(doc._id),
      errorCode,
      errorType: isConfigError ? 'CONFIGURATION' : isTimeout ? 'TIMEOUT' : isBudgetError ? 'BUDGET' : isInvalidResponse ? 'INVALID_RESPONSE' : 'UNKNOWN',
      provider: semanticConfig.provider,
      model: semanticConfig.model,
      attempt: semanticRun?.metrics?.attemptCount || 0,
      durationMs: Date.now() - semanticStartedAt,
      credentialConfigured: Boolean(semanticConfig.apiKey)
    });
  }
  const semanticAiMs = Date.now() - semanticStartedAt;
  const mergeStartedAt = Date.now();
  const corrections = canonical.mergeCorrections([...lt, ...ai]);
  const canonicalMergeMs = Date.now() - mergeStartedAt;
  const retainedAiIds = new Set(corrections.filter((item) => item.source === 'AI').map((item) => item.id));
  rejectionReasons.duplicate = ai.filter((item) => !retainedAiIds.has(item.id)).length;
  const failedStage = languageToolError ? 'LANGUAGE_TOOL_ANALYSIS_FAILED' : safeErrorCode(semanticError);
  const persistedSemanticMetrics = { ...(semanticRun?.metrics || {}), semanticQueueWaitMs: null, semanticValidationMs, semanticMappingMs,
    canonicalMergeMs, rawCorrectionCount: semanticReturnedCount, acceptedCorrectionCount: ai.length - rejectionReasons.duplicate,
    rejectedCorrectionCount: Object.values(rejectionReasons).reduce((sum, count) => sum + count, 0), rejectionReasons };
  const finalWrite = await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
    writingCorrections: corrections, correctionStatistics: canonical.statistics(corrections), correctionSourceHash: hash,
    correctionVersion: canonical.VERSION, correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionStatus: failedStage ? (corrections.length ? 'partial' : 'failed') : 'completed',
    correctionError: failedStage, correctionUpdatedAt: new Date(), semanticStatus: failedStage ? 'failed' : 'completed',
    semanticNextRetryAt: null, semanticErrorCode: failedStage || null,
    semanticProvider: semanticRun?.provider || semanticConfig.provider, semanticModel: semanticRun?.model || semanticConfig.model,
    semanticPromptVersion: semantic.SEMANTIC_PROMPT_VERSION,
    semanticMetrics: persistedSemanticMetrics
  }});
  if (!finalWrite.modifiedCount) {
    semanticMetrics.increment('semanticJobsSuperseded');
    logger.info({ message: 'Canonical correction job superseded before final persistence', submissionId: String(doc._id), stage: 'finalCorrectionsPersisted', persisted: false });
    return;
  }
  const totalCorrectionsMs = Date.now() - totalStartedAt;
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id),
    stage: semanticError ? 'semanticFailed' : 'semanticCompleted', durationMs: semanticAiMs,
    semanticProvider: semanticRun?.provider || semanticConfig.provider, semanticModel: semanticRun?.model || semanticConfig.model,
    attemptCount: semanticRun?.metrics?.attemptCount || 0, timeoutCount: semanticRun?.metrics?.timeoutCount || 0,
    promptInputTokenEstimate: semanticRun?.metrics?.promptInputTokenEstimate || null,
    outputTokenCount: semanticRun?.metrics?.outputTokenCount || null,
    semanticReturnedCount, semanticAcceptedCount: persistedSemanticMetrics.acceptedCorrectionCount,
    semanticRejectedCount: persistedSemanticMetrics.rejectedCorrectionCount, rejectionReasons, errorCode: failedStage });
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'finalCorrectionsPersisted',
    languageToolCount: lt.length, semanticAiCount: ai.length, totalCount: corrections.length });
  let evaluationMs = 0; let detailedFeedbackMs = 0;
  if (!failedStage) {
    const evaluationStartedAt = Date.now();
    logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'evaluationStarted' });
    const refreshed = await doc.constructor.findById(doc._id);
    const evaluationResult = refreshed ? await canonicalEvaluation.generate({ submission: refreshed, assignment }) : null;
    evaluationMs = Date.now() - evaluationStartedAt;
    detailedFeedbackMs = Number(evaluationResult?.timings?.detailedFeedbackMs || 0);
    logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'evaluationCompleted', durationMs: evaluationMs });
  }
  logger.debug({ message: 'Canonical correction analysis completed', submissionId: String(doc._id),
    fileCount: Array.isArray(doc.files) ? doc.files.length : (doc.file ? 1 : 0), ocrPageCount: canonicalTranscript.pages.length,
    pageFileIds: canonicalTranscript.pages.map((page) => page.fileId), pageTextLengths: canonicalTranscript.pages.map((page) => page.text.length),
    combinedTranscriptLength: transcript.length, correctionSourceHash: hash,
    correctionCounts: canonical.statistics(corrections), sourceCounts: { LANGUAGETOOL: lt.length, AI: ai.length } });
  logger.info({ message: 'Submission analysis timing', submissionId: String(doc._id), stages: {
    canonicalTranscriptMs: languageToolStartedAt - totalStartedAt, languageToolMs,
    semanticRequestBuildMs: semanticRun?.metrics?.semanticRequestBuildMs || 0,
    semanticProviderConnectMs: semanticRun?.metrics?.semanticProviderConnectMs ?? null,
    semanticTimeToFirstByteMs: semanticRun?.metrics?.semanticTimeToFirstByteMs ?? null,
    semanticProviderMs: semanticRun?.metrics?.semanticProviderMs || semanticAiMs,
    semanticParseMs: semanticRun?.metrics?.semanticParseMs || 0, semanticValidationMs, semanticMappingMs, canonicalMergeMs,
    semanticAiMs, evaluationMs, detailedFeedbackMs, partialCorrectionsAvailableMs: languageToolMs,
    totalCorrectionsMs, totalResultReadyMs: Date.now() - totalStartedAt
  }});
  const totalResultReadyMs = Date.now() - totalStartedAt;
  await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
    semanticMetrics: { ...persistedSemanticMetrics, evaluationMs, detailedFeedbackMs,
      totalCorrectionsMs, totalResultReadyMs }
  }}).catch(() => {});
  return { reused: false, semanticSourceKey, semanticMetrics: semanticRun?.metrics || null };
}

module.exports = { wordsFromSubmission, buildCorrectionSourceHash, generateAndPersist };
