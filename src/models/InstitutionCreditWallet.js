const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, unique: true },
  monthlyCredits: { type: Number, min: 0, required: true }, monthlyCreditsUsed: { type: Number, min: 0, default: 0 },
  cycleStart: { type: Date, required: true }, cycleEnd: { type: Date, required: true },
  cycleAnchorDay: { type: Number, min: 1, max: 31 },
  appliedDebitKeys: { type: [String], default: [], select: false }
}, { timestamps: true });
module.exports = mongoose.model('InstitutionCreditWallet', schema);
