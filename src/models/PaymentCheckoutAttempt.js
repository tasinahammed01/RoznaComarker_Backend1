'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  attemptId: { type: String, required: true, trim: true },
  provider: { type: String, required: true, enum: ['paypal', 'stripe'], index: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  planKey: { type: String, required: true, trim: true },
  billingInterval: { type: String, required: true, enum: ['monthly', 'yearly'] },
  providerPlanId: { type: String, trim: true },
  providerSubscriptionId: { type: String, trim: true, unique: true, sparse: true },
  status: { type: String, enum: ['creating', 'approval_pending', 'active', 'cancelled', 'failed'], default: 'creating', index: true },
  approvalUrl: { type: String, trim: true },
  completedAt: Date,
  cancelledAt: Date,
  errorCode: { type: String, trim: true }
}, { timestamps: true });

schema.index({ provider: 1, attemptId: 1 }, { unique: true });
schema.index({ provider: 1, userId: 1, status: 1 });

module.exports = mongoose.model('PaymentCheckoutAttempt', schema);
