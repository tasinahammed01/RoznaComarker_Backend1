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

const WorksheetSubmissionSchema = new Schema({
  worksheetId: { type: Schema.Types.ObjectId, ref: 'Worksheet', required: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  answers: [AnswerSchema],
  totalPointsEarned: { type: Number, default: 0 },
  totalPointsPossible: { type: Number, default: 0 },
  percentage: { type: Number, default: 0 },
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
