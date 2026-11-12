'use strict';
// Per-teacher sliding window of feedback emails sent for teacher uploads (services/teacherUploadEmail.service.js). One small
// document per teacher; the times older than the window are dropped on every update. Only the default _id index.
const mongoose = require('mongoose');

module.exports = mongoose.model('TeacherEmailQuota', new mongoose.Schema({
  _id: { type: String },
  sent: { type: [Date], default: [] },
  accepted: { type: Boolean }
}, { versionKey: false }));
