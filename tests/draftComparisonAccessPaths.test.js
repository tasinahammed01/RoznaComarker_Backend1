'use strict';
// Task 6F-0: the draft comparison as each caller receives it (registered student, guest own link, guest resend link, recovery portal
// session, class teacher). Synthetic data only.
process.env.JWT_SECRET = 'draft-comparison-access-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/draft-comparison-access';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const emailService = require('../src/services/email.service');
const access = require('../src/services/guestAccess.service');
const { captureCurrentRevision } = require('../src/services/submissionRevision.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const REMOVED = ['previousSubmissionId', 'matchStrategy'];
let fixture, studentJwt, teacherJwt, resendToken, portalSession;

function keysIn(value, keys, out = []) {
  if (Array.isArray(value)) value.forEach(item => keysIn(item, keys, out));
  else if (value && typeof value === 'object') for (const [key, nested] of Object.entries(value)) { if (keys.includes(key)) out.push(key); keysIn(nested, keys, out); }
  return out;
}

async function openPortal() {
  const before = emailService.sendRecoveryPortalEmail.mock.calls.length;
  expect((await request(app).post('/api/recovery/request').send({ email: 'guest.student@example.com' })).status).toBe(202);
  for (let i = 0; i < 300 && emailService.sendRecoveryPortalEmail.mock.calls.length === before; i++) await new Promise(r => setTimeout(r, 10));
  const link = new URL(emailService.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link);
  const res = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(res.status).toBe(200);
  return res.body.data.session;
}

const student = () => request(app).get(`/api/submissions/${fixture.IDS.registered}/draft-comparison`).set('Authorization', `Bearer ${studentJwt}`);
const teacher = () => request(app).get(`/api/submissions/${fixture.IDS.registered}/draft-comparison`).set('Authorization', `Bearer ${teacherJwt}`);
const guest = header => request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/drafts`).set(...header());
const CALLERS = {
  'registered student': student,
  'guest own link': () => guest(() => ['X-Guest-Token', fixture.guestToken]),
  'guest resend link': () => guest(() => ['X-Guest-Token', resendToken]),
  'recovery portal session': () => guest(() => ['X-Recovery-Session', portalSession]),
};

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await Promise.all(['Submission', 'RecoveryToken', 'RecoverySession', 'RecoveryEmailWindow'].map(m => require(`../src/models/${m}`).init()));
  fixture = await seedAnnotationFixture({ uploadRoot });
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  teacherJwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
  const resend = access.issueToken();
  resendToken = resend.token;
  await Submission.updateOne({ _id: fixture.IDS.guest }, { $push: { 'guest.recoveryAccess': { hash: resend.accessHash, expiresAt: resend.expiresAt, createdAt: new Date() } } });
  portalSession = await openPortal();
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

describe.each(Object.keys(CALLERS))('%s', (name) => {
  test('first draft: answered, without the removed keys', async () => {
    const res = await CALLERS[name]();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ available: false, code: 'FIRST_DRAFT' });
    expect(keysIn(res.body, REMOVED)).toEqual([]);
  });
});

describe('with a previous draft', () => {
  let revisionIds;
  beforeAll(async () => {
    revisionIds = [];
    for (const id of [fixture.IDS.registered, fixture.IDS.guest]) {
      const doc = await Submission.findById(id);
      revisionIds.push(String((await captureCurrentRevision(doc))._id));
      await Submission.updateOne({ _id: id }, { $set: { draftNumber: 2, fileContentIdentity: `access-draft-2-${id}` } });
    }
  });

  test('positive control: the class teacher still receives both keys, so their absence below means something', async () => {
    const res = await teacher();
    expect(res.status).toBe(200);
    expect(res.body.data.available).toBe(true);
    expect(res.body.data.previousSubmissionId).toBe(revisionIds[0]);
    expect(res.body.data.rubricCategories[0].matchStrategy).toBeTruthy();
  });

  describe.each(Object.keys(CALLERS))('%s', (name) => {
    test('the comparison has its content and neither removed key, at any depth', async () => {
      const res = await CALLERS[name]();
      expect(res.status).toBe(200);
      expect(res.body.data.available).toBe(true);
      expect(res.body.data.rubricCategories.length).toBeGreaterThan(0);
      expect(res.body.data.overall).toBeTruthy();
      expect(keysIn(res.body, REMOVED)).toEqual([]);
      for (const id of revisionIds) expect(JSON.stringify(res.body)).not.toContain(id);
    });

    test('marks hidden: still the same answer as before, without the removed keys', async () => {
      await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { showMarksToStudent: false } });
      try {
        const res = await CALLERS[name]();
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ available: false, code: 'MARKS_HIDDEN' });
        expect(keysIn(res.body, REMOVED)).toEqual([]);
      } finally {
        await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $unset: { showMarksToStudent: 1 } });
      }
    });

    test('previous draft not assessed: no revision id in the answer', async () => {
      await SubmissionRevision.updateMany({}, { $set: { evaluationStatus: 'failed' } });
      try {
        const res = await CALLERS[name]();
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ available: false, code: 'PREVIOUS_UNASSESSED' });
        expect(keysIn(res.body, REMOVED)).toEqual([]);
        for (const id of revisionIds) expect(JSON.stringify(res.body)).not.toContain(id);
      } finally {
        await SubmissionRevision.updateMany({}, { $set: { evaluationStatus: 'completed' } });
      }
    });
  });
});

describe('guest route: a submission that exists but is not yours answers like one that does not exist', () => {
  let otherId;
  beforeAll(async () => {
    const own = await Submission.findById(fixture.IDS.guest).lean();
    otherId = new (require('mongoose').Types.ObjectId)();
    await Submission.collection.insertOne({ ...own, _id: otherId, guest: { ...own.guest, normalizedEmail: 'someone.else@example.com', accessHash: access.hash('H'.repeat(43)) } });
  });
  const missing = () => new (require('mongoose').Types.ObjectId)();
  const drafts = (id, header) => request(app).get(`/api/guest/submissions/${id}/drafts`).set(...header);

  test.each([['own link token', () => ['X-Guest-Token', fixture.guestToken], 410], ['recovery portal session', () => ['X-Recovery-Session', portalSession], 404]])('%s', async (_name, header, status) => {
    const foreign = await drafts(otherId, header());
    const absent = await drafts(missing(), header());
    expect(foreign.status).toBe(status);
    expect(absent.status).toBe(status);
    expect(foreign.body).toEqual(absent.body);
  });
});
