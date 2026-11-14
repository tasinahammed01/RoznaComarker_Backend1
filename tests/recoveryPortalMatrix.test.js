'use strict';
// "See all your submissions" (/recover): one emailed link must list EVERY open submission of that email address. Matrix, all with the
// same address (typed in mixed case with spaces): a self-submitted guest submission; teacher uploads (guest) in the same assignment,
// another assignment (closed to guests), another class and another teacher; a teacher upload and a self submission on the account of
// a class member with that email ("Sign in to view": title, class and date only); and what must stay out: a revoked submission, an
// archived class, an inactive assignment, a non-essay assignment, another address and another account. Privacy: the same public answer
// whether or not anything exists, no results or teacher-only data, the portal session cannot open account work, unreleased Improved
// Writing Model text never appears, the cool-down remains, and revoked or expired links stay refused. Synthetic data; email mocked.
process.env.JWT_SECRET = 'recovery-portal-matrix-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.IMPROVED_WRITING_MODEL_ENABLED = 'true';
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
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionWritingModel = require('../src/models/SubmissionWritingModel');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const portal = require('../src/services/recoveryPortal.service');
const sendLink = require('../src/services/email.service').sendRecoveryPortalEmail;

jest.setTimeout(60000);
const KID = 'kid.lee@example.com';
let ids;

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), RecoveryToken.init(), RecoverySession.init()]); });
afterAll(async () => { delete process.env.IMPROVED_WRITING_MODEL_ENABLED; await disconnectInMemoryMongo(); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); sendLink.mockResolvedValue({ success: true });
  const user = (email, role, name) => User.create({ firebaseUid: crypto.randomUUID(), email, role, displayName: name });
  const [t1, t2, kid, other] = [await user('t1@example.com', 'teacher', 'Ms One'), await user('t2@example.com', 'teacher', 'Mr Two'),
    await user(KID, 'student', 'Kid Lee'), await user('other.kid@example.com', 'student', 'Other Kid')];
  const cls = (name, teacher, extra = {}) => Class.create({ name, teacher: teacher._id, joinCode: `J-${crypto.randomUUID().slice(0, 8)}`, ...extra });
  const [c1, c2, c3, cMember, cArchived] = [await cls('Class One', t1), await cls('Class Two', t1), await cls('Class Three', t2), await cls('Member Class', t1),
    await cls('Old Class', t1, { status: 'archived' })];
  await Membership.create({ student: kid._id, class: cMember._id, status: 'active' });
  await Membership.create({ student: other._id, class: cMember._id, status: 'active' });
  const asg = (title, c, teacher, extra = {}) => Assignment.create({ title, class: c._id, teacher: teacher._id, instructions: 'Write.', rubric: 'PRIVATE RUBRIC',
    qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, ...extra });
  const a = { self: await asg('Self Essay', c1, t1), closed: await asg('Guests Off Essay', c1, t1, { allowGuestSubmission: false }), otherClass: await asg('Class Two Essay', c2, t1),
    otherTeacher: await asg('Other Teacher Essay', c3, t2), member: await asg('Member Upload Essay', cMember, t1), memberSelf: await asg('Member Self Essay', cMember, t1),
    archived: await asg('Archived Essay', cArchived, t1), inactive: await asg('Inactive Essay', c1, t1, { isActive: false }),
    worksheet: await asg('A Worksheet', cMember, t1, { resourceType: 'worksheet' }) };
  const upload = teacher => ({ teacherUpload: { uploadedBy: teacher._id, batchId: 'batch-1', uploadedAt: new Date(), typedName: 'TYPED NAME', email: { status: 'sent' } } });
  const guest = (assignment, email, extra = {}) => Submission.create({ submissionMode: 'guest', assignment: assignment._id, class: assignment.class, qrToken: assignment.qrToken,
    submittedAt: new Date(Date.now() - Math.floor(Math.random() * 1e6)), status: 'submitted', assessmentStatus: 'complete', guest: { displayName: 'Kid', normalizedEmail: email, ...(extra.guest || {}) }, ...(extra.top || {}) });
  const member = (assignment, student, extra = {}) => Submission.create({ submissionMode: 'registered', student: student._id, assignment: assignment._id, class: assignment.class,
    submittedAt: new Date(), status: 'submitted', assessmentStatus: 'complete', ...extra });
  ids = {
    selfGuest: await guest(a.self, KID),
    uploadSame: await guest(a.self, KID, { top: upload(t1) }),
    uploadGuestsOff: await guest(a.closed, KID, { top: upload(t1) }),
    uploadOtherClass: await guest(a.otherClass, KID, { top: upload(t1) }),
    uploadOtherTeacher: await guest(a.otherTeacher, KID, { top: upload(t2) }),
    memberUpload: await member(a.member, kid, upload(t1)),
    memberSelf: await member(a.memberSelf, kid),
    revoked: await guest(a.self, KID, { guest: { revokedAt: new Date() } }),
    archived: await guest(a.archived, KID, { top: upload(t1) }),
    inactive: await guest(a.inactive, KID),
    worksheet: await member(a.worksheet, kid),
    otherEmail: await guest(a.self, 'someone.else@example.com'),
    otherAccount: await member(a.member, other),
  };
  // Unreleased Improved Writing Model text on two of the listed submissions: never shown in the portal.
  for (const doc of [ids.selfGuest, ids.memberUpload]) {
    await SubmissionWritingModel.create({ submission: doc._id, assignment: doc.assignment, teacher: t1._id, draftText: 'SECRET UNRELEASED DRAFT', revision: 1 });
  }
});

const waitFor = async check => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('timeout'); };
async function sessionFor(typed) {
  const before = sendLink.mock.calls.length;
  const res = await request(app).post('/api/recovery/request').send({ email: typed });
  expect(res.status).toBe(202);
  await waitFor(() => sendLink.mock.calls.length > before);
  const link = new URL(sendLink.mock.calls.at(-1)[0].link);
  expect(link.pathname).toBe('/recover/portal');                       // the all-submissions portal, not a single-submission link
  const exchanged = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(exchanged.status).toBe(200);
  return { token: link.hash.slice(1), session: exchanged.body.data.session };
}
const list = session => request(app).get('/api/recovery/assignments').set('X-Recovery-Session', session);

describe('the portal lists every open submission of the address', () => {
  test('the case matrix: guest work (self and uploaded, any assignment, class or teacher) and the class member\'s account work', async () => {
    const { session } = await sessionFor('  Kid.LEE@Example.com ');
    expect(sendLink.mock.calls.at(-1)[0].to).toBe(KID);
    const res = await list(session);
    expect(res.status).toBe(200);
    const items = res.body.data.assignments;
    const guestIds = items.filter(i => i.access !== 'signIn').map(i => i.id).sort();
    expect(guestIds).toEqual(['selfGuest', 'uploadSame', 'uploadGuestsOff', 'uploadOtherClass', 'uploadOtherTeacher'].map(k => String(ids[k]._id)).sort());
    const signIn = items.filter(i => i.access === 'signIn');
    expect(signIn.map(i => i.assignmentTitle).sort()).toEqual(['Member Self Essay', 'Member Upload Essay']);
    expect(new Set(items.map(i => i.className))).toEqual(new Set(['Class One', 'Class Two', 'Class Three', 'Member Class']));
    const body = JSON.stringify(res.body);
    for (const key of ['revoked', 'archived', 'inactive', 'worksheet', 'otherEmail', 'otherAccount', 'memberUpload', 'memberSelf']) expect(body).not.toContain(String(ids[key]._id));
    for (const title of ['Archived Essay', 'Inactive Essay', 'A Worksheet']) expect(body).not.toContain(title);
  });

  test('account rows say only "sign in": title, class and date; no status, score, real id or teacher-only data', async () => {
    const { session } = await sessionFor(KID);
    const items = (await list(session)).body.data.assignments;
    for (const row of items.filter(i => i.access === 'signIn')) {
      expect(Object.keys(row).sort()).toEqual(['access', 'assignmentTitle', 'className', 'id', 'submittedAt']);
      expect(row.id).toMatch(/^account-\d+$/);
    }
    for (const row of items.filter(i => i.access !== 'signIn')) expect(Object.keys(row).sort()).toEqual(['assignmentTitle', 'className', 'id', 'status', 'submittedAt']);
    const body = JSON.stringify(items);
    for (const leak of ['SECRET UNRELEASED DRAFT', 'PRIVATE RUBRIC', 'TYPED NAME', 'teacherUpload', 't1@example.com', 'Ms One', KID, 'score', 'grade']) expect(body).not.toContain(leak);
  });

  test('the portal session cannot open account work (sign in is required), nor another address\'s work', async () => {
    const { session } = await sessionFor(KID);
    for (const doc of [ids.memberUpload, ids.memberSelf, ids.otherEmail]) {
      const res = await request(app).get(`/api/guest/submissions/${doc._id}/presentation`).set('X-Recovery-Session', session);
      expect(res.status).toBe(404);
    }
    expect((await request(app).get(`/api/guest/submissions/${ids.uploadOtherTeacher._id}/presentation`).set('X-Recovery-Session', session)).status).toBe(200);
  });
});

describe('no enumeration, limits and links', () => {
  test('an address with only account work now gets a link; the public answer is the same as for an unknown address', async () => {
    await Submission.deleteMany({ submissionMode: 'guest' });
    const known = await request(app).post('/api/recovery/request').send({ email: KID });
    const unknown = await request(app).post('/api/recovery/request').send({ email: 'nobody@example.com' });
    expect(known.status).toBe(unknown.status);
    expect(known.body).toEqual(unknown.body);
    await waitFor(() => sendLink.mock.calls.length >= 1);
    await new Promise(r => setTimeout(r, 50));
    expect(sendLink.mock.calls.map(([m]) => m.to)).toEqual([KID]);
  });
  test('an address with nothing gets no email; the cool-down still applies to account-only addresses', async () => {
    expect(await portal.issueLink('nobody@example.com')).toEqual({ sent: false, reason: 'no_submissions' });
    await Submission.deleteMany({ submissionMode: 'guest' });
    expect((await portal.issueLink(KID)).sent).toBe(true);
    expect((await portal.issueLink(KID)).sent).toBe(false);
    expect(sendLink).toHaveBeenCalledTimes(1);
  });
  test('revoked and expired older links stay refused; a new link works', async () => {
    const first = await sessionFor(KID);
    await portal.revokeAllForEmail(KID);
    expect((await list(first.session)).status).toBe(410);
    expect((await request(app).post('/api/recovery/exchange').send({ token: first.token })).status).toBe(410);
    await RecoveryToken.updateMany({}, { $set: { revokedAt: null, expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(app).post('/api/recovery/exchange').send({ token: first.token })).status).toBe(410);
    await new Promise(r => setTimeout(r, 10));
    await require('../src/models/RecoveryEmailWindow').deleteMany({});
    const fresh = await sessionFor(KID);
    expect((await list(fresh.session)).body.data.assignments.length).toBe(7);
  });
});
