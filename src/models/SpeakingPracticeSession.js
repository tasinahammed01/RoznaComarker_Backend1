'use strict';
// Speaking Coach (SPEAKING_COACH_ENABLED): one practice session per speaking submission, owner (student or guest) and assessed source. Kept in
// its own collection: it never touches the graded Submission, SubmissionFeedback, reports, dashboards or PDFs. The tasks are built from the
// stored assessment (the weakest rubric areas); the settings (pass percent, attempt cap) are copied in when the session starts and never change.
const mongoose = require('mongoose');

const { Schema } = mongoose;
const TASK_TYPES = Object.freeze(['repeat_improve', 'follow_up', 'fluency_drill', 'vocab_swap']);
const TASK_STATUSES = Object.freeze(['locked', 'active', 'passed']);
const SESSION_STATUSES = Object.freeze(['generating', 'ready', 'completed', 'capped', 'failed']);
const PASS_RULES = Object.freeze(['threshold', 'second_highest', 'top_only']);
const MAX_TASKS = 3;

const levelSchema = new Schema({ title: { type: String, required: true, trim: true, maxlength: 120 }, percent: { type: Number, required: true },
  description: { type: String, trim: true, maxlength: 600, default: '' } }, { _id: false });

const criterionSnapshotSchema = new Schema({
  criterionId: { type: String, required: true, trim: true, maxlength: 120 },
  title: { type: String, required: true, trim: true, maxlength: 200 },
  weight: { type: Number, default: null },
  levelTitle: { type: String, trim: true, maxlength: 120, default: '' },
  levelPercent: { type: Number, default: null },
  comment: { type: String, trim: true, maxlength: 600, default: '' },
  levels: { type: [levelSchema], default: [] }
}, { _id: false });

const taskSchema = new Schema({
  taskId: { type: String, required: true, trim: true, maxlength: 40 },
  order: { type: Number, required: true, min: 1, max: MAX_TASKS },
  type: { type: String, enum: TASK_TYPES, required: true },
  criterionId: { type: String, required: true, trim: true, maxlength: 120 },
  areaLabel: { type: String, required: true, trim: true, maxlength: 200 },
  prompt: { type: String, required: true, trim: true, maxlength: 400 },
  tip: { type: String, required: true, trim: true, maxlength: 300 },
  targets: { type: [{ type: String, trim: true, maxlength: 60 }], default: [] },
  maxSeconds: { type: Number, required: true, min: 15, max: 180 },
  status: { type: String, enum: TASK_STATUSES, required: true },
  attemptCount: { type: Number, min: 0, default: 0 },
  passedAt: { type: Date, default: null },
  passRule: { rule: { type: String, enum: PASS_RULES, required: true }, minimumPercent: { type: Number, required: true } }
}, { _id: false });

const sessionSchema = new Schema({
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: function requiredStudent() { return !this.guestSubmissionId; } },
  guestSubmissionId: { type: Schema.Types.ObjectId, ref: 'Submission' },
  status: { type: String, enum: SESSION_STATUSES, required: true },
  settings: {
    passPercent: { type: Number, required: true, min: 50, max: 100, immutable: true },
    attemptCap: { type: Number, required: true, min: 1, max: 50, immutable: true }
  },
  sourceFingerprint: { type: String, required: true, match: /^[a-f0-9]{64}$/ },
  sourceSnapshot: {
    feedbackId: { type: Schema.Types.ObjectId, ref: 'SubmissionFeedback', default: null },
    feedbackUpdatedAt: { type: Date, default: null },
    criteria: { type: [criterionSnapshotSchema], default: [] },
    fluency: { type: Schema.Types.Mixed, default: null }
  },
  tasks: { type: [taskSchema], default: [], validate: {
    validator(value) {
      if (this.status === 'generating' || this.status === 'failed') return value.length <= MAX_TASKS;
      return value.length >= 1 && value.length <= MAX_TASKS && new Set(value.map(t => t.taskId)).size === value.length;
    },
    message: 'A practice session holds one to three tasks with unique ids.'
  } },
  currentTaskId: { type: String, trim: true, maxlength: 40, default: null },
  attemptsUsed: { type: Number, min: 0, default: 0 },
  completedAt: { type: Date, default: undefined },
  endedAt: { type: Date, default: null },
  endedReason: { type: String, enum: [null, 'completed', 'capped'], default: null },
  // The attempt being transcribed or checked (one at a time per session): set atomically with the attempt count, cleared when it ends.
  activeAttemptId: { type: Schema.Types.ObjectId, ref: 'SpeakingPracticeAttempt', default: null },
  // Server only: never sent to a student or guest.
  generation: {
    source: { type: String, enum: ['ai', 'template'], default: undefined },
    provider: { type: String, trim: true }, model: { type: String, trim: true }, promptVersion: { type: String, trim: true },
    startedAt: Date, completedAt: Date, errorCode: { type: String, trim: true, maxlength: 64 },
    metrics: { type: Schema.Types.Mixed, default: undefined }
  },
  revision: { type: Number, min: 0, default: 0 }
}, { timestamps: true, versionKey: false });

sessionSchema.index({ submissionId: 1, studentId: 1, sourceFingerprint: 1 },
  { unique: true, name: 'speaking_practice_session_student_v1', partialFilterExpression: { studentId: { $exists: true } } });
sessionSchema.index({ submissionId: 1, guestSubmissionId: 1, sourceFingerprint: 1 },
  { unique: true, name: 'speaking_practice_session_guest_v1', partialFilterExpression: { guestSubmissionId: { $exists: true } } });
sessionSchema.index({ assignmentId: 1, completedAt: 1 }, { name: 'speaking_practice_session_assignment_v1' });

sessionSchema.set('toJSON', { transform(_doc, ret) { delete ret.generation; return ret; } });

module.exports = mongoose.model('SpeakingPracticeSession', sessionSchema);
module.exports.TASK_TYPES = TASK_TYPES;
module.exports.SESSION_STATUSES = SESSION_STATUSES;
module.exports.MAX_TASKS = MAX_TASKS;
