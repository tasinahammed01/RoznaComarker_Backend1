'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  normalizedCode: { type: String, required: true, unique: true },
  active: { type: Boolean, default: true },
  discountType: { type: String, enum: ['PERCENT', 'FIXED'], required: true },
  // Percent in basis points, fixed discounts in currency minor units.
  discountValue: { type: Number, required: true, min: 1 },
  currency: { type: String, required: true },
  validFrom: { type: Date, default: null }, validUntil: { type: Date, default: null },
  plans: [String], billingPeriods: [String],
  totalLimit: { type: Number, default: null }, perUserLimit: { type: Number, default: null },
  allocated: { type: Number, default: 0 }, consumed: { type: Number, default: 0 },
  revision: { type: Number, default: 1 },
  createdBy: { type: mongoose.Schema.Types.ObjectId, required: true }
}, { timestamps: true });
module.exports = mongoose.model('PromoCode', schema);
