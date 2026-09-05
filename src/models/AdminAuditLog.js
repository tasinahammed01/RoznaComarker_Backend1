const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true }, targetType: { type: String, required: true }, targetId: String,
  changedFields: [String], before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed
}, { timestamps: true, versionKey: false });
schema.index({ createdAt: -1 });
module.exports = mongoose.model('AdminAuditLog', schema);
