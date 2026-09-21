'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase4-test-secret-with-at-least-32-characters';

const { validateProductionSecurity } = require('../src/config/env');

function production(overrides = {}) {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'a-production-secret-with-more-than-32-characters',
    MONGO_URI: 'mongodb+srv://database.example.test/rozna',
    FRONTEND_URL: 'https://comarkers.roznahub.com',
    PUBLIC_API_URL: 'https://comarkerback.roznahub.com',
    CORS_ALLOWED_ORIGINS: 'https://comarkers.roznahub.com',
    PAYMENT_PROVIDER: 'paypal', PAYPAL_ENV: 'sandbox',
    PAYPAL_SANDBOX_CLIENT_ID: 'sandbox-client', PAYPAL_SANDBOX_CLIENT_SECRET: 'sandbox-secret',
    PAYPAL_SANDBOX_WEBHOOK_ID: 'WH-SANDBOX', PAYPAL_SANDBOX_PRODUCT_ID: 'PROD-SANDBOX',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY: 'P-ESSENTIAL-MONTHLY',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL: 'P-ESSENTIAL-ANNUAL',
    PAYPAL_SANDBOX_PLAN_PRO_MONTHLY: 'P-PRO-MONTHLY', PAYPAL_SANDBOX_PLAN_PRO_ANNUAL: 'P-PRO-ANNUAL',
    ...overrides
  };
}

describe('Phase 4 production security configuration', () => {
  test('accepts the exact HTTPS topology and PayPal provider', () => {
    expect(() => validateProductionSecurity(production({
      STRIPE_PUBLISHABLE_KEY: 'pk_test_public-identifier'
    }))).not.toThrow();
  });

  test.each([
    ['weak JWT secret', { JWT_SECRET: 'short' }, /JWT_SECRET/],
    ['localhost database', { MONGO_URI: 'mongodb://127.0.0.1/rozna' }, /MONGO_URI/],
    ['public production bind', { HOST: '0.0.0.0' }, /HOST must be 127\.0\.0\.1/],
    ['HTTP frontend', { FRONTEND_URL: 'http://comarkers.roznahub.com' }, /FRONTEND_URL/],
    ['wrong frontend host', { FRONTEND_URL: 'https://attacker.example' }, /FRONTEND_URL/],
    ['extra CORS origin', { CORS_ALLOWED_ORIGINS: 'https://comarkers.roznahub.com,https://attacker.example' }, /CORS/],
    ['Stripe provider', { PAYMENT_PROVIDER: 'stripe' }, /PAYMENT_PROVIDER/],
    ['missing provider', { PAYMENT_PROVIDER: undefined }, /PAYMENT_PROVIDER/]
  ])('fails closed for %s', (_label, values, expected) => {
    expect(() => validateProductionSecurity(production(values))).toThrow(expected);
  });

  test('does not impose production-only values on local development', () => {
    expect(() => validateProductionSecurity({ NODE_ENV: 'development' })).not.toThrow();
  });
});
