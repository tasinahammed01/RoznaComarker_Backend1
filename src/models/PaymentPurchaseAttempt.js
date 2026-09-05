'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ['paypal', 'stripe'] },
  attemptId: { type: String, required: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  purchaseType: { type: String, required: true, enum: ['assessment_credits'], default: 'assessment_credits' },
  packCode: { type: String, required: true, trim: true, uppercase: true },
  credits: { type: Number, required: true, min: 1 },
  expectedAmount: { type: String, required: true, trim: true },
  currency: { type: String, required: true, trim: true, uppercase: true },
  providerOrderId: { type: String, trim: true },
  providerCaptureId: { type: String, trim: true },
  createRequestId: { type: String, required: true, trim: true },
  captureRequestId: { type: String, required: true, trim: true },
  status: { type: String, required: true, enum: ['creating', 'approval_pending', 'capturing', 'captured', 'credited',
    'failed', 'cancelled', 'refunded', 'review_required'], default: 'creating', index: true },
  approvalUrl: { type: String, trim: true },
  failureClass: { type: String, enum: ['retryable', 'permanent'], default: undefined },
  failureCode: { type: String, trim: true },
  safeFailureMessage: { type: String, trim: true },
  retryCount: { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: Date.now },
  processingLeaseExpiresAt: Date,
  capturedAt: Date,
  creditedAt: Date,
  refundedAt: Date,
  creditTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction' }
}, { timestamps: true });

schema.index({ provider: 1, attemptId: 1 }, { unique: true });
schema.index({ provider: 1, providerOrderId: 1 }, { unique: true,
  partialFilterExpression: { providerOrderId: { $type: 'string' } } });
schema.index({ provider: 1, providerCaptureId: 1 }, { unique: true,
  partialFilterExpression: { providerCaptureId: { $type: 'string' } } });

module.exports = mongoose.model('PaymentPurchaseAttempt', schema);
