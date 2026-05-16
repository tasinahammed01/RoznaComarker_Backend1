const mongoose = require('mongoose');

const { Schema } = mongoose;

const AnswerSchema = new Schema({
  questionId: { type: String, required: true },
  sectionId: { type: String, required: true },
  studentAnswer: { type: String, default: '' },
  isCorrect: { type: Boolean, default: false },
  pointsEarned: { type: Number, default: 0 },
  aiGradingFeedback: { type: String, default: '' },
}, { _id: false });

const PerQuestionResultSchema = new Schema({
  questionId: { type: String, required: true },
  slotId: { type: String },
  isCorrect: { type: Boolean, default: false },
  studentAnswer: { type: Schema.Types.Mixed },
  correctAnswer: { type: Schema.Types.Mixed },
}, { _id: false });

const SectionSchema = new Schema({
  sectionId: { type: String, required: true },
  sectionName: { type: String, default: '' },
  activityType: { type: String, default: '' },
  earnedPoints: { type: Number, default: 0 },
  totalPoints: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  correctCount: { type: Number, default: 0 },
  incorrectCount: { type: Number, default: 0 },
  skippedCount: { type: Number, default: 0 },
  perQuestionResults: [PerQuestionResultSchema],
}, { _id: false });

const WorksheetSubmissionSchema = new Schema({
  worksheetId: { type: Schema.Types.ObjectId, ref: 'Worksheet', required: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  answers: [AnswerSchema],
  // Legacy fields (kept for backward compatibility)
  totalPointsEarned: { type: Number, default: 0 },
  totalPointsPossible: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
  // New root-level fields (single source of truth)
  earnedPoints: { type: Number, default: 0 },
  totalPoints: { type: Number, default: 0 },
  score: { type: Number, default: 0 },
  isPassed: { type: Boolean, default: false },
  // Per-section analytics array
  sections: [SectionSchema],
  timeTaken: { type: Number, default: 0 },
  status: { type: String, enum: ['submitted', 'late'], default: 'submitted' },
  isLate: { type: Boolean, default: false },
  attempts: { type: Number, default: 1 },
  lastAttemptAt: { type: Date, default: Date.now },
  submittedAt: { type: Date, default: Date.now },
  gradingStatus: {
    type: String,
    enum: ['auto-graded', 'pending-review'],
    default: 'auto-graded'
  },
}, { timestamps: true });

WorksheetSubmissionSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });
WorksheetSubmissionSchema.index({ worksheetId: 1, submittedAt: -1 });
WorksheetSubmissionSchema.index({ studentId: 1, submittedAt: -1 });
WorksheetSubmissionSchema.index({ assignmentId: 1, submittedAt: -1 });
WorksheetSubmissionSchema.index({ createdAt: -1 });

module.exports = mongoose.model('WorksheetSubmission', WorksheetSubmissionSchema);
