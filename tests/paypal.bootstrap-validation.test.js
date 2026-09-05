'use strict';

process.env.NODE_ENV = 'test';

const { getPaypalConfig, validatePaypalConfig } = require('../src/config/paypal');
const { billingPlanPayload, planDefinitions, provisionSandboxPlans } = require('../src/services/paypal/paypalProvisioning.service');
const { run: checkConfiguration } = require('../scripts/paypal/checkConfiguration');
const { run: validateResources } = require('../scripts/paypal/validateResources');
const { run: provisionWebhook } = require('../scripts/paypal/provisionSandboxWebhook');

function credentials(overrides = {}) {
  return { PAYPAL_ENV: 'sandbox', PAYPAL_SANDBOX_CLIENT_ID: 'sandbox-client',
    PAYPAL_SANDBOX_CLIENT_SECRET: 'sandbox-secret', ...overrides };
}

function runtime(overrides = {}) {
  return { ...credentials(), PAYMENT_PROVIDER: 'paypal', APP_PUBLIC_URL: 'http://localhost:4200',
    PAYPAL_SANDBOX_WEBHOOK_ID: 'WH-SANDBOX', PAYPAL_SANDBOX_PRODUCT_ID: 'PROD-SANDBOX',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY: 'P-ESSENTIAL-MONTHLY',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL: 'P-ESSENTIAL-ANNUAL',
    PAYPAL_SANDBOX_PLAN_PRO_MONTHLY: 'P-PRO-MONTHLY', PAYPAL_SANDBOX_PLAN_PRO_ANNUAL: 'P-PRO-ANNUAL',
    ...overrides };
}

function applicationPlans() {
  return [
    { slug: 'free', name: 'Free', price: 0, annualPrice: 0, currency: 'USD', isActive: true },
    { slug: 'essential', name: 'Essential', price: 24.99, annualPrice: 249, currency: 'USD', isActive: true },
    { slug: 'pro', name: 'Pro', price: 49.99, annualPrice: 499, currency: 'USD', isActive: true },
    { slug: 'institution', name: 'Institution', price: 0, currency: 'USD', isActive: true }
  ];
}

function product(id = 'PROD-SANDBOX') {
  return { id, name: 'RoznaHub / CoMarker Subscription',
    description: 'Teacher SaaS subscription for RoznaHub / CoMarker.', type: 'SERVICE', category: 'SOFTWARE' };
}

function fullPlan(id, productId, definition) { return { id, ...billingPlanPayload(productId, definition) }; }

function provisioningClient({ productId = 'PROD-SANDBOX', configuredPlans = new Map(), listedPlans = [] } = {}) {
  const created = new Map();
  let sequence = 0;
  const definitions = planDefinitions(applicationPlans());
  return {
    environment: 'sandbox',
    listProducts: jest.fn().mockResolvedValue({ products: [] }),
    createProduct: jest.fn().mockResolvedValue({ id: productId }),
    getProduct: jest.fn().mockResolvedValue(product(productId)),
    listPlans: jest.fn().mockResolvedValue({ plans: listedPlans }),
    createPlan: jest.fn(async (payload) => {
      sequence += 1;
      const id = `P-CREATED-${sequence}`;
      const plan = { id, ...payload };
      created.set(id, plan);
      return { id };
    }),
    getPlan: jest.fn(async (id) => {
      if (configuredPlans.has(id)) return configuredPlans.get(id);
      if (created.has(id)) return created.get(id);
      const listed = listedPlans.find((item) => item.id === id);
      if (listed) {
        const definition = definitions.find((item) => `${item.planKey}-${item.interval}` === listed.definitionKey);
        return fullPlan(id, productId, definition);
      }
      return null;
    })
  };
}

describe('PayPal provisioning bootstrap validation contexts', () => {
  test('A: provisioning accepts all four missing Plan IDs and creates only the four paid plans', async () => {
    expect(() => validatePaypalConfig(credentials(), { purpose: 'provisioning' })).not.toThrow();
    const client = provisioningClient();
    const result = await provisionSandboxPlans({ client, plans: applicationPlans(), environment: credentials(), logger: {} });
    expect(result.plans).toHaveLength(4);
    expect(client.createPlan).toHaveBeenCalledTimes(4);
  });

  test('B: an existing Product and one configured Plan are reused while three missing plans are created', async () => {
    const definitions = planDefinitions(applicationPlans());
    const existing = definitions[0];
    const configuredPlans = new Map([['P-EXISTING', fullPlan('P-EXISTING', 'PROD-SANDBOX', existing)]]);
    const environment = credentials({ PAYPAL_SANDBOX_PRODUCT_ID: 'PROD-SANDBOX',
      PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY: 'P-EXISTING' });
    const client = provisioningClient({ configuredPlans });
    const result = await provisionSandboxPlans({ client, plans: applicationPlans(), environment, logger: {} });
    expect(result.product.action).toBe('reused');
    expect(result.plans).toEqual(expect.arrayContaining([expect.objectContaining({ planId: 'P-EXISTING', action: 'reused' })]));
    expect(client.createPlan).toHaveBeenCalledTimes(3);
  });

  test('C: one discoverable existing Plan is recovered and only the other three are created', async () => {
    const listedPlans = [{ id: 'P-DISCOVERED', name: 'Essential Monthly', definitionKey: 'essential-monthly' }];
    const client = provisioningClient({ listedPlans });
    const result = await provisionSandboxPlans({ client, plans: applicationPlans(),
      environment: credentials({ PAYPAL_SANDBOX_PRODUCT_ID: 'PROD-SANDBOX' }), logger: {} });
    expect(result.plans).toEqual(expect.arrayContaining([expect.objectContaining({ planId: 'P-DISCOVERED', action: 'discovered' })]));
    expect(client.createPlan).toHaveBeenCalledTimes(3);
  });

  test('D: normal runtime remains fail-closed when a required Plan ID is missing', () => {
    const environment = runtime(); delete environment.PAYPAL_SANDBOX_PLAN_PRO_ANNUAL;
    expect(() => validatePaypalConfig(environment, { purpose: 'runtime' }))
      .toThrow(/Missing PAYPAL_SANDBOX_PLAN_PRO_ANNUAL/u);
  });

  test('E: paypal:check:auth needs credentials but no Product, Plan, or Webhook IDs', async () => {
    const getAccessToken = jest.fn().mockResolvedValue('token');
    const result = await checkConfiguration({ environment: credentials(), authenticate: true,
      output: { log: jest.fn() }, clientFactory: () => ({ getAccessToken }) });
    expect(result).toEqual({ ok: true, authenticated: true });
    expect(getAccessToken).toHaveBeenCalledTimes(1);
  });

  test('F: validate-resources fails clearly before DB/API work when required IDs are missing', async () => {
    await expect(validateResources({ environment: credentials(), client: {}, PlanModel: {} }))
      .rejects.toThrow(/Missing PAYPAL_SANDBOX_PRODUCT_ID/u);
  });

  test('G: Sandbox webhook provisioning requires credentials and public URL, not subscription resources', async () => {
    const client = { listWebhooks: jest.fn().mockResolvedValue({ webhooks: [] }),
      createWebhook: jest.fn().mockResolvedValue({ id: 'WH-NEW' }) };
    await expect(provisionWebhook({ environment: credentials({ PAYPAL_WEBHOOK_URL: 'https://hooks.example.com/paypal' }),
      client, output: { log: jest.fn() } })).resolves.toMatchObject({ id: 'WH-NEW' });
    expect(client.createWebhook).toHaveBeenCalledTimes(1);
  });

  test('H: every provisioning context refuses Live mode even when Live credentials exist', () => {
    const live = { PAYPAL_ENV: 'live', PAYPAL_LIVE_CLIENT_ID: 'live-client', PAYPAL_LIVE_CLIENT_SECRET: 'live-secret' };
    expect(() => validatePaypalConfig(live, { purpose: 'provisioning' }))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_SANDBOX_REQUIRED' }));
    expect(() => validatePaypalConfig(live, { purpose: 'webhookProvisioning' }))
      .toThrow(expect.objectContaining({ code: 'PAYPAL_SANDBOX_REQUIRED' }));
  });

  test('I: selected-environment credentials never fall back to generic or opposite-environment values', () => {
    const genericOnly = { PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'generic', PAYPAL_CLIENT_SECRET: 'generic-secret' };
    expect(getPaypalConfig(genericOnly)).toMatchObject({ clientId: '', clientSecret: '' });
    expect(() => validatePaypalConfig(genericOnly, { purpose: 'authentication' }))
      .toThrow(/PAYPAL_SANDBOX_CLIENT_ID/u);
    const live = { ...credentials(), PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'generic', PAYPAL_CLIENT_SECRET: 'generic-secret' };
    expect(getPaypalConfig(live)).toMatchObject({ clientId: '', clientSecret: '' });
  });
});
