'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  targetClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', default: null },
  requestId: { type: String, required: true, trim: true },
  status: { type: String, enum: ['processing', 'completed', 'failed'], required: true },
  selectedAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }],
  completedAssignmentIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' }],
  errorCode: { type: String, default: null }, completedAt: { type: Date, default: null }
}, { timestamps: true });
schema.index({ teacherId: 1, requestId: 1 }, { unique: true });
module.exports = mongoose.model('SemesterCopyOperation', schema);
