'use strict';
// Task 20: the correction-stage retry after a failed correction stage. Correction stage only: the score, the feedback and the credit never change;
// one automatic retry; a visible retry for the student, the guest and the owning teacher (404 for anyone else); idempotent; superseded by newer work;
// never picked up by the recovery sweeper; internals never reach a student. The provider is mocked; synthetic text only.
process.env.JWT_SECRET = 'correction-retry-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/correction-retry';
process.env.OPENROUTER_API_KEY = 'mock-only';   // the provider itself is mocked: no request leaves the process
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const evaluation = require('../src/services/canonicalEvaluation.service');
const completion = require('../src/services/assessmentCompletion.service');
const creditRouter = require('../src/services/assessmentCreditRouter.service');
const retry = require('../src/services/correctionStageRetry.service');
const { buildCanonicalResultState } = require('../src/services/canonicalResultState.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ASSIGNMENT = { title: 'Weekend essay', description: 'Describe your weekend.', rubric: null, rubrics: null };
const malformed = () => Object.assign(new Error('All configured AI models failed'), { code: 'AI_CHAIN_EXHAUSTED', finalFailureCode: 'AI_CHAIN_EXHAUSTED',
  attempts: [{ code: 'AI_OUTPUT_VALIDATION_FAILED', validationCode: 'SEMANTIC_SCHEMA_INVALID' }] });
const authFailure = () => Object.assign(new Error('auth'), { code: 'AI_CHAIN_EXHAUSTED', finalFailureCode: 'AI_AUTH_FAILED', attempts: [{ code: 'AI_AUTH_FAILED' }] });
const completedRun = corrections => ({ status: 'completed', corrections, diagnostics: { rawCorrectionCount: corrections.length },
  metrics: { attempts: [] }, coverage: { complete: true, coverageComplete: true, totalChunks: 1, successfulChunks: 1, failedChunks: 0,
    structuralPassStatus: 'completed', categoryCoverageComplete: { CONTENT: true, ORGANIZATION: true, VOCABULARY: true, GRAMMAR: true, MECHANICS: true } } });
const jwtFor = user => signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role });

let fixture, original, scheduled, spies;
beforeAll(async () => { await connectInMemoryMongo(); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
afterEach(() => jest.restoreAllMocks());

/** The real full pipeline, with the correction stage failing: the state a student sees after a failed correction stage. */
async function failCorrectionStage(id, error = malformed()) {
  jest.spyOn(coordinator, 'analyze').mockRejectedValueOnce(error);
  const doc = await Submission.findById(id);
  await pipeline.generateAndPersist(doc, { assignment: ASSIGNMENT });
}

beforeEach(async () => {
  await mongoose.connection.dropDatabase(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
  original = { registered: (await Submission.findById(fixture.IDS.registered).lean()).writingCorrections,
    guest: (await Submission.findById(fixture.IDS.guest).lean()).writingCorrections };
  // Scoring stays out of these tests: the rubric is mocked and evaluation only finishes the run, as a real one would.
  jest.spyOn(evaluation, 'prepareRubricAssessment').mockResolvedValue({});
  jest.spyOn(evaluation, 'persistProvisionalScore').mockResolvedValue();
  jest.spyOn(evaluation, 'generate').mockImplementation(async ({ submission }) => {
    await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'completed' } }); return { status: 'completed' }; });
  scheduled = [];
  const realSchedule = retry.scheduleAutomatic;
  jest.spyOn(retry, 'scheduleAutomatic').mockImplementation((Model, id, error, options = {}) =>
    realSchedule(Model, id, error, { ...options, timer: fn => { scheduled.push(fn); return { unref() {} }; } }));
  await failCorrectionStage(fixture.IDS.registered);
  await failCorrectionStage(fixture.IDS.guest);
  // From here on, any re-score or credit use is a failure of the test.
  spies = { generate: evaluation.generate, rubric: evaluation.prepareRubricAssessment, start: jest.spyOn(completion, 'start'),
    complete: jest.spyOn(completion, 'complete'), canRun: jest.spyOn(creditRouter, 'canRunAssessment') };
  evaluation.generate.mockClear(); evaluation.prepareRubricAssessment.mockClear();
  coordinator.analyze.mockClear();
});

const settle = async id => {
  for (let i = 0; i < 200; i++) {
    const doc = await Submission.findById(id).lean();
    if (['completed', 'failed'].includes(doc.correctionRetry?.status)) return doc;
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error('retry did not settle');
};
const feedbackOf = id => SubmissionFeedback.findOne({ submissionId: id }).lean();
const expectNoRescoreNoCredit = () => {
  expect(spies.generate).not.toHaveBeenCalled(); expect(spies.rubric).not.toHaveBeenCalled();
  expect(spies.start).not.toHaveBeenCalled(); expect(spies.complete).not.toHaveBeenCalled(); expect(spies.canRun).not.toHaveBeenCalled();
};

describe('the failed state and the one automatic retry', () => {
  test('a failed correction stage schedules exactly one automatic retry, and the page keeps polling meanwhile', async () => {
    const doc = await Submission.findById(fixture.IDS.registered).lean();
    expect(doc).toMatchObject({ semanticStatus: 'failed', correctionStatus: 'partial', writingCorrections: [] });
    expect(doc.correctionRetry).toMatchObject({ status: 'scheduled', trigger: 'automatic', automaticCount: 1 });
    expect(scheduled).toHaveLength(2);   // one per submission
    const state = buildCanonicalResultState({ submission: doc, feedback: await feedbackOf(doc._id) });
    expect(state).toMatchObject({ correctionRetryActive: true, processingActive: true, automaticPollingAllowed: true, terminal: false,
      manualRetryAllowed: false, correctionRetryAllowed: false });
    // A second failure of the same submission never schedules a second automatic retry.
    await Submission.updateOne({ _id: doc._id }, { $set: { 'correctionRetry.status': 'failed' } });
    expect(await retry.scheduleAutomatic(Submission, doc._id, malformed())).toMatchObject({ scheduled: false });
  });

  test('the automatic retry runs the correction stage only: corrections appear, score, feedback and credit untouched', async () => {
    const id = fixture.IDS.registered, before = await feedbackOf(id);
    jest.spyOn(coordinator, 'analyze').mockResolvedValueOnce(completedRun(original.registered));
    await scheduled[0]();
    const doc = await settle(id);
    expect(doc).toMatchObject({ semanticStatus: 'completed', correctionStatus: 'completed', correctionRetry: { status: 'completed' } });
    expect(doc.writingCorrections.map(c => c.id)).toEqual(original.registered.map(c => c.id));
    expect(await feedbackOf(id)).toEqual(before);
    expectNoRescoreNoCredit();
    const state = buildCanonicalResultState({ submission: doc, feedback: before });
    expect(state).toMatchObject({ correctionRetryActive: false, correctionRetryAllowed: false, correctionsAvailable: true });
  });

  test('an auth or configuration failure is never retried automatically, and offers no free retry', async () => {
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $unset: { correctionRetry: 1 } });
    await failCorrectionStage(fixture.IDS.registered, authFailure());
    const doc = await Submission.findById(fixture.IDS.registered).lean();
    expect(doc.correctionRetry?.status).toBeUndefined();
    expect(buildCanonicalResultState({ submission: doc, feedback: await feedbackOf(doc._id) }).correctionRetryAllowed).toBe(false);
  });

  test('the recovery sweeper never picks up a scheduled or running retry (it would re-score)', async () => {
    const { dueWorkQuery } = require('../src/services/assessmentRecovery.service');
    await Submission.updateMany({}, { $set: { 'correctionRetry.status': 'processing', updatedAt: new Date(Date.now() - 3600000),
      correctionUpdatedAt: new Date(Date.now() - 3600000) } }, { timestamps: false });
    expect(await Submission.countDocuments(dueWorkQuery(new Date(), 5))).toBe(0);
  });
});

describe('the visible retry: student, guest and owning teacher; nobody else', () => {
  const settleScheduledAway = async () => Submission.updateMany({}, { $set: { 'correctionRetry.status': 'failed' } });
  beforeEach(settleScheduledAway);

  test('student: 202, correction stage only, no credit, no re-score', async () => {
    const id = fixture.IDS.registered, before = await feedbackOf(id);
    jest.spyOn(coordinator, 'analyze').mockResolvedValueOnce(completedRun(original.registered));
    const res = await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`);
    expect(res.status).toBe(202);
    expect(res.body.data).toMatchObject({ correctionRetryActive: true, processingActive: true, automaticPollingAllowed: true });
    const doc = await settle(id);
    expect(doc).toMatchObject({ semanticStatus: 'completed', correctionRetry: { status: 'completed', trigger: 'manual', manualCount: 1 } });
    expect(await feedbackOf(id)).toEqual(before);
    expectNoRescoreNoCredit();
  });

  test('guest with their own link: 202 and completes', async () => {
    const id = fixture.IDS.guest;
    jest.spyOn(coordinator, 'analyze').mockResolvedValueOnce(completedRun(original.guest));
    const res = await request(app).post(`/api/guest/submissions/${id}/corrections/retry`).set('X-Guest-Token', fixture.guestToken);
    expect(res.status).toBe(202);
    expect(await settle(id)).toMatchObject({ semanticStatus: 'completed', correctionRetry: { status: 'completed' } });
    expectNoRescoreNoCredit();
  });

  test('owning teacher: 202 without a credit check', async () => {
    const id = fixture.IDS.registered;
    jest.spyOn(coordinator, 'analyze').mockResolvedValueOnce(completedRun(original.registered));
    const res = await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.teacher)}`);
    expect(res.status).toBe(202);
    await settle(id);
    expectNoRescoreNoCredit();
  });

  test('another teacher, another student, a wrong guest token: no retry, 404 or refused', async () => {
    const analyze = jest.spyOn(coordinator, 'analyze');
    const User = require('../src/models/user.model');
    const stranger = await User.create({ firebaseUid: 'stranger', email: 'stranger@example.com', role: 'student', displayName: 'S' });
    const r = fixture.IDS.registered, g = fixture.IDS.guest;
    expect((await request(app).post(`/api/submissions/${r}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.otherTeacher)}`)).status).toBe(404);
    expect((await request(app).post(`/api/submissions/${r}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(stranger)}`)).status).toBe(404);
    expect((await request(app).post(`/api/submissions/${g}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`)).status).toBe(404);
    expect((await request(app).post(`/api/guest/submissions/${g}/corrections/retry`).set('X-Guest-Token', 'X'.repeat(43))).status).toBeGreaterThanOrEqual(400);
    expect((await request(app).post(`/api/submissions/${r}/corrections/retry`)).status).toBe(401);
    expect(analyze).not.toHaveBeenCalled();
    expect((await Submission.findById(r).lean()).correctionRetry.manualCount).toBeUndefined();
  });

  test('idempotent: two requests at once start one run; the second answers 409 in progress', async () => {
    const id = fixture.IDS.registered; let release;
    const analyze = jest.spyOn(coordinator, 'analyze').mockImplementation(() => new Promise(r => { release = () => r(completedRun(original.registered)); }));
    const send = () => request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`);
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect([a, b].find(x => x.status === 409).body.code).toBe('CORRECTION_RETRY_IN_PROGRESS');
    for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 20));
    release(); await settle(id);
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  test('a retry that fails again leaves the earlier result as it was; the limit then stops free retries', async () => {
    const id = fixture.IDS.registered, before = await feedbackOf(id);
    for (let n = 1; n <= retry.MANUAL_LIMIT; n++) {
      jest.spyOn(coordinator, 'analyze').mockRejectedValueOnce(malformed());
      const res = await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`);
      expect(res.status).toBe(202);
      const doc = await settle(id);
      expect(doc).toMatchObject({ semanticStatus: 'failed', correctionStatus: 'partial', writingCorrections: [],
        correctionRetry: { status: 'failed', manualCount: n } });
    }
    const last = await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`);
    expect(last.status).toBe(409); expect(last.body.code).toBe('CORRECTION_RETRY_LIMIT_REACHED');
    expect(buildCanonicalResultState({ submission: await Submission.findById(id).lean(), feedback: before }).correctionRetryAllowed).toBe(false);
    expect(await feedbackOf(id)).toEqual(before);
    expectNoRescoreNoCredit();
  });

  test('newer work wins: a regeneration started during the retry is never overwritten by it', async () => {
    const id = fixture.IDS.registered; let release;
    jest.spyOn(coordinator, 'analyze').mockImplementation(() => new Promise(r => { release = () => r(completedRun(original.registered)); }));
    expect((await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`)).status).toBe(202);
    for (let i = 0; i < 100 && !release; i++) await new Promise(r => setTimeout(r, 20));
    await Submission.updateOne({ _id: id }, { $set: { correctionStatus: 'processing', semanticStatus: 'pending' } });   // e.g. the teacher regenerates
    release();
    const doc = await settle(id);
    expect(doc).toMatchObject({ correctionStatus: 'processing', semanticStatus: 'pending', writingCorrections: [],
      correctionRetry: { status: 'failed', lastErrorCode: 'CORRECTION_RETRY_SUPERSEDED' } });
  });

  test('a changed source is not retried: the full pipeline owns it', async () => {
    const id = fixture.IDS.registered;
    const analyze = jest.spyOn(coordinator, 'analyze');
    await Submission.updateOne({ _id: id }, { $set: { correctionSourceHash: 'something-else' } });
    expect((await request(app).post(`/api/submissions/${id}/corrections/retry`).set('Authorization', `Bearer ${jwtFor(fixture.student)}`)).status).toBe(202);
    expect(await settle(id)).toMatchObject({ correctionRetry: { status: 'failed', lastErrorCode: 'CORRECTION_RETRY_SOURCE_CHANGED' }, semanticStatus: 'failed' });
    expect(analyze).not.toHaveBeenCalled();
  });
});

test('Task 22: the ocr-corrections payload carries the same retry flags as the feedback payload (the page merges both)', async () => {
  await Submission.updateMany({}, { $set: { 'correctionRetry.status': 'failed' } });
  const studentJwt = jwtFor(fixture.student);
  const feedback = (await request(app).get(`/api/feedback/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)).body.data;
  const ocr = (await request(app).get(`/api/submissions/${fixture.IDS.registered}/ocr-corrections`).set('Authorization', `Bearer ${studentJwt}`)).body.data;
  expect(feedback.correctionRetryAllowed).toBe(true);
  expect(ocr.correctionRetryAllowed).toBe(true);
  const guest = (await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/ocr-corrections`).set('X-Guest-Token', fixture.guestToken)).body.data;
  expect(guest.correctionRetryAllowed).toBe(true);
});

test('students and guests see the two booleans, never the retry job, counters or error codes', async () => {
  const studentJwt = jwtFor(fixture.student);
  const out = await capture(surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken }));
  const text = JSON.stringify(out);
  expect(text).not.toMatch(/"correctionRetry"\s*:/);
  expect(text).not.toMatch(/automaticCount|manualCount/);
  const job = (await Submission.findById(fixture.IDS.registered).lean()).correctionRetry.jobId;
  expect(text).not.toContain(job);
  expect(out['registered: feedback'].status).toBe(200);
  expect(text).toMatch(/"correctionRetryActive":true/);
});
