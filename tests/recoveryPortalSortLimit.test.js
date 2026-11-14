'use strict';
// Production bug: GET /api/recovery/assignments answered 503 with MongoServerError at the lookup stage. The two listing queries
// sorted heavy submissions (OCR pages with per-word boxes, corrections, annotations) in memory, with no index for the sort; on a
// server where a blocking sort may not spill to disk this fails with code 292 (QueryExceededMemoryLimitNoDiskUseAllowed). Here the
// in-memory server is put in that mode (disk use off, sort memory limit scaled to this synthetic data) and the list must still work.
// Also: neither listing query plans an in-memory SORT, the account query does not walk the guest queue index, rows are light (no
// per-word data or correction text fetched), the list status equals the result page's status, the 1000-row cap is logged, and a
// MongoServerError is logged with errorCode and codeName only. Synthetic data; email mocked.
process.env.JWT_SECRET = 'recovery-portal-sort-limit-secret';
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
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const portal = require('../src/services/recoveryPortal.service');
const { guestResultStatus } = require('../src/services/canonicalResultState.service');
const sendLink = require('../src/services/email.service').sendRecoveryPortalEmail;

jest.setTimeout(120000);
const KID = 'kid.sort@example.com';
const COUNT = 25;
const id = () => new mongoose.Types.ObjectId();
let ctx;

// A heavy page and heavy corrections, like real OCR and correction output (~300 KB per submission).
const heavyPage = n => ({ fileId: id(), fileOrder: 0, pageIndex: n, pageNumber: 1, text: 'x'.repeat(2000), sourceTextExact: 'page text',
  words: Array.from({ length: 2500 }, (_, i) => ({ id: `w${i}`, text: 'word', bbox: { x: 0.1, y: 0.2, w: 0.03, h: 0.02 }, confidence: 0.98 })) });
const heavyCorrections = () => Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, source: i % 2 ? 'AI' : 'LT', category: 'GRAMMAR',
  message: 'SECRET CORRECTION TEXT '.repeat(20), quotedText: 'word', bboxList: Array.from({ length: 20 }, () => ({ x: 0.1, y: 0.1, w: 0.1, h: 0.1 })) }));

async function setServer(params) {
  for (const [name, value] of Object.entries(params)) await mongoose.connection.db.admin().command({ setParameter: 1, [name]: value });
}
beforeAll(async () => {
  await connectInMemoryMongo();
  await Promise.all([Submission.init(), RecoveryToken.init(), RecoverySession.init()]);   // the model's indexes, as on a migrated server
  // A server where a blocking sort may not spill to disk; 2 MB here plays the part of the 100 MB limit for production-sized data.
  await setServer({ allowDiskUseByDefault: false, internalQueryMaxBlockingSortMemoryUsageBytes: 2 * 1024 * 1024 });
});
afterAll(async () => {
  await setServer({ allowDiskUseByDefault: true, internalQueryMaxBlockingSortMemoryUsageBytes: 100 * 1024 * 1024 });
  await disconnectInMemoryMongo();
});
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); sendLink.mockResolvedValue({ success: true });
  jest.spyOn(logger, 'warn');
  const teacher = id(), kid = id(), cls = id();
  await User.collection.insertMany([{ _id: teacher, firebaseUid: 'sort-t', email: 'teacher@example.com', role: 'teacher' },
    { _id: kid, firebaseUid: 'sort-kid', email: KID, role: 'student' }]);
  await Class.collection.insertOne({ _id: cls, name: 'Writing 7B', teacher, isActive: true });
  await Membership.collection.insertOne({ student: kid, class: cls, status: 'active' });
  const assignments = Array.from({ length: COUNT }, (_, i) => ({ _id: id(), title: `Essay ${String(i).padStart(2, '0')}`, class: cls, teacher, isActive: true, allowGuestSubmission: true }));
  await Assignment.collection.insertMany(assignments);
  const base = Date.UTC(2026, 9, 1);
  for (let i = 0; i < COUNT; i++) {
    const heavy = { ocrPages: [heavyPage(0)], transcriptPages: [heavyPage(1)], writingCorrections: heavyCorrections(), teacherAnnotations: { blob: 'SECRET ANNOTATION '.repeat(500) } };
    await Submission.collection.insertOne({ submissionMode: 'registered', student: kid, assignment: assignments[i]._id, class: cls, submittedAt: new Date(base + i * 60000), ...heavy });
    await Submission.collection.insertOne({ submissionMode: 'guest', assignment: assignments[i]._id, class: cls, submittedAt: new Date(base + i * 60000 + 1000),
      assessmentStatus: 'processing', guest: { normalizedEmail: KID, displayName: 'Kid' }, ...heavy });
  }
  ctx = { teacher, kid, cls, assignments };
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
  return exchanged.body.data.session;
}
const list = session => request(app).get('/api/recovery/assignments').set('X-Recovery-Session', session);
const warnings = () => logger.warn.mock.calls.map(([entry]) => entry);
/** Runs one list call and returns the Mongoose queries the service built with Submission.find, as they were sent. */
async function capturedQueries(session) {
  const real = Submission.find.bind(Submission), queries = [];
  jest.spyOn(Submission, 'find').mockImplementation((...args) => { const query = real(...args); queries.push(query); return query; });
  const res = await list(session);
  Submission.find.mockRestore();
  return { res, queries };
}
const stagesOf = plan => { const out = []; const walk = s => { if (!s) return; out.push(s.stage + (s.indexName ? `(${s.indexName})` : '')); walk(s.inputStage); (s.inputStages || []).forEach(walk); walk(s.queryPlan); }; walk(plan); return out; };

describe('a server where a blocking sort cannot spill to disk', () => {
  test('heavy guest and account work still lists (it was 503, MongoServerError 292), newest first', async () => {
    const session = await sessionFor(KID);
    const res = await list(session);
    expect(res.status).toBe(200);
    const items = res.body.data.assignments;
    const guest = items.filter(i => i.access !== 'signIn'), account = items.filter(i => i.access === 'signIn');
    expect(guest).toHaveLength(COUNT);
    expect(account).toHaveLength(COUNT);
    expect(guest.map(i => i.assignmentTitle)).toEqual(ctx.assignments.map(a => a.title).reverse());
    expect(account.map(i => i.assignmentTitle)).toEqual(ctx.assignments.map(a => a.title).reverse());
    expect(JSON.stringify(res.body)).not.toContain('SECRET');
    expect(warnings().some(entry => entry?.event === 'recovery_portal_request_failed')).toBe(false);
  });

  test('neither listing query plans an in-memory SORT; the account query does not walk the guest queue index; rows are light', async () => {
    const session = await sessionFor(KID);
    const { res, queries } = await capturedQueries(session);
    expect(res.status).toBe(200);
    expect(queries).toHaveLength(2);
    for (const query of queries) {
      const options = query.getOptions();
      expect(options.sort).toBeUndefined();
      const explained = await Submission.collection.find(query.getFilter(), { projection: query.projection(), limit: options.limit }).explain('queryPlanner');
      const stages = stagesOf(explained.queryPlanner.winningPlan);
      expect(stages.filter(stage => /SORT/.test(stage))).toEqual([]);
      const projection = query.projection() || {};
      for (const heavy of ['ocrPages.words', 'transcriptPages', 'teacherAnnotations', 'writingCorrections.message', 'writingCorrections.bboxList'])
        expect(Object.prototype.hasOwnProperty.call(projection, heavy)).toBe(false);
      expect(Object.values(projection).every(value => value === 1)).toBe(true);   // inclusion only: nothing heavy by default
    }
    const accountQuery = queries.find(q => q.getFilter().student);
    const accountPlan = stagesOf((await Submission.collection.find(accountQuery.getFilter(), { projection: accountQuery.projection() }).explain('queryPlanner')).queryPlanner.winningPlan);
    expect(accountPlan.join(' ')).not.toContain('guest_result_email_queue_v1');
    // What actually came back from the database is light: no per-word data, no correction text, no annotations.
    const fetched = await Promise.all(queries.map(q => Submission.find(q.getFilter()).select(q.projection()).limit(5).lean()));
    const raw = JSON.stringify(fetched);
    expect(raw).not.toContain('"words"');
    expect(raw).not.toContain('SECRET');
  });
});

describe('the list status is the result page\'s status', () => {
  test.each([
    ['complete, nothing evaluated yet', { assessmentStatus: 'complete' }],
    ['OCR failed', { ocrStatus: 'failed', assessmentStatus: 'failed' }],
    ['evaluation blocked', { evaluationStatus: 'blocked' }],
    ['exact-source mode, not verified', { sourceFidelityMode: 'gpt_vision_exact', sourceFidelityStatus: 'OCR_UNCERTAIN', ocrStatus: 'completed' }],
    ['complete with a current evaluation and feedback', { assessmentStatus: 'complete', ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
      evaluationStatus: 'completed', correctionSourceHash: 'hash-1', correctionTranscriptLayoutVersion: require('../src/utils/ocrTranscriptNormalizer').CANONICAL_TRANSCRIPT_LAYOUT_VERSION }],
  ])('%s', async (_name, fields) => {
    const target = await Submission.collection.findOne({ submissionMode: 'guest', assignment: ctx.assignments[0]._id });
    await Submission.collection.updateOne({ _id: target._id }, { $set: fields });
    if (fields.evaluationStatus === 'completed') {
      await SubmissionFeedback.collection.insertOne({ submissionId: target._id, evaluationSourceHash: 'hash-1', overallScore: 70, detailedFeedbackSourceHash: 'hash-1',
        detailedFeedback: { areasForImprovement: [], strengths: [], actionSteps: [] } });
    }
    const full = await Submission.findById(target._id).lean();
    const feedback = await SubmissionFeedback.findOne({ submissionId: target._id }).lean();
    const page = guestResultStatus({ submission: full, feedback }).status;
    const expected = page === 'complete' ? 'ready' : ['failed', 'blocked'].includes(page) ? 'failed' : 'processing';
    const row = (await portal.listAssignments(KID)).find(r => r.id === String(target._id));
    expect(row.status).toBe(expected);
  });
});

describe('the database cap', () => {
  test('an address with more than 1000 guest submissions: the cap is logged without personal data; the list still answers', async () => {
    const extra = Array.from({ length: 1000 }, (_, i) => ({ submissionMode: 'guest', assignment: ctx.assignments[i % COUNT]._id, class: ctx.cls,
      submittedAt: new Date(Date.UTC(2025, 0, 1) + i), guest: { normalizedEmail: KID } }));
    await Submission.collection.insertMany(extra);
    logger.warn.mockClear();
    const rows = await portal.listAssignments(KID);
    expect(rows.length).toBeLessThanOrEqual(200);
    expect(rows.length).toBeGreaterThan(0);
    const capped = warnings().filter(entry => entry?.event === 'recovery_portal_cap_reached');
    expect(capped).toEqual([{ event: 'recovery_portal_cap_reached', code: 'RECOVERY_CAP_REACHED' }]);
    expect(JSON.stringify(warnings())).not.toContain(KID);
  });
  test('below the cap nothing is logged', async () => {
    logger.warn.mockClear();
    await portal.listAssignments(KID);
    expect(warnings().some(entry => entry?.event === 'recovery_portal_cap_reached')).toBe(false);
  });
});

describe('failure log for a MongoServerError', () => {
  test('errorCode and codeName are added (MongoServerError only); never the message, filter values or the email', async () => {
    const session = await sessionFor(KID);
    const { MongoServerError } = mongoose.mongo;
    jest.spyOn(Submission, 'find').mockImplementationOnce(() => {
      throw new MongoServerError({ message: `synthetic sort failure for ${KID}`, code: 292, codeName: 'QueryExceededMemoryLimitNoDiskUseAllowed' });
    });
    logger.warn.mockClear();
    const res = await list(session);
    expect(res.status).toBe(503);
    const failed = warnings().find(entry => entry?.event === 'recovery_portal_request_failed');
    expect(failed).toEqual({ event: 'recovery_portal_request_failed', code: 'RECOVERY_FAILED', stage: 'lookup', errorName: 'MongoServerError',
      frame: expect.stringMatching(/^src\/[\w./-]+\.js:\d+$/), errorCode: 292, codeName: 'QueryExceededMemoryLimitNoDiskUseAllowed' });
    const text = JSON.stringify(warnings());
    expect(text).not.toContain('synthetic');
    expect(text).not.toContain(KID);
  });
});
