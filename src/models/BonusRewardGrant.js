'use strict';
const mongoose = require('mongoose');

const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  eventType: { type: String, required: true, index: true },
  eventKey: { type: String, required: true, trim: true },
  amount: { type: Number, required: true, min: 1 },
  status: { type: String, enum: ['PENDING', 'GRANTED', 'SKIPPED', 'FAILED', 'REVIEW_REQUIRED'], required: true, default: 'PENDING', index: true },
  creditStatus: { type: String, enum: ['PENDING', 'PROCESSING', 'GRANTED'], required: true, default: 'PENDING' },
  notificationStatus: { type: String, enum: ['PENDING', 'SENT'], required: true, default: 'PENDING' },
  sourceId: { type: String, trim: true },
  repeatPolicy: { type: String, required: true },
  qualifiedAt: { type: Date, required: true, default: Date.now },
  grantedAt: Date,
  failureReason: { type: String, maxlength: 500 },
  idempotencyKey: { type: String, required: true, unique: true, index: true }
}, { timestamps: true, versionKey: false });

schema.index({ userId: 1, eventType: 1, createdAt: -1 });
module.exports = mongoose.model('BonusRewardGrant', schema);
