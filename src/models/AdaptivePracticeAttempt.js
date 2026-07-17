'use strict';

const mongoose = require('mongoose');
const { Schema } = mongoose;

const checklistResultSchema = new Schema({
  item: { type: String, required: true, trim: true },
  met: { type: Boolean, required: true },
  feedback: { type: String, required: true, trim: true }
}, { _id: false });

const adaptivePracticeAttemptSchema = new Schema({
  sessionId: { type: Schema.Types.ObjectId, ref: 'AdaptivePracticeSession', required: true, index: true },
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  activityId: { type: String, required: true, trim: true },
  attemptNumber: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['checking', 'ready', 'failed'], required: true, index: true },
  response: { type: String, required: true },
  responseFingerprint: { type: String, required: true },
  result: {
    score: { type: Number, min: 0, max: 100 },
    passed: Boolean,
    summary: { type: String, trim: true },
    strength: { type: String, trim: true },
    nextImprovement: { type: String, trim: true },
    checklist: { type: [checklistResultSchema], default: undefined },
    suggestedRevision: { type: String, trim: true },
    scoring: {
      taskFulfillment: { type: Number, min: 0, max: 30 },
      targetSkillApplication: { type: Number, min: 0, max: 50 },
      checklistCompletion: { type: Number, min: 0, max: 20 }
    }
  },
  checking: {
    provider: { type: String, trim: true }, model: { type: String, trim: true },
    promptVersion: { type: String, trim: true }, startedAt: Date, completedAt: Date,
    errorCode: { type: String, trim: true }, errorMessage: { type: String, trim: true }
  }
}, { timestamps: true });

adaptivePracticeAttemptSchema.index(
  { sessionId: 1, activityId: 1, studentId: 1, responseFingerprint: 1 },
  { unique: true, name: 'unique_adaptive_response' }
);
adaptivePracticeAttemptSchema.index(
  { sessionId: 1, activityId: 1, studentId: 1, attemptNumber: 1 },
  { unique: true, name: 'unique_adaptive_attempt_number' }
);

module.exports = mongoose.model('AdaptivePracticeAttempt', adaptivePracticeAttemptSchema);
