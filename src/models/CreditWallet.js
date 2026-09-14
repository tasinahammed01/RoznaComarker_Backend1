const mongoose = require('mongoose');

const purchaseOperationSchema = new mongoose.Schema({
  idempotencyKey: { type: String, required: true },
  transactionId: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditTransaction', required: true },
  kind: { type: String, enum: ['grant', 'reversal'], required: true },
  credits: { type: Number, min: 1, required: true },
  state: { type: String, enum: ['claimed', 'applied'], required: true },
  startedAt: { type: Date, required: true }
}, { _id: false });

const usageNudgesSchema = new mongoose.Schema({
  cycleKey: { type: String, required: true },
  handledThresholds: [{ type: Number, enum: [50, 80, 100] }],
  updatedAt: { type: Date, required: true }
}, { _id: false });

const creditWalletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  creditMutationVersion: { type: Number, min: 0, default: 0 },
  monthlyCredits: { type: Number, min: 0, required: true, default: 0 },
  monthlyCreditsUsed: { type: Number, min: 0, required: true, default: 0 },
  purchasedCredits: { type: Number, min: 0, required: true, default: 0 },
  bonusCredits: { type: Number, min: 0, required: true, default: 0 },
  billingCycleStart: { type: Date, required: true },
  billingCycleEnd: { type: Date, required: true },
  lastCreditReset: { type: Date, required: true },
  nudgeCycleStart: { type: Date, default: null },
  nudge80AcknowledgedAt: { type: Date, default: null },
  usageNudges: { type: usageNudgesSchema, default: undefined },
  pendingPurchaseOperation: { type: purchaseOperationSchema, default: undefined, select: false },
  // Atomic wallet receipt: retained until the corresponding ledger entry is committed.
  pendingCreditOperation: { type: new mongoose.Schema({
    idempotencyKey: { type: String, required: true },
    balanceAfter: { type: Number, required: true },
    outcome: { type: String, enum: ['committed', 'failed'], default: 'committed' },
    failure: mongoose.Schema.Types.Mixed,
    creditBucket: String
  }, { _id: false }), default: undefined }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('CreditWallet', creditWalletSchema);
