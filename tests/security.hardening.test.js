process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');

const app = require('../src/app');

describe('Security & Production Hardening', () => {
  test('Helmet sets key security headers', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);
    expect(res.body.runtime).toMatchObject({ applicationVersion: '1.0.0', contractHash: expect.stringMatching(/^[a-f0-9]{16}$/),
      contracts: { correctionSchema: 'semantic-corrections-v11-provider-compatible-symbol-coverage', rubricSchema: 'semantic-rubric-assessment-json-v5' } });

    // CSP
    expect(res.headers).toHaveProperty('content-security-policy');
    // HSTS should not be set in non-production
    expect(res.headers).not.toHaveProperty('strict-transport-security');

    // Clickjacking protection
    expect(res.headers['x-frame-options']).toBeTruthy();

    // Legacy XSS header disabled/controlled by Helmet
    expect(res.headers).toHaveProperty('x-xss-protection');
  });

  test('CORS blocks disallowed origins in production', async () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevFrontendUrl = process.env.FRONTEND_URL;

    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://allowed.example.com';

    jest.resetModules();
    const prodApp = require('../src/app');

    const res = await request(prodApp)
      .get('/api/health')
      .set('Origin', 'https://evil.example.com');

    expect([401, 403]).toContain(res.status);

    process.env.NODE_ENV = prevNodeEnv;
    process.env.FRONTEND_URL = prevFrontendUrl;
  }, 15000);

  test('Validation errors return consistent JSON', async () => {
    const res = await request(app)
      .post('/api/classes')
      .send({});

    // verifyJwtToken runs first, so this is unauthorized, but should still be consistent JSON
    expect([401, 400]).toContain(res.status);
    expect(res.body).toHaveProperty('success', false);
    expect(typeof res.body.message).toBe('string');
  });

  test('health and ordinary polling reads are not consumed by a global limiter', async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await request(app).get('/api/health')).status).toBe(200);
    }
  });

  test('sensitive routes are deterministically limited', async () => {
    const express = require('express');
    const { createSensitiveRateLimiter } = require('../src/middlewares/rateLimit.middleware');
    const prevWindow = process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS;
    const prevMax = process.env.SENSITIVE_RATE_LIMIT_MAX;
    process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS = '60000';
    process.env.SENSITIVE_RATE_LIMIT_MAX = '3';
    const limitedApp = express();
    limitedApp.post('/expensive', createSensitiveRateLimiter(), (_req, res) => res.json({ success: true }));
    const responses = [];
    for (let index = 0; index < 4; index += 1) responses.push(await request(limitedApp).post('/expensive'));
    expect(responses.map((response) => response.status)).toEqual([200, 200, 200, 429]);
    expect(responses[3].body).toHaveProperty('success', false);
    if (prevWindow === undefined) delete process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS;
    else process.env.SENSITIVE_RATE_LIMIT_WINDOW_MS = prevWindow;
    if (prevMax === undefined) delete process.env.SENSITIVE_RATE_LIMIT_MAX;
    else process.env.SENSITIVE_RATE_LIMIT_MAX = prevMax;
  });
});
