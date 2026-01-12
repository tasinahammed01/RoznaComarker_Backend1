const mongoose = require('mongoose');

const { Schema } = mongoose;

const submissionSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    assignment: {
      type: Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true,
      index: true
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true
    },
    file: {
      type: Schema.Types.ObjectId,
      ref: 'File',
      required: true
    },
    fileUrl: {
      type: String,
      required: true,
      trim: true
    },
    status: {
      type: String,
      enum: ['submitted', 'late', 'missing'],
      required: true
    },
    submittedAt: {
      type: Date,
      required: true
    },
    isLate: {
      type: Boolean,
      required: true,
      default: false
    },
    qrToken: {
      type: String,
      trim: true
    },
    transcriptText: {
      type: String,
      trim: true
    },
    feedback: {
      type: Schema.Types.ObjectId,
      ref: 'Feedback'
    }
  },
  {
    timestamps: true
  }
);

submissionSchema.index({ student: 1, assignment: 1 }, { unique: true });
submissionSchema.index({ assignment: 1 });
submissionSchema.index({ class: 1 });
submissionSchema.index({ feedback: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
