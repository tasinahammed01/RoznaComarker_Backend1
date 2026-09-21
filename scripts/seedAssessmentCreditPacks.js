'use strict';
// No commercial defaults: Admin Pricing / the existing database owns prices.
const CreditPack = require('../src/models/CreditPack');
const Plan = require('../src/models/Plan');
const { packRejection } = require('../src/services/creditPackPolicy');
async function seedAssessmentCreditPacks(packs) {
  if (!Array.isArray(packs) || !packs.length) throw new Error('An explicitly approved catalog is required; use Admin Pricing or the eligibility migration.');
  const slugs = await Plan.distinct('slug');
  for (const pack of packs) {
    if (packRejection(pack) || pack.allowedPlans.some(slug => !slugs.includes(slug))) throw new Error('Invalid approved catalog');
  }
  for (const pack of packs) await CreditPack.updateOne({ code: pack.code }, { $setOnInsert: pack }, { upsert: true, runValidators: true });
  return packs;
}
if (require.main === module) {
  console.error('Pack seed defaults were retired. Use Admin Pricing for commercial values and pricing:migrate-billing for eligibility-only repair.');
  process.exitCode = 1;
}
module.exports = { seedAssessmentCreditPacks };
