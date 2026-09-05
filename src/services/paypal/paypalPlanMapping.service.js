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

async function getPayPalPlanId({ planKey, billingInterval }, { environment = process.env, PlanModel = Plan } = {}) {
  const slug = normalizePlanKey(planKey);
  const interval = normalizeBillingInterval(billingInterval);
  const plan = await PlanModel.findOne({ slug, isActive: true }).lean();
  if (!plan) throw new PayPalPlanMappingError('PAYPAL_PLAN_UNKNOWN', `Unknown plan: ${slug || '(empty)'}`, 404);
  if (isFreeOrNonBillable(plan)) {
    throw new PayPalPlanMappingError('PAYPAL_PLAN_NOT_BILLABLE', `Plan is not billable through PayPal: ${slug}`);
  }
  const configuredInterval = String(plan.billingInterval || plan.billingType || '').trim().toLowerCase();
  const recordMatchesInterval = interval === 'monthly'
    ? ['month', 'monthly'].includes(configuredInterval) || !configuredInterval
    : ['year', 'yearly', 'annual'].includes(configuredInterval);
  const supportedPrice = recordMatchesInterval ? plan.price : interval === 'yearly' ? plan.annualPrice : null;
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
  const plans = await PlanModel.find({ isActive: true }).lean();
  for (const plan of plans) {
    if (isFreeOrNonBillable(plan)) continue;
    const configured = String(plan.billingInterval || '').toLowerCase();
    const interval = ['year', 'yearly', 'annual'].includes(configured) ? 'yearly' : 'monthly';
    if (configuredPlanId(plan.slug, interval, environment).value === id) return plan;
  }
  throw new PayPalPlanMappingError('PAYPAL_WEBHOOK_UNKNOWN_PLAN', 'PayPal Plan ID is not configured', 422);
}

module.exports = {
  PayPalPlanMappingError, getPayPalPlanId, getPlanByPayPalPlanId, getPaypalPlanVariableName,
  isFreeOrNonBillable, normalizeBillingInterval, normalizePlanKey, planIdEnvName
};
