'use strict';

const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const { isStructuredDetailedFeedback } = require('./canonicalDetailedFeedback.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('./rubricLanguageScoring.service');

const SEMANTIC_CATEGORIES = ['content', 'organization', 'vocabulary', 'grammar', 'mechanics'];

const countSources = (corrections) => (corrections || []).reduce((out, item) => {
  const source = String(item?.source || '').toUpperCase();
  if (source === 'AI') out.semanticAi += 1;
  return out;
}, { languageTool: 0, semanticAi: 0 });

function safeErrorCode(error) {
  const explicitCode = typeof error === 'object' && error && typeof error.code === 'string' ? error.code : '';
  if (['AI_PROVIDER_NOT_CONFIGURED', 'AI_CHAIN_NOT_CONFIGURED', 'AI_CHAIN_EXHAUSTED', 'AI_TOTAL_BUDGET_EXHAUSTED',
    'AI_ATTEMPT_TIMEOUT', 'AI_PROVIDER_TIMEOUT', 'AI_RESPONSE_TRUNCATED', 'AI_OUTPUT_VALIDATION_FAILED',
    'SEMANTIC_BUDGET_EXHAUSTED', 'AI_PROVIDER_RESPONSE_INVALID',
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

function buildCanonicalResultState({ submission = {}, feedback = null, currentSettings = null } = {}) {
  const storedCorrectionStatus = String(submission.correctionStatus || 'pending');
  const layoutCurrent = !submission.correctionSourceHash
    || submission.correctionTranscriptLayoutVersion === CANONICAL_TRANSCRIPT_LAYOUT_VERSION;
  const correctionStatus = layoutCurrent ? storedCorrectionStatus : 'stale';
  const corrections = layoutCurrent && Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [];
  const sourceCounts = countSources(corrections);
  const semanticComplete = layoutCurrent && (submission.semanticStatus === 'completed' || (!submission.semanticStatus && correctionStatus === 'completed'));
  const semanticPartial = layoutCurrent && submission.semanticStatus === 'partial';
  const semanticFailed = !layoutCurrent || submission.semanticStatus === 'failed'
    || (!submission.semanticStatus && ['partial', 'failed', 'stale'].includes(correctionStatus));
  const statistics = layoutCurrent ? (submission.correctionStatistics || null) : null;
  const semanticCoverage = submission.semanticMetrics?.coverage || null;
  const categoryCoverage = semanticCoverage?.categoryCoverageComplete || null;
  const categoryAvailability = {};
  for (const category of SEMANTIC_CATEGORIES) {
    const coverageComplete = categoryCoverage?.[category]
      ?? categoryCoverage?.[category.toUpperCase()];
    categoryAvailability[category] = semanticComplete ? 'available'
      : semanticPartial && coverageComplete === true ? 'available'
        : semanticPartial && coverageComplete === false ? 'failed'
          : semanticPartial ? 'partial' : semanticFailed ? 'failed' : 'pending';
  }
  const canonicalComplete = semanticComplete && correctionStatus === 'completed';
  const anyCategoryAvailable = semanticComplete || semanticPartial;

  const sourceHash = layoutCurrent ? (submission.correctionSourceHash || null) : null;
  const teacherOverride = layoutCurrent && Boolean(feedback?.overriddenByTeacher);
  const correctionProcessing = correctionStatus === 'processing';
  const correctionPending = ['pending', 'processing'].includes(correctionStatus);
  const persistedEvaluationStatus = String(submission.evaluationStatus || 'pending');
  const semanticStatus = layoutCurrent
    ? submission.semanticStatus || (correctionProcessing ? 'processing' : semanticComplete ? 'completed' : semanticFailed ? 'failed' : 'pending')
    : 'failed';
  const semanticProcessing = ['pending', 'processing', 'retry_wait'].includes(semanticStatus);
  const degradedEvaluationEligible = (semanticFailed || semanticPartial) && correctionStatus === 'partial' && Boolean(sourceHash);
  const evaluationJobActive = (semanticComplete || degradedEvaluationEligible)
    && persistedEvaluationStatus === 'processing' && Boolean(submission.evaluationJobId);
  const evaluationPending = (semanticComplete || degradedEvaluationEligible) && persistedEvaluationStatus === 'pending';
  const evaluationProcessing = evaluationJobActive || evaluationPending
    || (semanticComplete && persistedEvaluationStatus === 'processing');
  const evaluationLifecycleComplete = ['completed', 'partial'].includes(persistedEvaluationStatus);
  const storedRubricHash = feedback?.evaluationRubricSourceHash || submission.evaluationRubricSourceHash || null;
  const storedPolicyHash = feedback?.evaluationPolicyHash || submission.evaluationPolicyHash || null;
  const hasExplicitSettings = Boolean(currentSettings?.rubricHash && currentSettings?.policyHash);
  const rubricHashCurrent = hasExplicitSettings
    ? (currentSettings.hasValidCustomRubric
      ? storedRubricHash === currentSettings.rubricHash
      : !storedRubricHash || storedRubricHash === currentSettings.rubricHash)
    : (!submission.evaluationRubricSourceHash
      || feedback?.evaluationRubricSourceHash === submission.evaluationRubricSourceHash);
  const policyHashCurrent = hasExplicitSettings
    ? (!storedPolicyHash || storedPolicyHash === currentSettings.policyHash)
    : (!submission.evaluationPolicyHash
      || feedback?.evaluationPolicyHash === submission.evaluationPolicyHash);
  const evaluationCurrent = Boolean(feedback && (teacherOverride || (
    evaluationLifecycleComplete && sourceHash && feedback.evaluationSourceHash === sourceHash
    && rubricHashCurrent && policyHashCurrent
    && feedback.assessmentVersion === ASSESSMENT_VERSION && feedback.evaluationVersion === EVALUATION_VERSION
    && submission.evaluationVersion === EVALUATION_VERSION)));
  const sourceHashCurrent = Boolean(sourceHash && feedback?.evaluationSourceHash === sourceHash);
  const versionCurrent = Boolean(feedback
    && feedback.assessmentVersion === ASSESSMENT_VERSION
    && feedback.evaluationVersion === EVALUATION_VERSION
    && submission.evaluationVersion === EVALUATION_VERSION);
  let evaluationStatus = teacherOverride ? 'completed' : persistedEvaluationStatus;
  if (evaluationCurrent && !teacherOverride) evaluationStatus = persistedEvaluationStatus;
  else if ((correctionPending || semanticProcessing) && !teacherOverride) evaluationStatus = 'pending';
  else if (!teacherOverride && evaluationProcessing) evaluationStatus = evaluationJobActive ? 'processing' : 'pending';
  else if (!teacherOverride && evaluationCurrent) evaluationStatus = persistedEvaluationStatus;
  else if (semanticFailed && !teacherOverride) evaluationStatus = 'blocked';
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
  const staleReason = !teacherOverride && !evaluationProcessing && semanticComplete
    && ['completed', 'partial', 'stale'].includes(persistedEvaluationStatus)
    ? (!rubricHashCurrent && currentSettings?.hasValidCustomRubric ? 'rubric'
      : !policyHashCurrent ? 'policy'
        : !rubricHashCurrent ? 'settings'
          : !evaluationCurrent ? 'other' : null)
    : null;
  const hasCompletedEvaluation = Boolean(feedback?.evaluationSourceHash
    && Number.isFinite(Number(feedback?.overallScore))
    && ['completed', 'partial', 'stale'].includes(persistedEvaluationStatus));
  const reevaluationReason = !hasCompletedEvaluation || teacherOverride || evaluationProcessing
    ? null
    : !rubricHashCurrent ? 'rubric'
      : !policyHashCurrent ? 'policy'
        : !sourceHashCurrent ? 'source'
          : !versionCurrent ? 'version'
            : null;
  const evaluationFreshness = teacherOverride
    ? 'overridden'
    : evaluationProcessing || processingActive
      ? 'processing'
      : persistedEvaluationStatus === 'failed'
        ? 'failed'
        : reevaluationReason
          ? `stale_${reevaluationReason}`
          : evaluationCurrent
            ? 'current'
            : 'not_ready';
  const requiresCanonicalReevaluation = evaluationFreshness.startsWith('stale_');

  return {
    correctionStatus,
    correctionCurrent: layoutCurrent,
    transcriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionStage: correctionStatus === 'completed' ? 'complete' : semanticFailed ? 'ai_only_failed' : 'ai_only',
    statisticsStatus: canonicalComplete ? 'complete' : anyCategoryAvailable ? 'partial' : semanticFailed ? 'failed' : 'processing',
    statisticsCompleteness: canonicalComplete ? 'canonical' : semanticPartial ? 'partial' : 'none',
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
    semanticSucceeded: semanticStatus === 'completed' ? true : ['partial', 'failed'].includes(semanticStatus) ? false : null,
    correctionsAvailable: canonicalComplete || semanticPartial,
    correctionsCompleteness: canonicalComplete ? 'complete' : semanticPartial ? 'partial' : 'none',
    semanticAttempt: Number(submission.semanticAttempt || 0),
    semanticMaxAttempts: Number(submission.semanticMaxAttempts || 0),
    semanticNextRetryAt: submission.semanticNextRetryAt || null,
    semanticErrorCode,
    semanticCoverage,
    coverageComplete: semanticCoverage?.coverageComplete === true,
    retryable: manualRetryAllowed,
    score: evaluationCurrent && Number.isFinite(Number(feedback?.overallScore)) ? Number(feedback.overallScore) : null,
    grade: evaluationCurrent && typeof feedback?.grade === 'string' ? feedback.grade : null,
    evaluationCurrent,
    evaluationFreshness,
    requiresCanonicalReevaluation,
    reevaluationReason,
    detailedFeedbackCurrent: detailedCurrent,
    evaluationStaleReason: staleReason,
    rubricFresh: hasExplicitSettings ? rubricHashCurrent : null,
    policyFresh: hasExplicitSettings ? policyHashCurrent : null,
    hasValidCustomRubric: Boolean(currentSettings?.hasValidCustomRubric),
    currentRubricSourceHash: currentSettings?.rubricHash || null,
    currentPolicyHash: currentSettings?.policyHash || null,
    evaluationRubricSourceHash: storedRubricHash,
    evaluationPolicyHash: storedPolicyHash
  };
}

function buildPreviousEvaluation(feedback, resultState) {
  if (!feedback || resultState?.evaluationCurrent || !feedback.evaluationSourceHash
    || !Number.isFinite(Number(feedback.overallScore))) return null;
  return {
    overallScore: Number(feedback.overallScore),
    grade: typeof feedback.grade === 'string' ? feedback.grade : null,
    rubricScores: feedback.rubricScores || null,
    customRubricScores: feedback.customRubricScores || null,
    sourceRubric: feedback.sourceRubric || null,
    scoringAudit: feedback.scoringAudit || null,
    detailedFeedback: feedback.detailedFeedback || null,
    evaluationSourceHash: feedback.evaluationSourceHash,
    evaluationRubricSourceHash: feedback.evaluationRubricSourceHash || null,
    evaluationPolicyHash: feedback.evaluationPolicyHash || null,
    evaluationVersion: feedback.evaluationVersion || null,
    assessmentVersion: feedback.assessmentVersion || null
  };
}

module.exports = { buildCanonicalResultState, buildPreviousEvaluation, countSources, safeErrorCode };
