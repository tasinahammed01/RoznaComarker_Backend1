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
    }
  },
  {
    timestamps: true
  }
);

feedbackSchema.index({ submission: 1 }, { unique: true });
feedbackSchema.index({ student: 1 });
feedbackSchema.index({ assignment: 1 });

module.exports = mongoose.model('Feedback', feedbackSchema);
