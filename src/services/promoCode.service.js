'use strict';
const Promo = require('../models/PromoCode');
const Usage = require('../models/PromoUsage');
const Plan = require('../models/Plan');
const Audit = require('../models/AdminAuditLog');
const { fail, minor, money } = require('./billingMoney.service');
const { planPeriods } = require('./planCatalogPeriods.service');
const CURRENCIES = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD']);
function normalizeCode(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{2,40}$/.test(value.trim()))
    throw fail('PROMO_INVALID', 'Promo code is invalid.');
  return value.trim().toUpperCase();
}
function validate(promo, { planSlug, billingPeriod, currency, now = new Date() }) {
  if (!promo || !promo.active) throw fail('PROMO_INVALID', 'Promo code is invalid.');
  if (promo.validFrom && promo.validFrom > now) throw fail('PROMO_NOT_STARTED', 'This promo code is not yet available.');
  if (promo.validUntil && promo.validUntil <= now) throw fail('PROMO_EXPIRED', 'This promo code has expired.');
  if (promo.currency !== currency) throw fail('PROMO_CURRENCY', 'This promo code is not available for this currency.');
  if (promo.plans.length && !promo.plans.includes(planSlug)) throw fail('PROMO_PLAN', 'This promo code is not available for this plan.');
  if (promo.billingPeriods.length && !promo.billingPeriods.includes(billingPeriod))
    throw fail('PROMO_PERIOD', 'This promo code is not available for this billing period.');
  if (promo.totalLimit != null && promo.allocated >= promo.totalLimit) throw fail('PROMO_EXHAUSTED', 'This promo code is no longer available.');
}
function calculate(subtotal, promo) {
  const discount = promo.discountType === 'PERCENT'
    ? Number((BigInt(subtotal) * BigInt(promo.discountValue) + 5000n) / 10000n) : promo.discountValue;
  if (discount >= subtotal) throw fail('PROMO_MINIMUM_PAYMENT', 'This promo requires a remaining payment of at least 0.01.');
  return discount;
}
async function quote(code, context, userId, subtotal) {
  const promo = await Promo.findOne({ normalizedCode: normalizeCode(code) }).lean();
  validate(promo, context);
  const usage = await Usage.findOne({ promoId: promo._id, userId }).lean();
  if (promo.perUserLimit != null && (usage?.allocated || 0) >= promo.perUserLimit)
    throw fail('PROMO_USER_LIMIT', 'This promo code has already been used or reserved by you.');
  return { id: String(promo._id), code: promo.normalizedCode, revision: promo.revision,
    discountType: promo.discountType, discountValue: promo.discountValue, discountAmount: money(calculate(subtotal, promo)) };
}
async function reserve(snapshot, userId, session) {
  if (!snapshot.promo) return;
  const promo = await Promo.findById(snapshot.promo.id).session(session);
  validate(promo, snapshot);
  if (promo.revision !== snapshot.promo.revision) throw fail('PROMO_CHANGED', 'Promo settings changed. Apply the code again.', 409);
  const usage = await Usage.findOne({ promoId: promo._id, userId }).session(session);
  if (promo.perUserLimit != null && (usage?.allocated || 0) >= promo.perUserLimit)
    throw fail('PROMO_USER_LIMIT', 'This promo code has already been used or reserved by you.');
  // These writes share a transaction with attempt creation. Conflicting last-slot
  // reservations cause a transaction retry and recheck, not oversubscription.
  const claimed = await Promo.updateOne({ _id: promo._id, revision: promo.revision, allocated: promo.allocated },
    { $inc: { allocated: 1 } }, { session });
  if (claimed.modifiedCount !== 1) throw fail('PROMO_BUSY', 'Promo availability changed. Try again.', 409);
  await Usage.updateOne({ promoId: promo._id, userId }, { $inc: { allocated: 1 }, $setOnInsert: { consumed: 0 } }, { upsert: true, session });
}
async function transition(attempt, state, session) {
  if (!attempt.pricingSnapshot?.promo || attempt.promoState !== 'reserved') return;
  const amount = state === 'consumed' ? { consumed: 1 } : { allocated: -1 };
  await Promo.updateOne({ _id: attempt.pricingSnapshot.promo.id }, { $inc: amount }, { session });
  await Usage.updateOne({ promoId: attempt.pricingSnapshot.promo.id, userId: attempt.userId }, { $inc: amount }, { session });
  attempt.promoState = state;
}
async function save(input, actor, id, session) {
  const keys = ['code', 'active', 'discountType', 'discountValue', 'currency', 'validFrom', 'validUntil', 'plans', 'billingPeriods', 'totalLimit', 'perUserLimit'];
  if (!input || Object.keys(input).some(key => !keys.includes(key))) throw fail('PROMO_INPUT', 'Unsupported promo field.');
  const before = id ? await Promo.findById(id).session(session) : null;
  if (id && !before) throw fail('PROMO_NOT_FOUND', 'Promo code was not found.', 404);
  const normalizedCode = normalizeCode(input.code);
  if (before && normalizedCode !== before.normalizedCode) throw fail('PROMO_CODE_IMMUTABLE', 'An existing promo code cannot be renamed.');
  if (!['PERCENT', 'FIXED'].includes(input.discountType) || typeof input.active !== 'boolean' || !CURRENCIES.has(input.currency))
    throw fail('PROMO_INPUT', 'Invalid promo type, active state, or currency.');
  const discountValue = minor(input.discountValue);
  if (discountValue < 1 || (input.discountType === 'PERCENT' && discountValue > 10000)) throw fail('PROMO_INPUT', 'Invalid discount value.');
  const values = { normalizedCode, active: input.active, discountType: input.discountType, discountValue, currency: input.currency };
  for (const key of ['validFrom', 'validUntil']) {
    values[key] = input[key] == null || input[key] === '' ? null : new Date(input[key]);
    if (values[key] && !Number.isFinite(values[key].getTime())) throw fail('PROMO_INPUT', 'Invalid validity date.');
  }
  if (values.validFrom && values.validUntil && values.validFrom >= values.validUntil) throw fail('PROMO_INPUT', 'Expiration must follow the start date.');
  for (const key of ['totalLimit', 'perUserLimit']) {
    values[key] = input[key] == null ? null : input[key];
    if (values[key] != null && (!Number.isSafeInteger(values[key]) || values[key] < 1)) throw fail('PROMO_INPUT', 'Limits must be positive whole numbers.');
  }
  if (before && values.totalLimit != null && values.totalLimit < before.allocated) throw fail('PROMO_INPUT', 'Limit cannot be lower than existing usage and reservations.');
  if (!Array.isArray(input.plans) || input.plans.length > 30 || input.plans.some(p => typeof p !== 'string' || !/^[a-z0-9_-]{1,80}$/.test(p)))
    throw fail('PROMO_INPUT', 'Invalid plan restrictions.');
  const plans = [...new Set(input.plans)];
  const catalog = plans.length ? await Plan.find({ slug: { $in: plans }, isActive: true })
    .select('slug price annualPrice billingInterval billingType').session(session).lean() : [];
  if (catalog.length !== plans.length || catalog.some(plan => !planPeriods(plan).length))
    throw fail('PROMO_INPUT', 'One or more paid plans are unavailable.');
  const derived = plans.length ? [...new Set(catalog.flatMap(planPeriods))] : [];
  const supplied = Object.prototype.hasOwnProperty.call(input, 'billingPeriods');
  if (supplied && (!Array.isArray(input.billingPeriods) || input.billingPeriods.some(p => !['monthly', 'annual'].includes(p))))
    throw fail('PROMO_INPUT', 'Invalid billing periods.');
  // Old clients may still narrow periods. Empty means unrestricted, so normalize
  // it to selected variants. New clients omit the field entirely.
  let periods = supplied && input.billingPeriods.length ? [...new Set(input.billingPeriods)] : derived;
  const unchangedPlans = before && plans.length === before.plans.length && plans.every(slug => before.plans.includes(slug));
  if (!supplied && unchangedPlans && before.billingPeriods.length) {
    periods = plans.length ? before.billingPeriods.filter(period => derived.includes(period)) : [...before.billingPeriods];
    if (!periods.length) throw fail('PROMO_RESTRICTIONS_REVIEW', 'Existing plan and period restrictions conflict. Change the selected plans or review this promo before saving.');
  }
  if (plans.length && periods.some(period => !derived.includes(period)))
    throw fail('PROMO_INPUT', 'Billing periods must match the selected paid plans.');
  values.plans = plans;
  values.billingPeriods = ['monthly', 'annual'].filter(period => periods.includes(period));
  const saved = before ? await Promo.findOneAndUpdate({ _id: before._id }, { $set: values, $inc: { revision: 1 } }, { session, returnDocument: 'after' })
    : (await Promo.create([{ ...values, createdBy: actor }], { session }))[0];
  await Audit.create([{ adminUserId: actor, action: before ? 'PROMO_UPDATE' : 'PROMO_CREATE', targetType: 'PromoCode',
    targetId: String(saved._id), before: before?.toObject(), after: saved.toObject(), changedFields: Object.keys(values) }], { session });
  return dto(saved);
}
function dto(promo) { const data = promo.toObject ? promo.toObject() : promo; return { ...data, code: data.normalizedCode, discountValue: money(data.discountValue) }; }
module.exports = { normalizeCode, validate, calculate, quote, reserve, transition, save, dto, CURRENCIES };
