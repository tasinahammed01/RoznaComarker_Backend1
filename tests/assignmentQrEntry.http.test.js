'use strict';
// End-to-end HTTP coverage for the two assignment-link entry points:
// guest entry (GET /api/guest/assignments/:qrToken) and registered QR access
// (GET /api/assignments/qr/:qrToken), including real JWT + membership checks.
process.env.JWT_SECRET = 'assignment-qr-entry-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
jest.setTimeout(60000);
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 1000 }) };
});
const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');

let teacher, student, classDoc, guestAssignment, privateAssignment;
const bearer = user => `Bearer ${signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role })}`;
const qr = token => `/api/assignments/qr/${token}`;
const guest = token => `/api/guest/assignments/${token}`;

beforeAll(async () => { await connectInMemoryMongo(); });
afterAll(async () => { await disconnectInMemoryMongo(); });
beforeEach(async () => {
  process.env.GUEST_SUBMISSION_ENABLED = 'true';
  await clearDatabase();
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
  student = await User.create({ firebaseUid: crypto.randomUUID(), email: 'student@example.com', role: 'student' });
  classDoc = await Class.create({ name: 'Writing', teacher: teacher._id, joinCode: 'QRTEST01' });
  guestAssignment = await Assignment.create({ title: 'Guest essay', class: classDoc._id, teacher: teacher._id,
    instructions: 'Write an essay.', qrToken: 'guest-token', allowGuestSubmission: true });
  privateAssignment = await Assignment.create({ title: 'Members only', class: classDoc._id, teacher: teacher._id,
    instructions: 'Write an essay.', qrToken: 'private-token', allowGuestSubmission: false });
});

describe('guest entry', () => {
  test('anonymous visitor opens a guest-enabled assignment', async () => {
    const res = await request(app).get(guest('guest-token'));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ title: 'Guest essay', allowGuestSubmission: true });
  });

  test('anonymous visitor stays blocked on an assignment without guest submission', async () => {
    const res = await request(app).get(guest('private-token'));
    expect(res.status).toBe(404);
    expect(res.body.data).toBeUndefined();
  });

  test('global kill switch blocks even a guest-enabled assignment', async () => {
    process.env.GUEST_SUBMISSION_ENABLED = 'false';
    const res = await request(app).get(guest('guest-token'));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('GUEST_SUBMISSION_UNAVAILABLE');
  });

  test('past-deadline guest assignment still opens (late work is accepted and flagged on submit)', async () => {
    await Assignment.updateOne({ _id: guestAssignment._id }, { $set: { deadline: new Date(Date.now() - 86400000) } });
    const res = await request(app).get(guest('guest-token'));
    expect(res.status).toBe(200);
    expect(new Date(res.body.data.deadline).getTime()).toBeLessThan(Date.now());
  });
});

describe('registered QR access', () => {
  test('active class member opens the assignment', async () => {
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    const res = await request(app).get(qr('private-token')).set('Authorization', bearer(student));
    expect(res.status).toBe(200);
    expect(String(res.body.data._id)).toBe(String(privateAssignment._id));
  });

  test('active class member also opens a guest-enabled assignment through the registered path', async () => {
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    const res = await request(app).get(qr('guest-token')).set('Authorization', bearer(student));
    expect(res.status).toBe(200);
  });

  test.each([['no membership', null], ['membership that has left', 'left']])('student with %s is denied', async (_label, status) => {
    if (status) await Membership.create({ student: student._id, class: classDoc._id, status });
    const res = await request(app).get(qr('private-token')).set('Authorization', bearer(student));
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  test('anonymous request is rejected before any lookup', async () => {
    const res = await request(app).get(qr('private-token'));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  test('teacher owner cannot use the student QR endpoint', async () => {
    const res = await request(app).get(qr('private-token')).set('Authorization', bearer(teacher));
    expect(res.status).toBe(403);
    expect(res.body.data).toBeUndefined();
  });

  test('past-deadline assignment still opens for a member', async () => {
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    await Assignment.updateOne({ _id: privateAssignment._id }, { $set: { deadline: new Date(Date.now() - 86400000) } });
    const res = await request(app).get(qr('private-token')).set('Authorization', bearer(student));
    expect(res.status).toBe(200);
  });

  test('unknown token is not found', async () => {
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    const res = await request(app).get(qr('missing-token')).set('Authorization', bearer(student));
    expect(res.status).toBe(404);
  });
});
