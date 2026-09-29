'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
  revision: { type: Number, default: 0 },
  pendingAttempt: { type: String, default: null }
}, { timestamps: true });
module.exports = mongoose.model('BillingAccount', schema);
