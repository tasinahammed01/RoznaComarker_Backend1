const SubmissionFeedback = require('../models/SubmissionFeedback');
const SubmissionRevision = require('../models/SubmissionRevision');

function plain(value) {
  if (value == null) return value;
  if (typeof value.toObject === 'function') return value.toObject({ depopulate: true, versionKey: false });
  return JSON.parse(JSON.stringify(value));
}

async function captureCurrentRevision(submission) {
  const draftNumber = Math.max(1, Number(submission?.draftNumber) || 1);
  const existing = await SubmissionRevision.findOne({ sourceSubmissionId: submission._id, draftNumber });
  if (existing) return existing;
  const feedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
  return SubmissionRevision.findOneAndUpdate(
    { sourceSubmissionId: submission._id, draftNumber },
    { $setOnInsert: {
      sourceSubmissionId: submission._id, student: submission.student, assignment: submission.assignment,
      class: submission.class, draftNumber, submittedAt: submission.submittedAt,
      fileContentIdentity: submission.fileContentIdentity,
      file: submission.file, fileUrl: submission.fileUrl, files: plain(submission.files),
      fileOrder: plain(submission.fileOrder), fileUrls: plain(submission.fileUrls),
      transcriptText: submission.transcriptText || submission.combinedOcrText || submission.ocrText || '',
      rawTranscriptText: submission.rawTranscriptText || submission.rawCombinedOcrText || submission.rawOcrText || '',
      combinedOcrText: submission.combinedOcrText || '', ocrPages: plain(submission.ocrPages),
      writingCorrections: plain(submission.writingCorrections),
      correctionStatistics: plain(submission.correctionStatistics), correctionStatus: submission.correctionStatus,
      correctionSourceHash: submission.correctionSourceHash, correctionVersion: submission.correctionVersion,
      semanticStatus: submission.semanticStatus, semanticMetrics: plain(submission.semanticMetrics),
      evaluationStatus: submission.evaluationStatus, assessmentStatus: submission.assessmentStatus,
      assessmentCompletedAt: submission.assessmentCompletedAt, evaluationSourceHash: submission.evaluationSourceHash,
      evaluationRubricSourceHash: submission.evaluationRubricSourceHash,
      evaluationPolicyHash: submission.evaluationPolicyHash, feedbackSnapshot: plain(feedback)
    } },
    { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
  );
}

module.exports = { captureCurrentRevision };
