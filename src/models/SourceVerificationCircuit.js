'use strict';
const mongoose = require('mongoose');
module.exports = mongoose.model('SourceVerificationCircuit', new mongoose.Schema({
  _id: String, failures: { type: Number, default: 0 }, openUntil: Date,
  probeOwner: String, probeUntil: Date, blocked: Boolean
}, { timestamps: true }));
