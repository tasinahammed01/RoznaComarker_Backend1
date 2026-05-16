const mongoose = require('mongoose');

const { Schema } = mongoose;

const worksheetDraftSchema = new Schema(
  {
    worksheetId: {
      type: Schema.Types.ObjectId,
      ref: 'Worksheet',
      required: true,
      index: true,
    },
    assignmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true,
      index: true,
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    answers: {
      type: [
        {
          questionId: { type: String, required: true },
          sectionId: { type: String, required: true },
          studentAnswer: { type: String, default: '' },
        },
      ],
      default: [],
    },
    activity1Answers: {
      type: Map,
      of: String,
      default: new Map(),
    },
    activity2Answers: {
      type: Map,
      of: String,
      default: new Map(),
    },
    activity2Revealed: {
      type: Map,
      of: Boolean,
      default: new Map(),
    },
    activity3Answers: {
      type: Map,
      of: String,
      default: new Map(),
    },
    activity4Blanks: {
      type: Map,
      of: String,
      default: new Map(),
    },
    progressPercentage: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    timeSpent: {
      type: Number,
      default: 0,
    },
    startedAt: {
      type: Date,
      default: Date.now,
    },
    lastSavedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  }
);

// Unique draft per student per assignment
worksheetDraftSchema.index({ assignmentId: 1, studentId: 1 }, { unique: true });
worksheetDraftSchema.index({ worksheetId: 1, studentId: 1 });
worksheetDraftSchema.index({ studentId: 1, lastSavedAt: -1 });

module.exports = mongoose.model('WorksheetDraft', worksheetDraftSchema);
