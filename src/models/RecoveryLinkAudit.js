'use strict';
const mongoose = require('mongoose');

// Audit trail of teacher-sent recovery links: who, when, which submission, the masked address and the outcome. Never the token,
// the link or the full email address.
const recoveryLinkAuditSchema = new mongoose.Schema({
  source: { type: String, enum: ['teacher'], required: true },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', default: null },
  emailMasked: { type: String, maxlength: 80, default: null },
  result: { type: String, enum: ['sent', 'throttled', 'failed', 'no_email', 'refused'], required: true },
  reason: { type: String, maxlength: 40, default: null },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

recoveryLinkAuditSchema.index({ submissionId: 1, createdAt: -1 }, { name: 'recovery_link_audit_submission_v1' });
recoveryLinkAuditSchema.index({ issuedBy: 1, createdAt: -1 }, { name: 'recovery_link_audit_teacher_v1' });

module.exports = mongoose.models.RecoveryLinkAudit || mongoose.model('RecoveryLinkAudit', recoveryLinkAuditSchema);
