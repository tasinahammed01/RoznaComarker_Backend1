'use strict';

const PAYPAL_BASE_URLS = Object.freeze({
  sandbox: 'https://api-m.sandbox.paypal.com',
  live: 'https://api-m.paypal.com'
});

const REQUIRED_PLAN_MAPPINGS = Object.freeze([
  ['essential', 'monthly'], ['essential', 'yearly'], ['pro', 'monthly'], ['pro', 'yearly']
]);

const PAYPAL_VALIDATION_PURPOSES = Object.freeze({
  runtime: Object.freeze({ credentials: true, webhook: true, product: true, plans: true, redirects: true }),
  provisioning: Object.freeze({ credentials: true, sandboxOnly: true }),
  check: Object.freeze({}),
  authentication: Object.freeze({ credentials: true }),
  resources: Object.freeze({ credentials: true, product: true, plans: true }),
  webhookProvisioning: Object.freeze({ credentials: true, sandboxOnly: true })
});

class PayPalConfigError extends Error {
  constructor(code, message) { super(message); this.name = 'PayPalConfigError'; this.code = code; }
}

function fail(code, message) { throw new PayPalConfigError(code, message); }
function value(environment, name) { return String(environment?.[name] || '').trim(); }
function enabled(valueToCheck) { return String(valueToCheck || '').trim().toLowerCase() === 'true'; }

function getPaypalEnvironment(environment = process.env) {
  const selected = value(environment, 'PAYPAL_ENV').toLowerCase() || 'sandbox';
  if (!Object.hasOwn(PAYPAL_BASE_URLS, selected)) fail('PAYPAL_ENV_INVALID', 'PAYPAL_CONFIG_INVALID: PAYPAL_ENV must be sandbox or live');
  return selected;
}

function getPaypalApiBaseUrl(environment = process.env) { return PAYPAL_BASE_URLS[getPaypalEnvironment(environment)]; }
function isPaypalSandbox(environment = process.env) { return getPaypalEnvironment(environment) === 'sandbox'; }
function isPaypalLive(environment = process.env) { return getPaypalEnvironment(environment) === 'live'; }
function isPaypalEnabled(environment = process.env) {
  return enabled(environment.PAYPAL_ENABLED) || value(environment, 'PAYMENT_PROVIDER').toLowerCase() === 'paypal';
}

function planMappingKey(planKey, billingInterval) {
  let key = String(planKey || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  const annual = ['year', 'yearly', 'annual'].includes(String(billingInterval || '').trim().toLowerCase());
  key = key.replace(/_(?:monthly|annual|yearly)$/u, '');
  return `${key}_${annual ? 'annual' : 'monthly'}`.toUpperCase();
}

function legacyPlanVariable(planKey, billingInterval) {
  const original = String(planKey || '').trim().toLowerCase().replace(/[^a-z0-9]+/gu, '_').replace(/^_+|_+$/gu, '');
  const annual = ['year', 'yearly', 'annual'].includes(String(billingInterval || '').trim().toLowerCase());
  const alreadyNamesInterval = annual ? /_(?:annual|yearly)$/u.test(original) : /_monthly$/u.test(original);
  return `PAYPAL_${original.toUpperCase()}${alreadyNamesInterval ? '' : `_${annual ? 'YEARLY' : 'MONTHLY'}`}_PLAN_ID`;
}

function selectedVariable(environment, suffix) {
  return `PAYPAL_${getPaypalEnvironment(environment).toUpperCase()}_${suffix}`;
}

function selectedValue(environment, suffix, legacyName) {
  const selectedName = selectedVariable(environment, suffix);
  const selected = value(environment, selectedName);
  if (selected) return { value: selected, variable: selectedName, legacy: false };
  if (isPaypalSandbox(environment) && legacyName && value(environment, legacyName)) {
    return { value: value(environment, legacyName), variable: legacyName, legacy: true };
  }
  return { value: '', variable: selectedName, legacy: false };
}

function getPaypalPlanVariableName(planKey, billingInterval, environment = process.env) {
  return selectedVariable(environment, `PLAN_${planMappingKey(planKey, billingInterval)}`);
}

function getPaypalPlanId(planKey, billingInterval, environment = process.env) {
  return selectedValue(environment, `PLAN_${planMappingKey(planKey, billingInterval)}`,
    legacyPlanVariable(planKey, billingInterval));
}

function getPaypalConfig(environment = process.env) {
  const paypalEnvironment = getPaypalEnvironment(environment);
  // Credentials are deliberately environment-specific. Resource-ID legacy names
  // remain Sandbox-only for migration compatibility, but secrets never fall back.
  const clientId = selectedValue(environment, 'CLIENT_ID');
  const clientSecret = selectedValue(environment, 'CLIENT_SECRET');
  const webhookId = selectedValue(environment, 'WEBHOOK_ID', 'PAYPAL_WEBHOOK_ID');
  const productId = selectedValue(environment, 'PRODUCT_ID', 'PAYPAL_PRODUCT_ID');
  return {
    environment: paypalEnvironment,
    apiBaseUrl: PAYPAL_BASE_URLS[paypalEnvironment],
    liveEnabled: paypalEnvironment !== 'live' || enabled(environment.PAYPAL_LIVE_ENABLED),
    clientId: clientId.value, clientSecret: clientSecret.value, webhookId: webhookId.value, productId: productId.value,
    variables: { clientId: clientId.variable, clientSecret: clientSecret.variable,
      webhookId: webhookId.variable, productId: productId.variable }
  };
}

function appPublicUrl(environment = process.env) {
  const legacyRedirectVariable = ['PAYPAL_RETURN_URL', 'PAYPAL_CANCEL_URL', 'PAYPAL_CHANGE_PLAN_RETURN_URL',
    'PAYPAL_CHANGE_PLAN_CANCEL_URL', 'PAYPAL_TOPUP_RETURN_URL', 'PAYPAL_TOPUP_CANCEL_URL']
    .find((name) => value(environment, name));
  const variable = value(environment, 'APP_PUBLIC_URL') ? 'APP_PUBLIC_URL'
    : value(environment, 'APP_FRONTEND_URL') ? 'APP_FRONTEND_URL'
      : value(environment, 'FRONTEND_URL') ? 'FRONTEND_URL' : legacyRedirectVariable || 'APP_PUBLIC_URL';
  let url;
  try { url = new URL(value(environment, variable)); } catch { fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${variable} must be a valid URL`); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) {
    fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${variable} must be HTTPS or local HTTP`);
  }
  return url.origin;
}

function trustedRedirect(environment, variable, route, query = {}) {
  const origin = appPublicUrl(environment);
  const configured = value(environment, variable);
  let url;
  try { url = new URL(configured || route, origin); } catch { fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${variable} must be a valid URL`); }
  if (url.origin !== origin || url.pathname !== route || url.username || url.password) {
    fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${variable} must use ${origin}${route}`);
  }
  for (const [key, queryValue] of Object.entries(query)) url.searchParams.set(key, String(queryValue));
  return url.toString();
}

function getPaypalRedirectUrls(flow, environment = process.env, query = {}) {
  const definitions = {
    subscription: ['PAYPAL_RETURN_URL', '/billing/paypal/success', 'PAYPAL_CANCEL_URL', '/billing/paypal/cancel'],
    changePlan: ['PAYPAL_CHANGE_PLAN_RETURN_URL', '/billing/paypal/change-plan/success',
      'PAYPAL_CHANGE_PLAN_CANCEL_URL', '/billing/paypal/change-plan/cancel'],
    topup: ['PAYPAL_TOPUP_RETURN_URL', '/teacher/dashboard', 'PAYPAL_TOPUP_CANCEL_URL', '/teacher/dashboard']
  };
  const definition = definitions[flow];
  if (!definition) fail('PAYPAL_CONFIG_INVALID', `Unknown PayPal redirect flow: ${flow}`);
  return { returnUrl: trustedRedirect(environment, definition[0], definition[1], query.return || {}),
    cancelUrl: trustedRedirect(environment, definition[2], definition[3], query.cancel || {}) };
}

function assertDistinctResources(environment, config) {
  const opposite = config.environment === 'live' ? 'SANDBOX' : 'LIVE';
  for (const [property, suffix] of [['webhookId', 'WEBHOOK_ID'], ['productId', 'PRODUCT_ID']]) {
    const other = value(environment, `PAYPAL_${opposite}_${suffix}`);
    if (config[property] && other && config[property] === other) {
      fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${config.variables[property]} must not reuse PAYPAL_${opposite}_${suffix}`);
    }
  }
}

function assertPlanResources(environment, config, required) {
  for (const [planKey, interval] of REQUIRED_PLAN_MAPPINGS) {
    const mapping = getPaypalPlanId(planKey, interval, environment);
    if (required && !mapping.value) fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: Missing ${mapping.variable}`);
    if (!mapping.value) continue;
    const opposite = config.environment === 'live' ? 'sandbox' : 'live';
    const other = getPaypalPlanId(planKey, interval, { ...environment, PAYPAL_ENV: opposite });
    if (other.value && other.value === mapping.value) {
      fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: ${mapping.variable} must not reuse ${other.variable}`);
    }
  }
}

function validatePaypalConfig(environment = process.env, { purpose = 'runtime', requirePlans } = {}) {
  const requirements = PAYPAL_VALIDATION_PURPOSES[purpose];
  if (!requirements) fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: Unknown validation purpose ${purpose}`);
  if (!value(environment, 'PAYPAL_ENV')) fail('PAYPAL_CONFIG_INVALID', 'PAYPAL_CONFIG_INVALID: Missing PAYPAL_ENV');
  const config = getPaypalConfig(environment);
  if (requirements.sandboxOnly && config.environment !== 'sandbox') {
    fail('PAYPAL_SANDBOX_REQUIRED', `Refusing PayPal ${purpose}: PAYPAL_ENV must equal sandbox`);
  }
  const requiredProperties = [
    ...(requirements.credentials ? ['clientId', 'clientSecret'] : []),
    ...(requirements.webhook ? ['webhookId'] : []),
    ...(requirements.product ? ['productId'] : [])
  ];
  for (const property of requiredProperties) {
    if (!config[property]) fail('PAYPAL_CONFIG_INVALID', `PAYPAL_CONFIG_INVALID: Missing ${config.variables[property]}`);
  }
  if (requirements.redirects) {
    appPublicUrl(environment);
    getPaypalRedirectUrls('subscription', environment);
    getPaypalRedirectUrls('changePlan', environment);
    getPaypalRedirectUrls('topup', environment);
  }
  assertDistinctResources(environment, config);
  assertPlanResources(environment, config, requirePlans === undefined ? requirements.plans === true : requirePlans === true);
  return config;
}

function validatePaypalRuntimeConfig(environment = process.env) {
  if (!isPaypalEnabled(environment)) return null;
  return validatePaypalConfig(environment, { purpose: 'runtime' });
}

function assertPaypalLiveEnabled(environment = process.env) {
  if (isPaypalLive(environment) && !enabled(environment.PAYPAL_LIVE_ENABLED)) {
    fail('PAYPAL_LIVE_NOT_ENABLED', 'Live PayPal operations are disabled. Set PAYPAL_LIVE_ENABLED=true only after cutover approval.');
  }
}

module.exports = { PAYPAL_BASE_URLS, PAYPAL_VALIDATION_PURPOSES, REQUIRED_PLAN_MAPPINGS, PayPalConfigError, appPublicUrl,
  assertPaypalLiveEnabled, getPaypalApiBaseUrl, getPaypalConfig, getPaypalEnvironment, getPaypalPlanId,
  getPaypalPlanVariableName, getPaypalRedirectUrls, isPaypalEnabled, isPaypalLive, isPaypalSandbox,
  legacyPlanVariable, planMappingKey, selectedValue, validatePaypalConfig, validatePaypalRuntimeConfig };
