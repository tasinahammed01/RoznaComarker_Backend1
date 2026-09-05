const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true, index: true },
  actorUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  action: { type: String, required: true, trim: true }, targetUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });
schema.index({ institutionId: 1, createdAt: -1 });
module.exports = mongoose.model('InstitutionAuditLog', schema);
