'use strict';
// Speaking Coach: one practice recording for one task. The audio itself is an AudioRecording with purpose 'practice' (submissionId null, so no
// graded reader sees it); its file is deleted once the transcript is stored. The check of the attempt runs in its own queue (lease fields
// below), never the graded speaking assessment. result.levelTitle and result.levelPercent are for the teacher only; the student and guest get
// passed/feedback without either (enforced in the student DTO, tested).
const mongoose = require('mongoose');

const { Schema } = mongoose;
const ATTEMPT_STATUSES = Object.freeze(['transcribing', 'assessing', 'ready', 'not_assessable', 'failed']);
const NOT_ASSESSABLE_REASONS = Object.freeze(['not_enough_speech', 'not_english', 'unintelligible', 'off_topic', 'too_long']);
const line = { type: String, trim: true, maxlength: 240 };

const attemptSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'SpeakingPracticeSession', required: true },
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: function requiredStudent() { return !this.guestSubmissionId; } },
  guestSubmissionId: { type: Schema.Types.ObjectId, ref: 'Submission' },
  taskId: { type: String, required: true, trim: true, maxlength: 40 },
  attemptNumber: { type: Number, required: true, min: 1 },
  requestId: { type: String, required: true, trim: true, maxlength: 80 },
  recordingId: { type: Schema.Types.ObjectId, ref: 'AudioRecording', default: null },
  status: { type: String, enum: ATTEMPT_STATUSES, required: true },
  notAssessableReason: { type: String, enum: [null, ...NOT_ASSESSABLE_REASONS], default: null },
  errorCode: { type: String, trim: true, maxlength: 64, default: null },
  wordCount: { type: Number, min: 0, default: null },
  fluency: { type: Schema.Types.Mixed, default: null },
  result: {
    levelTitle: { type: String, trim: true, maxlength: 120 },
    levelPercent: { type: Number },
    passed: { type: Boolean },
    onTask: { type: Boolean },
    vocab: { used: { type: [String], default: undefined }, missing: { type: [String], default: undefined } },
    fluencyChange: { type: Schema.Types.Mixed, default: undefined },
    feedback: { improved: { type: [line], default: undefined }, stillWeak: { type: [line], default: undefined }, nextTip: line }
  },
  readyAt: { type: Date, default: null },
  // The check's queue and lease (as the graded speaking assessment keeps on AudioRecording). Never serialised.
  assessmentQueue: { type: Boolean, default: undefined, select: false },
  assessmentAttempts: { type: Number, min: 0, default: 0 },
  assessmentNextAttemptAt: { type: Date, default: null },
  assessmentLeaseUntil: { type: Date, default: null, select: false },
  assessmentAttemptKey: { type: String, default: undefined, select: false },
  // Server only: provider, model, prompt version, timing and token usage of the check.
  assessing: { type: Schema.Types.Mixed, default: undefined, select: false }
}, { timestamps: true, versionKey: false });

attemptSchema.index({ sessionId: 1, attemptNumber: 1 }, { unique: true, name: 'speaking_practice_attempt_number_v1' });
attemptSchema.index({ sessionId: 1, requestId: 1 }, { unique: true, name: 'speaking_practice_attempt_request_v1' });
attemptSchema.index({ assessmentQueue: 1, assessmentNextAttemptAt: 1, assessmentLeaseUntil: 1 },
  { name: 'speaking_practice_attempt_queue_v1', partialFilterExpression: { assessmentQueue: true } });
attemptSchema.index({ recordingId: 1 }, { name: 'speaking_practice_attempt_recording_v1' });

attemptSchema.set('toJSON', { transform(_doc, ret) {
  for (const key of ['assessmentQueue', 'assessmentLeaseUntil', 'assessmentAttemptKey', 'assessing']) delete ret[key];
  return ret;
} });

module.exports = mongoose.model('SpeakingPracticeAttempt', attemptSchema);
module.exports.ATTEMPT_STATUSES = ATTEMPT_STATUSES;
module.exports.NOT_ASSESSABLE_REASONS = NOT_ASSESSABLE_REASONS;
