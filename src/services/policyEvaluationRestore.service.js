'use strict';
const { buildCanonicalResultState } = require('./canonicalResultState.service');

function decideRestore({ submission, feedback, nextPolicyHash, currentSettings, allowLegacy = false }) {
  const no = reason => ({ restore: false, reason });
  if (!submission || !feedback) return no('missing_record');
  if (feedback.overriddenByTeacher) return no('teacher_override');
  if (feedback.evaluationStaleReason === 'rubric') return no('rubric_stale');
  if (submission.evaluationStatus !== 'stale' || feedback.evaluationStatus !== 'stale') return no('not_stale_or_running');
  if (feedback.evaluationStaleReason !== 'policy' && !(allowLegacy && !feedback.evaluationStaleReason)) return no('not_policy_stale');
  if (submission.assessmentStatus !== 'complete' || submission.ocrStatus !== 'completed'
      || ['pending', 'processing'].includes(submission.correctionStatus)
      || ['pending', 'processing', 'retry_wait'].includes(submission.semanticStatus)) return no('assessment_or_resubmission_in_progress');
  if (!nextPolicyHash || feedback.evaluationPolicyHash !== nextPolicyHash
      || currentSettings?.policyHash !== nextPolicyHash) return no('different_policy');
  let status = feedback.evaluationStatusBeforeStale;
  if (!status && allowLegacy && !feedback.evaluationStaleReason && feedback.detailedFeedback?.status === 'completed') status = 'completed';
  if (!['completed', 'partial'].includes(status)) return no('missing_prior_status');
  const state = buildCanonicalResultState({ submission: { ...submission, evaluationStatus: status },
    feedback: { ...feedback, evaluationStatus: status }, currentSettings });
  if (!state.evaluationCurrent || !state.detailedFeedbackCurrent) return no('canonical_result_not_current');
  return { restore: true, status, reason: allowLegacy && !feedback.evaluationStaleReason ? 'proven_legacy_policy_revert' : 'policy_reverted' };
}

async function restoreOne({ submission, feedback, nextPolicyHash, currentSettings, allowLegacy = false }) {
  const decision = decideRestore({ submission, feedback, nextPolicyHash, currentSettings, allowLegacy });
  if (!decision.restore) return decision;
  const Submission = require('../models/Submission');
  const Feedback = require('../models/SubmissionFeedback');
  // Snapshot + lifecycle guards: never overwrite a new OCR/evaluation job or teacher edit.
  const feedbackGuard = { _id: feedback._id, evaluationStatus: 'stale', overriddenByTeacher: { $ne: true },
    evaluationPolicyHash: nextPolicyHash, updatedAt: feedback.updatedAt,
    evaluationJobId: feedback.evaluationJobId || null,
    evaluationStaleReason: feedback.evaluationStaleReason || null };
  const changed = await Feedback.updateMany(feedbackGuard, { $set: { evaluationStatus: decision.status } });
  if (!changed.modifiedCount) return { restore: false, reason: 'concurrent_feedback_change' };
  const changedSubmission = await Submission.updateMany({ _id: submission._id, evaluationStatus: 'stale',
    assessmentStatus: 'complete', updatedAt: submission.updatedAt,
    ocrJobId: submission.ocrJobId || null, evaluationJobId: submission.evaluationJobId || null,
    evaluationPolicyHash: submission.evaluationPolicyHash || null,
    correctionSourceHash: submission.correctionSourceHash }, { $set: { evaluationStatus: decision.status } });
  if (!changedSubmission.modifiedCount) {
    await Feedback.updateMany({ _id: feedback._id, evaluationStatus: decision.status,
      overriddenByTeacher: { $ne: true },
      evaluationJobId: feedback.evaluationJobId || null, evaluationPolicyHash: nextPolicyHash,
      evaluationStaleReason: feedback.evaluationStaleReason || null }, { $set: { evaluationStatus: 'stale' } });
    return { restore: false, reason: 'concurrent_submission_change' };
  }
  await Feedback.updateMany({ _id: feedback._id, evaluationStatus: decision.status,
    overriddenByTeacher: { $ne: true },
    evaluationJobId: feedback.evaluationJobId || null, evaluationPolicyHash: nextPolicyHash },
  { $unset: { evaluationStaleReason: 1, evaluationStatusBeforeStale: 1 } });
  return decision;
}
module.exports = { decideRestore, restoreOne };
