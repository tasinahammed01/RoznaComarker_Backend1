'use strict';

const express = require('express');
const request = require('supertest');
const { createCorsMiddleware } = require('../src/middlewares/cors.middleware');
const { getPublicApiUrl, buildPublicUploadUrl } = require('../src/utils/publicApiUrl');
const { normalizePublicUploadsUrlForDev } = require('../src/controllers/submission.controller');

describe('production URL and CORS configuration', () => {
  const previous = {};
  beforeAll(() => {
    for (const key of ['NODE_ENV', 'FRONTEND_URL', 'CORS_ORIGINS', 'PUBLIC_API_URL', 'BASE_URL']) previous[key] = process.env[key];
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://comarkers.roznahub.com';
    process.env.CORS_ORIGINS = 'https://comarkers.roznahub.com';
    process.env.PUBLIC_API_URL = 'https://comarkerback.roznahub.com';
    process.env.BASE_URL = 'https://comarkerback.roznahub.com';
  });
  afterAll(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  function app() {
    const value = express();
    value.use(createCorsMiddleware());
    value.all('/api/assignments/my', (_req, res) => res.json({ success: true }));
    return value;
  }

  test('allows the exact frontend origin and required preflight headers', async () => {
    const response = await request(app()).options('/api/assignments/my')
      .set('Origin', 'https://comarkers.roznahub.com')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('https://comarkers.roznahub.com');
    expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain('authorization');
    expect(response.headers['access-control-allow-headers'].toLowerCase()).toContain('content-type');
  });

  test('rejects an unapproved production origin', async () => {
    const response = await request(app()).get('/api/assignments/my').set('Origin', 'https://evil.example.test');
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('builds public and upload URLs from the canonical backend origin', () => {
    const req = { protocol: 'http', get: () => '127.0.0.1:5000' };
    expect(getPublicApiUrl(req)).toBe('https://comarkerback.roznahub.com');
    expect(buildPublicUploadUrl(req, 'submissions', 'page one.png')).toBe(
      'https://comarkerback.roznahub.com/uploads/submissions/page%20one.png'
    );
  });

  test('normalizes legacy upload URLs in production and leaves other URLs unchanged', () => {
    const req = { protocol: 'http', get: () => '127.0.0.1:5000' };

    expect(normalizePublicUploadsUrlForDev(
      req,
      'http://localhost:5000/uploads/submissions/example.png'
    )).toBe('https://comarkerback.roznahub.com/uploads/submissions/example.png');
    expect(normalizePublicUploadsUrlForDev(
      req,
      'https://assets.example.com/submissions/example.png'
    )).toBe('https://assets.example.com/submissions/example.png');
  });
});
