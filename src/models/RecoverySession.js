'use strict';
const mongoose = require('mongoose');

// Short-lived, read-only portal session obtained by exchanging a recovery link. The link token is sent once; afterwards only this
// session travels (X-Recovery-Session header). Only its SHA-256 is stored. Revoking the link revokes its sessions too.
const recoverySessionSchema = new mongoose.Schema({
  tokenId: { type: mongoose.Schema.Types.ObjectId, ref: 'RecoveryToken', required: true },
  emailNormalized: { type: String, required: true, maxlength: 254 },
  sessionHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  revokedAt: { type: Date, default: null },
}, { timestamps: { createdAt: true, updatedAt: false }, versionKey: false });

recoverySessionSchema.index({ sessionHash: 1 }, { unique: true, name: 'recovery_session_hash_v1' });
recoverySessionSchema.index({ tokenId: 1 }, { name: 'recovery_session_token_v1' });
// Removed one hour after expiry.
recoverySessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600, name: 'recovery_session_purge_v1' });

module.exports = mongoose.models.RecoverySession || mongoose.model('RecoverySession', recoverySessionSchema);
