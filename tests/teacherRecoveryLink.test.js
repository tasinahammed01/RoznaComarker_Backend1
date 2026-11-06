'use strict';
// Task 5: a teacher sends a recovery link for one guest submission in the teacher's own class.
process.env.JWT_SECRET = 'teacher-recovery-link-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-recovery-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })), sendTeacherRecoveryEmail: jest.fn(async () => ({ success: true })) }));
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
const { signTestJwt } = require('./helpers/auth');
const { pageImage } = require('./fixtures/imagePreflightPage');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const RecoveryLinkAudit = require('../src/models/RecoveryLinkAudit');
const email = require('../src/services/email.service');
const logger = require('../src/utils/logger');

jest.setTimeout(120000);
const STUDENT = 'jane.student@example.com';
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let png, teacherA, teacherB, studentUser, assignmentA, assignmentB, tokenA, tokenB, tokenStudent;

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), RecoveryLinkAudit.init()]); png = await pageImage(); });
afterAll(async () => { jest.useRealTimers(); await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  jest.useRealTimers();
  await clearDatabase(); await seedTestPlans(); jest.clearAllMocks();
  delete process.env.RECOVERY_TEACHER_SENDS_PER_HOUR;
  [teacherA, teacherB, studentUser] = await User.create(['teacher', 'teacher', 'student'].map((role, i) => ({ firebaseUid: crypto.randomUUID(), email: `user${i}@example.com`, role })));
  const [classA, classB] = await Class.create([{ name: 'A', teacher: teacherA._id, joinCode: 'TR-A-' + crypto.randomUUID().slice(0, 4) },
    { name: 'B', teacher: teacherB._id, joinCode: 'TR-B-' + crypto.randomUUID().slice(0, 4) }]);
  [assignmentA, assignmentB] = await Assignment.create([classA, classB].map((cls, i) => ({ title: `Essay ${i}`, class: cls._id, teacher: cls.teacher,
    instructions: 'Write.', qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true })));
  const token = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
  [tokenA, tokenB, tokenStudent] = [teacherA, teacherB, studentUser].map(token);
});

function advance(ms) {
  const now = Date.now() + ms;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(now);
}
/** The same instant on every run, ten minutes before an hour starts: the hourly limits and the one-hour login token no longer depend on when the test runs. */
function fixedClock() {
  advance(Date.UTC(2030, 0, 7, 9, 50) - Date.now());
  tokenA = signTestJwt({ id: teacherA._id, role: teacherA.role, firebaseUid: teacherA.firebaseUid });
}
async function guestSubmission(assignment = assignmentA, address = STUDENT) {
  const res = await request(app).post(`/api/guest/assignments/${assignment.qrToken}/submit`).set('Idempotency-Key', crypto.randomUUID())
    .field('name', 'Jane').field('email', address).attach('files', png, { filename: 'essay.png', contentType: 'image/png' });
  expect(res.status).toBe(200);
  const doc = await Submission.findOne({ assignment: assignment._id, 'guest.normalizedEmail': address }).select('+guest.normalizedEmail').sort({ submittedAt: -1 });
  return { id: String(doc._id), ownToken: new URL(res.body.data.returnUrl).hash.slice(1) };
}
const send = (id, token = tokenA, body) => { const r = request(app).post(`/api/submissions/${id}/guest-access/recovery-link`).set('Authorization', `Bearer ${token}`); return body ? r.send(body) : r; };
const statusOf = (id, token = tokenA) => request(app).get(`/api/submissions/${id}/guest-access/recovery-link`).set('Authorization', `Bearer ${token}`);
const teacherLinks = () => email.sendTeacherRecoveryEmail.mock.calls.map(([m]) => m.link);
const presentation = (id, token) => request(app).get(`/api/guest/submissions/${id}/presentation`).set('X-Guest-Token', token);

describe('who may send', () => {
  test('the owning teacher sends a link to the stored address; it opens exactly this submission; nothing secret comes back', async () => {
    const sub = await guestSubmission();
    const res = await send(sub.id);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toEqual({ sent: true, emailMasked: 'j***@example.com', lastSentAt: expect.any(String) });
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(1);
    const [{ to, link }] = email.sendTeacherRecoveryEmail.mock.calls[0];
    expect(to).toBe(STUDENT);
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe(`https://school.example/guest/results/${sub.id}`);
    expect((await presentation(sub.id, url.hash.slice(1))).status).toBe(200);
    const body = JSON.stringify(res.body);
    for (const secret of [STUDENT, url.hash.slice(1), link]) expect(body).not.toContain(secret);
  });
  test('IDOR: another teacher gets 404 for both status and send; unknown ids are the same 404', async () => {
    const sub = await guestSubmission();
    for (const res of [await send(sub.id, tokenB), await statusOf(sub.id, tokenB), await send('6a1111111111111111111111', tokenA)])
      expect([res.status, res.body.code]).toEqual([404, 'SUBMISSION_NOT_FOUND']);
    expect(email.sendTeacherRecoveryEmail).not.toHaveBeenCalled();
    expect((await send('not-an-id')).status).toBe(400);
  });
  test('unauthenticated is 401 and a student account is 403', async () => {
    const sub = await guestSubmission();
    expect((await request(app).post(`/api/submissions/${sub.id}/guest-access/recovery-link`)).status).toBe(401);
    expect((await send(sub.id, tokenStudent)).status).toBe(403);
    expect(email.sendTeacherRecoveryEmail).not.toHaveBeenCalled();
  });
  test('the request takes no input: an address in the body is rejected and nothing is sent anywhere', async () => {
    const sub = await guestSubmission();
    for (const body of [{ email: 'attacker@evil.example' }, { to: 'x@y.z' }, { anything: 1 }]) {
      const res = await send(sub.id, tokenA, body);
      expect([res.status, res.body.code]).toEqual([400, 'NO_INPUT_ACCEPTED']);
    }
    expect(email.sendTeacherRecoveryEmail).not.toHaveBeenCalled();
  });
  test('registered (account) submissions and submissions without an email are refused with a clear reason', async () => {
    const registered = await Submission.create({ student: studentUser._id, assignment: assignmentA._id, class: assignmentA.class, submittedAt: new Date(), status: 'submitted' });
    let res = await send(String(registered._id));
    expect([res.status, res.body.code]).toEqual([409, 'REGISTERED_STUDENT']);
    expect((await statusOf(String(registered._id))).body.data).toMatchObject({ available: false, reason: 'registered' });
    const sub = await guestSubmission();
    await Submission.updateOne({ _id: sub.id }, { $unset: { 'guest.normalizedEmail': 1 } });
    res = await send(sub.id);
    expect([res.status, res.body.code]).toEqual([409, 'NO_EMAIL_ON_RECORD']);
    expect(email.sendTeacherRecoveryEmail).not.toHaveBeenCalled();
  });
});

describe('limits', () => {
  test('per-address cool-down (shared with the student resend): an immediate second send is 429 with an honest wait', async () => {
    const sub = await guestSubmission();
    expect((await send(sub.id)).status).toBe(200);
    const second = await send(sub.id);
    expect([second.status, second.body.code, second.body.emailMasked]).toEqual([429, 'ADDRESS_COOLDOWN', 'j***@example.com']);
    expect(second.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(second.body.retryAfterSeconds).toBeLessThanOrEqual(120);
    // The student's own "Lost your link?" request right after is held by the same cool-down.
    await request(app).post(`/api/guest/submissions/${sub.id}/recover`).send({ email: STUDENT });
    await new Promise(r => setTimeout(r, 200));
    expect(email.sendGuestRecoveryEmail).not.toHaveBeenCalled();
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(1);
  });
  test('per-address hourly cap: at most RECOVERY_EMAILS_PER_HOUR (3) per address, then 429 until the next hour', async () => {
    fixedClock();
    const sub = await guestSubmission();
    advance(Math.ceil(Date.now() / 3600000) * 3600000 + 1000 - Date.now());
    const codes = [];
    for (let i = 0; i < 4; i++) { const r = await send(sub.id); codes.push(r.body.code || r.status); advance(3 * 60000); }
    expect(codes).toEqual([200, 200, 200, 'ADDRESS_HOURLY_LIMIT']);
  });
  test('per-teacher cap: RECOVERY_TEACHER_SENDS_PER_HOUR across different students', async () => {
    process.env.RECOVERY_TEACHER_SENDS_PER_HOUR = '2';
    fixedClock();
    const subs = [];
    for (let i = 0; i < 3; i++) subs.push(await guestSubmission(assignmentA, `student${i}@example.com`));
    advance(Math.ceil(Date.now() / 3600000) * 3600000 + 1000 - Date.now());
    const results = [];
    for (const s of subs) { const r = await send(s.id); results.push([r.status, r.body.code || null]); }
    expect(results).toEqual([[200, null], [200, null], [429, 'TEACHER_LIMIT']]);
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(2);
  });
  test('20 parallel sends for one submission deliver exactly one email', async () => {
    const sub = await guestSubmission();
    const responses = await Promise.all(Array.from({ length: 20 }, () => send(sub.id)));
    expect(responses.filter(r => r.status === 200)).toHaveLength(1);
    expect(responses.every(r => [200, 429].includes(r.status))).toBe(true);
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(1);
  });
});

describe('links and failures', () => {
  test('an SMTP failure is reported (502), removes the unsent link and gives every slot back: an immediate retry sends', async () => {
    const sub = await guestSubmission();
    email.sendTeacherRecoveryEmail.mockResolvedValueOnce({ success: false, code: 'SMTP_TIMEOUT' });
    const failed = await send(sub.id);
    expect([failed.status, failed.body.code]).toEqual([502, 'EMAIL_FAILED']);
    expect((await presentation(sub.id, new URL(teacherLinks()[0]).hash.slice(1))).status).toBe(410);
    const stored = await Submission.findById(sub.id).select('+guest.recoveryAccess').lean();
    expect(stored.guest.recoveryAccess || []).toHaveLength(0);
    const retry = await send(sub.id);
    expect(retry.status).toBe(200);
    expect((await presentation(sub.id, new URL(teacherLinks()[1]).hash.slice(1))).status).toBe(200);
  });
  test("the student's existing link keeps working; a teacher revoke kills the teacher-sent link too", async () => {
    const sub = await guestSubmission();
    await send(sub.id);
    const teacherToken = new URL(teacherLinks()[0]).hash.slice(1);
    expect((await presentation(sub.id, sub.ownToken)).status).toBe(200);
    expect((await presentation(sub.id, teacherToken)).status).toBe(200);
    expect((await request(app).post(`/api/submissions/${sub.id}/guest-access/revoke`).set('Authorization', `Bearer ${tokenA}`)).status).toBe(200);
    for (const token of [sub.ownToken, teacherToken]) expect((await presentation(sub.id, token)).status).toBe(410);
    advance(3 * 60000);
    const after = await send(sub.id);
    expect([after.status, after.body.code]).toEqual([409, 'GUEST_ACCESS_REVOKED']);
  });
});

describe('audit and secrets', () => {
  test('every attempt is audited with a masked address and no secrets; the teacher sees the last sent time', async () => {
    const sub = await guestSubmission();
    await send(sub.id);                                   // sent
    await send(sub.id);                                   // throttled (cool-down)
    advance(3 * 60000);
    email.sendTeacherRecoveryEmail.mockResolvedValueOnce({ success: false, code: 'SMTP' });
    await send(sub.id);                                   // failed
    const audits = await RecoveryLinkAudit.find({ submissionId: sub.id }).sort({ createdAt: 1 }).lean();
    expect(audits.map(a => [a.result, a.reason, a.emailMasked, a.source, String(a.issuedBy)])).toEqual([
      ['sent', null, 'j***@example.com', 'teacher', String(teacherA._id)],
      ['throttled', 'cooldown', 'j***@example.com', 'teacher', String(teacherA._id)],
      ['failed', 'delivery_failed', 'j***@example.com', 'teacher', String(teacherA._id)]]);
    const stored = JSON.stringify(audits);
    for (const secret of [STUDENT, ...teacherLinks(), ...teacherLinks().map(l => new URL(l).hash.slice(1))]) expect(stored).not.toContain(secret);
    const status = await statusOf(sub.id);
    expect(status.headers['cache-control']).toBe('private, no-store');
    expect(status.body.data).toEqual({ available: true, reason: null, emailMasked: 'j***@example.com', lastSentAt: audits[0].createdAt.toISOString() });
  });
  test('logs hold no address, link or token', async () => {
    const sinks = ['info', 'warn', 'error', 'debug'].map(level => jest.spyOn(logger, level));
    try {
      const sub = await guestSubmission();
      await send(sub.id); await send(sub.id);
      advance(3 * 60000);
      email.sendTeacherRecoveryEmail.mockResolvedValueOnce({ success: false, code: 'SMTP' });
      await send(sub.id);
      const logged = JSON.stringify(sinks.flatMap(s => s.mock.calls));
      for (const secret of [STUDENT, ...teacherLinks(), 'school.example/guest']) expect(logged).not.toContain(secret);
    } finally { sinks.forEach(s => s.mockRestore()); }
  });
});
