'use strict';
const mongoose = require('mongoose');
const { Schema } = mongoose;

const schema = new Schema({
  flashcardSetId: { type: Schema.Types.ObjectId, ref: 'FlashcardSet', required: true },
  cardId: { type: Schema.Types.ObjectId, required: true },
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
  studentAnswer: { type: String, required: true },
  correctAnswer: { type: String, required: true },
  isCorrect: { type: Boolean, required: true },
  gradingMethod: { type: String, enum: ['exact', 'normalized', 'semantic_ai'], required: true },
  confidence: { type: Number, default: null },
  explanation: { type: String, default: '' },
  checkedAt: { type: Date, default: Date.now }
}, { timestamps: true });
schema.index({ flashcardSetId: 1, cardId: 1, userId: 1, assignmentId: 1 }, { unique: true });
module.exports = mongoose.model('FlashcardAnswerCheck', schema);
