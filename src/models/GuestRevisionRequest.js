'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  _id: String,
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  contentHash: { type: String, required: true },
  status: { type: String, enum: ['pending', 'complete'], default: 'pending' },
  draftNumber: Number
}, { timestamps: true, versionKey: false });
module.exports = mongoose.model('GuestRevisionRequest', schema);
