process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase2-test-secret';

const express = require('express');
const request = require('supertest');
const {
  createEmailRateLimiter,
  createSensitiveRateLimiter,
  createUserRateLimiter
} = require('../src/middlewares/rateLimit.middleware');
const {
  createUserConcurrencyGuard,
  resetConcurrencyStateForTests
} = require('../src/middlewares/concurrency.middleware');
const { handleUploadError } = require('../src/middlewares/upload.middleware');

describe('Security Hardening Phase 2', () => {
  afterEach(() => resetConcurrencyStateForTests());

  test('returns the stable 429 response and standard headers', async () => {
    const app = express();
    app.post('/costly', createSensitiveRateLimiter({ windowMs: 60_000, limit: 2 }), (_req, res) => res.json({ success: true }));

    expect((await request(app).post('/costly')).status).toBe(200);
    expect((await request(app).post('/costly')).status).toBe(200);
    const blocked = await request(app).post('/costly');

    expect(blocked.status).toBe(429);
    expect(blocked.body).toEqual({
      success: false,
      code: 'RATE_LIMITED',
      message: 'Too many requests. Please try again later.'
    });
    expect(blocked.headers).toHaveProperty('ratelimit');
  });

  test('authenticated limiter keys by account instead of shared IP alone', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { _id: req.get('x-test-user'), role: 'teacher' }; next(); });
    app.post('/ai', createUserRateLimiter({ windowMs: 60_000, limit: 1 }), (_req, res) => res.json({ success: true }));

    expect((await request(app).post('/ai').set('x-test-user', 'teacher-a')).status).toBe(200);
    expect((await request(app).post('/ai').set('x-test-user', 'teacher-a')).status).toBe(429);
    expect((await request(app).post('/ai').set('x-test-user', 'teacher-b')).status).toBe(200);
  });

  test('email limiter normalizes case and whitespace without storing raw email keys', async () => {
    const app = express();
    app.use(express.json());
    app.post('/send', createEmailRateLimiter({ windowMs: 60_000, limit: 1 }), (_req, res) => res.json({ success: true }));

    expect((await request(app).post('/send').send({ email: ' Teacher@Example.com ' })).status).toBe(200);
    expect((await request(app).post('/send').send({ email: 'teacher@example.com' })).status).toBe(429);
    expect((await request(app).post('/send').send({ email: 'other@example.com' })).status).toBe(200);
  });

  test('per-user concurrency guard rejects an overlapping expensive request and releases afterward', async () => {
    const app = express();
    app.use((req, _res, next) => { req.user = { _id: 'teacher-a', role: 'teacher' }; next(); });
    app.post('/generate', createUserConcurrencyGuard({ operation: 'test_generation', maxConcurrent: 1 }),
      (_req, res) => setTimeout(() => res.json({ success: true }), 50));

    const first = request(app).post('/generate');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = request(app).post('/generate');
    const statuses = (await Promise.all([first, second])).map((response) => response.status).sort();
    expect(statuses).toEqual([200, 429]);
    expect((await request(app).post('/generate')).status).toBe(200);
  });

  test('security tokens use cryptographic generators and preserve expected formats', () => {
    const authController = require('../src/controllers/authController');
    const mathRandom = jest.spyOn(Math, 'random');
    const otp = authController.generateOTP();
    const token = authController.generateToken();

    expect(otp).toMatch(/^\d{6}$/);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mathRandom).not.toHaveBeenCalled();
    mathRandom.mockRestore();
  });

  test('upload count/part overflow maps to a safe 413 response', () => {
    const req = { user: { _id: 'student-a' }, uploadType: 'submissions' };
    const json = jest.fn();
    const res = { status: jest.fn(() => ({ json })) };
    handleUploadError({ code: 'LIMIT_FILE_COUNT', message: 'internal multer detail' }, req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({ success: false, message: 'Upload payload is too large.' });
  });

  test('oversized JSON receives a sanitized 413 response', async () => {
    const { errorHandler } = require('../src/middlewares/error.middleware');
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.post('/json', (_req, res) => res.json({ success: true }));
    app.use(errorHandler);
    const response = await request(app).post('/json').send({ value: 'x'.repeat(2048) });
    expect(response.status).toBe(413);
    expect(response.body).toEqual({
      success: false,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'Request payload is too large.'
    });
  });

  test('source inventory preserves Stripe webhook exclusion and protects Unsplash', () => {
    const fs = require('fs');
    const path = require('path');
    const appSource = fs.readFileSync(path.join(__dirname, '../src/app.js'), 'utf8');
    const unsplashSource = fs.readFileSync(path.join(__dirname, '../src/routes/unsplash.routes.js'), 'utf8');
    const flashcardSource = fs.readFileSync(path.join(__dirname, '../src/routes/flashcard.routes.js'), 'utf8');

    expect(appSource.indexOf("app.use('/api/stripe'")).toBeLessThan(appSource.indexOf('app.use("/api", createGlobalRateLimiter'));
    expect(unsplashSource).toMatch(/verifyJwtToken[\s\S]*requireRole\('teacher'\)/);
    expect(flashcardSource).toMatch(/reserveAiFlashcardUsage\(\)/);
  });
});
