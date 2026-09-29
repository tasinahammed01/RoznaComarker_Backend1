'use strict';

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'login-rate-limit-test-secret';

const express = require('express');
const request = require('supertest');
const {
  createAuthIpRateLimiter,
  createCoarseIpRateLimiter,
  createAuthenticatedTrafficLimiter,
  createGlobalRateLimiter,
  isBaselineExcludedRequest
} = require('../src/middlewares/rateLimit.middleware');
const { signJwt } = require('../src/utils/jwt');

const authOptions = (limit = 3) => ({
  windowMs: 60_000,
  limit,
  event: 'API_RATE_LIMITED',
  scope: 'auth_login',
  reason: 'too_many_ip_attempts',
  skipSuccessfulRequests: true,
  responseCode: 'AUTH_RATE_LIMITED',
  responseMessage: 'Too many login attempts. Please wait a moment and try again.'
});

function loginApp({ limit = 3, trustProxy = 1 } = {}) {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.post('/api/auth/login', createAuthIpRateLimiter(authOptions(limit)), (req, res) => {
    const status = Number(req.get('x-test-status')) || 401;
    return res.status(status).json({ success: status < 400 });
  });
  return app;
}

describe('dedicated login rate limiting', () => {
  test('allows normal and several failed login attempts below the threshold', async () => {
    const app = loginApp({ limit: 4 });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await request(app).post('/api/auth/login').expect(401);
    }
  });

  test('blocks excessive rapid failed logins with a clean 429 and Retry-After', async () => {
    const app = loginApp({ limit: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app).post('/api/auth/login').expect(401);
    }
    const blocked = await request(app).post('/api/auth/login');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      code: 'AUTH_RATE_LIMITED',
      message: 'Too many login attempts. Please wait a moment and try again.'
    });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  test('successful logins do not consume the failed-attempt allowance', async () => {
    const app = loginApp({ limit: 2 });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app).post('/api/auth/login').set('x-test-status', '200').expect(200);
    }
    await request(app).post('/api/auth/login').expect(401);
    await request(app).post('/api/auth/login').expect(401);
    await request(app).post('/api/auth/login').expect(429);
  });

  test('different Nginx-forwarded client IPs use separate buckets', async () => {
    const app = loginApp({ limit: 1 });
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '198.51.100.10').expect(401);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '198.51.100.10').expect(429);
    await request(app).post('/api/auth/login').set('X-Forwarded-For', '198.51.100.11').expect(401);
  });

  test('a spoofed leftmost forwarded value cannot rotate the trusted one-hop bucket', async () => {
    const app = loginApp({ limit: 1 });
    await request(app).post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.1, 198.51.100.20').expect(401);
    await request(app).post('/api/auth/login')
      .set('X-Forwarded-For', '203.0.113.2, 198.51.100.20').expect(429);
  });

  test('unrelated API traffic does not consume login quota while baseline remains active elsewhere', async () => {
    const previous = process.env.BASELINE_RATE_LIMIT_MAX;
    process.env.BASELINE_RATE_LIMIT_MAX = '1';
    try {
      const app = express();
      app.set('trust proxy', 1);
      app.use('/api', createGlobalRateLimiter({ skip: isBaselineExcludedRequest }));
      app.get('/api/general', (_req, res) => res.json({ success: true }));
      app.post('/api/auth/login', createAuthIpRateLimiter(authOptions(1)), (_req, res) => {
        res.status(401).json({ success: false });
      });

      await request(app).get('/api/general').expect(200);
      await request(app).get('/api/general').expect(429);
      await request(app).post('/api/auth/login').expect(401);
      await request(app).post('/api/auth/login').expect(429);
    } finally {
      if (previous === undefined) delete process.env.BASELINE_RATE_LIMIT_MAX;
      else process.env.BASELINE_RATE_LIMIT_MAX = previous;
    }
  });

  test('the baseline limiter still blocks excessive traffic on ordinary API routes', async () => {
    const previous = process.env.BASELINE_RATE_LIMIT_MAX;
    process.env.BASELINE_RATE_LIMIT_MAX = '2';
    try {
      const app = express();
      app.use('/api', createGlobalRateLimiter());
      app.get('/api/general', (_req, res) => res.json({ success: true }));
      await request(app).get('/api/general').expect(200);
      await request(app).get('/api/general').expect(200);
      await request(app).get('/api/general').expect(429);
    } finally {
      if (previous === undefined) delete process.env.BASELINE_RATE_LIMIT_MAX;
      else process.env.BASELINE_RATE_LIMIT_MAX = previous;
    }
  });
});

describe('layered API traffic limits', () => {
  const token = id => `Bearer ${signJwt({ _id: id, role: 'student' })}`;
  function appWithLimits() {
    const app = express();
    app.set('trust proxy', 1);
    app.use('/api', createCoarseIpRateLimiter());
    app.use('/api', createGlobalRateLimiter());
    app.use('/api', createAuthenticatedTrafficLimiter());
    app.get('/api/read', (_req, res) => res.json({ ok: true }));
    app.post('/api/submit', (_req, res) => res.json({ ok: true }));
    return app;
  }
  let saved;
  beforeEach(() => {
    saved = ['BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX']
      .map(key => [key, process.env[key]]);
    process.env.BASELINE_RATE_LIMIT_MAX = '2';
    process.env.COARSE_IP_RATE_LIMIT_MAX = '100';
    process.env.AUTH_READ_RATE_LIMIT_MAX = '3';
    process.env.AUTH_WRITE_RATE_LIMIT_MAX = '2';
  });
  afterEach(() => saved.forEach(([key, value]) => value === undefined ? delete process.env[key] : process.env[key] = value));

  test('shared-IP users have independent read buckets and reads cannot block a write', async () => {
    const app = appWithLimits();
    const first = token('507f1f77bcf86cd799439011');
    const second = token('507f1f77bcf86cd799439012');
    for (let i = 0; i < 3; i++) await request(app).get('/api/read').set('Authorization', first).expect(200);
    const blocked = await request(app).get('/api/read').set('Authorization', first).expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    await request(app).get('/api/read').set('Authorization', second).expect(200);
    await request(app).post('/api/submit').set('Authorization', first).expect(200);
  });

  test('one user cannot rotate IP or body identity to escape, while anonymous IP stays guarded', async () => {
    const app = appWithLimits();
    const auth = token('507f1f77bcf86cd799439013');
    await request(app).post('/api/submit').set('Authorization', auth).set('X-Forwarded-For', '198.51.100.10').send({ userId: 'other' }).expect(200);
    await request(app).post('/api/submit?userId=rotated').set('Authorization', auth).set('X-Forwarded-For', '198.51.100.11').expect(200);
    await request(app).post('/api/submit').set('Authorization', auth).set('X-Forwarded-For', '198.51.100.12').expect(429);
    for (let i = 0; i < 2; i++) await request(app).get('/api/read').set('X-Forwarded-For', '198.51.100.20').expect(200);
    await request(app).get('/api/read').set('X-Forwarded-For', '198.51.100.20').expect(429);
  });

  test('a full 15-minute class polling equivalent cannot consume essay submission quota', async () => {
    process.env.AUTH_READ_RATE_LIMIT_MAX = '200';
    process.env.COARSE_IP_RATE_LIMIT_MAX = '500';
    const app = appWithLimits();
    const auth = token('507f1f77bcf86cd799439014');
    // Two class reads every 15 seconds for 15 minutes: 120 requests.
    for (let i = 0; i < 120; i++) await request(app).get('/api/read').set('Authorization', auth).expect(200);
    await request(app).post('/api/submit').set('Authorization', auth).expect(200);
    await request(app).get('/api/read').expect(200);
    await request(app).get('/api/read').expect(200);
    await request(app).get('/api/read').expect(429);
  });

  test('the coarse shared-IP guard still stops a broad authenticated burst', async () => {
    process.env.COARSE_IP_RATE_LIMIT_MAX = '2';
    const app = appWithLimits();
    await request(app).get('/api/read').set('Authorization', token('507f1f77bcf86cd799439015')).expect(200);
    await request(app).get('/api/read').set('Authorization', token('507f1f77bcf86cd799439016')).expect(200);
    const blocked = await request(app).get('/api/read').set('Authorization', token('507f1f77bcf86cd799439017')).expect(429);
    expect(blocked.body.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
  });
});
