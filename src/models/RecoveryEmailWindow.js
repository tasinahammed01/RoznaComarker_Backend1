'use strict';
const mongoose = require('mongoose');

// Atomic per-address limits for recovery emails (all recovery endpoints share them). No plain email address is stored here.
//   "<sha256(address)>:<clock hour>"  hourly counter, incremented in one atomic update before any link is created
//   "<sha256(address)>:cooldown"      the time before which no further email is sent (claimed atomically)
// Removed automatically after use.
const recoveryEmailWindowSchema = new mongoose.Schema({
  _id: { type: String },
  count: { type: Number, default: 0 },
  until: { type: Date },
  expiresAt: { type: Date, required: true },
}, { versionKey: false });

recoveryEmailWindowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'recovery_email_window_purge_v1' });

module.exports = mongoose.models.RecoveryEmailWindow || mongoose.model('RecoveryEmailWindow', recoveryEmailWindowSchema);
