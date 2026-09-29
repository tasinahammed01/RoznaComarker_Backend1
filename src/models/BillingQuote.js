'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  kind: { type: String, enum: ['purchase', 'admin'], required: true },
  snapshot: { type: mongoose.Schema.Types.Mixed, required: true },
  expiresAt: { type: Date, required: true }
}, { timestamps: true });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.model('BillingQuote', schema);
