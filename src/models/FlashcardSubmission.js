const mongoose = require('mongoose');

const { Schema } = mongoose;

const studyResultSchema = new Schema(
  {
    cardId: { type: Schema.Types.ObjectId },
    status: { type: String, enum: ['know', 'learning'] }
  },
  { _id: false }
);

const cardResultSchema = new Schema(
  {
    cardId: { type: Schema.Types.ObjectId },
    known: { type: Boolean },
    studentAnswer: { type: String, default: null },
    isCorrect: { type: Boolean, default: null }
  },
  { _id: false }
);

const flashcardSubmissionSchema = new Schema(
  {
    flashcardSetId: { type: Schema.Types.ObjectId, ref: 'FlashcardSet', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    /** GAP 3 / PART 1 — links submission to a class Assignment record (null for teacher self-study) */
    assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
    results: [studyResultSchema],
    template: { type: String, enum: ['term-def', 'qa', 'concept'], default: 'term-def' },
    totalCards: { type: Number },
    cardResults: [cardResultSchema],
    score: { type: Number },
    timeTaken: { type: Number },
    submittedAt: { type: Date, default: Date.now }
  }
);

/** Original unique guard: one teacher study submission per set per user */
flashcardSubmissionSchema.index({ flashcardSetId: 1, userId: 1 }, { unique: true, partialFilterExpression: { assignmentId: null } });
/** Sparse guard: one submission per assignment per student */
flashcardSubmissionSchema.index({ assignmentId: 1, userId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('FlashcardSubmission', flashcardSubmissionSchema);
