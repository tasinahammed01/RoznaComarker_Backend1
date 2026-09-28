'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  owner: { type: String, required: true },
  leaseExpiresAt: { type: Date, required: true }
}, { timestamps: true, versionKey: false });
module.exports = mongoose.model('PlanEntitlementLock', schema);
