'use strict';

const { PayPalClient, PayPalApiError } = require('../src/services/paypal/paypalClient.service');
const {
  getPayPalPlanId, planIdEnvName
} = require('../src/services/paypal/paypalPlanMapping.service');
const { validatePaypalRuntimeConfig: validatePayPalRuntimeConfig } = require('../src/config/paypal');
const {
  assertPlanMatches, billingPlanPayload, cleanProductPayload, normalizeMoneyString, normalizePayPalPlan,
  planDefinitions, provisionSandboxPlans
} = require('../src/services/paypal/paypalProvisioning.service');
const {
  StripePaymentProvider, configuredProviderName
} = require('../src/services/payments/paymentProvider.service');

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => payload === null ? '' : JSON.stringify(payload)
  };
}

function plans() {
  return [
    { slug: 'free', name: 'Free', price: 0, annualPrice: 0, currency: 'USD', isActive: true },
    { slug: 'essential', name: 'Essential', price: 24.99, annualPrice: 249, currency: 'USD', isActive: true },
    { slug: 'pro', name: 'Pro', price: 49.99, annualPrice: 499, currency: 'USD', isActive: true }
  ];
}

function paypalPlan(id, productId, definition) {
  return { id, ...billingPlanPayload(productId, definition) };
}

function annualDefinition() {
  return planDefinitions([{ slug: 'essential_annual', name: 'Essential Annual', price: 99,
    currency: 'USD', billingInterval: 'year', isActive: true }])[0];
}

function realAnnualPlan(overrides = {}) {
  return {
    id: 'P-4E985073TK7549318NKKABMQ', product_id: 'PROD-3X898607EB833701R',
    name: 'Essential Annual', status: 'ACTIVE',
    billing_cycles: [{ frequency: { interval_unit: 'YEAR', interval_count: 1 }, tenure_type: 'REGULAR',
      sequence: 1, total_cycles: 0,
      pricing_scheme: { fixed_price: { value: '99.0', currency_code: 'USD' } } }],
    payment_preferences: { auto_bill_outstanding: true, payment_failure_threshold: 3 },
    ...overrides
  };
}

function paypalProduct(id = 'PROD-SAFE') {
  return { id, name: 'RoznaHub / CoMarker Subscription',
    description: 'Teacher SaaS subscription for RoznaHub / CoMarker.', type: 'SERVICE', category: 'SOFTWARE' };
}

function planModel(document) {
  return { findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(document) })) };
}

describe('PayPal REST client foundation', () => {
  test('obtains a sandbox OAuth token with Client Credentials', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { access_token: 'sandbox-token', expires_in: 3600 }));
    const logger = { info: jest.fn() };
    const client = new PayPalClient({ clientId: 'client-id', clientSecret: 'client-secret', fetchImpl, logger });
    await expect(client.getAccessToken()).resolves.toBe('sandbox-token');
    expect(fetchImpl).toHaveBeenCalledWith('https://api-m.sandbox.paypal.com/v1/oauth2/token', expect.objectContaining({ method: 'POST' }));
    expect(fetchImpl.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /u);
    expect(logger.info).toHaveBeenCalledWith('[PAYPAL] OAuth token acquired environment=sandbox');
  });

  test('caches an OAuth token until near expiry', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { access_token: 'cached-token', expires_in: 3600 }));
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, logger: {}, now: () => 1000 });
    expect(await client.getAccessToken()).toBe('cached-token');
    expect(await client.getAccessToken()).toBe('cached-token');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('normalizes PayPal API failures without exposing secrets or tokens', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'sensitive-access-token', expires_in: 3600 }))
      .mockResolvedValueOnce(response(400, { name: 'INVALID_REQUEST', message: 'client_secret=secret-value access_token=token-value' }));
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret-value', fetchImpl, logger: {} });
    const error = await client.listProducts().catch((item) => item);
    expect(error).toBeInstanceOf(PayPalApiError);
    expect(error.code).toBe('PAYPAL_API_ERROR');
    expect(error.message).not.toContain('secret-value');
    expect(error.message).not.toContain('token-value');
    expect(JSON.stringify(error)).not.toContain('sensitive-access-token');
  });

  test('sends the deterministic Catalog Product creation request', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(200, { access_token: 'token', expires_in: 3600 }))
      .mockResolvedValueOnce(response(201, { id: 'PROD-SAFE' }));
    const client = new PayPalClient({ clientId: 'id', clientSecret: 'secret', fetchImpl, logger: {} });
    await client.createProduct(cleanProductPayload());
    const call = fetchImpl.mock.calls[1];
    expect(call[0]).toBe('https://api-m.sandbox.paypal.com/v1/catalogs/products');
    const payload = JSON.parse(call[1].body);
    expect(payload).toEqual({ name: 'RoznaHub / CoMarker Subscription',
      description: 'Teacher SaaS subscription for RoznaHub / CoMarker.', type: 'SERVICE', category: 'SOFTWARE' });
    expect(payload).not.toHaveProperty('custom_id');
  });

  test('builds a fixed monthly Billing Plan request', () => {
    const definition = planDefinitions(plans()).find((item) => item.planKey === 'essential' && item.interval === 'monthly');
    const payload = billingPlanPayload('PROD-SAFE', definition);
    expect(Object.keys(payload).sort()).toEqual(['billing_cycles', 'description', 'name', 'payment_preferences', 'product_id', 'status']);
    expect(payload.status).toBe('ACTIVE');
    expect(payload.payment_preferences).toEqual({ auto_bill_outstanding: true, payment_failure_threshold: 3 });
    expect(payload.billing_cycles[0]).toMatchObject({
      frequency: { interval_unit: 'MONTH', interval_count: 1 }, tenure_type: 'REGULAR', total_cycles: 0,
      pricing_scheme: { fixed_price: { value: '24.99', currency_code: 'USD' } }
    });
  });

  test('builds a fixed yearly Billing Plan request', () => {
    const definition = planDefinitions(plans()).find((item) => item.planKey === 'pro' && item.interval === 'yearly');
    const payload = billingPlanPayload('PROD-SAFE', definition);
    expect(payload.billing_cycles[0]).toMatchObject({
      frequency: { interval_unit: 'YEAR', interval_count: 1 }, tenure_type: 'REGULAR',
      pricing_scheme: { fixed_price: { value: '499.00', currency_code: 'USD' } }
    });
  });
});

describe('PayPal plan mapping', () => {
  test('maps an internal plan and interval only through its backend environment variable', async () => {
    const model = planModel({ slug: 'essential', price: 24.99, annualPrice: 249, isActive: true });
    await expect(getPayPalPlanId({ planKey: 'essential', billingInterval: 'monthly' }, {
      PlanModel: model, environment: { PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID: 'P-SAFE' }
    })).resolves.toBe('P-SAFE');
    expect(planIdEnvName('essential', 'yearly')).toBe('PAYPAL_ESSENTIAL_YEARLY_PLAN_ID');
    expect(planIdEnvName('essential_monthly', 'monthly')).toBe('PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID');
    expect(planIdEnvName('essential_annual', 'yearly')).toBe('PAYPAL_ESSENTIAL_ANNUAL_PLAN_ID');
  });

  test('rejects the free plan as not billable', async () => {
    await expect(getPayPalPlanId({ planKey: 'free', billingInterval: 'monthly' }, { PlanModel: planModel({ slug: 'free', price: 0, isActive: true }), environment: {} }))
      .rejects.toMatchObject({ code: 'PAYPAL_PLAN_NOT_BILLABLE' });
  });

  test('rejects an unknown plan', async () => {
    await expect(getPayPalPlanId({ planKey: 'attacker-plan', billingInterval: 'monthly' }, { PlanModel: planModel(null), environment: {} }))
      .rejects.toMatchObject({ code: 'PAYPAL_PLAN_UNKNOWN' });
  });

  test('reports PAYPAL_PLAN_NOT_CONFIGURED when the trusted mapping is absent', async () => {
    await expect(getPayPalPlanId({ planKey: 'pro', billingInterval: 'yearly' }, {
      PlanModel: planModel({ slug: 'pro', price: 49.99, annualPrice: 499, isActive: true }), environment: {}
    })).rejects.toMatchObject({ code: 'PAYPAL_PLAN_NOT_CONFIGURED' });
  });
});

describe('PayPal Plan response normalization', () => {
  test('normalizes the real GET Plan response shape', () => {
    expect(normalizePayPalPlan(realAnnualPlan())).toMatchObject({
      planId: 'P-4E985073TK7549318NKKABMQ', productId: 'PROD-3X898607EB833701R', status: 'ACTIVE',
      intervalUnit: 'YEAR', intervalCount: 1, totalCycles: 0, price: '99.00', rawPrice: '99.0', currency: 'USD'
    });
  });

  test('accepts the exact real annual Plan without a false price mismatch', () => {
    expect(() => assertPlanMatches(realAnnualPlan(), annualDefinition(), 'PROD-3X898607EB833701R',
      'P-4E985073TK7549318NKKABMQ')).not.toThrow();
  });

  test('normalizes 99, 99.0, and 99.00 as equal money', () => {
    expect(['99', '99.0', '99.00'].map(normalizeMoneyString)).toEqual(['99.00', '99.00', '99.00']);
    expect(() => assertPlanMatches(realAnnualPlan({ billing_cycles: [{
      ...realAnnualPlan().billing_cycles[0], pricing_scheme: { fixed_price: { value: '99', currency_code: 'USD' } }
    }] }), annualDefinition(), 'PROD-3X898607EB833701R')).not.toThrow();
  });

  test.each([
    ['wrong price', { value: '98.99', currency_code: 'USD' }],
    ['wrong currency', { value: '99.00', currency_code: 'EUR' }]
  ])('%s is a true PAYPAL_PLAN_PRICE_MISMATCH', (_label, fixedPrice) => {
    const plan = realAnnualPlan({ billing_cycles: [{
      ...realAnnualPlan().billing_cycles[0], pricing_scheme: { fixed_price: fixedPrice }
    }] });
    expect(() => assertPlanMatches(plan, annualDefinition(), 'PROD-3X898607EB833701R'))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_PLAN_PRICE_MISMATCH' }));
  });

  test('rejects a missing REGULAR billing cycle distinctly', () => {
    const plan = realAnnualPlan({ billing_cycles: [{ tenure_type: 'TRIAL', sequence: 1, total_cycles: 1 }] });
    expect(() => assertPlanMatches(plan, annualDefinition(), 'PROD-3X898607EB833701R'))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_PLAN_REGULAR_CYCLE_MISSING' }));
  });

  test.each([
    ['pricing_scheme', { frequency: { interval_unit: 'YEAR', interval_count: 1 }, tenure_type: 'REGULAR', total_cycles: 0 }],
    ['fixed_price', { frequency: { interval_unit: 'YEAR', interval_count: 1 }, tenure_type: 'REGULAR', total_cycles: 0, pricing_scheme: {} }]
  ])('rejects missing %s as PAYPAL_PLAN_PRICING_MISSING', (_label, cycle) => {
    expect(() => assertPlanMatches(realAnnualPlan({ billing_cycles: [cycle] }), annualDefinition(), 'PROD-3X898607EB833701R'))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_PLAN_PRICING_MISSING' }));
  });

  test('rejects the wrong interval independently from price', () => {
    const plan = realAnnualPlan({ billing_cycles: [{ ...realAnnualPlan().billing_cycles[0],
      frequency: { interval_unit: 'MONTH', interval_count: 1 } }] });
    expect(() => assertPlanMatches(plan, annualDefinition(), 'PROD-3X898607EB833701R'))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_PLAN_BILLING_MISMATCH' }));
  });

  test('rejects the wrong product ID independently from price', () => {
    expect(() => assertPlanMatches(realAnnualPlan({ product_id: 'PROD-OTHER' }), annualDefinition(), 'PROD-3X898607EB833701R'))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_PLAN_PRODUCT_MISMATCH' }));
  });

  test('finds REGULAR pricing after multiple trial cycles', () => {
    const regular = realAnnualPlan().billing_cycles[0];
    const plan = realAnnualPlan({ billing_cycles: [
      { tenure_type: 'TRIAL', sequence: 1, total_cycles: 1 },
      { tenure_type: 'TRIAL', sequence: 2, total_cycles: 2 }, regular
    ] });
    expect(normalizePayPalPlan(plan)).toMatchObject({ intervalUnit: 'YEAR', price: '99.00', currency: 'USD' });
  });
});

describe('PayPal Sandbox provisioner safety', () => {
  test('uses exact split-record plan keys, intervals, and environment names', () => {
    const definitions = planDefinitions([
      { slug: 'essential_monthly', name: 'Essential Monthly', price: 9.99, currency: 'USD', billingInterval: 'month', isActive: true },
      { slug: 'essential_annual', name: 'Essential Annual', price: 99, currency: 'USD', billingInterval: 'year', isActive: true }
    ]);
    expect(definitions).toEqual([
      expect.objectContaining({ planKey: 'essential_monthly', interval: 'monthly', frequencyUnit: 'MONTH', price: '9.99', envName: 'PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID' }),
      expect.objectContaining({ planKey: 'essential_annual', interval: 'yearly', frequencyUnit: 'YEAR', price: '99.00', envName: 'PAYPAL_ESSENTIAL_ANNUAL_PLAN_ID' })
    ]);
  });

  test('dry-run detects plans but makes no PayPal calls and creates no resources', async () => {
    const client = { environment: 'sandbox', createProduct: jest.fn(), createPlan: jest.fn() };
    const result = await provisionSandboxPlans({ client, plans: plans(), environment: { PAYPAL_ENV: 'sandbox' }, dryRun: true });
    expect(result.plans).toHaveLength(4);
    expect(client.createProduct).not.toHaveBeenCalled();
    expect(client.createPlan).not.toHaveBeenCalled();
  });

  test('a second provisioning run reuses the manifest and creates no duplicates', async () => {
    const definitions = planDefinitions(plans());
    const createdPlans = new Map();
    let productCreates = 0; let planCreates = 0; let saved;
    const client = {
      environment: 'sandbox',
      listProducts: jest.fn().mockResolvedValue({ products: [] }),
      createProduct: jest.fn(async () => { productCreates += 1; return { id: 'PROD-SAFE' }; }),
      getProduct: jest.fn().mockResolvedValue(paypalProduct()),
      listPlans: jest.fn().mockResolvedValue({ plans: [] }),
      createPlan: jest.fn(async (payload) => {
        planCreates += 1; const definition = definitions.find((item) => item.name === payload.name) ||
          definitions.find((item) => billingPlanPayload('PROD-SAFE', item).name === payload.name);
        const result = { id: `P-${planCreates}`, ...payload }; createdPlans.set(result.id, result); return result;
      }),
      getPlan: jest.fn(async (id) => createdPlans.get(id))
    };
    const first = await provisionSandboxPlans({ client, plans: plans(), environment: { PAYPAL_ENV: 'sandbox' }, saveManifest: async (value) => { saved = value; }, logger: {} });
    expect(first.plans).toHaveLength(4);
    await provisionSandboxPlans({ client, plans: plans(), environment: { PAYPAL_ENV: 'sandbox' }, manifest: saved, saveManifest: async () => {}, logger: {} });
    expect(productCreates).toBe(1);
    expect(planCreates).toBe(4);
  });

  test('explicit existing Product and Plan IDs are reused and verified', async () => {
    const definition = planDefinitions(plans()).find((item) => item.planKey === 'essential' && item.interval === 'monthly');
    const client = {
      environment: 'sandbox', getProduct: jest.fn().mockResolvedValue(paypalProduct('PROD-EXISTING')),
      listPlans: jest.fn().mockResolvedValue({ plans: [] }),
      getPlan: jest.fn().mockResolvedValue(paypalPlan('P-EXISTING', 'PROD-EXISTING', definition)),
      createProduct: jest.fn(), createPlan: jest.fn()
    };
    const result = await provisionSandboxPlans({ client, plans: [{ slug: 'essential', name: 'Essential', price: 24.99, currency: 'USD', isActive: true }],
      environment: { PAYPAL_ENV: 'sandbox', PAYPAL_PRODUCT_ID: 'PROD-EXISTING', PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID: 'P-EXISTING' }, logger: {} });
    expect(result.product.action).toBe('reused');
    expect(result.plans[0]).toMatchObject({ planId: 'P-EXISTING', action: 'reused' });
    expect(client.createProduct).not.toHaveBeenCalled(); expect(client.createPlan).not.toHaveBeenCalled();
  });

  test('a discovered Product is verified before it is reused', async () => {
    const client = {
      environment: 'sandbox',
      listProducts: jest.fn().mockResolvedValue({ products: [{ id: 'PROD-WRONG', name: 'RoznaHub / CoMarker Subscription', type: 'SERVICE' }] }),
      getProduct: jest.fn().mockResolvedValue({ ...paypalProduct('PROD-WRONG'), description: 'An unrelated merchant product.' }),
      createProduct: jest.fn().mockResolvedValue(paypalProduct('PROD-NEW')),
      listPlans: jest.fn().mockResolvedValue({ plans: [] }),
      createPlan: jest.fn((payload) => Promise.resolve({ id: 'P-NEW', ...payload })),
      getPlan: jest.fn().mockImplementation(() => paypalPlan('P-NEW', 'PROD-NEW', planDefinitions([
        { slug: 'essential', name: 'Essential', price: 24.99, currency: 'USD', isActive: true }
      ])[0]))
    };
    const result = await provisionSandboxPlans({ client,
      plans: [{ slug: 'essential', name: 'Essential', price: 24.99, currency: 'USD', isActive: true }],
      environment: { PAYPAL_ENV: 'sandbox' }, logger: {} });
    expect(result.product).toMatchObject({ productId: 'PROD-NEW', action: 'created' });
    expect(client.getProduct).toHaveBeenCalledWith('PROD-WRONG');
    expect(client.createProduct).toHaveBeenCalledTimes(1);
  });

  test('validates a minimal Create Plan response through authoritative GET Plan details', async () => {
    const client = {
      environment: 'sandbox', getProduct: jest.fn().mockResolvedValue(paypalProduct('PROD-EXISTING')),
      listPlans: jest.fn().mockResolvedValue({ plans: [] }),
      createPlan: jest.fn().mockResolvedValue({ id: 'P-4E985073TK7549318NKKABMQ', status: 'ACTIVE' }),
      getPlan: jest.fn().mockResolvedValue(realAnnualPlan())
    };
    const result = await provisionSandboxPlans({ client,
      plans: [{ slug: 'essential_annual', name: 'Essential Annual', price: 99, currency: 'USD', billingInterval: 'year', isActive: true }],
      environment: { PAYPAL_ENV: 'sandbox', PAYPAL_PRODUCT_ID: 'PROD-3X898607EB833701R' }, logger: {} });
    expect(result.plans[0]).toMatchObject({ planId: 'P-4E985073TK7549318NKKABMQ', action: 'created' });
    expect(client.getPlan).toHaveBeenCalledWith('P-4E985073TK7549318NKKABMQ');
  });

  test('uses a list result only as a candidate then validates the full GET response', async () => {
    const client = {
      environment: 'sandbox', getProduct: jest.fn().mockResolvedValue(paypalProduct('PROD-3X898607EB833701R')),
      listPlans: jest.fn().mockResolvedValue({ plans: [{ id: 'P-4E985073TK7549318NKKABMQ', name: 'Essential Annual' }] }),
      getPlan: jest.fn().mockResolvedValue(realAnnualPlan()), createPlan: jest.fn()
    };
    const result = await provisionSandboxPlans({ client,
      plans: [{ slug: 'essential_annual', name: 'Essential Annual', price: 99, currency: 'USD', billingInterval: 'year', isActive: true }],
      environment: { PAYPAL_ENV: 'sandbox', PAYPAL_PRODUCT_ID: 'PROD-3X898607EB833701R' }, logger: {} });
    expect(result.plans[0]).toMatchObject({ planId: 'P-4E985073TK7549318NKKABMQ', action: 'discovered' });
    expect(client.getPlan).toHaveBeenCalledWith('P-4E985073TK7549318NKKABMQ');
    expect(client.createPlan).not.toHaveBeenCalled();
  });

  test('an existing PayPal price mismatch fails with safe expected and actual values', async () => {
    const definition = planDefinitions(plans()).find((item) => item.planKey === 'essential' && item.interval === 'monthly');
    const mismatched = paypalPlan('P-OLD', 'PROD-EXISTING', { ...definition, price: '19.99' });
    const client = { environment: 'sandbox', getProduct: jest.fn().mockResolvedValue(paypalProduct('PROD-EXISTING')),
      listPlans: jest.fn().mockResolvedValue({ plans: [] }), getPlan: jest.fn().mockResolvedValue(mismatched), createPlan: jest.fn() };
    const error = await provisionSandboxPlans({ client, plans: [{ slug: 'essential', name: 'Essential', price: 24.99, currency: 'USD', isActive: true }],
      environment: { PAYPAL_ENV: 'sandbox', PAYPAL_PRODUCT_ID: 'PROD-EXISTING', PAYPAL_ESSENTIAL_MONTHLY_PLAN_ID: 'P-OLD' }, logger: {} }).catch((item) => item);
    expect(error).toMatchObject({ code: 'PAYPAL_PLAN_PRICE_MISMATCH', details: {
      planKey: 'essential', billingInterval: 'monthly', expectedApplicationPrice: '24.99', paypalPlanPrice: '19.99'
    } });
    expect(client.createPlan).not.toHaveBeenCalled();
  });

  test('refuses non-sandbox provisioning', async () => {
    await expect(provisionSandboxPlans({ client: { environment: 'live' }, plans: plans(), environment: { PAYPAL_ENV: 'live' } }))
      .rejects.toMatchObject({ code: 'PAYPAL_SANDBOX_REQUIRED' });
  });
});

describe('payment-provider non-regression', () => {
  test('defaults to Stripe and leaves Stripe client creation behind the existing adapter', () => {
    const existingStripe = { existing: true };
    expect(configuredProviderName({})).toBe('stripe');
    expect(new StripePaymentProvider({ clientFactory: () => existingStripe }).getClient()).toBe(existingStripe);
  });

  test('Stripe-active startup does not require any PayPal IDs', () => {
    expect(() => validatePayPalRuntimeConfig({ PAYMENT_PROVIDER: 'stripe' })).not.toThrow();
  });

  test('PayPal runtime accepts isolated Sandbox and Live configurations without cross-environment fallback', () => {
    expect(() => validatePayPalRuntimeConfig({ PAYMENT_PROVIDER: 'paypal', PAYPAL_ENV: 'live' }))
      .toThrow('PAYPAL_LIVE_CLIENT_ID');
    const common = { PAYMENT_PROVIDER: 'paypal', APP_PUBLIC_URL: 'http://localhost:4200' };
    const sandbox = { ...common, PAYPAL_ENV: 'sandbox', PAYPAL_SANDBOX_CLIENT_ID: 'sandbox-id',
      PAYPAL_SANDBOX_CLIENT_SECRET: 'sandbox-secret', PAYPAL_SANDBOX_PRODUCT_ID: 'PROD-SANDBOX',
      PAYPAL_SANDBOX_WEBHOOK_ID: 'WH-SANDBOX', PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY: 'P-S-E-M',
      PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL: 'P-S-E-A', PAYPAL_SANDBOX_PLAN_PRO_MONTHLY: 'P-S-P-M',
      PAYPAL_SANDBOX_PLAN_PRO_ANNUAL: 'P-S-P-A' };
    const live = { ...common, PAYPAL_ENV: 'live', PAYPAL_LIVE_ENABLED: 'false', PAYPAL_LIVE_CLIENT_ID: 'live-id',
      PAYPAL_LIVE_CLIENT_SECRET: 'live-secret', PAYPAL_LIVE_PRODUCT_ID: 'PROD-LIVE',
      PAYPAL_LIVE_WEBHOOK_ID: 'WH-LIVE', PAYPAL_LIVE_PLAN_ESSENTIAL_MONTHLY: 'P-L-E-M',
      PAYPAL_LIVE_PLAN_ESSENTIAL_ANNUAL: 'P-L-E-A', PAYPAL_LIVE_PLAN_PRO_MONTHLY: 'P-L-P-M',
      PAYPAL_LIVE_PLAN_PRO_ANNUAL: 'P-L-P-A' };
    expect(() => validatePayPalRuntimeConfig(sandbox)).not.toThrow();
    expect(() => validatePayPalRuntimeConfig(live)).not.toThrow();
    expect(() => validatePayPalRuntimeConfig({ ...live, PAYPAL_LIVE_CLIENT_ID: '', PAYPAL_CLIENT_ID: 'legacy-id' }))
      .toThrow('PAYPAL_LIVE_CLIENT_ID');
  });
});
