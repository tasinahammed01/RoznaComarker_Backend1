'use strict';

const { isFreeOrNonBillable, planIdEnvName } = require('./paypalPlanMapping.service');
const { getPaypalConfig, getPaypalPlanId } = require('../../config/paypal');

const PRODUCT_NAME = 'RoznaHub / CoMarker Subscription';
const PRODUCT_DESCRIPTION = 'Teacher SaaS subscription for RoznaHub / CoMarker.';
const PRODUCT_TYPE = 'SERVICE';
const PRODUCT_CATEGORY = 'SOFTWARE';

class PayPalProvisioningError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PayPalProvisioningError';
    this.code = code;
    this.details = details;
  }
}

function money(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || Math.abs(Math.round(value * 100) - value * 100) > 0.000001) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_CONFIG_INVALID', `${label} must be a positive amount with at most two decimal places`);
  }
  return value.toFixed(2);
}

function currency(value, planKey) {
  const code = String(value || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(code)) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_CONFIG_INVALID', `Plan ${planKey} has an invalid currency`);
  }
  return code;
}

function planDefinitions(plans) {
  if (!Array.isArray(plans)) throw new PayPalProvisioningError('PAYPAL_PLAN_CONFIG_INVALID', 'Plan definitions are unavailable');
  const definitions = [];
  const seen = new Set();
  for (const plan of plans) {
    if (plan?.isActive !== true || isFreeOrNonBillable(plan)) continue;
    const planKey = String(plan.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,79}$/u.test(planKey) || seen.has(planKey)) {
      throw new PayPalProvisioningError('PAYPAL_PLAN_CONFIG_INVALID', `Paid plan has an invalid or duplicate key: ${planKey || '(empty)'}`);
    }
    seen.add(planKey);
    const planCurrency = currency(plan.currency, planKey);
    const displayName = String(plan.display?.title || plan.name || planKey).trim().slice(0, 100);
    const configuredInterval = String(plan.billingInterval || plan.billingType || 'month').trim().toLowerCase();
    const primaryInterval = ['year', 'yearly', 'annual'].includes(configuredInterval) ? 'yearly' : 'monthly';
    definitions.push({ planKey, displayName, interval: primaryInterval, frequencyUnit: primaryInterval === 'yearly' ? 'YEAR' : 'MONTH',
      price: money(plan.price, `${planKey} ${primaryInterval} price`), currency: planCurrency,
      envName: planIdEnvName(planKey, primaryInterval) });
    if (primaryInterval === 'monthly' && plan.annualPrice !== null && plan.annualPrice !== undefined) {
      definitions.push({ planKey, displayName, interval: 'yearly', frequencyUnit: 'YEAR', price: money(plan.annualPrice, `${planKey} yearly price`), currency: planCurrency,
        envName: planIdEnvName(planKey, 'yearly') });
    }
  }
  if (!definitions.length) throw new PayPalProvisioningError('PAYPAL_PLAN_CONFIG_INVALID', 'No active paid subscription plans were found');
  return definitions;
}

function productPayload() {
  return {
    name: PRODUCT_NAME,
    description: PRODUCT_DESCRIPTION,
    type: PRODUCT_TYPE,
    category: PRODUCT_CATEGORY
  };
}

function cleanProductPayload() {
  return productPayload();
}

function billingPlanName(definition) {
  const intervalLabel = definition.interval === 'monthly' ? 'Monthly' : 'Annual';
  return new RegExp(`\\b${intervalLabel}$`, 'iu').test(definition.displayName)
    ? definition.displayName.slice(0, 127)
    : `${definition.displayName} ${intervalLabel}`.slice(0, 127);
}

function billingPlanPayload(productId, definition) {
  return {
    product_id: productId,
    name: billingPlanName(definition),
    description: `${definition.displayName} subscription billed ${definition.interval}.`.slice(0, 127),
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: definition.frequencyUnit, interval_count: 1 },
      tenure_type: 'REGULAR', sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: definition.price, currency_code: definition.currency } }
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 3
    }
  };
}

function normalizeMoneyString(value) {
  const match = String(value ?? '').trim().match(/^(\d+)(?:\.(\d+))?$/u);
  if (!match) return null;
  const whole = match[1].replace(/^0+(?=\d)/u, '');
  const fraction = match[2] || '';
  if (fraction.length > 2 && /[^0]/u.test(fraction.slice(2))) return null;
  return `${whole}.${fraction.slice(0, 2).padEnd(2, '0')}`;
}

function getRegularBillingCycle(plan) {
  return Array.isArray(plan?.billing_cycles)
    ? plan.billing_cycles.find((item) => String(item?.tenure_type || '').toUpperCase() === 'REGULAR') || null
    : null;
}

function normalizePayPalPlan(plan) {
  const cycle = getRegularBillingCycle(plan);
  const pricingScheme = cycle?.pricing_scheme;
  const fixedPrice = pricingScheme?.fixed_price;
  const rawPrice = fixedPrice?.value === undefined || fixedPrice?.value === null ? null : String(fixedPrice.value);
  return {
    planId: String(plan?.id || ''),
    productId: String(plan?.product_id || ''),
    status: String(plan?.status || '').toUpperCase(),
    intervalUnit: String(cycle?.frequency?.interval_unit || '').toUpperCase(),
    intervalCount: Number(cycle?.frequency?.interval_count ?? -1),
    totalCycles: Number(cycle?.total_cycles ?? -1),
    price: normalizeMoneyString(rawPrice),
    rawPrice,
    currency: String(fixedPrice?.currency_code || '').toUpperCase() || null,
    hasRegularCycle: Boolean(cycle),
    hasPricingScheme: Boolean(pricingScheme),
    hasFixedPrice: Boolean(fixedPrice)
  };
}

function safePlanDetails(actual, definition) {
  return { planKey: definition.planKey, billingInterval: definition.interval, planId: actual.planId || null,
    expectedApplicationPrice: definition.price, expectedCurrency: definition.currency,
    paypalPlanPrice: actual.rawPrice, paypalCurrency: actual.currency };
}

function assertPlanMatches(plan, definition, productId, expectedPlanId = null) {
  const actual = normalizePayPalPlan(plan);
  const details = safePlanDetails(actual, definition);
  if (expectedPlanId && actual.planId !== expectedPlanId) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_ID_MISMATCH', 'PayPal returned an unexpected Plan ID', details);
  }
  if (actual.productId !== productId) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_PRODUCT_MISMATCH',
      `PayPal Plan belongs to an unexpected Product for ${definition.planKey} ${definition.interval}`, details);
  }
  if (actual.status !== 'ACTIVE') {
    throw new PayPalProvisioningError('PAYPAL_PLAN_STATUS_UNUSABLE',
      `PayPal Plan is not reusable in status ${actual.status || '(missing)'}`, details);
  }
  if (!actual.hasRegularCycle) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_REGULAR_CYCLE_MISSING',
      `PayPal Plan has no REGULAR billing cycle for ${definition.planKey} ${definition.interval}`, details);
  }
  if (actual.intervalUnit !== definition.frequencyUnit || actual.intervalCount !== 1 || actual.totalCycles !== 0) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_BILLING_MISMATCH',
      `PayPal Plan billing frequency does not match ${definition.planKey} ${definition.interval}`, details);
  }
  if (!actual.hasPricingScheme || !actual.hasFixedPrice || actual.rawPrice === null || actual.currency === null) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_PRICING_MISSING',
      `PayPal Plan fixed recurring pricing is missing for ${definition.planKey} ${definition.interval}`, details);
  }
  const expectedPrice = normalizeMoneyString(definition.price);
  if (!actual.price) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_PRICING_INVALID',
      `PayPal Plan returned an invalid fixed price for ${definition.planKey} ${definition.interval}`, details);
  }
  if (actual.price !== expectedPrice || actual.currency !== definition.currency) {
    throw new PayPalProvisioningError('PAYPAL_PLAN_PRICE_MISMATCH',
      `PayPal plan pricing does not match application configuration for ${definition.planKey} ${definition.interval}`,
      details);
  }
  return actual;
}

function manifestPlanId(manifest, definition) {
  return manifest?.planIds?.[definition.planKey]?.[definition.interval]?.planId || null;
}

function configuredPlanId(environment, manifest, definition) {
  return String(getPaypalPlanId(definition.planKey, definition.interval, environment).value ||
    manifestPlanId(manifest, definition) || '').trim();
}

function nextManifest(productId, definitions, results, previous = {}) {
  const planIds = {};
  for (const definition of definitions) {
    const result = results.find((item) => item.planKey === definition.planKey && item.interval === definition.interval);
    planIds[definition.planKey] ||= {};
    planIds[definition.planKey][definition.interval] = {
      planId: result.planId,
      price: definition.price,
      currency: definition.currency,
      provisionedAt: previous?.planIds?.[definition.planKey]?.[definition.interval]?.provisionedAt || new Date().toISOString()
    };
  }
  return { environment: 'sandbox', productId,
    createdAt: previous.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString(), planIds };
}

async function collectPages(fetchPage, collectionKey) {
  const items = [];
  for (let page = 1; page <= 100; page += 1) {
    const payload = await fetchPage(page);
    items.push(...(Array.isArray(payload?.[collectionKey]) ? payload[collectionKey] : []));
    const totalPages = Number(payload?.total_pages || 1);
    if (!Number.isFinite(totalPages) || page >= totalPages) return items;
  }
  throw new PayPalProvisioningError('PAYPAL_RESOURCE_LIST_TOO_LARGE', 'PayPal resource listing exceeded the safe page limit');
}

function assertProductMatches(product) {
  const matches = product?.name === PRODUCT_NAME && product?.description === PRODUCT_DESCRIPTION &&
    String(product?.type || '').toUpperCase() === PRODUCT_TYPE &&
    String(product?.category || '').toUpperCase() === PRODUCT_CATEGORY;
  if (!matches) {
    throw new PayPalProvisioningError('PAYPAL_PRODUCT_MISMATCH', 'Configured PayPal Product does not match the RoznaHub subscription product');
  }
}

async function resolveProduct({ client, environment, manifest, logger }) {
  const existingId = String(getPaypalConfig(environment).productId || manifest?.productId || '').trim();
  if (existingId) {
    assertProductMatches(await client.getProduct(existingId));
    return { productId: existingId, action: 'reused' };
  }
  const products = await collectPages((page) => client.listProducts({ page }), 'products');
  const candidates = products.filter((item) => item?.id && item.name === PRODUCT_NAME &&
    (!item.type || String(item.type).toUpperCase() === PRODUCT_TYPE));
  const verified = [];
  for (const candidate of candidates) {
    const product = await client.getProduct(candidate.id);
    try { assertProductMatches(product); verified.push(product); } catch (error) {
      if (error?.code !== 'PAYPAL_PRODUCT_MISMATCH') throw error;
    }
  }
  if (verified.length > 1) {
    throw new PayPalProvisioningError('PAYPAL_PRODUCT_DISCOVERY_AMBIGUOUS',
      `Multiple PayPal Products match the RoznaHub subscription identity; configure ${getPaypalConfig(environment).variables.productId} explicitly`);
  }
  if (verified.length === 1) {
    return { productId: verified[0].id, action: 'discovered' };
  }
  const product = await client.createProduct(cleanProductPayload(), 'roznahub-comarker-subscription-product-v1');
  if (!product?.id) throw new PayPalProvisioningError('PAYPAL_PRODUCT_CREATE_FAILED', 'PayPal did not return a Product ID');
  logger.info?.(`[PAYPAL] Product created productId=${product.id}`);
  return { productId: product.id, action: 'created' };
}

async function resolvePlan({ client, definition, productId, environment, manifest, listedPlans, logger }) {
  let planId = configuredPlanId(environment, manifest, definition);
  let action = 'reused';
  let plan;
  if (planId) {
    plan = await client.getPlan(planId);
  } else {
    const candidates = listedPlans.filter((item) => item?.id && item.name === billingPlanName(definition));
    if (candidates.length) {
      const verified = [];
      const failures = [];
      for (const candidate of candidates) {
        const candidatePlan = await client.getPlan(candidate.id);
        try {
          assertPlanMatches(candidatePlan, definition, productId, candidate.id);
          verified.push(candidatePlan);
        } catch (error) { failures.push(error); }
      }
      if (verified.length > 1) {
        throw new PayPalProvisioningError('PAYPAL_PLAN_DISCOVERY_AMBIGUOUS',
          `Multiple PayPal Plans match ${definition.planKey} ${definition.interval}; configure ${definition.envName} explicitly`);
      }
      if (!verified.length) throw failures[0];
      plan = verified[0]; planId = plan.id; action = 'discovered';
    } else {
      const created = await client.createPlan(billingPlanPayload(productId, definition),
        `roznahub-${definition.planKey}-${definition.interval}-v1`.slice(0, 108));
      planId = created?.id;
      action = 'created';
      if (!planId) throw new PayPalProvisioningError('PAYPAL_PLAN_CREATE_FAILED', `PayPal did not return a Plan ID for ${definition.planKey} ${definition.interval}`);
      logger.info?.(`[PAYPAL] Plan created planKey=${definition.planKey} interval=${definition.interval} planId=${planId}`);
      plan = await client.getPlan(planId);
    }
  }
  assertPlanMatches(plan, definition, productId, planId);
  return { planKey: definition.planKey, interval: definition.interval, envName: definition.envName,
    price: definition.price, currency: definition.currency, planId, action };
}

async function provisionSandboxPlans({ client, plans, environment = process.env, manifest = {}, dryRun = false,
  saveManifest = async () => {}, logger = console } = {}) {
  if (String(environment.PAYPAL_ENV || '').trim().toLowerCase() !== 'sandbox' || (!dryRun && client?.environment !== 'sandbox')) {
    throw new PayPalProvisioningError('PAYPAL_SANDBOX_REQUIRED', 'Sandbox provisioning requires PAYPAL_ENV=sandbox');
  }
  const definitions = planDefinitions(plans);
  if (dryRun) {
    const productId = String(getPaypalConfig(environment).productId || manifest?.productId || '').trim() || null;
    return { dryRun: true, product: { productId, action: productId ? 'would-reuse' : 'would-create-or-discover' },
      plans: definitions.map((definition) => ({ ...definition, planId: configuredPlanId(environment, manifest, definition) || null,
        action: configuredPlanId(environment, manifest, definition) ? 'would-reuse-and-verify' : 'would-create-or-discover' })) };
  }
  if (!client) throw new PayPalProvisioningError('PAYPAL_CLIENT_REQUIRED', 'PayPal client is required');
  const product = await resolveProduct({ client, environment, manifest, logger });
  const listedPlans = await collectPages((page) => client.listPlans(product.productId, { page }), 'plans');
  const results = [];
  for (const definition of definitions) {
    results.push(await resolvePlan({ client, definition, productId: product.productId, environment, manifest, listedPlans, logger }));
  }
  const savedManifest = nextManifest(product.productId, definitions, results, manifest);
  await saveManifest(savedManifest);
  return { dryRun: false, product, plans: results, manifest: savedManifest };
}

module.exports = {
  PRODUCT_CATEGORY, PRODUCT_DESCRIPTION, PRODUCT_NAME, PRODUCT_TYPE, PayPalProvisioningError,
  assertPlanMatches, assertProductMatches, billingPlanName, billingPlanPayload,
  cleanProductPayload, collectPages, getRegularBillingCycle, normalizeMoneyString, normalizePayPalPlan, planDefinitions, provisionSandboxPlans
};
