'use strict';
// Production bug: GET /api/recovery/assignments answered 503 (RECOVERY_FAILED) once the portal also listed account work. Old records
// with a missing, null or invalid assignment/class id were turned into "undefined"/"null"/"legacy" strings and passed to an $in query,
// which threw a CastError and failed the whole list. Here: production-like messy records (raw inserts, no schema validation) through
// the real routes. The list must answer 200 with every valid row; each broken row is skipped and logged with its submission id and a
// reason code only. Very old account records without submissionMode are listed. A real failure is logged with the error name, the
// first stack frame and the stage, never the message or personal data. Privacy rules unchanged. Synthetic data; email mocked.
process.env.JWT_SECRET = 'recovery-portal-messy-secret';
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
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const portal = require('../src/services/recoveryPortal.service');
const sendLink = require('../src/services/email.service').sendRecoveryPortalEmail;

jest.setTimeout(60000);
const KID = 'kid.messy@example.com', OTHER = 'other.messy@example.com';
const id = () => new mongoose.Types.ObjectId();
let ctx;

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), RecoveryToken.init(), RecoverySession.init()]); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); sendLink.mockResolvedValue({ success: true });
  jest.spyOn(logger, 'warn'); jest.spyOn(logger, 'info');
  const teacher = id(), kid = id(), cls = id(), asg = id(), asgNoClass = id();
  // One assignment per account submission (a student has one submission per assignment: unique index student+assignment).
  const [asgOld, asgA, asgB, asgC] = [id(), id(), id(), id()];
  await User.collection.insertMany([{ _id: teacher, firebaseUid: 'messy-t', email: 'teacher@example.com', role: 'teacher' },
    { _id: kid, firebaseUid: 'messy-kid', email: KID, role: 'student', displayName: null }]);
  await Class.collection.insertOne({ _id: cls, name: 'Writing 7B', teacher, isActive: true });
  await Assignment.collection.insertMany([{ _id: asg, title: 'Good Essay', class: cls, teacher, isActive: true, allowGuestSubmission: true },
    { _id: asgNoClass, title: 'Assignment Without Class', teacher, isActive: true, allowGuestSubmission: true },
    ...[[asgOld, 'Old Essay'], [asgA, 'Essay A'], [asgB, 'Essay B'], [asgC, 'Essay C']].map(([_id, title]) => ({ _id, title, class: cls, teacher, isActive: true }))]);
  await Membership.collection.insertOne({ student: kid, class: cls, status: 'active' });
  const sub = doc => Submission.collection.insertOne({ _id: id(), submittedAt: new Date(), ...doc }).then(r => String(r.insertedId));
  ctx = { kid, cls, asg, ids: {
    goodGuest: await sub({ submissionMode: 'guest', assignment: asg, class: cls, assessmentStatus: 'complete', guest: { normalizedEmail: KID, displayName: 'Kid' } }),
    guestMissingOptional: await sub({ submissionMode: 'guest', assignment: asg, class: cls, guest: { normalizedEmail: KID } }),
    goodAccount: await sub({ submissionMode: 'registered', student: kid, assignment: asg, class: cls }),
    oldAccountNoMode: await sub({ student: kid, assignment: asgOld, class: cls }),
    accountNoClass: await sub({ submissionMode: 'registered', student: kid, assignment: asgA }),
    accountNullClass: await sub({ submissionMode: 'registered', student: kid, assignment: asgB, class: null }),
    accountInvalidClass: await sub({ submissionMode: 'registered', student: kid, assignment: asgC, class: 'legacy-class' }),
    accountNoAssignment: await sub({ submissionMode: 'registered', student: kid, class: cls }),
    guestNoAssignment: await sub({ submissionMode: 'guest', class: cls, guest: { normalizedEmail: KID } }),
    guestInvalidAssignment: await sub({ submissionMode: 'guest', assignment: 'not-an-id', class: cls, guest: { normalizedEmail: KID } }),
    assignmentWithoutClass: await sub({ submissionMode: 'registered', student: kid, assignment: asgNoClass }),
    guestRevoked: await sub({ submissionMode: 'guest', assignment: asg, class: cls, guest: { normalizedEmail: KID, revokedAt: new Date() } }),
    otherEmailBroken: await sub({ submissionMode: 'guest', class: cls, guest: { normalizedEmail: OTHER } }),
  } };
});
afterEach(() => jest.restoreAllMocks());

const waitFor = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
async function sessionFor(email) {
  const before = sendLink.mock.calls.length;
  expect((await request(app).post('/api/recovery/request').send({ email })).status).toBe(202);
  await waitFor(() => sendLink.mock.calls.length > before);
  const token = new URL(sendLink.mock.calls.at(-1)[0].link).hash.slice(1);
  const exchanged = await request(app).post('/api/recovery/exchange').send({ token });
  expect(exchanged.status).toBe(200);
  return { token, session: exchanged.body.data.session };
}
const list = session => request(app).get('/api/recovery/assignments').set('X-Recovery-Session', session);
const warnings = () => logger.warn.mock.calls.map(([entry]) => entry);

describe('messy production-like records', () => {
  test('the list answers 200 with every valid row (it was 503); broken rows are left out', async () => {
    const { session } = await sessionFor(KID);
    const res = await list(session);
    expect(res.status).toBe(200);
    const items = res.body.data.assignments;
    expect(items.filter(i => i.access !== 'signIn').map(i => i.id).sort()).toEqual([ctx.ids.goodGuest, ctx.ids.guestMissingOptional].sort());
    // The good account submission and the very old one without submissionMode: two "Sign in to view" rows.
    expect(items.filter(i => i.access === 'signIn').map(i => i.assignmentTitle).sort()).toEqual(['Good Essay', 'Old Essay']);
    const body = JSON.stringify(res.body);
    for (const key of ['guestRevoked', 'otherEmailBroken', 'guestNoAssignment', 'guestInvalidAssignment']) expect(body).not.toContain(ctx.ids[key]);
    expect(body).not.toContain('Assignment Without Class');
  });

  test('each broken row is logged once with its submission id and a reason code only (no email, title or error text)', async () => {
    const { session } = await sessionFor(KID);
    logger.warn.mockClear();
    expect((await list(session)).status).toBe(200);
    const skipped = warnings().filter(entry => entry?.event === 'recovery_portal_row_skipped');
    const byId = Object.fromEntries(skipped.map(entry => [entry.submissionId, entry.reason]));
    expect(byId).toEqual({
      [ctx.ids.accountNoClass]: 'MISSING_CLASS', [ctx.ids.accountNullClass]: 'MISSING_CLASS', [ctx.ids.accountInvalidClass]: 'INVALID_CLASS',
      [ctx.ids.accountNoAssignment]: 'MISSING_ASSIGNMENT', [ctx.ids.guestNoAssignment]: 'MISSING_ASSIGNMENT', [ctx.ids.guestInvalidAssignment]: 'INVALID_ASSIGNMENT',
      [ctx.ids.assignmentWithoutClass]: 'MISSING_CLASS' });
    for (const entry of skipped) expect(Object.keys(entry).sort()).toEqual(['code', 'event', 'reason', 'submissionId']);
    for (const entry of skipped) expect(entry.code).toBe('RECOVERY_ROW_SKIPPED');
    const text = JSON.stringify(warnings());
    for (const leak of [KID, 'Good Essay', 'Assignment Without Class', 'legacy-class', 'Cast to ObjectId']) expect(text).not.toContain(leak);
    expect(warnings().some(entry => entry?.event === 'recovery_portal_request_failed')).toBe(false);
  });

  test('a row that throws while it is mapped is skipped; the rest are kept', async () => {
    const { session } = await sessionFor(KID);
    await Submission.collection.updateOne({ _id: new mongoose.Types.ObjectId(ctx.ids.goodGuest) }, { $set: { submittedAt: { $bad: 'shape' } } });
    const realStatus = require('../src/services/canonicalResultState.service').guestResultStatus;
    jest.spyOn(require('../src/services/canonicalResultState.service'), 'guestResultStatus').mockImplementation(args => {
      if (String(args.submission._id) === ctx.ids.goodGuest) throw new TypeError('synthetic row failure kid.messy@example.com');
      return realStatus(args);
    });
    logger.warn.mockClear();
    const res = await list(session);
    expect(res.status).toBe(200);
    expect(res.body.data.assignments.map(i => i.id)).toContain(ctx.ids.guestMissingOptional);
    expect(res.body.data.assignments.map(i => i.id)).not.toContain(ctx.ids.goodGuest);
    expect(warnings()).toContainEqual({ event: 'recovery_portal_row_skipped', code: 'RECOVERY_ROW_SKIPPED', reason: 'MAPPING_FAILED', submissionId: ctx.ids.goodGuest });
    expect(JSON.stringify(warnings())).not.toContain('synthetic row failure');
  });

  test('an address with only a very old account record (no submissionMode) gets a link; the public answer is unchanged', async () => {
    await Submission.collection.deleteMany({ $or: [{ submissionMode: 'guest' }, { submissionMode: 'registered' }] });
    const known = await request(app).post('/api/recovery/request').send({ email: KID });
    const unknown = await request(app).post('/api/recovery/request').send({ email: 'nobody.messy@example.com' });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    await waitFor(() => sendLink.mock.calls.length >= 1);
    await new Promise(r => setTimeout(r, 50));
    expect(sendLink.mock.calls.map(([m]) => m.to)).toEqual([KID]);
  });

  test('privacy: another address\'s broken record never appears or is logged for this list; revoked links stay revoked', async () => {
    const { token, session } = await sessionFor(KID);
    logger.warn.mockClear();
    await list(session);
    expect(JSON.stringify(warnings())).not.toContain(ctx.ids.otherEmailBroken);
    await portal.revokeAllForEmail(KID);
    expect((await list(session)).status).toBe(410);
    expect((await request(app).post('/api/recovery/exchange').send({ token })).status).toBe(410);
  });
});

describe('failure log when the list really fails', () => {
  test.each([
    ['lookup', () => jest.spyOn(Submission, 'find').mockImplementationOnce(() => { throw new TypeError('synthetic kid.messy@example.com'); })],
    ['account_lookup', () => jest.spyOn(User, 'findOne').mockImplementationOnce(() => { throw new RangeError('synthetic kid.messy@example.com'); })],
  ])('%s: 503 as before, logged with the error name, the first stack frame (src/...:line) and the stage; never the message', async (stage, breakIt) => {
    const { session } = await sessionFor(KID);
    logger.warn.mockClear();
    breakIt();
    const res = await list(session);
    expect(res.status).toBe(503);
    expect(res.body.code).toBe('RECOVERY_UNAVAILABLE');
    const failed = warnings().find(entry => entry?.event === 'recovery_portal_request_failed');
    expect(failed).toEqual({ event: 'recovery_portal_request_failed', code: 'RECOVERY_FAILED', stage,
      errorName: stage === 'lookup' ? 'TypeError' : 'RangeError', frame: expect.stringMatching(/^src\/[\w./-]+\.js:\d+$/) });
    expect(JSON.stringify(warnings())).not.toContain('synthetic');
    expect(JSON.stringify(warnings())).not.toContain(KID);
  });
});
