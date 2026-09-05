const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  singletonKey: { type: String, enum: ['global'], default: 'global', unique: true },
  referral: { type: mongoose.Schema.Types.Mixed, default: undefined },
  bonusRewards: { type: mongoose.Schema.Types.Mixed, default: undefined },
  milestones: { type: mongoose.Schema.Types.Mixed, default: undefined },
  weeklySummary: { type: mongoose.Schema.Types.Mixed, default: undefined },
  creditNudges: { type: mongoose.Schema.Types.Mixed, default: undefined },
  institution: { type: mongoose.Schema.Types.Mixed, default: undefined },
  version: { type: Number, default: 1, min: 1 },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true, versionKey: false });
module.exports = mongoose.model('RetentionSettings', schema);
