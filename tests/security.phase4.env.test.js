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
    STRIPE_SECRET_KEY: 'sk_test_placeholder-but-format-valid',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder-but-format-valid',
    ...overrides
  };
}

describe('Phase 4 production security configuration', () => {
  test('accepts the exact HTTPS topology and matching Stripe mode', () => {
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
    ['mixed Stripe modes', { STRIPE_PUBLISHABLE_KEY: 'pk_live_public-identifier' }, /modes do not match/]
  ])('fails closed for %s', (_label, values, expected) => {
    expect(() => validateProductionSecurity(production(values))).toThrow(expected);
  });

  test('does not impose production-only values on local development', () => {
    expect(() => validateProductionSecurity({ NODE_ENV: 'development' })).not.toThrow();
  });
});
