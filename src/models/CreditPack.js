const mongoose = require('mongoose');

const creditPackSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  code: { type: String, required: true, trim: true, uppercase: true, unique: true, index: true },
  credits: { type: Number, required: true, min: 1 },
  price: { type: Number, required: true, min: 0 },
  currency: { type: String, required: true, trim: true, uppercase: true, default: 'USD' },
  stripePriceId: { type: String, trim: true, default: null },
  allowedPlans: [{ type: String, trim: true }],
  active: { type: Boolean, default: true, index: true },
  displayOrder: { type: Number, default: 0, index: true },
  metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false });

creditPackSchema.index({ stripePriceId: 1 }, { unique: true, partialFilterExpression: { stripePriceId: { $type: 'string' } } });

module.exports = mongoose.model('CreditPack', creditPackSchema);
