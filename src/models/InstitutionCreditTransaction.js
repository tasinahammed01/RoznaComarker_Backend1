const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  institutionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Institution', required: true },
  teacherUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', required: true },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
  assessmentId: { type: String, required: true }, cycleKey: { type: String, required: true },
  type: { type: String, enum: ['ASSESSMENT_DEBIT', 'MONTHLY_RESET'], required: true },
  status: { type: String, enum: ['pending', 'applying', 'committed', 'failed', 'rolled_back'], default: 'pending' },
  memberUsageApplied: { type: Boolean, default: false }, walletApplied: { type: Boolean, default: false },
  amount: { type: Number, required: true },
  balanceAfter: { type: Number, min: 0, default: 0 }, idempotencyKey: { type: String, required: true, unique: true },
  reason: { type: String, trim: true }
}, { timestamps: true });
schema.index({ institutionId: 1, cycleKey: 1, createdAt: -1 });
schema.index({ teacherUserId: 1, cycleKey: 1, createdAt: -1 });
module.exports = mongoose.model('InstitutionCreditTransaction', schema);
