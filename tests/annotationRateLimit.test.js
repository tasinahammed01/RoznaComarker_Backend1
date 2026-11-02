'use strict';
// Task 6A: annotation writes are limited per teacher (ANNOTATION_RATE_LIMIT_MAX per ANNOTATION_RATE_LIMIT_WINDOW_MS), not per IP.
process.env.JWT_SECRET = 'annotation-rate-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-rate';
process.env.ANNOTATION_RATE_LIMIT_MAX = '3';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi } = require('./helpers/annotationApi');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture;
beforeAll(async () => { await connectInMemoryMongo(); await seedTestPlans(); fixture = await seedAnnotationFixture({ uploadRoot }); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

test('the 4th write in the window is 429 for that teacher only; reads are not limited by it', async () => {
  const teacher = annotationApi(app, fixture.teacher), other = annotationApi(app, fixture.otherTeacher);
  const body = () => ({ action: 'hide', id: 'ai_0000000000000000', revision: 0, sourceHash: 'x', requestId: crypto.randomUUID() });
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await teacher.post(fixture.IDS.registered, body())).status);
  expect(statuses.slice(0, 3).every(s => s !== 429)).toBe(true);
  const limited = await teacher.post(fixture.IDS.registered, body());
  expect({ status: limited.status, code: limited.body.code }).toEqual({ status: 429, code: 'ANNOTATION_RATE_LIMITED' });
  expect(statuses[3]).toBe(429);
  // Another teacher from the same address keeps a full budget (it gets 404: not their submission).
  expect((await other.post(fixture.IDS.registered, body())).status).toBe(404);
  expect((await teacher.snapshot(fixture.IDS.registered)).status).toBe(200);
});
