'use strict';

process.env.NODE_ENV = 'test';

const {
  getPaypalApiBaseUrl, getPaypalConfig, getPaypalPlanId, getPaypalRedirectUrls, validatePaypalConfig
} = require('../src/config/paypal');
const { PayPalClient, redact } = require('../src/services/paypal/paypalClient.service');
const { validatePayPalResources } = require('../src/services/paypal/paypalResourceValidation.service');
const PaymentProviderEvent = require('../src/models/PaymentProviderEvent');
const PaymentCheckoutAttempt = require('../src/models/PaymentCheckoutAttempt');
const PaymentManagementAttempt = require('../src/models/PaymentManagementAttempt');
const PaymentPurchaseAttempt = require('../src/models/PaymentPurchaseAttempt');
const CreditTransaction = require('../src/models/CreditTransaction');
const { paypalWebhook, verificationPayload } = require('../src/controllers/paypalWebhook.controller');

function configured(selected = 'sandbox') {
  const prefix = `PAYPAL_${selected.toUpperCase()}`;
  return { PAYMENT_PROVIDER: 'paypal', PAYPAL_ENABLED: 'true', PAYPAL_ENV: selected,
    PAYPAL_LIVE_ENABLED: 'false', APP_PUBLIC_URL: 'http://localhost:4200',
    [`${prefix}_CLIENT_ID`]: `${selected}-client`, [`${prefix}_CLIENT_SECRET`]: `${selected}-secret`,
    [`${prefix}_WEBHOOK_ID`]: `${selected}-webhook`, [`${prefix}_PRODUCT_ID`]: `${selected}-product`,
    [`${prefix}_PLAN_ESSENTIAL_MONTHLY`]: `${selected}-essential-monthly`,
    [`${prefix}_PLAN_ESSENTIAL_ANNUAL`]: `${selected}-essential-annual`,
    [`${prefix}_PLAN_PRO_MONTHLY`]: `${selected}-pro-monthly`,
    [`${prefix}_PLAN_PRO_ANNUAL`]: `${selected}-pro-annual` };
}

function response(status, payload) {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null },
    text: async () => JSON.stringify(payload) };
}

function product(id) { return { id, name: 'RoznaHub / CoMarker Subscription',
  description: 'Teacher SaaS subscription for RoznaHub / CoMarker.', type: 'SERVICE', category: 'SOFTWARE' }; }

function plan(id, productId, { amount = '9.99', currency = 'USD', unit = 'MONTH' } = {}) {
  return { id, product_id: productId, status: 'ACTIVE', billing_cycles: [{ tenure_type: 'REGULAR', total_cycles: 0,
    frequency: { interval_unit: unit, interval_count: 1 },
    pricing_scheme: { fixed_price: { value: amount, currency_code: currency } } }] };
}

const applicationPlans = [{ slug: 'essential_monthly', name: 'Essential Monthly', price: 9.99,
  currency: 'USD', billingInterval: 'month', isActive: true }];

describe('PayPal Phase 5 environment isolation', () => {
  test('sandbox loads only Sandbox credentials and resources', () => {
    const environment = { ...configured('sandbox'), ...configured('live'), PAYPAL_ENV: 'sandbox' };
    expect(getPaypalConfig(environment)).toMatchObject({ environment: 'sandbox', clientId: 'sandbox-client',
      clientSecret: 'sandbox-secret', webhookId: 'sandbox-webhook', productId: 'sandbox-product' });
  });

  test('live loads only Live credentials and resources', () => {
    const environment = { ...configured('sandbox'), ...configured('live'), PAYPAL_ENV: 'live' };
    expect(getPaypalConfig(environment)).toMatchObject({ environment: 'live', clientId: 'live-client',
      clientSecret: 'live-secret', webhookId: 'live-webhook', productId: 'live-product' });
  });

  test('invalid PAYPAL_ENV is rejected', () => {
    expect(() => getPaypalConfig({ PAYPAL_ENV: 'staging' })).toThrow(expect.objectContaining({ code: 'PAYPAL_ENV_INVALID' }));
  });

  test('missing selected credential names the missing environment-specific variable', () => {
    const environment = configured('live'); delete environment.PAYPAL_LIVE_CLIENT_SECRET;
    expect(() => validatePaypalConfig(environment)).toThrow(/PAYPAL_LIVE_CLIENT_SECRET/u);
  });

  test('live never falls back to generic or Sandbox credentials', () => {
    const environment = { ...configured('sandbox'), PAYPAL_ENV: 'live', PAYPAL_CLIENT_ID: 'legacy', PAYPAL_CLIENT_SECRET: 'legacy' };
    expect(getPaypalConfig(environment)).toMatchObject({ environment: 'live', clientId: '', clientSecret: '', webhookId: '' });
  });

  test('Sandbox webhook and Live plan mappings cannot cross environments', () => {
    const environment = { ...configured('sandbox'), ...configured('live'), PAYPAL_ENV: 'sandbox' };
    expect(getPaypalConfig(environment).webhookId).toBe('sandbox-webhook');
    environment.PAYPAL_ENV = 'live';
    expect(getPaypalPlanId('essential', 'monthly', environment).value).toBe('live-essential-monthly');
  });

  test('Live monetary call is blocked unless PAYPAL_LIVE_ENABLED is true', () => {
    const fetchImpl = jest.fn();
    const client = new PayPalClient({ environmentVariables: configured('live'), fetchImpl, logger: {} });
    expect(() => client.createOrder({}, 'stable-id')).toThrow(expect.objectContaining({ code: 'PAYPAL_LIVE_NOT_ENABLED' }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('Sandbox and Live hosts are selected explicitly and independently from NODE_ENV', () => {
    expect(getPaypalApiBaseUrl({ PAYPAL_ENV: 'sandbox', NODE_ENV: 'production' })).toBe('https://api-m.sandbox.paypal.com');
    expect(getPaypalApiBaseUrl({ PAYPAL_ENV: 'live', NODE_ENV: 'development' })).toBe('https://api-m.paypal.com');
  });

  test('trusted redirect generation keeps exact application origin and routes', () => {
    expect(getPaypalRedirectUrls('subscription', configured('sandbox'))).toEqual({
      returnUrl: 'http://localhost:4200/billing/paypal/success', cancelUrl: 'http://localhost:4200/billing/paypal/cancel'
    });
  });

  test('arbitrary external redirect configuration is rejected', () => {
    expect(() => getPaypalRedirectUrls('subscription', { ...configured('sandbox'),
      PAYPAL_RETURN_URL: 'https://attacker.example/callback' })).toThrow(/PAYPAL_RETURN_URL/u);
  });
});

describe('PayPal Phase 5 webhook and logging safety', () => {
  const req = { headers: { 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert',
    'paypal-transmission-id': 'transmission', 'paypal-transmission-sig': 'signature',
    'paypal-transmission-time': '2026-09-01T00:00:00Z' } };

  test('webhook verification uses the selected-environment Webhook ID', () => {
    expect(verificationPayload(req, {}, { ...configured('sandbox'), PAYPAL_LIVE_WEBHOOK_ID: 'wrong-live' }).webhook_id)
      .toBe('sandbox-webhook');
  });

  test('verification failure performs no payment-ledger mutation', async () => {
    const environment = configured('sandbox');
    const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
    Object.assign(process.env, environment);
    const verify = jest.spyOn(PayPalClient.prototype, 'verifyWebhookSignature').mockRejectedValue(new Error('bad signature'));
    const ledger = jest.spyOn(PaymentProviderEvent, 'create');
    const result = { statusCode: 0, body: null };
    const res = { status(code) { result.statusCode = code; return this; }, json(body) { result.body = body; return this; } };
    await paypalWebhook({ ...req, body: Buffer.from(JSON.stringify({ id: 'WH-BAD', event_type: 'PAYMENT.CAPTURE.COMPLETED' })) }, res);
    expect(result).toMatchObject({ statusCode: 400, body: { code: 'PAYPAL_WEBHOOK_VERIFICATION_FAILED' } });
    expect(ledger).not.toHaveBeenCalled(); verify.mockRestore(); ledger.mockRestore();
    for (const [key, oldValue] of Object.entries(previous)) {
      if (oldValue === undefined) delete process.env[key]; else process.env[key] = oldValue;
    }
  });

  test('provider error sanitization removes bearer, basic, secret, and token values', () => {
    const safe = redact('Authorization Bearer token-value Basic encoded-value client_secret=secret-value access_token=access-value');
    expect(safe).not.toMatch(/token-value|encoded-value|secret-value|access-value/u);
  });
});

describe('PayPal Phase 5 payment index audit', () => {
  function hasIndex(model, keys, options = {}) {
    return model.schema.indexes().some(([actualKeys, actualOptions]) =>
      JSON.stringify(actualKeys) === JSON.stringify(keys)
      && Object.entries(options).every(([key, value]) => JSON.stringify(actualOptions[key]) === JSON.stringify(value)));
  }

  test('economic identities and active operations retain their intended unique scopes', () => {
    expect(hasIndex(PaymentProviderEvent, { provider: 1, providerEventId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentCheckoutAttempt, { provider: 1, attemptId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentManagementAttempt, { provider: 1, attemptId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentManagementAttempt, { activeOperationKey: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentPurchaseAttempt, { provider: 1, attemptId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentPurchaseAttempt, { provider: 1, providerOrderId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(PaymentPurchaseAttempt, { provider: 1, providerCaptureId: 1 }, { unique: true })).toBe(true);
    expect(hasIndex(CreditTransaction, { idempotencyKey: 1 }, { unique: true })).toBe(true);
  });
});

describe('PayPal Phase 5 non-mutating resource validation', () => {
  function environment() { return configured('sandbox'); }
  function client(overrides = {}) { return { getProduct: jest.fn().mockResolvedValue(product('sandbox-product')),
    getPlan: jest.fn().mockResolvedValue(plan('sandbox-essential-monthly', 'sandbox-product')), ...overrides }; }

  test('mismatched product is rejected', async () => {
    const result = await validatePayPalResources({ client: client({ getProduct: jest.fn().mockResolvedValue(product('other')) }),
      plans: applicationPlans, environment: environment() });
    expect(result.product).toMatchObject({ pass: false, error: { code: 'PAYPAL_PRODUCT_ID_MISMATCH' } });
  });

  test.each([
    ['mismatched amount', { amount: '8.99' }, 'PAYPAL_PLAN_PRICE_MISMATCH'],
    ['mismatched currency', { currency: 'EUR' }, 'PAYPAL_PLAN_PRICE_MISMATCH'],
    ['wrong interval', { unit: 'YEAR' }, 'PAYPAL_PLAN_BILLING_MISMATCH']
  ])('%s is rejected', async (_label, override, code) => {
    const result = await validatePayPalResources({ client: client({ getPlan: jest.fn().mockResolvedValue(
      plan('sandbox-essential-monthly', 'sandbox-product', override)) }), plans: applicationPlans, environment: environment() });
    expect(result.plans[0]).toMatchObject({ pass: false, error: { code } });
  });

  test('valid product, amount, currency, interval, and status pass', async () => {
    await expect(validatePayPalResources({ client: client(), plans: applicationPlans, environment: environment() }))
      .resolves.toMatchObject({ pass: true, product: { pass: true }, plans: [{ pass: true }] });
  });

  test('Live API client uses Live OAuth host when explicitly enabled without making a monetary call', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, { access_token: 'safe-token', expires_in: 60 }));
    const env = { ...configured('live'), PAYPAL_LIVE_ENABLED: 'true' };
    await new PayPalClient({ environmentVariables: env, fetchImpl, logger: {} }).getAccessToken();
    expect(fetchImpl.mock.calls[0][0]).toBe('https://api-m.paypal.com/v1/oauth2/token');
  });
});
