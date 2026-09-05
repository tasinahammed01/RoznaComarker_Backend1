const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, trim: true, lowercase: true, unique: true, sparse: true },
  status: { type: String, enum: ['ACTIVE', 'PAST_DUE', 'SUSPENDED', 'CANCELED'], default: 'ACTIVE', index: true },
  ownerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  seatLimit: { type: Number, min: 1, default: undefined },
  activeSeatCount: { type: Number, min: 0, default: 1 },
  allowPersonalFallback: { type: Boolean, default: false },
  plan: {
    provider: { type: String, enum: ['MANUAL', 'STRIPE', 'PAYPAL'], default: 'MANUAL' },
    providerCustomerId: { type: String, trim: true }, providerSubscriptionId: { type: String, trim: true },
    planKey: { type: String, trim: true }, status: { type: String, trim: true },
    billingCycleStart: Date, billingCycleEnd: Date
  }
}, { timestamps: true });

module.exports = mongoose.model('Institution', schema);
