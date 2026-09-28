'use strict';

require('../src/config/env');
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');

async function main() {
  const submissionId = String(process.argv[2] || '').trim();
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    throw new Error('Usage: npm run diagnose:assessment -- <submissionId>');
  }
  await connectDB();
  const submission = await Submission.findById(submissionId).select([
    '_id', 'draftNumber', 'createdAt', 'updatedAt', 'ocrStatus', 'ocrUpdatedAt', 'ocrErrorCode',
    'ocrJobId', 'files', 'file', 'ocrPages', 'combinedOcrText', 'ocrText', 'correctionStatus',
    'correctionJobId', 'writingCorrections', 'semanticStatus', 'semanticAttempt', 'semanticMaxAttempts',
    'semanticErrorCode', 'evaluationStatus', 'evaluationErrorCode', 'assessmentStatus', 'assessmentRunId',
    'analysisAttempt', 'analysisNextRetryAt', 'analysisErrorCode', 'analysisLeaseExpiresAt'
  ].join(' ')).lean();
  if (!submission) throw new Error('Submission not found');
  const feedback = await SubmissionFeedback.findOne({ submissionId: submission._id })
    .select('overallScore detailedFeedback evaluationStatus').lean();
  const files = Array.isArray(submission.files) && submission.files.length
    ? submission.files.length : (submission.file ? 1 : 0);
  const transcript = String(submission.combinedOcrText || submission.ocrText || '');
  const detailed = feedback?.detailedFeedback;
  process.stdout.write(`${JSON.stringify({
    submissionId: String(submission._id), draftNumber: submission.draftNumber || 1,
    createdAt: submission.createdAt, updatedAt: submission.updatedAt,
    ocrStatus: submission.ocrStatus || null, ocrUpdatedAt: submission.ocrUpdatedAt || null,
    ocrErrorCode: submission.ocrErrorCode || null, ocrJobIdPresent: Boolean(submission.ocrJobId),
    numberOfFiles: files, numberOfOcrPages: submission.ocrPages?.length || 0,
    transcriptCharacterCount: transcript.length, correctionStatus: submission.correctionStatus || null,
    correctionJobIdPresent: Boolean(submission.correctionJobId),
    correctionCount: submission.writingCorrections?.length || 0,
    semanticStatus: submission.semanticStatus || null, semanticAttempt: submission.semanticAttempt || 0,
    semanticMaxAttempts: submission.semanticMaxAttempts || 0, semanticErrorCode: submission.semanticErrorCode || null,
    evaluationStatus: submission.evaluationStatus || feedback?.evaluationStatus || null,
    evaluationErrorCode: submission.evaluationErrorCode || null,
    assessmentStatus: submission.assessmentStatus || null, assessmentRunIdPresent: Boolean(submission.assessmentRunId),
    feedbackExists: Boolean(feedback), overallScoreExists: Number.isFinite(Number(feedback?.overallScore)),
    detailedFeedbackExists: Boolean(detailed && (detailed.strengths?.length || detailed.areasForImprovement?.length || detailed.actionSteps?.length)),
    recovery: { attempt: submission.analysisAttempt || 0, nextRetryAt: submission.analysisNextRetryAt || null,
      errorCode: submission.analysisErrorCode || null, leaseExpiresAt: submission.analysisLeaseExpiresAt || null }
  }, null, 2)}\n`);
}

main().catch(error => {
  process.stderr.write(`${String(error?.message || error)}\n`);
  process.exitCode = 1;
}).finally(() => mongoose.disconnect());
