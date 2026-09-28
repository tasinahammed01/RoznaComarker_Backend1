'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ['paypal', 'stripe'] },
  providerEnvironment: { type: String, enum: ['sandbox', 'live'] },
  attemptId: { type: String, required: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  // `purchaseType` is retained for old credit-purchase documents. `purpose` is
  // the authoritative discriminator for all new PayPal Orders attempts.
  purchaseType: { type: String, enum: ['assessment_credits'], default: 'assessment_credits' },
  purpose: { type: String, required: true, enum: ['credit_pack', 'plan_purchase'], default: 'credit_pack', index: true },
  fundingSource: { type: String, required: true, enum: ['paypal', 'card'], default: 'paypal' },
  packCode: { type: String, trim: true, uppercase: true },
  credits: { type: Number, min: 1 },
  planSlug: { type: String, trim: true, lowercase: true },
  billingPeriod: { type: String, enum: ['monthly', 'annual'] },
  expectedAmount: { type: String, required: true, trim: true },
  currency: { type: String, required: true, trim: true, uppercase: true },
  providerOrderId: { type: String, trim: true },
  providerCaptureId: { type: String, trim: true },
  createRequestId: { type: String, required: true, trim: true },
  captureRequestId: { type: String, required: true, trim: true },
  status: { type: String, required: true, enum: ['creating', 'approval_pending', 'capturing', 'captured', 'credited', 'fulfilled',
    'failed', 'cancelled', 'refunded', 'review_required'], default: 'creating', index: true },
  approvalUrl: { type: String, trim: true },
  failureClass: { type: String, enum: ['retryable', 'permanent'], default: undefined },
  failureCode: { type: String, trim: true },
  safeFailureMessage: { type: String, trim: true },
  providerDebugId: { type: String, trim: true, maxlength: 300 },
  retryCount: { type: Number, default: 0, min: 0 },
  lastAttemptAt: { type: Date, default: Date.now },
  processingLeaseExpiresAt: Date,
  capturedAt: Date,
  creditedAt: Date,
  refundedAt: Date,
  creditTransactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction' }
  , entitlementId: { type: mongoose.Schema.Types.ObjectId, ref: 'PlanEntitlement' }
}, { timestamps: true });

schema.index({ provider: 1, attemptId: 1 }, { unique: true });
schema.index({ provider: 1, providerOrderId: 1 }, { unique: true,
  partialFilterExpression: { providerOrderId: { $type: 'string' } } });
schema.index({ provider: 1, providerCaptureId: 1 }, { unique: true,
  partialFilterExpression: { providerCaptureId: { $type: 'string' } } });

module.exports = mongoose.model('PaymentPurchaseAttempt', schema);
