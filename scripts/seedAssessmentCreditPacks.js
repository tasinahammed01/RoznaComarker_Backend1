'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Plan = require('../src/models/Plan');
const CreditPack = require('../src/models/CreditPack');

const PACKS = [
  { code: 'CREDITS_10', name: '10 Assessment Credits', credits: 10, price: 1.99, currency: 'USD', displayOrder: 1 },
  { code: 'CREDITS_50', name: '50 Assessment Credits', credits: 50, price: 4.99, currency: 'USD', displayOrder: 2 }
];

async function seedAssessmentCreditPacks() {
  const allowedPlans = await Plan.find({ isActive: true, slug: { $nin: ['institution', 'custom'] } }).distinct('slug');
  if (!allowedPlans.length) throw new Error('No active personal plans are configured for Assessment Credit packs.');
  for (const pack of PACKS) await CreditPack.updateOne({ code: pack.code },
    { $setOnInsert: { ...pack, allowedPlans, active: true, stripePriceId: null } }, { upsert: true, runValidators: true });
  return PACKS;
}

if (require.main === module) {
  connectDB().then(seedAssessmentCreditPacks).then(async packs => { console.log(`Configured ${packs.length} Assessment Credit packs.`);await mongoose.disconnect(); })
    .catch(async error => { console.error(error);await mongoose.disconnect();process.exitCode=1; });
}
module.exports={PACKS,seedAssessmentCreditPacks};
