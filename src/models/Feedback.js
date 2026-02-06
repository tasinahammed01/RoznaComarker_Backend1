const mongoose = require('mongoose');

const { Schema } = mongoose;

const annotationSchema = new Schema(
  {
    page: {
      type: Number,
      required: true
    },
    comment: {
      type: String,
      required: true,
      trim: true
    },
    x: {
      type: Number,
      required: true
    },
    y: {
      type: Number,
      required: true
    }
  },
  {
    _id: false
  }
);

const overriddenScoresSchema = new Schema(
  {
    grammarScore: { type: Number, default: undefined },
    structureScore: { type: Number, default: undefined },
    contentScore: { type: Number, default: undefined },
    vocabularyScore: { type: Number, default: undefined },
    taskAchievementScore: { type: Number, default: undefined },
    overallScore: { type: Number, default: undefined }
  },
  {
    _id: false
  }
);

const feedbackSchema = new Schema(
  {
    teacher: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true
    },
    assignment: {
      type: Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true,
      index: true
    },
    submission: {
      type: Schema.Types.ObjectId,
      ref: 'Submission',
      required: true,
      unique: true,
      index: true
    },
    textFeedback: {
      type: String,
      trim: true
    },
    score: {
      type: Number
    },
    maxScore: {
      type: Number
    },
    teacherComments: {
      type: String,
      trim: true
    },
    overriddenScores: {
      type: overriddenScoresSchema,
      default: undefined
    },
    overrideReason: {
      type: String,
      trim: true
    },
    overriddenBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: undefined
    },
    overriddenAt: {
      type: Date,
      default: undefined
    },
    annotations: {
      type: [annotationSchema],
      default: undefined
    },
    file: {
      type: Schema.Types.ObjectId,
      ref: 'File'
    },
    fileUrl: {
      type: String,
      trim: true
    },
    aiFeedback: {
      type: Schema.Types.Mixed,
      default: undefined
    },
    aiGeneratedAt: {
      type: Date,
      default: undefined
    }
  },
  {
    timestamps: true
  }
);

feedbackSchema.index({ student: 1 });
feedbackSchema.index({ assignment: 1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
