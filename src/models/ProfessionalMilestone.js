'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  milestoneKey: { type: String, required: true }, metricType: { type: String, required: true, index: true },
  threshold: { type: Number, required: true, min: 1 }, sourceValue: { type: Number, required: true, min: 0 },
  status: { type: String, enum: ['ACHIEVED'], default: 'ACHIEVED', required: true }, achievedAt: { type: Date, default: Date.now, required: true },
  rewardStatus: { type: String, enum: ['PENDING', 'GRANTED', 'DISABLED', 'FAILED'], default: 'PENDING' },
  notificationStatus: { type: String, enum: ['PENDING', 'SENT'], default: 'PENDING' }
}, { timestamps: true, versionKey: false });
schema.index({ userId: 1, milestoneKey: 1 }, { unique: true });
schema.index({ userId: 1, achievedAt: -1 });
module.exports = mongoose.model('ProfessionalMilestone', schema);
