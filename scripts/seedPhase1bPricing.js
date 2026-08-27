'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Plan = require('../src/models/Plan');
const CreditPack = require('../src/models/CreditPack');

async function run() {
  await connectDB();
  const plans = [
    { slug: 'free', name: 'Free', price: 0, annualPrice: 0, credits: 25, order: 1, popular: false },
    { slug: 'essential', name: 'Essential', price: 24.99, annualPrice: 249, credits: 100, order: 2, popular: true },
    { slug: 'pro', name: 'Pro', price: 49.99, annualPrice: 499, credits: 200, order: 3, popular: false }
  ];
  for (const plan of plans) {
    await Plan.updateOne({ slug: plan.slug }, { $set: { name: plan.name, price: plan.price, annualPrice: plan.annualPrice,
      currency: 'USD', billingInterval: 'month', billingType: 'monthly', displayOrder: plan.order, isActive: true,
      popular: plan.popular, 'features.essayAnalysesPerMonth': plan.credits,
      'assessmentCreditNudges.softThresholdPercent': 50, 'assessmentCreditNudges.warningThresholdPercent': 80 },
      $setOnInsert: { display: { title: plan.name, description: null, priceLabel: null,
        cta: plan.slug === 'free' ? 'Get Started' : 'Upgrade Plan' } } }, { upsert: true });
  }
  await CreditPack.updateOne({ code: 'TOPUP_SMALL' }, { $set: { name: 'Top-Up Small', credits: 10, price: 4.99,
    currency: 'USD', allowedPlans: ['essential', 'pro'], active: true, displayOrder: 1 }, $setOnInsert: { stripePriceId: null } }, { upsert: true });
  await CreditPack.updateOne({ code: 'TOPUP_LARGE' }, { $set: { name: 'Top-Up Large', credits: 50, price: 19.99,
    currency: 'USD', allowedPlans: ['essential', 'pro'], active: true, displayOrder: 2 }, $setOnInsert: { stripePriceId: null } }, { upsert: true });
  await mongoose.disconnect();
}

run().catch(async (error) => { console.error(error); await mongoose.disconnect(); process.exitCode = 1; });
