const mongoose = require('mongoose');

const stripeEventSchema = new mongoose.Schema({
  stripeEventId: { type: String, required: true, unique: true, index: true },
  eventType: { type: String, required: true },
  processedAt: { type: Date, required: true, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('StripeEvent', stripeEventSchema);
