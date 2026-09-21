'use strict';
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = process.env.JWT_SECRET || 'credit-api-secret';
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const Plan = require('../src/models/Plan'); const User = require('../src/models/user.model');

let teacher; let teacherToken; let adminToken;
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); const plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, features: { essayAnalysesPerMonth: 2 } });
  teacher = await User.create({ firebaseUid: 'credit-api-teacher', email: 'credit-api-teacher@example.com', role: 'teacher', plan: plan._id });
  const admin = await User.create({ firebaseUid: 'credit-api-admin', email: 'credit-api-admin@example.com', role: 'admin', plan: plan._id });
  teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
  adminToken = signTestJwt({ id: admin._id, firebaseUid: admin.firebaseUid, role: admin.role });
});

test('unauthorized teacher cannot use admin adjustment', async () => {
  const response = await request(app).post(`/api/credits/admin/${teacher._id}/adjust`).set('Authorization', `Bearer ${teacherToken}`)
    .send({ amount: 1, reason: 'Not allowed' });
  expect(response.status).toBe(403);
});

test('admin search, adjustment, resulting balance, and paginated history are authoritative', async () => {
  expect((await request(app).get('/api/credits/admin/teachers?q=credit-api').set('Authorization', `Bearer ${adminToken}`)).body.teachers).toHaveLength(1);
  const adjusted = await request(app).post(`/api/credits/admin/${teacher._id}/adjust`).set('Authorization', `Bearer ${adminToken}`)
    .send({ amount: 3, reason: 'Approved support credit', idempotencyKey: '00000000-0000-4000-8000-000000000088' });
  expect(adjusted.status).toBe(200); expect(adjusted.body.wallet.availableCredits).toBe(5);
  const history = await request(app).get(`/api/credits/admin/${teacher._id}?page=1&limit=1`).set('Authorization', `Bearer ${adminToken}`);
  expect(history.status).toBe(200); expect(history.body.transactions).toHaveLength(1);
  expect(history.body.pagination).toMatchObject({ page: 1, limit: 1, total: 1, pages: 1 });
  expect(history.body.transactions[0].metadata.adminActorId).toBeDefined();
});

test('response-loss retry adjusts once and rejects a changed operation identity', async () => {
  const route = `/api/credits/admin/${teacher._id}/adjust`;
  const body = { amount: 3, reason: 'Support credit', idempotencyKey: '00000000-0000-4000-8000-000000000089' };
  const call = value => request(app).post(route).set('Authorization', `Bearer ${adminToken}`).send(value);
  expect((await call(body)).status).toBe(200);
  const replay = await call(body);
  expect(replay.status).toBe(200);
  expect(replay.body.wallet.bonusCredits).toBe(3);
  expect((await call({ ...body, reason: 'Another operation' })).status).toBe(409);
  expect((await call({ amount: 3, reason: 'Missing key' })).status).toBe(400);
});
