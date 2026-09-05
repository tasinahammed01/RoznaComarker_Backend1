'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ['paypal', 'stripe'] },
  providerEventId: { type: String, required: true, trim: true },
  eventType: { type: String, required: true, trim: true },
  resourceId: { type: String, trim: true },
  status: { type: String, enum: ['processing', 'processed', 'review_required', 'failed'], default: 'processing' },
  receivedAt: { type: Date, default: Date.now },
  processedAt: Date,
  processingStartedAt: Date,
  processingLeaseExpiresAt: Date,
  processingAttemptCount: { type: Number, default: 0, min: 0 },
  errorCode: { type: String, trim: true }
}, { timestamps: true });

schema.index({ provider: 1, providerEventId: 1 }, { unique: true });

module.exports = mongoose.model('PaymentProviderEvent', schema);
