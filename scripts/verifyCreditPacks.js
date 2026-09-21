'use strict';
const mongoose = require('mongoose');
const { packRejection } = require('../src/services/creditPackPolicy');
const normalize = value => String(value || '').trim().toLowerCase();

const contracts = [
  ['plans', { slug: 1 }], ['creditpacks', { code: 1 }], ['creditwallets', { userId: 1 }],
  ['credittransactions', { idempotencyKey: 1 }],
  ['paymentcheckoutattempts', { provider: 1, attemptId: 1 }],
  ['paymentcheckoutattempts', { activeOperationKey: 1 }, 'activeOperationKey'],
  ['paymentmanagementattempts', { provider: 1, attemptId: 1 }],
  ['paymentmanagementattempts', { activeOperationKey: 1 }, 'activeOperationKey'],
  ['paymentpurchaseattempts', { provider: 1, attemptId: 1 }],
  ['paymentpurchaseattempts', { provider: 1, providerOrderId: 1 }, 'providerOrderId'],
  ['paymentpurchaseattempts', { provider: 1, providerCaptureId: 1 }, 'providerCaptureId'],
  ['paymentproviderevents', { provider: 1, providerEventId: 1 }],
  ['users', { paypalSubscriptionId: 1 }, 'paypalSubscriptionId']
];

async function inspect(db, { output = console, teacherId } = {}) {
  let failures = 0;
  const fail = message => { failures++; output.log(`FAIL ${message}`); };
  const plans = await db.collection('plans').find({}, { projection: { slug: 1, isActive: 1 } }).toArray();
  const seen = new Set();
  for (const plan of plans) {
    const slug = normalize(plan.slug);
    if (!slug) fail(`MISSING_PLAN_SLUG record=${plan._id}`);
    if (seen.has(slug)) fail(`DUPLICATE_PLAN_SLUG ${slug} (active/inactive included)`);
    if (plan.slug !== slug) fail(`PLAN_SLUG_MISMATCH record=${plan._id}`);
    seen.add(slug);
  }
  output.log(`Active Plan slugs: ${plans.filter(p => p.isActive).map(p => normalize(p.slug)).join(',')}`);
  const packs = await db.collection('creditpacks').find({}).sort({ displayOrder: 1, code: 1 }).toArray();
  if (!packs.length) fail('EMPTY_CATALOG');
  for (const pack of packs) {
    const reason = packRejection(pack);
    output.log(JSON.stringify({ code: pack.code, name: pack.name, credits: pack.credits, price: pack.price,
      currency: pack.currency, active: pack.active, displayOrder: pack.displayOrder, allowedPlans: pack.allowedPlans,
      purchasable: !reason, rejection: reason, freeEligible: !reason && pack.allowedPlans.includes('free') }));
    if (pack.active && reason) fail(`INVALID_PACK ${pack.code}: ${reason}`);
    if (pack.allowedPlans?.some(slug => !seen.has(slug))) fail(`PLAN_SLUG_MISMATCH ${pack.code}`);
  }
  if (!packs.some(p => !packRejection(p) && p.allowedPlans.includes('free'))) fail('NO_FREE_ELIGIBILITY');
  if (teacherId) {
    if (!mongoose.isObjectIdOrHexString(teacherId)) throw new Error('INVALID_TEACHER_ID');
    const user = await db.collection('users').findOne({ _id: new mongoose.Types.ObjectId(teacherId), role: 'teacher' },
      { projection: { plan: 1, paypalPlanId: 1, paypalSubscriptionStatus: 1, paypalCurrentPeriodEnd: 1, planExpiresAt: 1 } });
    if (!user) fail('TEACHER_NOT_FOUND');
    else {
      let plan = plans.find(p => String(p._id) === String(user.plan));
      if (user.paypalSubscriptionStatus) {
        const entitled = user.paypalSubscriptionStatus === 'ACTIVE' || (user.paypalSubscriptionStatus === 'CANCELLED' &&
          new Date(user.paypalCurrentPeriodEnd || user.planExpiresAt) > new Date());
        if (entitled) {
          try { plan = await require('../src/services/paypal/paypalPlanMapping.service').getPlanByPayPalPlanId(user.paypalPlanId); }
          catch { fail('TEACHER_PROVIDER_PLAN_UNRESOLVED'); plan = null; }
        } else plan = plans.find(p => p.slug === 'free');
      }
      const slug = normalize(plan?.slug);
      output.log(JSON.stringify({ resolvedPlanSlug: slug, eligiblePackCodes:
        packs.filter(p => !packRejection(p) && p.allowedPlans.includes(slug)).map(p => p.code) }));
    }
  }
  for (const [collection, key, partial] of contracts) {
    let indexes = [];
    try { indexes = await db.collection(collection).indexes(); } catch (error) { if (error.code !== 26) throw error; }
    const match = indexes.some(i => i.unique === true && JSON.stringify(i.key) === JSON.stringify(key) &&
      (partial ? (i.partialFilterExpression?.[partial]?.$type === 'string' || (partial === 'paypalSubscriptionId' && i.sparse))
        : !i.partialFilterExpression && !i.sparse));
    const label = `${collection} ${Object.keys(key).join('+')} unique index`;
    if (match) output.log(`PASS ${label}`); else fail(label);
  }
  return { failures, plans, packs };
}

async function main() {
  require('dotenv').config({ quiet: true });
  try {
    if (!process.env.MONGO_URI) throw new Error('MONGO_URI_MISSING');
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000 });
    const teacherArg = process.argv.find(a => a.startsWith('--teacher='));
    const result = await inspect(mongoose.connection.db, { teacherId: teacherArg?.slice(10) });
    if (result.failures) process.exitCode = 1;
  } catch (error) { console.error(`FAIL DATABASE_AUDIT_UNAVAILABLE (${error.code || error.name})`); process.exitCode = 1; }
  finally { await mongoose.disconnect(); }
}
if (require.main === module) main();
module.exports = { inspect, contracts, normalize };
