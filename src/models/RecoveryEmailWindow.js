'use strict';
const mongoose = require('mongoose');

// Atomic per-address email counter for recovery links: one document per (SHA-256 of the address, clock hour). The counter is
// incremented with a single atomic update before any link is created, so parallel requests can never send more than the limit.
// No plain email address is stored here. Removed automatically after the window.
const recoveryEmailWindowSchema = new mongoose.Schema({
  _id: { type: String },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

recoveryEmailWindowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'recovery_email_window_purge_v1' });

module.exports = mongoose.models.RecoveryEmailWindow || mongoose.model('RecoveryEmailWindow', recoveryEmailWindowSchema);
