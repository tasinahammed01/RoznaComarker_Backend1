'use strict';

const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const { isStructuredDetailedFeedback } = require('./canonicalDetailedFeedback.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('./rubricLanguageScoring.service');

const SEMANTIC_CATEGORIES = ['content', 'organization', 'vocabulary'];
const LANGUAGE_CATEGORIES = ['grammar', 'mechanics'];

const countSources = (corrections) => (corrections || []).reduce((out, item) => {
  const source = String(item?.source || '').toUpperCase();
  if (source === 'LANGUAGETOOL') out.languageTool += 1;
  if (source === 'AI') out.semanticAi += 1;
  return out;
}, { languageTool: 0, semanticAi: 0 });

function safeErrorCode(error) {
  const explicitCode = typeof error === 'object' && error && typeof error.code === 'string' ? error.code : '';
  if (['AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_TIMEOUT', 'SEMANTIC_BUDGET_EXHAUSTED', 'AI_PROVIDER_RESPONSE_INVALID',
    'SEMANTIC_RESPONSE_INVALID', 'SEMANTIC_SOURCE_MISMATCH', 'SEMANTIC_SCHEMA_INVALID', 'SEMANTIC_EVIDENCE_UNGROUNDED',
    'GOOGLE_RESPONSE_EMPTY', 'GOOGLE_RESPONSE_BLOCKED', 'GOOGLE_OUTPUT_TRUNCATED'].includes(explicitCode)
    || /^HTTP_(400|401|402|403|404|408|429|500|502|503|504)$/u.test(explicitCode)) return explicitCode;
  const message = String(error || '').toLowerCase();
  if (!message) return null;
  if (message.includes('config') || message.includes('api key') || message.includes('credential')) return 'AI_PROVIDER_NOT_CONFIGURED';
  if (message.includes('timeout') || message.includes('timed out') || message.includes('abort')) return 'AI_PROVIDER_TIMEOUT';
  if (message.includes('hash')) return 'SEMANTIC_SOURCE_MISMATCH';
  if (message.includes('json') || message.includes('valid')) return 'SEMANTIC_RESPONSE_INVALID';
  if (message.includes('supersed')) return 'ANALYSIS_JOB_SUPERSEDED';
  return 'SEMANTIC_ANALYSIS_FAILED';
}

function buildCanonicalResultState({ submission = {}, feedback = null } = {}) {
  const storedCorrectionStatus = String(submission.correctionStatus || 'pending');
  const layoutCurrent = !submission.correctionSourceHash
    || submission.correctionTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION;
  const correctionStatus = layoutCurrent ? storedCorrectionStatus : 'stale';
  const corrections = layoutCurrent && Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [];
  const sourceCounts = countSources(corrections);
  const semanticComplete = layoutCurrent && (submission.semanticStatus === 'completed' || (!submission.semanticStatus && correctionStatus === 'completed'));
  const semanticFailed = !layoutCurrent || submission.semanticStatus === 'failed'
    || (!submission.semanticStatus && ['partial', 'failed', 'stale'].includes(correctionStatus));
  const explicitLanguageStatus = submission.languageToolStatus;
  const retainedLanguageCurrent = layoutCurrent && explicitLanguageStatus === 'failed'
    && submission.languageToolSourceHash === submission.correctionSourceHash
    && submission.languageToolVersion === submission.correctionVersion
    && submission.languageToolTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION
    && corrections.some((item) => String(item?.source || '').toUpperCase() === 'LANGUAGETOOL');
  const languageAvailable = layoutCurrent && (explicitLanguageStatus === 'completed' || retainedLanguageCurrent
    || (!explicitLanguageStatus && ['processing', 'partial', 'completed'].includes(correctionStatus) && Array.isArray(submission.writingCorrections)));
  const languageFailed = !layoutCurrent || (explicitLanguageStatus === 'failed' && !retainedLanguageCurrent)
    || (!explicitLanguageStatus && ['failed', 'stale'].includes(correctionStatus));
  const statistics = layoutCurrent ? (submission.correctionStatistics || null) : null;
  const categoryAvailability = {};
  for (const category of LANGUAGE_CATEGORIES) categoryAvailability[category] = languageAvailable ? 'available'
    : languageFailed ? 'failed' : 'pending';
  for (const category of SEMANTIC_CATEGORIES) categoryAvailability[category] = semanticComplete ? 'available' : semanticFailed ? 'failed' : 'pending';
  const canonicalComplete = semanticComplete && languageAvailable && correctionStatus === 'completed';
  const anyCategoryAvailable = semanticComplete || languageAvailable;

  const sourceHash = layoutCurrent ? (submission.correctionSourceHash || null) : null;
  const teacherOverride = layoutCurrent && Boolean(feedback?.overriddenByTeacher);
  const correctionProcessing = correctionStatus === 'processing';
  const correctionPending = ['pending', 'processing'].includes(correctionStatus);
  const persistedEvaluationStatus = String(submission.evaluationStatus || 'pending');
  const semanticStatus = layoutCurrent
    ? submission.semanticStatus || (correctionProcessing ? 'processing' : semanticComplete ? 'completed' : semanticFailed ? 'failed' : 'pending')
    : 'failed';
  const semanticProcessing = ['pending', 'processing', 'retry_wait'].includes(semanticStatus);
  const evaluationJobActive = semanticComplete && persistedEvaluationStatus === 'processing' && Boolean(submission.evaluationJobId);
  const evaluationPending = semanticComplete && persistedEvaluationStatus === 'pending';
  const evaluationProcessing = evaluationJobActive || evaluationPending;
  const evaluationLifecycleComplete = ['completed', 'partial'].includes(persistedEvaluationStatus);
  const evaluationCurrent = Boolean(feedback && (teacherOverride || (semanticComplete
    && evaluationLifecycleComplete && sourceHash && feedback.evaluationSourceHash === sourceHash
    && feedback.assessmentVersion === ASSESSMENT_VERSION && feedback.evaluationVersion === EVALUATION_VERSION
    && submission.evaluationVersion === EVALUATION_VERSION)));
  let evaluationStatus = teacherOverride ? 'completed' : persistedEvaluationStatus;
  if ((correctionPending || semanticProcessing) && !teacherOverride) evaluationStatus = 'pending';
  else if (semanticFailed && !teacherOverride) evaluationStatus = 'blocked';
  else if (!teacherOverride && evaluationProcessing) evaluationStatus = evaluationJobActive ? 'processing' : 'pending';
  else if (!teacherOverride && evaluationCurrent) evaluationStatus = persistedEvaluationStatus;
  else if (!teacherOverride && persistedEvaluationStatus === 'failed') evaluationStatus = 'failed';
  else if (!teacherOverride && semanticComplete) evaluationStatus = 'stale';
  const detailedHashCurrent = Boolean(sourceHash && feedback?.detailedFeedbackSourceHash === sourceHash);
  const structuredDetailedFeedback = isStructuredDetailedFeedback(feedback?.detailedFeedback);
  const invalidCanonicalFeedback = Boolean(evaluationCurrent && detailedHashCurrent && feedback?.detailedFeedback && !structuredDetailedFeedback && !teacherOverride);
  const detailedCurrent = Boolean(!evaluationProcessing && evaluationCurrent && (teacherOverride
    ? feedback?.detailedFeedback
    : detailedHashCurrent && structuredDetailedFeedback));
  const detailedFeedbackStatus = correctionPending && !teacherOverride
    ? 'pending'
    : semanticFailed && !teacherOverride
    ? 'blocked'
    : evaluationProcessing && !teacherOverride
    ? 'processing'
    : invalidCanonicalFeedback
    ? 'failed'
    : detailedCurrent
    ? String(feedback?.detailedFeedback?.status || 'completed')
    : feedback?.detailedFeedback ? 'stale' : 'blocked';
  const processingActive = ['pending', 'processing'].includes(String(submission.ocrStatus || 'completed'))
    || correctionPending || semanticProcessing || evaluationProcessing;
  const terminal = !processingActive && (teacherOverride || evaluationCurrent || semanticFailed
    || ['failed', 'stale'].includes(evaluationStatus));
  const automaticPollingAllowed = processingActive && !terminal;
  const semanticErrorCode = submission.semanticErrorCode || safeErrorCode(submission.correctionError);
  const nonRetryableConfigurationFailure = semanticErrorCode === 'AI_PROVIDER_NOT_CONFIGURED';
  const manualRetryAllowed = !nonRetryableConfigurationFailure && (semanticFailed
    || ['failed', 'stale'].includes(evaluationStatus) || invalidCanonicalFeedback);

  return {
    correctionStatus,
    correctionCurrent: layoutCurrent,
    transcriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionStage: correctionStatus === 'completed' ? 'complete' : semanticFailed ? 'semantic_failed'
      : languageFailed ? 'language_tool_failed' : languageAvailable ? 'semantic' : 'language_tool',
    statisticsStatus: canonicalComplete ? 'complete' : anyCategoryAvailable ? 'partial'
      : (semanticFailed || languageFailed) ? 'failed' : 'processing',
    statisticsCompleteness: canonicalComplete ? 'canonical' : semanticComplete && !languageAvailable ? 'semantic_only'
      : languageAvailable ? 'language_only' : 'none',
    statistics,
    categoryAvailability,
    sourceCounts,
    correctionErrorCode: safeErrorCode(submission.correctionError),
    evaluationStatus,
    evaluationSource: evaluationCurrent ? feedback?.evaluationSource || null : null,
    evaluationVersion: evaluationCurrent ? feedback?.evaluationVersion || null : null,
    assessmentVersion: evaluationCurrent ? feedback?.assessmentVersion || null : null,
    evaluationErrorCode: feedback?.evaluationErrorCode || submission.evaluationErrorCode || safeErrorCode(submission.evaluationError),
    detailedFeedbackStatus,
    processingActive,
    automaticPollingAllowed,
    manualRetryAllowed,
    terminal,
    evaluationBlockedReason: evaluationStatus === 'blocked' ? 'corrections_incomplete' : null,
    detailedFeedbackBlockedReason: detailedFeedbackStatus === 'blocked' ? (semanticFailed ? 'evaluation_unavailable' : 'evaluation_unavailable') : null,
    semanticStatus,
    semanticAttempt: Number(submission.semanticAttempt || 0),
    semanticMaxAttempts: Number(submission.semanticMaxAttempts || 0),
    semanticNextRetryAt: submission.semanticNextRetryAt || null,
    semanticErrorCode,
    retryable: manualRetryAllowed,
    score: !evaluationProcessing && evaluationCurrent && Number.isFinite(Number(feedback?.overallScore)) ? Number(feedback.overallScore) : null,
    grade: !evaluationProcessing && evaluationCurrent && typeof feedback?.grade === 'string' ? feedback.grade : null,
    evaluationCurrent,
    detailedFeedbackCurrent: detailedCurrent
  };
}

module.exports = { buildCanonicalResultState, countSources, safeErrorCode };
