const crypto = require('crypto');
const semantic = require('./semanticWritingCorrections.service');
const canonical = require('./correctionCanonical.service');
const { buildCanonicalSubmissionTranscript, CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const logger = require('../utils/logger');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const canonicalEvaluation = require('./canonicalEvaluation.service');
const semanticRubricAssessment = require('./semanticRubricAssessment.service');
const { safeErrorCode } = require('./canonicalResultState.service');
const { getSemanticAIConfig, getSemanticAIConfigStatus } = require('./semanticAIClient.service');
const semanticMetrics = require('./semanticMetrics.service');
const { resolveLegend } = require('./correctionLegendResolver.service');

async function blockEvaluationAfterCorrectionFailure({ submissionId, errorCode, feedbackModel = SubmissionFeedback }) {
  return feedbackModel.updateOne({ submissionId, overriddenByTeacher: { $ne: true },
    evaluationStatus: { $nin: ['completed', 'partial'] } }, { $set: {
    evaluationStatus: 'blocked', overallScore: null, grade: null, rubricScores: null,
    correctionStats: null, evaluationErrorCode: errorCode || 'SEMANTIC_ANALYSIS_FAILED'
  }, $unset: { evaluationSourceHash: 1, evaluationRubricSourceHash: 1, evaluationPolicyHash: 1,
    evaluationVersion: 1, evaluationProvider: 1, evaluationModel: 1 } });
}

function wordsFromSubmission(doc) {
  const all = [];
  for (const page of doc.ocrPages || []) {
    const fileId = String(page.fileId || 'legacy');
    const words = normalizeOcrWordsFromStored(page.words || [], { fileId });
    for (const word of words) all.push({ ...word, page: Number(page.pageNumber || word.page || 1), fileId });
  }
  return all;
}

function orderedPageIdentity(pages = []) {
  return pages.map((page, index) => ({ fileId: String(page?.fileId || ''),
    uploadOrder: Number.isFinite(Number(page?.fileOrder)) ? Number(page.fileOrder) : index,
    pageIndex: Number.isFinite(Number(page?.pageIndex)) ? Number(page.pageIndex) : Number(page?.pageNumber || 1) - 1,
    normalizedPageTextHash: crypto.createHash('sha256').update(String(page?.text || '')).digest('hex') }));
}

function buildCorrectionSourceHash({ transcript, pages = [], assignment = {},
  transcriptLayoutVersion = CANONICAL_TRANSCRIPT_LAYOUT_VERSION }) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalEvaluation.stable({ transcript, assignment,
    orderedPages: orderedPageIdentity(pages), version: canonical.VERSION,
    promptVersion: semantic.SEMANTIC_PROMPT_VERSION, schemaVersion: semantic.SEMANTIC_SCHEMA_VERSION,
    transcriptLayoutVersion }))).digest('hex');
}

function plannedSemanticAttempts(config = {}) {
  const modelCount = Array.isArray(config.chain) ? config.chain.length : (config.fallback ? 2 : 1);
  return (1 + Number(config.primaryRetries || 0))
    + Math.max(0, modelCount - 1) * (1 + Number(config.fallbackRetries || 0));
}

function hasHolisticCoverageMismatch(categoryScores = {}, statistics = {}) {
  return holisticCoverageMismatchCategories(categoryScores, statistics).length > 0;
}

function holisticCoverageMismatchCategories(categoryScores = {}, statistics = {}) {
  const statisticKey = { CONTENT: 'content', ORGANIZATION: 'organization', VOCABULARY: 'vocabulary' };
  return Object.entries(statisticKey).filter(([category, key]) => {
    const score = Number(categoryScores?.[category]?.score);
    const maximum = Number(categoryScores?.[category]?.maxScore || 20);
    return Number.isFinite(score) && Number.isFinite(maximum) && maximum > 0
      && score <= maximum * 0.85 && Number(statistics?.[key] || 0) === 0;
  }).map(([category]) => category);
}

async function generateAndPersist(doc, { assignment = {}, force = false } = {}) {
  const totalStartedAt = Date.now();
  logger.info({ message: 'Canonical evaluation timing', submissionId: String(doc._id),
    stage: 'correction_start', attemptNumber: null, provider: null, model: null,
    errorCode: null, durationMs: 0 });
  const canonicalTranscript = buildCanonicalSubmissionTranscript(doc);
  if (!canonicalTranscript.isComplete) {
    await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId }, { $set: {
      correctionStatus: Array.isArray(doc.writingCorrections) && doc.writingCorrections.length ? 'partial' : 'processing',
      correctionError: 'OCR is incomplete for one or more uploaded files.'
    }});
    return;
  }
  const transcript = canonicalTranscript.text;
  const spans = canonicalTranscript.wordSpans.map((span) => ({ ...span }));
  if (!transcript) return;
  const hash = buildCorrectionSourceHash({ transcript, pages: canonicalTranscript.pages, assignment });
  const semanticConfig = getSemanticAIConfig();
  const legend = await resolveLegend();
  const assignmentHash = crypto.createHash('sha256').update(JSON.stringify(canonicalEvaluation.stable(assignment))).digest('hex');
  const semanticSourceKey = semantic.semanticSourceKey({ correctionSourceHash: hash, config: semanticConfig,
    legendVersion: legend.version, legendContentHash: legend.contentHash, assignmentHash });
  if (!force && doc.correctionSourceHash === hash && doc.correctionVersion === canonical.VERSION
    && doc.correctionTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION && doc.correctionStatus === 'completed'
    && doc.semanticSourceKey === semanticSourceKey) {
    semanticMetrics.increment('semanticJobsReused');
    return { reused: true, semanticSourceKey };
  }
  const jobId = crypto.randomUUID();
  const semanticMaxAttempts = plannedSemanticAttempts(semanticConfig);
  const locked = await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId,
    semanticStatus: { $nin: ['processing', 'retry_wait'] } }, { $set: { correctionStatus: 'processing', correctionJobId: jobId, correctionError: null,
    semanticStatus: 'processing', semanticAttempt: 0, semanticMaxAttempts,
    semanticNextRetryAt: null, semanticErrorCode: null,
    semanticSourceKey, semanticProvider: semanticConfig.provider, semanticModel: semanticConfig.model,
    semanticPromptVersion: semantic.SEMANTIC_PROMPT_VERSION } });
  if (!locked.modifiedCount) {
    semanticMetrics.increment('semanticJobsRejectedAsDuplicate');
    logger.info({ message: 'Semantic job rejected as duplicate', submissionId: String(doc._id), sourceHashMatch: doc.correctionSourceHash === hash });
    return { reused: true, duplicate: true, semanticSourceKey };
  }
  semanticMetrics.increment('semanticJobsStarted');
  await SubmissionFeedback.updateOne({ submissionId: doc._id, overriddenByTeacher: { $ne: true } },
    { $unset: { evaluationSourceHash: 1, evaluationRubricSourceHash: 1, evaluationPolicyHash: 1 } }).catch(() => {});
  let ai = []; let semanticError = null; let semanticReturnedCount = 0; let semanticRun = null; let failedSemanticAttempt = 0;
  const rejectionReasons = {};
  let semanticValidationMs = 0; let semanticMappingMs = 0;
  const semanticStartedAt = Date.now();
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'aiOnlyStarted' });
  try {
    semanticRun = await semantic.analyze({ transcript, assignment, legend, transcriptHash: hash, spans,
      pageManifest: canonicalTranscript.pages.map((page) => ({ fileId: page.fileId, fileOrder: page.fileOrder,
        pageNumber: page.pageNumber, pageIndex: page.pageIndex, startChar: page.startChar, endChar: page.endChar })),
      onAttempt: async ({ attempt, maxAttempts, provider, model, attemptTimeoutMs, remainingBudgetMs, maxOutputTokens }) => {
        failedSemanticAttempt = attempt;
        await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
          semanticStatus: 'processing', semanticAttempt: attempt, semanticMaxAttempts: maxAttempts, semanticNextRetryAt: null
        }});
        logger.info({ message: 'AI-only correction analysis attempt', feature: 'semantic_corrections',
          submissionId: String(doc._id), provider, model, attempt, maxAttempts,
          maxOutputTokens, attemptTimeoutMs, remainingBudgetMs, jobIdPresent: true, sourceHashMatch: true });
      },
      onRetry: async ({ attempt, maxAttempts, delayMs, code, remainingBudgetMs, nextProvider, nextModel }) => {
        const nextRetryAt = new Date(Date.now() + delayMs);
        await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
          semanticStatus: 'retry_wait', semanticAttempt: attempt, semanticMaxAttempts: maxAttempts, semanticNextRetryAt: nextRetryAt, semanticErrorCode: code
        }});
        logger.info({ message: 'AI-only correction analysis retry scheduled', submissionId: String(doc._id), attempt, maxAttempts, retryDelayMs: delayMs,
          timeoutClassification: code, remainingBudgetMs, nextProvider, nextModel, jobIdPresent: true, sourceHashMatch: true });
      } });
    const raw = semanticRun.corrections || [];
    semanticReturnedCount = semanticRun.diagnostics?.rawCorrectionCount ?? raw.length;
    Object.assign(rejectionReasons, semanticRun.diagnostics?.rejectionReasons || {});
    semanticValidationMs = Number(semanticRun.metrics?.semanticValidationMs || 0);
    const mappingStartedAt = Date.now();
    ai = raw.map((item) => item?.id && item?.source === 'AI' ? item
      : canonical.normalizeCorrection(item, transcript, spans, legend, 'AI')).filter(Boolean);
    semanticMappingMs = Date.now() - mappingStartedAt;
  } catch (err) {
    semanticError = err;
    if (err?.validationDiagnostics) {
      semanticReturnedCount = Number(err.validationDiagnostics.rawCorrectionCount || 0);
      Object.assign(rejectionReasons, err.validationDiagnostics.rejectionReasons || {});
    }
    const errorCode = safeErrorCode(err) || 'SEMANTIC_ANALYSIS_FAILED';
    logger.warn({
      message: 'AI-only correction analysis failure',
      errorCode,
      provider: semanticConfig.provider,
      model: semanticConfig.model,
      attempt: failedSemanticAttempt,
      durationMs: Date.now() - semanticStartedAt,
      httpStatus: Number(err?.httpStatus || err?.status) || null,
      candidateCount: Number.isFinite(Number(err?.candidateCount)) ? Number(err.candidateCount) : null,
      finishReason: typeof err?.finishReason === 'string' ? err.finishReason : null,
      responseTextLength: Number.isFinite(Number(err?.responseTextLength)) ? Number(err.responseTextLength) : null,
      validationStage: typeof err?.validationStage === 'string' ? err.validationStage : null,
      credentialConfigured: getSemanticAIConfigStatus(semanticConfig).credentialConfigured
    });
  }
  const semanticAiMs = Date.now() - semanticStartedAt;
  const mergeStartedAt = Date.now();
  const merged = canonical.mergeCanonicalCorrections({ aiCorrections: ai });
  const corrections = merged.corrections;
  const combinedStatistics = canonical.statistics(corrections);
  const canonicalMergeMs = Date.now() - mergeStartedAt;
  const retainedAiIds = new Set(corrections.filter((item) => item.source === 'AI').map((item) => item.id));
  const removedByMerge = ai.filter((item) => !retainedAiIds.has(item.id));
  rejectionReasons.DUPLICATE_OR_CONFLICT = removedByMerge.length;
  const categoryKeys = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'];
  const zeroCategories = () => Object.fromEntries(categoryKeys.map((key) => [key, 0]));
  const countByCategory = (items) => items.reduce((counts, item) => {
    if (counts[item?.category] !== undefined) counts[item.category] += 1; return counts;
  }, zeroCategories());
  const terminalValidation = semanticRun?.diagnostics || semanticError?.validationDiagnostics || {};
  const returnedByCategory = terminalValidation.returnedByCategory || zeroCategories();
  const acceptedBeforeMergeByCategory = terminalValidation.acceptedByCategory || countByCategory(ai);
  const rejectedByCategory = terminalValidation.rejectedByCategory || zeroCategories();
  const retainedAfterMergeByCategory = countByCategory(corrections.filter((item) => item.source === 'AI'));
  const removedDuringMergeByCategory = countByCategory(removedByMerge);
  const failedStage = safeErrorCode(semanticError);
  const anyAnalysisStageAvailable = !semanticError;
  const terminalAttempts = semanticRun?.metrics?.attempts || semanticError?.attempts || [];
  const terminalAttempt = terminalAttempts[terminalAttempts.length - 1] || null;
  const gatewayMetrics = semanticRun?.metrics || (semanticError ? {
    attemptCount: semanticError.attemptCount || terminalAttempts.length,
    timeoutCount: semanticError.timeoutCount
      ?? terminalAttempts.filter((attempt) => attempt.code === 'AI_ATTEMPT_TIMEOUT').length,
    attempts: terminalAttempts,
    semanticProviderMs: semanticError.totalDurationMs || semanticError.durationMs || semanticAiMs,
    finalFailureCode: semanticError.finalFailureCode || terminalAttempt?.code || safeErrorCode(semanticError)
  } : {});
  const rejectionCounts = terminalValidation.rejectionReasons || rejectionReasons;
  const rejectionStageCounts = {
    rejectedBySchema: Number(rejectionCounts.INVALID_SCHEMA || 0) + Number(rejectionCounts.INVALID_SEVERITY || 0),
    rejectedByLegend: Number(rejectionCounts.LEGEND_MISMATCH || 0),
    rejectedByConfidence: Number(rejectionCounts.LOW_CONFIDENCE || 0),
    rejectedByQuoteMatch: Number(rejectionCounts.QUOTE_NOT_FOUND || 0),
    rejectedByOccurrence: Number(rejectionCounts.OCCURRENCE_NOT_FOUND || 0),
    rejectedByGrounding: Number(rejectionCounts.QUOTE_NOT_FOUND || 0) + Number(rejectionCounts.OCCURRENCE_NOT_FOUND || 0),
    rejectedByOcrMapping: Number(rejectionCounts.INVALID_LOCATION || 0),
    removedAsExactDuplicate: Number(merged.diagnostics?.exactDuplicates || 0),
    removedAsOverlapDuplicate: Number(merged.diagnostics?.overlapDuplicates || 0)
  };
  const persistedSemanticMetrics = { ...gatewayMetrics, semanticQueueWaitMs: null, semanticValidationMs, semanticMappingMs,
    validationDiagnostics: semanticRun?.diagnostics || semanticError?.validationDiagnostics || null,
    canonicalMergeMs, mergeDiagnostics: merged.diagnostics,
    rawCorrectionCount: semanticReturnedCount, acceptedCorrectionCount: ai.length - rejectionReasons.DUPLICATE_OR_CONFLICT,
    rejectedCorrectionCount: Object.values(rejectionReasons).reduce((sum, count) => sum + count, 0), rejectionReasons,
    returnedByCategory, acceptedByCategory: acceptedBeforeMergeByCategory, rejectedByCategory,
    rejectionReasonsByCategory: terminalValidation.rejectionReasonsByCategory || {},
    symbolReviewCoverage: terminalValidation.symbolReviewCoverage || null,
    allCategoriesReviewed: terminalValidation.allCategoriesReviewed === true,
    totalExpectedSymbols: Number(terminalValidation.totalExpectedSymbols || 0),
    totalReceivedUniqueSymbols: Number(terminalValidation.totalReceivedUniqueSymbols || 0),
    incompleteReviewCategories: Array.isArray(terminalValidation.incompleteReviewCategories)
      ? terminalValidation.incompleteReviewCategories : [],
    retainedAfterMergeByCategory, removedDuringMergeByCategory, persistedByCategory: retainedAfterMergeByCategory,
    ...rejectionStageCounts };
  const finalWrite = await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
    writingCorrections: corrections, correctionStatistics: combinedStatistics, correctionSourceHash: hash,
    correctionVersion: canonical.VERSION, correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionStatus: failedStage ? (anyAnalysisStageAvailable ? 'partial' : 'failed') : 'completed',
    correctionError: failedStage, correctionUpdatedAt: new Date(), semanticStatus: semanticError ? 'failed' : 'completed',
    semanticNextRetryAt: null, semanticErrorCode: safeErrorCode(semanticError) || null,
    semanticProvider: semanticRun?.provider || terminalAttempt?.provider || semanticConfig.provider,
    semanticModel: semanticRun?.model || terminalAttempt?.model || semanticConfig.model,
    semanticPromptVersion: semantic.SEMANTIC_PROMPT_VERSION,
    evaluationStatus: semanticError && !['completed', 'partial'].includes(String(doc.evaluationStatus || ''))
      ? 'blocked' : doc.evaluationStatus,
    correctionLegendSource: legend.source,
    correctionLegendVersion: legend.version, correctionLegendContentHash: legend.contentHash,
    deductionPolicyVersion: canonical.DEDUCTION_POLICY_VERSION,
    semanticMetrics: persistedSemanticMetrics
  }});
  if (!finalWrite.modifiedCount) {
    semanticMetrics.increment('semanticJobsSuperseded');
    logger.info({ message: 'Canonical correction job superseded before final persistence', submissionId: String(doc._id), stage: 'finalCorrectionsPersisted', persisted: false });
    return;
  }
  if (semanticError) {
    await blockEvaluationAfterCorrectionFailure({ submissionId: doc._id,
      errorCode: safeErrorCode(semanticError) || 'SEMANTIC_ANALYSIS_FAILED' }).catch(() => {});
  }
  const totalCorrectionsMs = Date.now() - totalStartedAt;
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id),
    stage: semanticError ? 'aiOnlyFailed' : 'aiOnlyCompleted', durationMs: semanticAiMs,
    ocrJobId: doc.ocrJobId || null, correctionSourceHash: hash,
    semanticProvider: semanticRun?.provider || terminalAttempt?.provider || semanticConfig.provider,
    semanticModel: semanticRun?.model || terminalAttempt?.model || semanticConfig.model,
    fallbackIndex: Number.isInteger(terminalAttempt?.fallbackIndex) ? terminalAttempt.fallbackIndex : null,
    attemptCount: gatewayMetrics.attemptCount || 0, timeoutCount: gatewayMetrics.timeoutCount || 0,
    temperature: semanticConfig.temperature, promptVersion: semantic.SEMANTIC_PROMPT_VERSION,
    schemaVersion: semantic.SEMANTIC_SCHEMA_VERSION,
    promptInputTokenEstimate: semanticRun?.metrics?.promptInputTokenEstimate || null,
    outputTokenCount: semanticRun?.metrics?.outputTokenCount || null,
    semanticReturnedCount, semanticAcceptedCount: persistedSemanticMetrics.acceptedCorrectionCount,
    semanticRejectedCount: persistedSemanticMetrics.rejectedCorrectionCount, rejectionReasons, errorCode: failedStage });
  logger.info({ message: 'AI-only correction completion summary', submissionId: String(doc._id),
    provider: semanticRun?.provider || terminalAttempt?.provider || semanticConfig.provider,
    model: semanticRun?.model || terminalAttempt?.model || semanticConfig.model,
    attemptCount: gatewayMetrics.attemptCount || 0, rawCorrectionCount: semanticReturnedCount,
    acceptedCorrectionCount: persistedSemanticMetrics.acceptedCorrectionCount,
    rejectedCorrectionCount: persistedSemanticMetrics.rejectedCorrectionCount,
    returnedByCategory, acceptedByCategory: acceptedBeforeMergeByCategory, rejectedByCategory,
    rejectionReasonsByCategory: persistedSemanticMetrics.rejectionReasonsByCategory,
    retainedAfterMergeByCategory, removedDuringMergeByCategory, mergeDiagnostics: merged.diagnostics,
    durationMs: semanticAiMs });
  logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'finalCorrectionsPersisted',
    aiOnlyCount: ai.length, totalCount: corrections.length });
  let evaluationMs = 0; let detailedFeedbackMs = 0; let holisticCorrectionCoverageMismatch = false;
  let holisticCorrectionCoverageMismatchCategories = [];
  if (!semanticError) {
    const evaluationStartedAt = Date.now();
    logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'evaluationStarted',
      semanticSucceeded: true });
    const refreshed = await doc.constructor.findById(doc._id);
    const evaluationResult = refreshed ? await canonicalEvaluation.generate({ submission: refreshed, assignment }) : null;
    evaluationMs = Date.now() - evaluationStartedAt;
    detailedFeedbackMs = Number(evaluationResult?.timings?.detailedFeedbackMs || 0);
    holisticCorrectionCoverageMismatchCategories = holisticCoverageMismatchCategories(
      evaluationResult?.categoryScores, combinedStatistics);
    holisticCorrectionCoverageMismatch = holisticCorrectionCoverageMismatchCategories.length > 0;
    const evaluationStage = ['completed', 'partial'].includes(evaluationResult?.status) ? 'evaluationSucceeded'
      : evaluationResult?.status === 'failed' ? 'evaluationFailed'
      : evaluationResult?.status === 'reused' ? 'evaluationReused' : 'evaluationSuperseded';
    logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: evaluationStage, durationMs: evaluationMs,
      ocrJobId: doc.ocrJobId || null, correctionSourceHash: hash,
      provider: evaluationResult?.provider || null, model: evaluationResult?.model || null,
      attemptCount: Array.isArray(evaluationResult?.attempts) ? evaluationResult.attempts.length : 0,
      fallbackIndex: Array.isArray(evaluationResult?.attempts) && evaluationResult.attempts.length
        ? evaluationResult.attempts[evaluationResult.attempts.length - 1].fallbackIndex : null,
      categoryScores: evaluationResult?.categoryScores
        ? Object.fromEntries(Object.entries(evaluationResult.categoryScores).map(([key, value]) => [key, value.score])) : null,
      overallScore: evaluationResult?.overallScore ?? null,
      promptVersion: semanticRubricAssessment.PROMPT_VERSION,
      schemaVersion: semanticRubricAssessment.SCHEMA_VERSION,
      errorCode: evaluationResult?.errorCode || null });
  } else {
    logger.info({ message: 'Canonical correction stage', submissionId: String(doc._id), stage: 'evaluationSkipped',
      reason: 'aiOnlyAnalysisFailed', semanticErrorCode: safeErrorCode(semanticError) });
  }
  logger.debug({ message: 'Canonical correction analysis completed', submissionId: String(doc._id),
    fileCount: Array.isArray(doc.files) ? doc.files.length : (doc.file ? 1 : 0), ocrPageCount: canonicalTranscript.pages.length,
    pageFileIds: canonicalTranscript.pages.map((page) => page.fileId), pageTextLengths: canonicalTranscript.pages.map((page) => page.text.length),
    combinedTranscriptLength: transcript.length, correctionSourceHash: hash,
    correctionCounts: canonical.statistics(corrections), sourceCounts: { AI: ai.length } });
  logger.info({ message: 'Submission analysis timing', submissionId: String(doc._id), stages: {
    canonicalTranscriptMs: semanticStartedAt - totalStartedAt,
    semanticRequestBuildMs: semanticRun?.metrics?.semanticRequestBuildMs || 0,
    semanticProviderConnectMs: semanticRun?.metrics?.semanticProviderConnectMs ?? null,
    semanticTimeToFirstByteMs: semanticRun?.metrics?.semanticTimeToFirstByteMs ?? null,
    semanticProviderMs: semanticRun?.metrics?.semanticProviderMs || semanticAiMs,
    semanticParseMs: semanticRun?.metrics?.semanticParseMs || 0, semanticValidationMs, semanticMappingMs, canonicalMergeMs,
    semanticAiMs, evaluationMs, detailedFeedbackMs,
    totalCorrectionsMs, totalResultReadyMs: Date.now() - totalStartedAt
  }});
  const totalResultReadyMs = Date.now() - totalStartedAt;
  logger.info({ message: 'Canonical evaluation timing', submissionId: String(doc._id),
    stage: 'correction_end', attemptNumber: null,
    provider: semanticRun?.provider || terminalAttempt?.provider || semanticConfig.provider,
    model: semanticRun?.model || terminalAttempt?.model || semanticConfig.model,
    errorCode: failedStage || null, durationMs: totalResultReadyMs });
  await doc.constructor.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, correctionJobId: jobId }, { $set: {
    semanticMetrics: { ...persistedSemanticMetrics, evaluationMs, detailedFeedbackMs,
      totalCorrectionsMs, totalResultReadyMs, holisticCorrectionCoverageMismatch,
      holisticCorrectionCoverageMismatchCategories,
      rubricDeductionWithZeroCorrectionsByCategory: holisticCorrectionCoverageMismatchCategories }
  }}).catch(() => {});
  return { reused: false, semanticSourceKey, semanticMetrics: semanticRun?.metrics || null };
}

module.exports = { wordsFromSubmission, orderedPageIdentity, buildCorrectionSourceHash, plannedSemanticAttempts,
  hasHolisticCoverageMismatch, holisticCoverageMismatchCategories, blockEvaluationAfterCorrectionFailure, generateAndPersist };
