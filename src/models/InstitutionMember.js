const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role: { type: String, enum: ['INSTITUTION_OWNER', 'INSTITUTION_ADMIN', 'TEACHER'], required: true },
  status: { type: String, enum: ['INVITED', 'ACTIVE', 'REMOVED'], default: 'ACTIVE' },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, joinedAt: Date, removedAt: Date,
  monthlyCreditLimit: { type: Number, min: 0, default: undefined },
  cycleKey: { type: String, trim: true }, cycleCreditsUsed: { type: Number, min: 0, default: 0 },
  appliedDebitKeys: { type: [String], default: [], select: false }
}, { timestamps: true });
schema.index({ institutionId: 1, userId: 1 }, { unique: true });
schema.index({ institutionId: 1, status: 1 });
schema.index({ userId: 1, status: 1 });
schema.index({ userId: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' } });
module.exports = mongoose.model('InstitutionMember', schema);
