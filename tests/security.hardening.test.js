process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');

const app = require('../src/app');

describe('Security & Production Hardening', () => {
  test('Helmet sets key security headers', async () => {
    const res = await request(app).get('/api/health');

    expect(res.status).toBe(200);

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
  });

  test('Validation errors return consistent JSON', async () => {
    const res = await request(app)
      .post('/api/classes')
      .send({});

    // verifyJwtToken runs first, so this is unauthorized, but should still be consistent JSON
    expect([401, 400]).toContain(res.status);
    expect(res.body).toHaveProperty('success', false);
    expect(typeof res.body.message).toBe('string');
  });

  test('Rate limiter triggers on repeated requests', async () => {
    const prevWindow = process.env.RATE_LIMIT_WINDOW;
    const prevMax = process.env.RATE_LIMIT_MAX;

    process.env.RATE_LIMIT_WINDOW = '60000';
    process.env.RATE_LIMIT_MAX = '3';

    jest.resetModules();
    const limitedApp = require('../src/app');

    const r1 = await request(limitedApp).get('/api/health');
    const r2 = await request(limitedApp).get('/api/health');
    const r3 = await request(limitedApp).get('/api/health');
    const r4 = await request(limitedApp).get('/api/health');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
    expect(r4.body).toHaveProperty('success', false);

    process.env.RATE_LIMIT_WINDOW = prevWindow;
    process.env.RATE_LIMIT_MAX = prevMax;
  });
});
