'use strict';
const mongoose = require('mongoose');
// Private collection: deliberately absent from Submission and every API serializer.
// No public/guest endpoint. Explicit developer access must select the private payload.
const schema = new mongoose.Schema({
  _id: { type: String, required: true },
  evidenceKey: { type: String, required: true },
  submissionId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
  runId: { type: String, required: true },
  status: { type: String, required: true },
  payload: { type: mongoose.Schema.Types.Mixed, select: false },
  expiresAt: { type: Date, required: true, expires: 0 }
}, { timestamps: true, strict: 'throw', bufferCommands: false });
module.exports = mongoose.models.HybridOcrEvidence || mongoose.model('HybridOcrEvidence', schema);
