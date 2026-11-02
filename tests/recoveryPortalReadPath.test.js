'use strict';
// Recovery portal follow-up: realistic results opened via own link vs portal session (identical), side-effect audit of every route the
// portal session reaches, write endpoints refused, and the per-address email cap under concurrency.
process.env.JWT_SECRET = 'recovery-read-path-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/recovery-read-test-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ ...jest.requireActual('../src/services/canonicalCorrectionsPipeline.service'), generateAndPersist: jest.fn(async () => {}) }));
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
const mongoose = require('mongoose');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { pageImage } = require('./fixtures/imagePreflightPage');
const { seedRealisticGuestResult } = require('./helpers/realisticGuestResult');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const RecoveryToken = require('../src/models/RecoveryToken');
const emailService = require('../src/services/email.service');
const scheduled = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const generate = require('../src/services/canonicalCorrectionsPipeline.service').generateAndPersist;
const credits = require('../src/services/assessmentCreditRouter.service').canRunAssessment;

jest.setTimeout(120000);
const EMAIL = 'qa-student@example.com';
let teacher, visible, hidden, other, png;
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);

beforeAll(async () => {
  await connectInMemoryMongo();
  await Promise.all([Submission.init(), RecoveryToken.init()]);
  png = await pageImage();
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans(); jest.clearAllMocks();
  for (const key of ['RECOVERY_EMAILS_PER_HOUR']) delete process.env[key];
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'qa-teacher@example.com', role: 'teacher' });
  const cls = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'QA-' + crypto.randomUUID().slice(0, 8) });
  const make = (title, extra = {}) => Assignment.create({ title, class: cls._id, teacher: teacher._id, instructions: 'Describe your weekend.',
    rubric: 'PRIVATE RUBRIC', qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, ...extra });
  [visible, hidden, other] = [await make('Marks visible'), await make('Marks hidden', { showMarksToStudent: false }), await make('Someone else')];
});

async function portalSession(email = EMAIL) {
  const link = await (async () => {
    const before = emailService.sendRecoveryPortalEmail.mock.calls.length;
    expect((await request(app).post('/api/recovery/request').send({ email })).status).toBe(202);
    for (let i = 0; i < 200 && emailService.sendRecoveryPortalEmail.mock.calls.length === before; i++) await new Promise(r => setTimeout(r, 10));
    return new URL(emailService.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link);
  })();
  const res = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(res.status).toBe(200);
  return res.body.data.session;
}
const readRoutes = submission => {
  const id = String(submission._id), fileId = String(submission.files[0]);
  return ['', 'presentation', 'feedback', 'ocr-corrections', 'drafts', 'practice', `media/${fileId}/essay.png`,
    `practice/${new mongoose.Types.ObjectId()}/attempts?activityId=a&questionId=q`].map(suffix => `/api/guest/submissions/${id}/${suffix}`);
};
const get = (url, header) => request(app).get(url).set(...header).buffer(true);
const comparable = res => ({ status: res.status, type: res.headers['content-type'],
  body: /json/.test(res.headers['content-type'] || '') ? res.body : Buffer.isBuffer(res.body) ? crypto.createHash('sha256').update(res.body).digest('hex') : res.text });

describe('A. opened results are identical via own link and via the portal session', () => {
  test.each([['marks visible', () => visible, true], ['marks hidden', () => hidden, false]])('%s: every read endpoint returns the same status and body', async (_n, pick, marks) => {
    const seeded = await seedRealisticGuestResult({ app, assignment: pick(), teacher, email: EMAIL, png });
    const session = await portalSession();
    for (const url of readRoutes(seeded.submission)) {
      const own = comparable(await get(url, ['X-Guest-Token', seeded.guestToken]));
      const viaPortal = comparable(await get(url, ['X-Recovery-Session', session]));
      expect({ url, ...viaPortal }).toEqual({ url, ...own });
    }
    // The pages that matter really have data: transcript words, a bound correction, the evaluation and the teacher comment.
    const ocr = await get(`/api/guest/submissions/${seeded.submission._id}/ocr-corrections`, ['X-Recovery-Session', session]);
    expect(ocr.status).toBe(200);
    expect(ocr.body.data.corrections.length).toBe(1);
    const feedback = await get(`/api/guest/submissions/${seeded.submission._id}/feedback`, ['X-Recovery-Session', session]);
    expect(feedback.status).toBe(200);
    expect(feedback.body.data.marksVisible).toBe(marks);
    expect(feedback.body.data.teacherComments).toContain('Teacher review complete.');
    const result = await get(`/api/guest/submissions/${seeded.submission._id}/`, ['X-Recovery-Session', session]);
    if (marks) expect(result.body.data.feedback.overallScore).toBe(82);
    else {
      // Redaction: no score anywhere in the result, the feedback or the presentation.
      for (const res of [result, feedback]) expect(JSON.stringify(res.body)).not.toMatch(/"overallScore":\s*\d|"score":\s*\d|"grade":\s*"[A-F]/);
    }
  });

  test('the earlier 409 on ocr-corrections is a seed artifact: a submission without OCR data gives the same 409 via its own link', async () => {
    const seeded = await seedRealisticGuestResult({ app, assignment: visible, teacher, email: EMAIL, png });
    await Submission.updateOne({ _id: seeded.submission._id }, { $set: { ocrPages: [] }, $unset: { transcriptText: 1, ocrText: 1, combinedOcrText: 1 } });
    const session = await portalSession();
    const url = `/api/guest/submissions/${seeded.submission._id}/ocr-corrections`;
    const own = comparable(await get(url, ['X-Guest-Token', seeded.guestToken])), viaPortal = comparable(await get(url, ['X-Recovery-Session', session]));
    expect(own.status).toBe(409);
    expect(viaPortal).toEqual(own);
    expect(own.body.message).toBe('OCR data is not available');
  });
});

describe('B. the portal read path has no side effects', () => {
  async function snapshot() {
    const collections = await mongoose.connection.db.listCollections().toArray();
    const out = {};
    for (const { name } of collections.sort((a, b) => a.name.localeCompare(b.name))) {
      out[name] = await mongoose.connection.db.collection(name).find({}).sort({ _id: 1 }).toArray();
    }
    const files = fs.existsSync(uploadRoot) ? fs.readdirSync(uploadRoot, { recursive: true }).map(String).sort() : [];
    return JSON.stringify({ out, files });
  }
  test('every GET route, twice, through the portal session: no database change, no new files, no OCR/AI/email/credit call', async () => {
    const seeded = await seedRealisticGuestResult({ app, assignment: visible, teacher, email: EMAIL, png });
    const session = await portalSession();
    jest.clearAllMocks();
    const before = await snapshot();
    const statuses = {};
    for (let round = 0; round < 2; round++) for (const url of readRoutes(seeded.submission)) {
      for (const method of ['get', 'head']) statuses[`${method.toUpperCase()} ${url.split(String(seeded.submission._id))[1]}`] = (await request(app)[method](url).set('X-Recovery-Session', session)).status;
    }
    expect(await snapshot()).toBe(before);
    for (const fn of [scheduled, generate, credits, emailService.sendGuestSubmissionEmail, emailService.sendTeacherSubmissionEmail, emailService.sendRecoveryPortalEmail])
      expect(fn).not.toHaveBeenCalled();
    // Documented in the report.
    // eslint-disable-next-line no-console
    console.log('portal GET/HEAD statuses', JSON.stringify(statuses));
  });
});

describe('D. abuse checks', () => {
  test('a portal session can not reach any write endpoint', async () => {
    const seeded = await seedRealisticGuestResult({ app, assignment: visible, teacher, email: EMAIL, png });
    const session = await portalSession();
    const id = String(seeded.submission._id), base = `/api/guest/submissions/${id}`;
    jest.clearAllMocks();   // the seed's own upload scheduled analysis once
    const before = await Submission.findById(id).lean();
    const attempts = [
      ['post', `${base}/revise`], ['post', `${base}/image-preflight`], ['post', `${base}/practice`],
      ['post', `${base}/practice/${new mongoose.Types.ObjectId()}/activity-1`], ['put', `${base}/`], ['patch', `${base}/`], ['delete', `${base}/`],
      ['post', `/api/submissions/${id}/ocr-corrections/regenerate`], ['delete', `/api/guest/submissions/${id}/revoke`],
    ];
    const results = {};
    for (const [method, url] of attempts) {
      const res = await request(app)[method](url).set('X-Recovery-Session', session).set('Idempotency-Key', crypto.randomUUID())
        .field('name', 'x').field('email', EMAIL).attach('files', png, { filename: 'a.png', contentType: 'image/png' });
      results[`${method.toUpperCase()} ${url.replace(id, ':id')}`] = res.status;
      expect([401, 403, 404, 410]).toContain(res.status);
    }
    expect(await Submission.findById(id).lean()).toEqual(before);
    expect(scheduled).not.toHaveBeenCalled();
    // eslint-disable-next-line no-console
    console.log('portal write attempts', JSON.stringify(results));
  });

  test('email bomb: 20 parallel requests for one address send at most RECOVERY_EMAILS_PER_HOUR emails', async () => {
    await seedRealisticGuestResult({ app, assignment: visible, teacher, email: EMAIL, png });
    process.env.RECOVERY_EMAILS_PER_HOUR = '3';
    const responses = await Promise.all(Array.from({ length: 20 }, () => request(app).post('/api/recovery/request').send({ email: EMAIL })));
    expect(responses.every(r => r.status === 202)).toBe(true);
    await new Promise(r => setTimeout(r, 1500));
    // eslint-disable-next-line no-console
    console.log('emails sent for 20 parallel requests:', emailService.sendRecoveryPortalEmail.mock.calls.length);
    expect(emailService.sendRecoveryPortalEmail.mock.calls.length).toBeLessThanOrEqual(3);
    expect(await RecoveryToken.countDocuments({ revokedAt: null })).toBeLessThanOrEqual(3);
  });
});
