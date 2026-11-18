'use strict';
// Stage 10 regression guard: the ESSAY guest flow, the recovery portal, the recovery links and the guest emails answer exactly as before
// speaking guests existed. Every assertion is on an exact shape (keys and values), so any change to essay behaviour in the shared code
// (guestAccess, guestRecovery, teacherRecovery, recoveryPortal, guestResultNotification, teacherUploadEmail) fails here. This file passes
// unchanged on the tree before stage 10 and after it. In-memory MongoDB; email.service is mocked; the global fetch is a tripwire.
process.env.JWT_SECRET = 'essay-guest-regression-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
jest.mock('../src/services/email.service', () => ({
  sendTeacherUploadFeedbackEmail: jest.fn(async () => ({ success: true })),
  sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })),
  sendTeacherRecoveryEmail: jest.fn(async () => ({ success: true }))
}));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 100000 }),
    createEmailRateLimiter: options => original.createEmailRateLimiter({ ...options, limit: 100000 }) };
});
const crypto = require('crypto');
const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const email = require('../src/services/email.service');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const access = require('../src/services/guestAccess.service');
const guestResults = require('../src/services/guestResultNotification.service');
const teacherUploadEmail = require('../src/services/teacherUploadEmail.service');

jest.setTimeout(60000);
const settle = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await settle(); } throw new Error('timeout'); };
const RESULT_LINK = id => new RegExp(`^https://school\\.example/guest/results/${id}#[\\w-]{43}$`);
let teacher, teacherToken, student, klass, essay, guest, guestToken;

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), RecoveryToken.init(), RecoverySession.init()]); });
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans(); jest.clearAllMocks();
  for (const fn of Object.values(email)) fn.mockResolvedValue({ success: true });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'regression.teacher@example.com', role: 'teacher', displayName: 'Ms Teacher' });
  teacherToken = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  student = await User.create({ firebaseUid: crypto.randomUUID(), email: 'member@example.com', role: 'student', displayName: 'Member' });
  klass = await Class.create({ name: 'Writing 8A', teacher: teacher._id, joinCode: `R${crypto.randomUUID().slice(0, 8)}` });
  await Membership.create({ student: student._id, class: klass._id, status: 'active' });
  essay = await Assignment.create({ title: 'River essay', class: klass._id, teacher: teacher._id, instructions: 'Write about the river.',
    qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, deadline: new Date(Date.now() + 86400000) });
  const issued = access.issueToken();
  guestToken = issued.token;
  guest = await Submission.create({ submissionMode: 'guest', assignment: essay._id, class: klass._id, qrToken: essay.qrToken, submittedAt: new Date(), status: 'submitted',
    guest: { displayName: 'Essay Guest', normalizedEmail: 'essay.guest@example.com', accessHash: issued.accessHash, expiresAt: issued.expiresAt } });
});

test('the essay guest entry: exactly the same fields', async () => {
  const res = await request(app).get(`/api/guest/assignments/${essay.qrToken}`);
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('no-store');
  expect(res.body).toEqual({ success: true, data: { title: 'River essay', instructions: 'Write about the river.', deadline: essay.deadline.toISOString(), allowGuestSubmission: true } });
});

test('the essay return link: the essay results page', () => {
  expect(access.returnUrl(String(guest._id), guestToken)).toBe(`https://school.example/guest/results/${guest._id}#${guestToken}`);
});

test('the essay result email: the same arguments (no new fields) and the essay results link', async () => {
  await Submission.updateOne({ _id: guest._id }, { $set: { assessmentStatus: 'complete' } });
  await guestResults.run();
  expect(email.sendGuestSubmissionEmail).toHaveBeenCalledTimes(1);
  const args = email.sendGuestSubmissionEmail.mock.calls[0][0];
  expect(Object.keys(args).sort()).toEqual(['assignmentTitle', 'resultReady', 'returnUrl', 'to']);
  expect(args).toEqual({ to: 'essay.guest@example.com', assignmentTitle: 'River essay', returnUrl: expect.stringMatching(RESULT_LINK(guest._id)), resultReady: true });
});

test('"Lost your link?" (assignment and submission routes): the same answer and an essay results link', async () => {
  const byAssignment = await request(app).post(`/api/guest/assignments/${essay.qrToken}/recover`).send({ email: 'essay.guest@example.com' });
  expect(byAssignment.status).toBe(200);
  await waitFor(() => email.sendGuestRecoveryEmail.mock.calls.length > 0);
  const first = email.sendGuestRecoveryEmail.mock.calls[0][0];
  expect(Object.keys(first).sort()).toEqual(['expiresInDays', 'link', 'to']);
  expect(first).toEqual({ to: 'essay.guest@example.com', link: expect.stringMatching(RESULT_LINK(guest._id)), expiresInDays: 30 });
  await require('../src/models/RecoveryEmailWindow').deleteMany({});
  const bySubmission = await request(app).post(`/api/guest/submissions/${guest._id}/recover`).send({ email: 'essay.guest@example.com' });
  expect(bySubmission.body).toEqual(byAssignment.body);
  await waitFor(() => email.sendGuestRecoveryEmail.mock.calls.length > 1);
  expect(email.sendGuestRecoveryEmail.mock.calls[1][0].link).toMatch(RESULT_LINK(guest._id));
});

test('the teacher-sent recovery link: the same answer and an essay results link', async () => {
  const res = await request(app).post(`/api/submissions/${guest._id}/guest-access/recovery-link`).set({ Authorization: `Bearer ${teacherToken}` }).send({});
  expect(res.status).toBe(200);
  expect(Object.keys(res.body.data).sort()).toEqual(['emailMasked', 'lastSentAt', 'sent']);
  const args = email.sendTeacherRecoveryEmail.mock.calls[0][0];
  expect(Object.keys(args).sort()).toEqual(['expiresInDays', 'link', 'to']);
  expect(args.link).toMatch(RESULT_LINK(guest._id));
});

test('the recovery portal: essay guest rows and account rows keep their exact shape', async () => {
  await Submission.create({ student: student._id, assignment: essay._id, class: klass._id, status: 'submitted', submittedAt: new Date() });
  const session = async address => {
    email.sendRecoveryPortalEmail.mockClear();
    await request(app).post('/api/recovery/request').send({ email: address });
    await waitFor(() => email.sendRecoveryPortalEmail.mock.calls.length > 0);
    const token = new URL(email.sendRecoveryPortalEmail.mock.calls[0][0].link).hash.slice(1);
    return (await request(app).post('/api/recovery/exchange').send({ token })).body.data.session;
  };
  const guestRows = (await request(app).get('/api/recovery/assignments').set('X-Recovery-Session', await session('essay.guest@example.com'))).body.data.assignments;
  expect(guestRows).toEqual([{ id: String(guest._id), assignmentTitle: 'River essay', className: 'Writing 8A', submittedAt: expect.any(String), status: 'processing' }]);
  const accountRows = (await request(app).get('/api/recovery/assignments').set('X-Recovery-Session', await session('member@example.com'))).body.data.assignments;
  expect(accountRows).toEqual([{ id: 'account-1', access: 'signIn', assignmentTitle: 'River essay', className: 'Writing 8A', submittedAt: expect.any(String) }]);
});

test('the essay teacher-upload email to a guest: the same message fields and an essay results link', async () => {
  await Submission.updateOne({ _id: guest._id }, { $set: { assessmentStatus: 'complete', teacherUpload: { uploadedBy: teacher._id, batchId: 'batch-r1', uploadedAt: new Date(),
    typedName: 'Essay Guest', email: { status: 'queued', requestedAt: new Date(), attempts: 0 } } } });
  await teacherUploadEmail.run();
  expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(1);
  const message = email.sendTeacherUploadFeedbackEmail.mock.calls[0][0];
  expect(Object.keys(message).sort()).toEqual(['assignmentTitle', 'expiresAt', 'issuedHash', 'link', 'needsLogin', 'studentName', 'teacherName', 'to']);
  expect(message).toEqual(expect.objectContaining({ to: 'essay.guest@example.com', studentName: 'Essay Guest', teacherName: 'Ms Teacher', assignmentTitle: 'River essay',
    needsLogin: false, link: expect.stringMatching(RESULT_LINK(guest._id)) }));
  expect((await Submission.findById(guest._id).select('+teacherUpload').lean()).teacherUpload.email.status).toBe('sent');
});

test('the essay guest result page still answers the same top-level fields', async () => {
  const res = await request(app).get(`/api/guest/submissions/${guest._id}`).set('X-Guest-Token', guestToken);
  expect(res.status).toBe(200);
  expect(Object.keys(res.body.data).sort()).toEqual(['allowResubmission', 'feedback', 'marksVisible', 'name', 'requireAdaptiveBeforeResubmission', 'status', 'submittedAt', 'title', 'transcript']);
  expect(res.body.data).not.toHaveProperty('kind');
});
