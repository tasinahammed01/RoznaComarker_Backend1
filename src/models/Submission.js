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
    // Legacy single-file fields (kept for backward compatibility)
    file: {
      type: Schema.Types.ObjectId,
      ref: 'File',
      required: false
    },
    fileUrl: {
      type: String,
      required: false,
      trim: true
    },

    // New multi-file fields
    files: [
      {
        type: Schema.Types.ObjectId,
        ref: 'File',
        required: false
      }
    ],
    fileUrls: [
      {
        type: String,
        trim: true
      }
    ],
    ocrPages: [
      {
        fileId: { type: Schema.Types.ObjectId, ref: 'File', required: false },
        pageNumber: { type: Number, required: false },
        text: { type: String, trim: true },
        words: { type: Schema.Types.Mixed, default: undefined }
      }
    ],
    combinedOcrText: {
      type: String,
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
    ocrStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: undefined,
      index: true
    },
    // Legacy OCR fields (single-file)
    ocrText: {
      type: String,
      trim: true
    },
    ocrError: {
      type: String,
      trim: true
    },
    ocrData: {
      type: Schema.Types.Mixed,
      default: undefined
    },
    ocrUpdatedAt: {
      type: Date
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
