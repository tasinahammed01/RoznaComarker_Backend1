'use strict';

function pendingAnalysisState({ ocrJobId, now = new Date() }) {
  return {
    ocrStatus: 'pending', ocrJobId, ocrText: undefined, rawOcrText: undefined,
    rawCombinedOcrText: undefined, ocrError: undefined, ocrData: undefined, ocrPages: [],
    combinedOcrText: undefined, transcriptText: undefined, rawTranscriptText: undefined,
    ocrUpdatedAt: now,
    writingCorrections: [], correctionStatistics: undefined, correctionStatus: 'pending',
    correctionSourceHash: undefined, correctionVersion: undefined,
    correctionTranscriptLayoutVersion: undefined, correctionError: undefined,
    correctionUpdatedAt: undefined, correctionJobId: undefined,
    semanticSourceKey: undefined, semanticStatus: 'pending', semanticAttempt: 0,
    semanticMaxAttempts: undefined, semanticNextRetryAt: undefined, semanticErrorCode: undefined,
    semanticProvider: undefined, semanticModel: undefined, semanticPromptVersion: undefined,
    semanticMetrics: undefined, correctionLegendSource: undefined, correctionLegendVersion: undefined,
    correctionLegendContentHash: undefined, deductionPolicyVersion: undefined,
    evaluationStatus: 'pending', evaluationJobId: undefined, evaluationSourceHash: undefined,
    evaluationVersion: undefined, evaluationRubricSourceHash: undefined,
    evaluationPolicyHash: undefined, evaluationProvider: undefined, evaluationModel: undefined,
    evaluationErrorCode: undefined, evaluationAttempts: undefined, evaluationDiagnostics: undefined,
    evaluationError: undefined, evaluationUpdatedAt: undefined,
    assessmentRunId: undefined, assessmentStatus: 'started', assessmentCompletedAt: undefined,
    assessmentErrorCode: undefined
  };
}

function resetSubmissionAnalysisState(submission, options) {
  Object.assign(submission, pendingAnalysisState(options));
  return submission;
}

module.exports = { pendingAnalysisState, resetSubmissionAnalysisState };
