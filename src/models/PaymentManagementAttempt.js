'use strict';

const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  provider: { type: String, required: true, enum: ['paypal', 'stripe'], index: true },
  attemptId: { type: String, required: true, trim: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  providerSubscriptionId: { type: String, required: true, trim: true, index: true },
  operation: { type: String, required: true, enum: ['CANCEL', 'CHANGE_PLAN'], index: true },
  sourcePlanKey: { type: String, trim: true },
  sourceProviderPlanId: { type: String, trim: true },
  targetPlanKey: { type: String, trim: true },
  targetProviderPlanId: { type: String, trim: true },
  status: {
    type: String,
    enum: ['processing', 'approval_pending', 'provider_pending', 'completed', 'cancelled', 'failed'],
    default: 'processing',
    index: true
  },
  approvalUrl: { type: String, trim: true },
  providerRequestId: { type: String, trim: true },
  activeOperationKey: { type: String, trim: true },
  failureClass: { type: String, enum: ['retryable', 'permanent'] },
  retryCount: { type: Number, default: 0, min: 0 },
  lastAttemptAt: Date,
  processingLeaseExpiresAt: Date,
  completedAt: Date,
  cancelledAt: Date,
  errorCode: { type: String, trim: true }
}, { timestamps: true });

schema.index({ provider: 1, attemptId: 1 }, { unique: true });
schema.index({ provider: 1, providerSubscriptionId: 1, operation: 1, status: 1 });
schema.index({ activeOperationKey: 1 }, {
  unique: true,
  partialFilterExpression: { activeOperationKey: { $type: 'string' } }
});

module.exports = mongoose.model('PaymentManagementAttempt', schema);
