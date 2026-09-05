'use strict';

const { getPaypalConfig, getPaypalPlanId } = require('../../config/paypal');
const { assertPlanMatches, assertProductMatches, planDefinitions } = require('./paypalProvisioning.service');

function safeFailure(error) {
  return { code: error?.code || 'PAYPAL_RESOURCE_VALIDATION_FAILED', message: error?.message || 'Validation failed' };
}

async function validatePayPalResources({ client, plans, environment = process.env } = {}) {
  const config = getPaypalConfig(environment);
  const definitions = planDefinitions(plans);
  const result = { environment: config.environment, product: { pass: false }, plans: [], pass: false };
  try {
    const product = await client.getProduct(config.productId);
    assertProductMatches(product);
    if (String(product?.id || '') !== config.productId) {
      throw Object.assign(new Error('PayPal returned an unexpected Product ID'), { code: 'PAYPAL_PRODUCT_ID_MISMATCH' });
    }
    result.product = { pass: true };
  } catch (error) { result.product = { pass: false, error: safeFailure(error) }; }

  for (const definition of definitions) {
    const mapping = getPaypalPlanId(definition.planKey, definition.interval, environment);
    const item = { planKey: definition.planKey, interval: definition.interval, variable: mapping.variable, pass: false };
    if (!mapping.value) {
      item.error = { code: 'PAYPAL_PLAN_NOT_CONFIGURED', message: `${mapping.variable} is not configured` };
      result.plans.push(item); continue;
    }
    try {
      const plan = await client.getPlan(mapping.value);
      assertPlanMatches(plan, definition, config.productId, mapping.value);
      item.pass = true;
    } catch (error) { item.error = safeFailure(error); }
    result.plans.push(item);
  }
  result.pass = result.product.pass && result.plans.length > 0 && result.plans.every((item) => item.pass);
  return result;
}

module.exports = { safeFailure, validatePayPalResources };
