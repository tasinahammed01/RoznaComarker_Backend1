'use strict';

const express = require('express');
const request = require('supertest');
const { createCorsMiddleware } = require('../src/middlewares/cors.middleware');

describe('localhost CORS configuration', () => {
  const previous = {};

  beforeEach(() => {
    for (const key of ['NODE_ENV', 'FRONTEND_URL', 'CORS_ALLOWED_ORIGINS', 'CORS_ORIGINS']) {
      previous[key] = process.env[key];
      delete process.env[key];
    }
    process.env.NODE_ENV = 'development';
    process.env.FRONTEND_URL = 'http://localhost:4200';
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function app() {
    const instance = express();
    instance.use(createCorsMiddleware());
    instance.get('/health', (_req, res) => res.json({ ok: true }));
    return instance;
  }

  test('allows the configured Angular development origin without cookie credentials', async () => {
    const response = await request(app()).get('/health').set('Origin', 'http://localhost:4200');
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(response.headers['access-control-allow-credentials']).toBeUndefined();
  });

  test('rejects an unconfigured browser origin in development', async () => {
    const response = await request(app()).get('/health').set('Origin', 'http://localhost:4300');
    expect(response.status).toBe(403);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  test('allows origin-less server and local test requests', async () => {
    await request(app()).get('/health').expect(200);
  });

  test('authenticated preflight succeeds for the local frontend', async () => {
    const response = await request(app()).options('/health')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:4200');
    expect(response.headers['access-control-allow-headers']).toMatch(/Authorization/i);
  });

  test('allows only the configured production frontend without adding localhost', async () => {
    process.env.NODE_ENV = 'production';
    process.env.FRONTEND_URL = 'https://comarkers.roznahub.com';
    const productionApp = app();
    const accepted = await request(productionApp).get('/health').set('Origin', 'https://comarkers.roznahub.com');
    expect(accepted.status).toBe(200);
    const rejected = await request(productionApp).get('/health').set('Origin', 'http://localhost:4200');
    expect(rejected.status).toBe(403);
  });

  test('rejects a literal null browser origin', async () => {
    const response = await request(app()).get('/health').set('Origin', 'null');
    expect(response.status).toBe(403);
  });
});
