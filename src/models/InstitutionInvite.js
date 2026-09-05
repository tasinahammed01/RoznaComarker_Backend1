const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  emailNormalized: { type: String, required: true, lowercase: true, trim: true },
  role: { type: String, enum: ['INSTITUTION_ADMIN', 'TEACHER'], default: 'TEACHER' },
  tokenHash: { type: String, required: true, unique: true, select: false },
  expiresAt: { type: Date, required: true },
  status: { type: String, enum: ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'], default: 'PENDING' },
  invitedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }, acceptedAt: Date
}, { timestamps: true });
schema.index({ institutionId: 1, status: 1, emailNormalized: 1 });
module.exports = mongoose.model('InstitutionInvite', schema);
