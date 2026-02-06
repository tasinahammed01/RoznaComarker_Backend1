const mongoose = require('mongoose');

const { Schema } = mongoose;

const ocrUploadSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
    originalName: {
      type: String,
      trim: true
    },
    ocrStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      required: true,
      default: 'pending',
      index: true
    },
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
    }
  },
  {
    timestamps: true
  }
);

ocrUploadSchema.index({ student: 1, createdAt: -1 });

module.exports = mongoose.model('OcrUpload', ocrUploadSchema);
