const mongoose = require('mongoose');

const creditWalletSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  monthlyCredits: { type: Number, min: 0, required: true, default: 0 },
  monthlyCreditsUsed: { type: Number, min: 0, required: true, default: 0 },
  purchasedCredits: { type: Number, min: 0, required: true, default: 0 },
  bonusCredits: { type: Number, min: 0, required: true, default: 0 },
  billingCycleStart: { type: Date, required: true },
  billingCycleEnd: { type: Date, required: true },
  lastCreditReset: { type: Date, required: true },
  nudgeCycleStart: { type: Date, default: null },
  nudge80AcknowledgedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('CreditWallet', creditWalletSchema);
