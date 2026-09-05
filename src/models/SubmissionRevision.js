const mongoose = require('mongoose');

const { Schema } = mongoose;

const submissionRevisionSchema = new Schema({
  sourceSubmissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
  student: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignment: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true, index: true },
  class: { type: Schema.Types.ObjectId, ref: 'Class', required: true, index: true },
  draftNumber: { type: Number, required: true, min: 1 },
  fileContentIdentity: { type: String, trim: true },
  file: { type: Schema.Types.ObjectId, ref: 'File' },
  fileUrl: { type: String, trim: true },
  files: [{ type: Schema.Types.ObjectId, ref: 'File' }],
  fileOrder: [{ _id: false, fileId: { type: Schema.Types.ObjectId, ref: 'File' }, order: Number }],
  fileUrls: [{ type: String, trim: true }],
  submittedAt: { type: Date, required: true },
  transcriptText: { type: String, trim: true },
  rawTranscriptText: { type: String },
  combinedOcrText: { type: String },
  ocrPages: { type: [Schema.Types.Mixed], default: undefined },
  writingCorrections: { type: [Schema.Types.Mixed], default: undefined },
  correctionStatistics: { type: Schema.Types.Mixed, default: undefined },
  correctionStatus: { type: String },
  correctionSourceHash: { type: String, trim: true },
  correctionVersion: { type: String, trim: true },
  semanticStatus: { type: String },
  semanticMetrics: { type: Schema.Types.Mixed, default: undefined },
  evaluationStatus: { type: String },
  assessmentStatus: { type: String },
  assessmentCompletedAt: { type: Date },
  evaluationSourceHash: { type: String, trim: true },
  evaluationRubricSourceHash: { type: String, trim: true },
  evaluationPolicyHash: { type: String, trim: true },
  feedbackSnapshot: { type: Schema.Types.Mixed, default: undefined }
}, { timestamps: true });

submissionRevisionSchema.index({ sourceSubmissionId: 1, draftNumber: 1 }, { unique: true });
submissionRevisionSchema.index({ class: 1, student: 1, submittedAt: 1 });
submissionRevisionSchema.index({ assignment: 1, student: 1, draftNumber: 1 });

module.exports = mongoose.model('SubmissionRevision', submissionRevisionSchema);
