const AssessmentRun = require('../models/AssessmentRun');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const Feedback = require('../models/Feedback');
require('../models/File');
const adaptivePractice = require('./adaptivePractice.service');
const reportService = require('./submissionFeedbackReport.service');
const CreditService = require('./credit.service');
const logger = require('../utils/logger');
const { publishToUser } = require('./notificationRealtime.service');

function publishCreditUpdate(teacherId, submissionId, runId) {
  publishToUser({ userId: teacherId, event: 'credits_updated', payload: {
    submissionId: String(submissionId), assessmentRunId: String(runId)
  } });
}

function completionError(code, cause) {
  const error = new Error('Complete assessment pipeline did not finish successfully. No credit was used.');
  error.code = 'ASSESSMENT_COMPLETION_FAILED'; error.componentCode = code; error.cause = cause;
  return error;
}

async function start({ runId, submission, teacherId, sourceHash }) {
  const run = await AssessmentRun.findOneAndUpdate({ runId }, { $setOnInsert: {
    runId, submissionId: submission._id, assignmentId: submission.assignment, teacherId, sourceHash
  }, $set: { status: 'processing', errorCode: null } },
  { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  await submission.constructor.updateOne({ _id: submission._id }, { $set: { assessmentRunId: runId,
    assessmentStatus: 'processing', assessmentErrorCode: null }, $unset: { assessmentCompletedAt: 1 } });
  return run;
}

async function complete({ runId, submissionId, teacherId, sourceHash }) {
  const submission = await Submission.findById(submissionId).populate('files').populate('file');
  if (!submission) throw completionError('SUBMISSION_NOT_FOUND');
  const run = await AssessmentRun.findOneAndUpdate({ runId }, { $setOnInsert: {
    runId, submissionId, assignmentId: submission.assignment, teacherId, sourceHash
  }, $set: { status: 'processing', errorCode: null } }, { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true });
  if (run.status === 'complete') {
    const existing = await CreditService.consumeAssessmentCredit({ userId: teacherId, submissionId,
      assignmentId: submission.assignment, assessmentId: runId, reason: 'AI Assessment' });
    publishCreditUpdate(teacherId, submissionId, runId);
    return { run, credit: existing };
  }
  try {
    const submissionFeedback = await SubmissionFeedback.findOne({ submissionId });
    if (submission.evaluationStatus !== 'completed' || !submissionFeedback
      || submissionFeedback.evaluationStatus !== 'completed'
      || submissionFeedback.evaluationSourceHash !== sourceHash
      || submissionFeedback.detailedFeedback?.status !== 'completed') {
      throw completionError('EVALUATION_OR_FEEDBACK_INCOMPLETE');
    }
    await AssessmentRun.updateOne({ _id: run._id }, { $set: { components: {
      transcription: 'complete', issueDetection: submission.semanticStatus === 'failed' ? 'failed'
        : submission.semanticStatus === 'partial' ? 'partial' : 'complete',
      evaluation: 'complete', detailedFeedback: 'complete',
      report: 'pending', adaptiveLearning: 'pending'
    } } });

    const legacyFeedback = await Feedback.findOne({ submission: submissionId });
    await reportService.buildPersistedSubmissionFeedbackReport({ submission, submissionFeedback,
      feedback: legacyFeedback, identity: {}, generatedAt: new Date().toISOString() });
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(submissionId), stage: 'reportReadyAt',
      timestamp: new Date().toISOString(), sourceHash });
    await AssessmentRun.updateOne({ _id: run._id }, { $set: { 'components.report': 'complete' } });

    const adaptive = await adaptivePractice.generateSession(submissionId, submission.student, { retry: true });
    if (!['ready', 'no-weaknesses'].includes(adaptive?.state)) throw completionError('ADAPTIVE_LEARNING_INCOMPLETE');
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(submissionId), stage: 'adaptiveReadyAt',
      timestamp: new Date().toISOString(), sourceHash, adaptiveState: adaptive.state });
    const adaptiveComponent = adaptive.state === 'no-weaknesses' ? 'not_required' : 'complete';
    const completed = await AssessmentRun.findOneAndUpdate({ _id: run._id, status: { $ne: 'complete' } }, { $set: {
      status: 'complete', 'components.adaptiveLearning': adaptiveComponent, adaptiveState: adaptive.state,
      completedAt: new Date(), failedAt: null, errorCode: null
    } }, { returnDocument: 'after' }) || await AssessmentRun.findById(run._id);
    await Submission.updateOne({ _id: submissionId, assessmentRunId: runId }, { $set: {
      assessmentStatus: 'complete', assessmentCompletedAt: completed.completedAt || new Date(), assessmentErrorCode: null
    } });
    const credit = await CreditService.consumeAssessmentCredit({ userId: teacherId, submissionId,
      assignmentId: submission.assignment, assessmentId: runId,
      reason: submission.draftVersion && Number(submission.draftVersion) > 1 ? 'Revised Draft Assessment' : 'AI Assessment' });
    publishCreditUpdate(teacherId, submissionId, runId);
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(submissionId), stage: 'assessmentCompleteAt',
      timestamp: new Date().toISOString(), sourceHash, runId: String(runId) });
    return { run: completed, credit };
  } catch (cause) {
    const code = cause?.componentCode || cause?.code || 'ASSESSMENT_COMPONENT_FAILED';
    await AssessmentRun.updateOne({ _id: run._id }, { $set: { status: 'failed', failedAt: new Date(), errorCode: code } });
    await Submission.updateOne({ _id: submissionId }, { $set: { assessmentRunId: runId,
      assessmentStatus: 'failed', assessmentErrorCode: code }, $unset: { assessmentCompletedAt: 1 } });
    logger.info({ event: 'credit.assessment.not_charged', userId: String(teacherId), submissionId: String(submissionId),
      assessmentId: runId, reason: code });
    throw cause?.code === 'ASSESSMENT_COMPLETION_FAILED' ? cause : completionError(code, cause);
  }
}

module.exports = { start, complete, completionError };
