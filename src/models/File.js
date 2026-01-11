const mongoose = require('mongoose');

const fileSchema = new mongoose.Schema(
  {
    originalName: {
      type: String,
      required: [true, 'originalName is required'],
      trim: true
    },
    filename: {
      type: String,
      required: [true, 'filename is required'],
      trim: true
    },
    path: {
      type: String,
      required: [true, 'path is required'],
      trim: true
    },
    url: {
      type: String,
      required: [true, 'url is required'],
      trim: true
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'uploadedBy is required']
    },
    role: {
      type: String,
      enum: ['teacher', 'student'],
      required: [true, 'role is required']
    },
    type: {
      type: String,
      enum: ['assignments', 'submissions', 'feedback'],
      required: [true, 'type is required']
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  {
    versionKey: false
  }
);

fileSchema.index({ uploadedBy: 1, type: 1, createdAt: -1 });

const File = mongoose.model('File', fileSchema);

module.exports = File;
