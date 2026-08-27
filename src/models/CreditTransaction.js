const mongoose = require('mongoose');

const TYPES = ['ASSESSMENT_DEBIT', 'BONUS_CREDIT', 'ADMIN_CREDIT', 'ADMIN_DEBIT', 'MONTHLY_RESET', 'PLAN_ALLOWANCE_CHANGE',
  'TOPUP_PURCHASE_PENDING', 'TOPUP_PURCHASE_COMPLETED', 'TOPUP_PURCHASE_FAILED', 'TOPUP_REFUND', 'TOPUP_ADMIN_ADJUSTMENT'];
const creditTransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: TYPES, required: true, index: true },
  amount: { type: Number, required: true },
  status: { type: String, enum: ['pending', 'committed', 'failed', 'refunded', 'review_required'], default: 'committed', index: true },
  balanceAfter: { type: Number, min: 0, required: true, default: 0 },
  reason: { type: String, required: true, trim: true, maxlength: 500 },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission' },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment' },
  assessmentId: { type: String, trim: true },
  referralId: { type: mongoose.Schema.Types.ObjectId },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
  idempotencyKey: { type: String, required: true, trim: true, unique: true, index: true }
}, { timestamps: true, versionKey: false });

module.exports = mongoose.model('CreditTransaction', creditTransactionSchema);
