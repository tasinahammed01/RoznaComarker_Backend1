process.env.NODE_ENV = 'test';
const express = require('express');
const request = require('supertest');
const app = require('../src/app');
test.each(['/api/stripe/webhook', '/api/subscription/checkout-session', '/api/subscription/customer-portal'])('PayPal app does not expose %s', async path => {
  expect((await request(app).post(path).send({})).status).toBe(404);
});
test('production omits mock-sync and jwt-test routes', async () => {
  const original = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    let auth, users;
    jest.isolateModules(() => {
      auth = require('../src/routes/auth.routes'); users = require('../src/routes/user.routes');
    });
    const production = express(); production.use('/api/auth', auth); production.use('/api/users', users);
    expect((await request(production).get('/api/auth/jwt-test')).status).toBe(404);
    expect((await request(production).post('/api/users/mock-sync')).status).toBe(404);
  } finally { process.env.NODE_ENV = original; }
});
