'use strict';

const mongoose = require('mongoose');

const referralSchema = new mongoose.Schema({
  referrerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  referredUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
  codeUsed: { type: String, trim: true, uppercase: true },
  status: { type: String, enum: ['ATTRIBUTED', 'QUALIFIED', 'REWARDED', 'REJECTED', 'REVIEW_REQUIRED'],
    default: 'ATTRIBUTED', required: true, index: true },
  attributedAt: { type: Date, required: true, default: Date.now },
  qualifiedAt: { type: Date },
  rewardedAt: { type: Date },
  qualificationType: { type: String, trim: true },
  qualificationId: { type: String, trim: true },
  fraudStatus: { type: String, enum: ['CLEAR', 'REVIEW_REQUIRED'], default: 'CLEAR', required: true },
  reviewReason: { type: String, trim: true, maxlength: 120 },
  referrerRewardStatus: { type: String, enum: ['PENDING', 'PROCESSING', 'REWARDED', 'CAPPED'],
    default: 'PENDING', required: true, index: true },
  referredRewardStatus: { type: String, enum: ['PENDING', 'PROCESSING', 'REWARDED'],
    default: 'PENDING', required: true, index: true },
  referrerRewardSlot: { type: Number, min: 1 },
  referrerRewardCredits: { type: Number, min: 0 },
  referredRewardCredits: { type: Number, min: 0 }
}, { timestamps: true, versionKey: false });

referralSchema.index({ referrerUserId: 1, status: 1, createdAt: -1 });
referralSchema.index({ referrerUserId: 1, referrerRewardStatus: 1 });
referralSchema.index({ status: 1, referredRewardStatus: 1, referrerRewardStatus: 1 });
referralSchema.index({ referrerUserId: 1, referrerRewardSlot: 1 }, {
  unique: true,
  partialFilterExpression: { referrerRewardSlot: { $type: 'number' } }
});

module.exports = mongoose.model('Referral', referralSchema);
