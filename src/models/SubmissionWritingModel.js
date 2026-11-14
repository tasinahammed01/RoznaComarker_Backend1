const mongoose = require('mongoose');

const { Schema } = mongoose;

// Improved Writing Model for ONE submission (services/writingModel.service.js, IMPROVED_WRITING_MODEL_ENABLED): an improved version of that
// student's own writing, written by the teacher or drafted by AI from that student's transcript. Only that student (or the guest holding that
// submission's link) can read the published text, and only through their own submission. Teacher-only fields never leave the teacher API.
// Its own collection, keyed by the submission: nothing is stored on Assignment or Submission, so no assignment or submission response can
// carry it. (The old assignment-wide Assignment.writingModel is kept untouched and is no longer served to anyone but its teacher, read-only.)
const publishedSchema = new Schema({
  text: { type: String, required: true },
  rule: { type: String, enum: ['manual', 'afterRevision'], required: true },
  at: { type: Date, required: true },
  by: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  transcriptHash: { type: String, default: null }
}, { _id: false });

const submissionWritingModelSchema = new Schema({
  submission: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
  assignment: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  teacher: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // The teacher's working text ("Save draft"): never shown to the student.
  draftText: { type: String, default: '' },
  source: { type: String, enum: ['teacher', 'ai'], default: 'teacher' },
  releaseRule: { type: String, enum: ['manual', 'afterRevision'], default: 'manual' },
  // Hash of the student's transcript the draft was written or generated against (the "writing changed" warning).
  basedOnTranscriptHash: { type: String, default: null },
  // What the student sees ("Submit"), or null: never changed except by the teacher submitting again.
  published: { type: publishedSchema, default: null },
  revision: { type: Number, default: 0 },
  updatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  requests: { type: [Schema.Types.Mixed], default: [] },       // last 20 { requestId, requestHash, revision }: idempotent replays
  generations: { type: [Schema.Types.Mixed], default: [] }     // last 50 { requestId, at, revision }: the per-submission daily AI cap
}, { timestamps: true, versionKey: false });

submissionWritingModelSchema.index({ submission: 1 }, { unique: true, name: 'submission_writing_model_unique_v1' });

module.exports = mongoose.model('SubmissionWritingModel', submissionWritingModelSchema);
