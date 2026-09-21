'use strict';

const Plan = require('../../models/Plan');
const { getPaypalPlanId: configuredPlanId, getPaypalPlanVariableName } = require('../../config/paypal');

class PayPalPlanMappingError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'PayPalPlanMappingError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizePlanKey(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeBillingInterval(value) {
  const interval = String(value || '').trim().toLowerCase();
  if (interval === 'monthly' || interval === 'month') return 'monthly';
  if (interval === 'yearly' || interval === 'year' || interval === 'annual') return 'yearly';
  throw new PayPalPlanMappingError('PAYPAL_BILLING_INTERVAL_UNSUPPORTED', 'Unsupported PayPal billing interval');
}

function planIdEnvName(planKey, billingInterval) {
  const normalizedKey = normalizePlanKey(planKey);
  const key = normalizedKey.replace(/[^a-z0-9]+/giu, '_').replace(/^_+|_+$/gu, '').toUpperCase();
  if (!key) throw new PayPalPlanMappingError('PAYPAL_PLAN_UNKNOWN', 'Unknown plan');
  const interval = normalizeBillingInterval(billingInterval);
  const keyAlreadyNamesInterval = interval === 'monthly'
    ? /_monthly$/u.test(normalizedKey)
    : /_(?:annual|yearly)$/u.test(normalizedKey);
  return `PAYPAL_${key}${keyAlreadyNamesInterval ? '' : `_${interval.toUpperCase()}`}_PLAN_ID`;
}

function isFreeOrNonBillable(plan) {
  const slug = normalizePlanKey(plan?.slug);
  return slug === 'free' || ['custom', 'institution'].includes(slug) || Number(plan?.price || 0) <= 0;
}

function requestedInterval(plan, period) {
  if (period !== undefined && !['monthly', 'annual'].includes(period)) {
    throw new PayPalPlanMappingError('PAYPAL_BILLING_INTERVAL_UNSUPPORTED', 'billingPeriod must be monthly or annual');
  }
  if (period === undefined && Number(plan.annualPrice) > 0 && !/_(monthly|annual|yearly)$/u.test(plan.slug)) {
    throw new PayPalPlanMappingError('PAYPAL_BILLING_INTERVAL_REQUIRED', 'billingPeriod is required');
  }
  return period ? normalizeBillingInterval(period) :
    /_(annual|yearly)$/u.test(plan.slug) ? 'yearly' : normalizeBillingInterval(plan.billingInterval || plan.billingType || 'monthly');
}

function priceForInterval(plan, interval) {
  const primary = /_(annual|yearly)$/u.test(plan.slug) ||
    ['year', 'yearly', 'annual'].includes(String(plan.billingInterval || plan.billingType).toLowerCase()) ? 'yearly' : 'monthly';
  // Separate records cannot be used as aliases for the opposite billing period.
  if (/_(monthly|annual|yearly)$/u.test(plan.slug) && primary !== interval) return null;
  return primary === interval ? plan.price : interval === 'yearly' ? plan.annualPrice : null;
}

async function getPayPalPlanId({ planKey, billingInterval }, { environment = process.env, PlanModel = Plan } = {}) {
  const slug = normalizePlanKey(planKey);
  const interval = normalizeBillingInterval(billingInterval);
  const plan = await PlanModel.findOne({ slug, isActive: true }).lean();
  if (!plan) throw new PayPalPlanMappingError('PAYPAL_PLAN_UNKNOWN', `Unknown plan: ${slug || '(empty)'}`, 404);
  if (isFreeOrNonBillable(plan)) {
    throw new PayPalPlanMappingError('PAYPAL_PLAN_NOT_BILLABLE', `Plan is not billable through PayPal: ${slug}`);
  }
  const supportedPrice = priceForInterval(plan, interval);
  if (!(typeof supportedPrice === 'number' && Number.isFinite(supportedPrice) && supportedPrice > 0)) {
    throw new PayPalPlanMappingError('PAYPAL_BILLING_INTERVAL_UNSUPPORTED', `Plan does not support ${interval} billing`);
  }
  const mapping = configuredPlanId(slug, interval, environment);
  if (!mapping.value) throw new PayPalPlanMappingError('PAYPAL_PLAN_NOT_CONFIGURED', `${mapping.variable} is not configured`, 503);
  return mapping.value;
}

async function getPlanByPayPalPlanId(paypalPlanId, { environment = process.env, PlanModel = Plan } = {}) {
  const id = String(paypalPlanId || '').trim();
  if (!id) throw new PayPalPlanMappingError('PAYPAL_WEBHOOK_UNKNOWN_PLAN', 'PayPal Plan ID is missing');
  const plans = await PlanModel.find({}).lean();
  const matches = [];
  for (const plan of plans) {
    if (isFreeOrNonBillable(plan)) continue;
    for (const interval of ['monthly', 'yearly']) {
      if (Number(priceForInterval(plan, interval)) > 0 && configuredPlanId(plan.slug, interval, environment).value === id) {
        matches.push({ ...plan, resolvedBillingInterval: interval });
      }
    }
  }
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new PayPalPlanMappingError('PAYPAL_PLAN_MAPPING_AMBIGUOUS', 'Multiple plans match the provider plan', 503);
  throw new PayPalPlanMappingError('PAYPAL_WEBHOOK_UNKNOWN_PLAN', 'PayPal Plan ID is not configured', 422);
}

module.exports = {
  PayPalPlanMappingError, getPayPalPlanId, getPlanByPayPalPlanId, getPaypalPlanVariableName,
  isFreeOrNonBillable, normalizeBillingInterval, normalizePlanKey, planIdEnvName, requestedInterval, priceForInterval
};
