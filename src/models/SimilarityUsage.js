'use strict';
// Similarity caps per UTC day: 'teacher:<id>' counts checks, 'global' sums the estimated provider spend. Reserved atomically before work
// starts and given back when a check fails before the provider could charge (services/similarity/usage.js).
const mongoose = require('mongoose');
const { Schema } = mongoose;

const usageSchema = new Schema({
  scope: { type: String, required: true, maxlength: 64 },
  day: { type: String, required: true, maxlength: 10 },     // YYYY-MM-DD, UTC
  checks: { type: Number, min: 0, default: 0 },
  spendUsd: { type: Number, min: 0, default: 0 }
}, { timestamps: true });

usageSchema.index({ scope: 1, day: 1 }, { name: 'similarity_usage_scope_day_v1', unique: true });

module.exports = mongoose.models.SimilarityUsage || mongoose.model('SimilarityUsage', usageSchema);
