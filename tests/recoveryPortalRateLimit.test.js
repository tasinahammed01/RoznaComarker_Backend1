'use strict';
// Real (unmocked) limiters on the recovery request: per email address and per IP.
process.env.JWT_SECRET = 'recovery-portal-rate-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
jest.mock('../src/services/email.service', () => ({ sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })), sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })) }));
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');

jest.setTimeout(60000);
beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
const ask = email => request(app).post('/api/recovery/request').send({ email });

test('one address: 3 requests an hour, then 429 (whether or not it has submissions)', async () => {
  for (let i = 0; i < 3; i++) expect((await ask('someone@example.com')).status).toBe(202);
  const limited = await ask('someone@example.com');
  expect(limited.status).toBe(429);
  expect(limited.headers['cache-control']).toBe('private, no-store');
});

test('one IP: 5 requests per 15 minutes across addresses, then 429', async () => {
  // 4 requests already counted for this IP by the previous test.
  expect((await ask('other1@example.com')).status).toBe(202);
  expect((await ask('other2@example.com')).status).toBe(429);
});

test('exchange attempts per IP are limited too (guessing tokens is throttled)', async () => {
  let last;
  for (let i = 0; i < 21; i++) last = await request(app).post('/api/recovery/exchange').send({ token: 'x'.repeat(43) });
  expect(last.status).toBe(429);
});
