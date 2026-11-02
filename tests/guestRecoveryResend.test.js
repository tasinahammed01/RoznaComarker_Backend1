'use strict';
// Task 3: a legitimate second recovery request must send a new email (after a short cool-down), without letting anyone kill the
// student's working links. Clock: only Date is faked (timers stay real so Mongo/HTTP keep working).
process.env.JWT_SECRET = 'guest-recovery-resend-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/guest-recovery-resend-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 100000 }),
    createEmailRateLimiter: options => original.createEmailRateLimiter({ ...options, limit: 100000 }) };
});
const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { pageImage } = require('./fixtures/imagePreflightPage');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const email = require('../src/services/email.service');

jest.setTimeout(120000);
const EMAIL = 'resend-student@example.com';
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let assignment, png, start;

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); png = await pageImage(); });
afterAll(async () => { jest.useRealTimers(); await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  jest.useRealTimers();
  await clearDatabase(); await seedTestPlans(); jest.clearAllMocks();
  const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'resend-teacher@example.com', role: 'teacher' });
  const cls = await Class.create({ name: 'Writing', teacher: teacher._id, joinCode: 'RS-' + crypto.randomUUID().slice(0, 6) });
  assignment = await Assignment.create({ title: 'Essay', class: cls._id, teacher: teacher._id, instructions: 'Write.', qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true });
  start = Date.now();
});

/** Moves only the Date clock forward. */
function advance(ms) {
  const now = Date.now() + ms;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(now);
}
async function submitOnce() {
  const res = await request(app).post(`/api/guest/assignments/${assignment.qrToken}/submit`).set('Idempotency-Key', crypto.randomUUID())
    .field('name', 'Student').field('email', EMAIL).attach('files', png, { filename: 'essay.png', contentType: 'image/png' });
  expect(res.status).toBe(200);
  email.sendGuestSubmissionEmail.mockClear();
  const doc = await Submission.findOne({ assignment: assignment._id });
  return { id: String(doc._id), token: new URL(res.body.data.returnUrl).hash.slice(1) };
}
const recoveryEmails = () => email.sendGuestSubmissionEmail.mock.calls.map(([message]) => new URL(message.returnUrl).hash.slice(1));
async function settle(expectedCalls) {
  for (let i = 0; i < 300 && email.sendGuestSubmissionEmail.mock.calls.length < expectedCalls; i++) await new Promise(r => setTimeout(r, 10));
  await new Promise(r => setTimeout(r, 50));
}
const recover = (submission, address = EMAIL) => request(app).post(`/api/guest/submissions/${submission.id}/recover`).send({ email: address });

describe('reproduction', () => {
  test('first recovery sends an email; a second request a few minutes later sends a NEW email', async () => {
    const submission = await submitOnce();
    expect((await recover(submission)).status).toBe(200);
    await settle(1);
    expect(recoveryEmails()).toHaveLength(1);
    advance(3 * 60 * 1000);
    expect((await recover(submission)).status).toBe(200);
    await settle(2);
    expect(recoveryEmails()).toHaveLength(2);
    expect(recoveryEmails()[1]).not.toBe(recoveryEmails()[0]);
  });
});

const presentation = (submission, token) => request(app).get(`/api/guest/submissions/${submission.id}/presentation`).set('X-Guest-Token', token);
const headerNames = res => Object.keys(res.headers).filter(h => !['date', 'etag'].includes(h) && !h.startsWith('ratelimit')).sort();

describe('cool-down and limits', () => {
  test('a request inside the cool-down sends nothing and gets the very same answer (status, body, headers)', async () => {
    const submission = await submitOnce();
    const first = await recover(submission); await settle(1);
    const second = await recover(submission); await settle(2);
    expect(recoveryEmails()).toHaveLength(1);
    expect([second.status, second.body]).toEqual([first.status, first.body]);
    expect(headerNames(second)).toEqual(headerNames(first));
    expect(first.body.data).toEqual({ message: expect.stringContaining('You can ask again in 2 minutes'), retryAfterSeconds: 120 });
  });
  test('both recovery paths and the portal share one cool-down per address', async () => {
    const submission = await submitOnce();
    await recover(submission); await settle(1);
    await request(app).post(`/api/guest/assignments/${assignment.qrToken}/recover`).send({ email: EMAIL });
    await request(app).post('/api/recovery/request').send({ email: EMAIL });
    await new Promise(r => setTimeout(r, 200));
    expect(recoveryEmails()).toHaveLength(1);
    expect(email.sendRecoveryPortalEmail).not.toHaveBeenCalled();
    advance(3 * 60000);
    await request(app).post(`/api/guest/assignments/${assignment.qrToken}/recover`).send({ email: EMAIL }); await settle(2);
    expect(recoveryEmails()).toHaveLength(2);
  });
  test('hourly cap: at most RECOVERY_EMAILS_PER_HOUR emails per clock hour, then the next hour works again', async () => {
    const submission = await submitOnce();
    advance(Math.ceil(Date.now() / 3600000) * 3600000 + 1000 - Date.now());   // start of a clock hour
    for (let i = 1; i <= 4; i++) { await recover(submission); await settle(Math.min(i, 3)); advance(3 * 60000); }
    expect(recoveryEmails()).toHaveLength(3);
    advance(60 * 60000);
    await recover(submission); await settle(4);
    expect(recoveryEmails()).toHaveLength(4);
  });
  test('email bomb: 20 parallel requests for one address send exactly one email', async () => {
    const submission = await submitOnce();
    const responses = await Promise.all(Array.from({ length: 20 }, () => recover(submission)));
    expect(new Set(responses.map(r => JSON.stringify([r.status, r.body]))).size).toBe(1);
    await new Promise(r => setTimeout(r, 1000));
    expect(recoveryEmails()).toHaveLength(1);
  });
});

describe('links stay safe', () => {
  test("a third party asking with the student's email never invalidates the student's working link", async () => {
    const submission = await submitOnce();
    expect((await presentation(submission, submission.token)).status).toBe(200);
    for (let i = 0; i < 3; i++) { await recover(submission); await settle(i + 1); advance(3 * 60000); }   // "attacker" requests
    expect((await presentation(submission, submission.token)).status).toBe(200);
    for (const token of recoveryEmails()) expect((await presentation(submission, token)).status).toBe(200);   // every emailed link works
  });
  test('old links after a resend: the original link, the result link and every earlier recovery link keep working until they expire', async () => {
    const submission = await submitOnce();
    const resultToken = crypto.randomBytes(32).toString('base64url');
    await Submission.updateOne({ _id: submission.id }, { $set: { 'guest.resultAccessHash': require('../src/services/guestAccess.service').hash(resultToken),
      'guest.resultExpiresAt': new Date(Date.now() + 86400000) } });
    await recover(submission); await settle(1); advance(3 * 60000);
    await recover(submission); await settle(2);
    for (const token of [submission.token, resultToken, ...recoveryEmails()]) expect((await presentation(submission, token)).status).toBe(200);
    // Each recovery link has its own expiry (GUEST_ACCESS_DAYS, default 30 days).
    advance(31 * 86400000);
    expect((await presentation(submission, recoveryEmails()[0])).status).toBe(410);
  });
  test('at most 10 recovery links are kept: the oldest drops out, the original link is untouched', async () => {
    const submission = await submitOnce();
    for (let i = 1; i <= 11; i++) { await recover(submission); await settle(i); advance(61 * 60000); }
    const links = recoveryEmails();
    expect(links).toHaveLength(11);
    expect((await presentation(submission, links[0])).status).toBe(410);
    expect((await presentation(submission, links[10])).status).toBe(200);
    expect((await presentation(submission, submission.token)).status).toBe(200);
    const stored = await Submission.findById(submission.id).select('+guest.recoveryAccess').lean();
    expect(stored.guest.recoveryAccess).toHaveLength(10);
    expect(JSON.stringify(stored.guest.recoveryAccess)).not.toContain(links[10]);   // hashes only
  });
  test('an SMTP failure does not consume the cool-down, leaves no unsent working link, and keeps the old link working', async () => {
    const submission = await submitOnce();
    email.sendGuestSubmissionEmail.mockResolvedValueOnce({ success: false, code: 'SMTP_TIMEOUT' });
    const failed = await recover(submission); await settle(1);
    const unsent = recoveryEmails()[0];
    expect((await presentation(submission, unsent)).status).toBe(410);
    expect((await presentation(submission, submission.token)).status).toBe(200);
    const retry = await recover(submission); await settle(2);
    expect(retry.body).toEqual(failed.body);
    expect(recoveryEmails()).toHaveLength(2);
    expect((await presentation(submission, recoveryEmails()[1])).status).toBe(200);
  });
  test('a teacher revoke removes every link, recovery links included, and recovery can not bring access back', async () => {
    const submission = await submitOnce();
    await recover(submission); await settle(1);
    await Submission.updateOne({ _id: submission.id }, { $set: { 'guest.revokedAt': new Date() }, $unset: { 'guest.accessHash': 1, 'guest.recoveryAccess': 1 } });
    for (const token of [submission.token, recoveryEmails()[0]]) expect((await presentation(submission, token)).status).toBe(410);
    advance(3 * 60000);
    await recover(submission); await new Promise(r => setTimeout(r, 200));
    expect(recoveryEmails()).toHaveLength(1);
  });
});

describe('no enumeration, no leaks', () => {
  test('unknown and known addresses get identical answers; a malformed address is a format-only 400', async () => {
    const submission = await submitOnce();
    const known = await recover(submission), unknown = await recover(submission, 'nobody@example.com');
    const otherPath = await request(app).post(`/api/guest/assignments/${assignment.qrToken}/recover`).send({ email: 'nobody@example.com' });
    expect([unknown.status, unknown.body]).toEqual([known.status, known.body]);
    expect([otherPath.status, otherPath.body]).toEqual([known.status, known.body]);
    expect(headerNames(unknown)).toEqual(headerNames(known));
    for (const bad of ['', 'not-an-email', { $gt: '' }]) expect((await recover(submission, bad)).status).toBe(400);
  });
  test('logs hold no token, link or email address', async () => {
    const logger = require('../src/utils/logger');
    const sinks = ['info', 'warn', 'error', 'debug'].map(level => jest.spyOn(logger, level));
    try {
      const submission = await submitOnce();
      email.sendGuestSubmissionEmail.mockResolvedValueOnce({ success: false, code: 'SMTP' });
      await recover(submission); await settle(1);
      await recover(submission); await settle(2);
      const logged = JSON.stringify(sinks.flatMap(s => s.mock.calls));
      for (const secret of [EMAIL, submission.token, ...recoveryEmails(), 'school.example/guest']) expect(logged).not.toContain(secret);
    } finally { sinks.forEach(s => s.mockRestore()); }
  });
});

