const mongoose = require('mongoose');

const { Schema } = mongoose;

const uploadSchema = new Schema(
  {
    assignmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true,
      index: true
    },
    studentId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    submissionId: {
      type: Schema.Types.ObjectId,
      ref: 'Submission',
      index: true
    },
    uploadedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    originalFilePath: {
      type: String,
      trim: true
    },
    processedFilePath: {
      type: String,
      trim: true
    },
    originalFilename: {
      type: String,
      trim: true,
      index: true
    },
    processedFilename: {
      type: String,
      trim: true,
      index: true
    },
    transcriptText: {
      type: String
    }
  },
  {
    timestamps: true,
    versionKey: false
  }
);

uploadSchema.index({ assignmentId: 1, studentId: 1, submissionId: 1, createdAt: -1 });

module.exports = mongoose.model('Upload', uploadSchema);
