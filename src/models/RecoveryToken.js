'use strict';
const mongoose = require('mongoose');

// A recovery link for the multi-assignment portal. Only the SHA-256 of the link token is stored; the raw token exists only in
// the email. More than one token per email may exist (a student can ask twice; a teacher may issue one later).
const recoveryTokenSchema = new mongoose.Schema({
  emailNormalized: { type: String, required: true, maxlength: 254 },
  tokenHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  lastUsedAt: { type: Date, default: null },
  usedCount: { type: Number, default: 0, min: 0 },
  revokedAt: { type: Date, default: null },
  // Who asked for the link: the student on the recovery page, or (later) a teacher on the student's behalf.
  source: { type: String, enum: ['student', 'teacher'], required: true },
  issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  // Kept a while after expiry so per-email throttling and audits still see it, then removed by the TTL index.
  purgeAt: { type: Date, required: true },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

recoveryTokenSchema.index({ tokenHash: 1 }, { unique: true, name: 'recovery_token_hash_v1' });
recoveryTokenSchema.index({ emailNormalized: 1, createdAt: -1 }, { name: 'recovery_token_email_v1' });
recoveryTokenSchema.index({ purgeAt: 1 }, { expireAfterSeconds: 0, name: 'recovery_token_purge_v1' });

module.exports = mongoose.models.RecoveryToken || mongoose.model('RecoveryToken', recoveryTokenSchema);
