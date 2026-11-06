'use strict';
// Multi-assignment recovery portal: one emailed link -> read-only portal session -> list -> open results with the normal guest checks.
process.env.JWT_SECRET = 'recovery-portal-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
jest.mock('../src/services/email.service', () => ({ sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })), sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 1000 }),
    createEmailRateLimiter: options => original.createEmailRateLimiter({ ...options, limit: 1000 }) };
});
const request = require('supertest');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const access = require('../src/services/guestAccess.service');
const portal = require('../src/services/recoveryPortal.service');
const logger = require('../src/utils/logger');
const sendLink = require('../src/services/email.service').sendRecoveryPortalEmail;

jest.setTimeout(60000);
const ALICE = 'alice@example.com', BOB = 'bob@example.com';
let assignmentA, assignmentB, hidden, aliceA, aliceB, bobA;

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), RecoveryToken.init(), RecoverySession.init()]); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); sendLink.mockResolvedValue({ success: true });
  for (const key of ['RECOVERY_LINK_TTL_HOURS', 'RECOVERY_LINK_MAX_USES', 'RECOVERY_SESSION_MINUTES', 'RECOVERY_EMAILS_PER_HOUR']) delete process.env[key];
  const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
  const classDoc = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'RECOVER-1' });
  const make = (title, extra = {}) => Assignment.create({ title, class: classDoc._id, teacher: teacher._id, instructions: 'Write.',
    rubric: 'PRIVATE RUBRIC', qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, ...extra });
  [assignmentA, assignmentB, hidden] = [await make('Essay A'), await make('Essay B'), await make('Closed essay', { isActive: false })];
  const guest = (assignment, email, extra = {}) => {
    const issued = access.issueToken();
    return Submission.create({ submissionMode: 'guest', assignment: assignment._id, class: classDoc._id, qrToken: assignment.qrToken,
      submittedAt: new Date(), status: 'submitted', guest: { displayName: 'Student', normalizedEmail: email, accessHash: issued.accessHash,
        expiresAt: issued.expiresAt }, ...extra }).then(doc => Object.assign(doc, { guestToken: issued.token }));
  };
  aliceA = await guest(assignmentA, ALICE, { assessmentStatus: 'complete' });
  aliceB = await guest(assignmentB, ALICE, { assessmentStatus: 'processing' });
  bobA = await guest(assignmentA, BOB, { assessmentStatus: 'complete' });
  await guest(hidden, ALICE);
});

// Moves only the Date clock (timers stay real so Mongo and HTTP keep working).
function advanceDate(ms) {
  const now = Date.now() + ms;
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
  jest.setSystemTime(now);
}
afterEach(() => jest.useRealTimers());
const waitFor = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
async function linkFor(email) {
  const before = sendLink.mock.calls.length;
  const res = await request(app).post('/api/recovery/request').send({ email });
  expect(res.status).toBe(202);
  await waitFor(() => sendLink.mock.calls.length > before);
  return new URL(sendLink.mock.calls.at(-1)[0].link);
}
async function sessionFor(email) {
  const token = (await linkFor(email)).hash.slice(1);
  const res = await request(app).post('/api/recovery/exchange').send({ token });
  expect(res.status).toBe(200);
  return { token, session: res.body.data.session };
}
const list = session => request(app).get('/api/recovery/assignments').set('X-Recovery-Session', session);

describe('requesting a link', () => {
  test('the same answer for an unknown and a known address; the email goes only to a known one', async () => {
    const known = await request(app).post('/api/recovery/request').send({ email: ` ${ALICE.toUpperCase()} ` });
    const unknown = await request(app).post('/api/recovery/request').send({ email: 'nobody@example.com' });
    expect([known.status, unknown.status]).toEqual([202, 202]);
    expect(unknown.body).toEqual(known.body);
    expect(Object.keys(unknown.headers).filter(h => h !== 'date' && !h.startsWith('ratelimit')).sort())
      .toEqual(Object.keys(known.headers).filter(h => h !== 'date' && !h.startsWith('ratelimit')).sort());
    await waitFor(() => sendLink.mock.calls.length === 1);
    await new Promise(r => setTimeout(r, 100));
    expect(sendLink).toHaveBeenCalledTimes(1);
    const [{ to, link }] = sendLink.mock.calls[0];
    expect(to).toBe(ALICE);
    expect(link).toMatch(/^https:\/\/school\.example\/recover\/portal#[A-Za-z0-9_-]{43}$/);   // token in the fragment: never sent to a server
  });
  test('a malformed address is a 400 about the format only', async () => {
    for (const email of [undefined, '', 'not-an-email', 'a@b', 'x'.repeat(300) + '@example.com', { $gt: '' }])
      expect((await request(app).post('/api/recovery/request').send({ email })).status).toBe(400);
  });
  test('the raw token is never stored; only its SHA-256', async () => {
    const token = (await linkFor(ALICE)).hash.slice(1);
    const stored = await RecoveryToken.find().select('+tokenHash').lean();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored[0]).toMatchObject({ emailNormalized: ALICE, tokenHash: portal.sha(token), usedCount: 0, revokedAt: null, source: 'student', issuedBy: null });
    expect(stored[0].expiresAt.getTime() - Date.now()).toBeGreaterThan(23 * 3600000);
    expect(stored[0].purgeAt.getTime()).toBeGreaterThan(stored[0].expiresAt.getTime());
  });
  test('per-address limit: no more than RECOVERY_EMAILS_PER_HOUR links an hour, with the same public answer', async () => {
    process.env.RECOVERY_EMAILS_PER_HOUR = '2';
    await linkFor(ALICE); advanceDate(3 * 60000); await linkFor(ALICE); advanceDate(3 * 60000);   // past the 2-minute cool-down each time
    const third = await request(app).post('/api/recovery/request').send({ email: ALICE });
    expect(third.status).toBe(202);
    await new Promise(r => setTimeout(r, 150));
    expect(sendLink).toHaveBeenCalledTimes(2);
  });
  test('a link whose email could not be delivered is revoked at once', async () => {
    sendLink.mockResolvedValue({ success: false, code: 'SMTP' });
    await request(app).post('/api/recovery/request').send({ email: ALICE });
    await waitFor(async () => (await RecoveryToken.countDocuments({ revokedAt: { $ne: null } })) === 1);
  });
});

describe('exchanging the link', () => {
  test('a valid link gives a short read-only session; the session, not the link, is stored hashed', async () => {
    const { token, session } = await sessionFor(ALICE);
    expect(session).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session).not.toBe(token);
    const stored = await RecoverySession.find().select('+sessionHash').lean();
    expect(JSON.stringify(stored)).not.toContain(session);
    expect(stored[0].sessionHash).toBe(portal.sha(session));
    expect(stored[0].expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60000);
    const used = await RecoveryToken.findOne().lean();
    expect(used.usedCount).toBe(1);
    expect(used.lastUsedAt).toBeInstanceOf(Date);
  });
  const rejected = async (token, label) => {
    const res = await request(app).post('/api/recovery/exchange').send({ token });
    expect({ label, status: res.status, code: res.body.code, message: res.body.message })
      .toEqual({ label, status: 410, code: 'RECOVERY_LINK_INVALID', message: portal.GENERIC_INVALID });
  };
  test('expired, revoked, tampered, unknown and malformed links all get the same generic answer', async () => {
    const token = (await linkFor(ALICE)).hash.slice(1);
    const flipped = token.slice(0, -1) + (token.at(-1) === 'A' ? 'B' : 'A');
    await rejected(flipped, 'tampered');
    await rejected(crypto.randomBytes(32).toString('base64url'), 'unknown');
    for (const bad of [undefined, '', 'short', token + 'x', { $ne: null }, [token]]) await rejected(bad, `malformed ${JSON.stringify(bad)}`);
    await RecoveryToken.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    await rejected(token, 'expired');
    await RecoveryToken.updateOne({}, { $set: { expiresAt: new Date(Date.now() + 3600000), revokedAt: new Date() } });
    await rejected(token, 'revoked');
  });
  test('a link may be reopened, but only RECOVERY_LINK_MAX_USES times', async () => {
    process.env.RECOVERY_LINK_MAX_USES = '2';
    const token = (await linkFor(ALICE)).hash.slice(1);
    for (let i = 0; i < 2; i++) expect((await request(app).post('/api/recovery/exchange').send({ token })).status).toBe(200);
    await rejected(token, 'used up');
  });
  test('a session never outlives its link', async () => {
    const { session } = await sessionFor(ALICE);
    await RecoverySession.updateOne({}, { $set: { expiresAt: new Date(Date.now() - 1) } });
    expect((await list(session)).status).toBe(410);
  });
  test('revoking the link (or all links of the address) ends its sessions', async () => {
    const { session } = await sessionFor(ALICE);
    expect(await portal.revokeAllForEmail(ALICE)).toBe(1);
    expect((await list(session)).status).toBe(410);
  });
});

describe('the portal list', () => {
  test('only this address\'s open submissions, in a minimal projection, never cached', async () => {
    const { session } = await sessionFor(ALICE);
    const res = await list(session);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    const items = res.body.data.assignments;
    expect(items.map(i => i.id).sort()).toEqual([String(aliceA._id), String(aliceB._id)].sort());   // not Bob's, not the closed assignment
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['assignmentTitle', 'className', 'id', 'status', 'submittedAt']);
    // assessmentStatus 'complete' but no evaluation stored: the result page shows it as processing, so the list does too (Task 4).
    expect(items.find(i => i.id === String(aliceA._id))).toMatchObject({ assignmentTitle: 'Essay A', className: 'Writing 7B', status: 'processing' });
    expect(items.find(i => i.id === String(aliceB._id))).toMatchObject({ status: 'processing' });
    const body = JSON.stringify(res.body);
    for (const leak of [BOB, ALICE, 'PRIVATE RUBRIC', 'Student', 'accessHash', 'qr-']) expect(body).not.toContain(leak);
  });
  test('without a valid session there is no list', async () => {
    for (const session of [undefined, '', 'x', crypto.randomBytes(32).toString('base64url')]) {
      const req = request(app).get('/api/recovery/assignments');
      expect((await (session === undefined ? req : req.set('X-Recovery-Session', session))).status).toBe(410);
    }
  });
  test('the same email in two classes is listed together; the same name with another email is not', async () => {
    const { session } = await sessionFor(BOB);
    expect((await list(session)).body.data.assignments.map(i => i.id)).toEqual([String(bobA._id)]);
  });
  test('ending the session works and is idempotent', async () => {
    const { session } = await sessionFor(ALICE);
    for (let i = 0; i < 2; i++) expect((await request(app).delete('/api/recovery/session').set('X-Recovery-Session', session)).status).toBe(200);
    expect((await list(session)).status).toBe(410);
  });
});

describe('opening one assignment through the normal guest result endpoints', () => {
  const open = (id, session, suffix = 'presentation') => request(app).get(`/api/guest/submissions/${id}/${suffix}`).set('X-Recovery-Session', session);
  test('the session opens the owner\'s results exactly as the submission\'s own link does (same visibility rules)', async () => {
    const { session } = await sessionFor(ALICE);
    for (const suffix of ['presentation', '']) {
      const viaPortal = await open(aliceA._id, session, suffix);
      const viaLink = await request(app).get(`/api/guest/submissions/${aliceA._id}/${suffix}`).set('X-Guest-Token', aliceA.guestToken);
      expect(viaLink.status).toBe(200);
      expect(viaPortal.status).toBe(200);
      expect(viaPortal.body).toEqual(viaLink.body);
    }
  });
  test('IDOR: Alice\'s session can not open Bob\'s submission (same assignment, same class)', async () => {
    const { session } = await sessionFor(ALICE);
    for (const suffix of ['presentation', '', 'feedback', 'drafts', 'ocr-corrections', 'pdf']) {
      const res = await open(bobA._id, session, suffix);
      expect({ suffix, status: res.status }).toEqual({ suffix, status: 404 });
      expect(JSON.stringify(res.body)).not.toContain('Essay');
    }
  });
  test('IDOR: an unknown or malformed submission id gets the same answers', async () => {
    const { session } = await sessionFor(ALICE);
    expect((await open(new (require('mongoose').Types.ObjectId)(), session)).status).toBe(404);
    expect((await open('not-an-id', session)).status).toBe(410);
  });
  test('the session is read-only: it can not revise, generate practice or upload', async () => {
    const { session } = await sessionFor(ALICE);
    for (const suffix of ['practice', 'revise', 'image-preflight']) {
      const res = await request(app).post(`/api/guest/submissions/${aliceA._id}/${suffix}`).set('X-Recovery-Session', session).send({});
      expect({ suffix, status: res.status }).toEqual({ suffix, status: 410 });
    }
  });
  test('a revoked guest submission is no longer reachable through the portal', async () => {
    const { session } = await sessionFor(ALICE);
    await Submission.updateOne({ _id: aliceA._id }, { $set: { 'guest.revokedAt': new Date() } });
    expect((await open(aliceA._id, session)).status).toBe(404);
    expect((await list(session)).body.data.assignments.map(i => i.id)).toEqual([String(aliceB._id)]);
  });
});

test('logs never contain the token, the session, the link or the email address', async () => {
  const sinks = ['info', 'warn', 'error', 'debug'].map(level => jest.spyOn(logger, level));
  try {
    const { token, session } = await sessionFor(ALICE);
    await list(session); await request(app).post('/api/recovery/exchange').send({ token: token.slice(0, -1) + 'x' });
    await request(app).get(`/api/guest/submissions/${bobA._id}/presentation`).set('X-Recovery-Session', session);
    const logged = JSON.stringify(sinks.flatMap(s => s.mock.calls));
    for (const secret of [token, session, ALICE, BOB, 'school.example/recover']) expect(logged).not.toContain(secret);
  } finally { sinks.forEach(s => s.mockRestore()); }
});
