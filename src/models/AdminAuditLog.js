const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  adminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  action: { type: String, required: true }, targetType: { type: String, required: true }, targetId: String,
  changedFields: [String], before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed,
  idempotencyKey: { type: String, trim: true }, reason: { type: String, trim: true }, note: { type: String, trim: true },
  amount: Number, previousBalance: Number, newBalance: Number, operationType: String, status: String
}, { timestamps: true, versionKey: false });
schema.index({ createdAt: -1 });
schema.index({ action: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
module.exports = mongoose.model('AdminAuditLog', schema);
