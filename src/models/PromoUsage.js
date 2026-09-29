'use strict';
const mongoose = require('mongoose');
const schema = new mongoose.Schema({
  promoId: { type: mongoose.Schema.Types.ObjectId, required: true },
  userId: { type: mongoose.Schema.Types.ObjectId, required: true },
  allocated: { type: Number, default: 0 }, consumed: { type: Number, default: 0 }
});
schema.index({ promoId: 1, userId: 1 }, { unique: true });
module.exports = mongoose.model('PromoUsage', schema);
