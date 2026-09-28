'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  planId: { type: mongoose.Schema.Types.ObjectId, ref: 'Plan', required: true },
  planSlug: { type: String, required: true, trim: true, lowercase: true },
  billingPeriod: { type: String, required: true, enum: ['monthly', 'annual', 'custom'] },
  status: { type: String, required: true, enum: ['active', 'scheduled', 'expired', 'revoked', 'refunded'], index: true },
  source: { type: String, required: true, enum: ['paypal', 'admin'], index: true },
  startsAt: { type: Date, required: true },
  endsAt: { type: Date, default: null },
  autoRenew: { type: Boolean, required: true, default: false },
  paymentProvider: { type: String, enum: ['paypal'], default: undefined },
  paymentAttemptId: { type: mongoose.Schema.Types.ObjectId, ref: 'PaymentPurchaseAttempt' },
  providerOrderId: { type: String, trim: true },
  providerCaptureId: { type: String, trim: true },
  activatedAt: Date,
  expiredAt: Date,
  revokedAt: Date,
  refundEventId: { type: String, trim: true },
  adminReason: { type: String, trim: true, maxlength: 500 },
  assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true, versionKey: false });

schema.index({ providerCaptureId: 1 }, { unique: true,
  partialFilterExpression: { providerCaptureId: { $type: 'string' } } });
schema.index({ userId: 1, status: 1 }, { unique: true,
  partialFilterExpression: { status: 'active' } });
schema.index({ userId: 1, status: 1, startsAt: 1, endsAt: 1 });
schema.index({ status: 1, endsAt: 1 });

module.exports = mongoose.model('PlanEntitlement', schema);
