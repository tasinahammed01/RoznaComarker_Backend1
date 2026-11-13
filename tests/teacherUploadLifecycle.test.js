'use strict';
// FIX 3: three sequential teacher uploads, the full lifecycle (save -> dispatch -> worker claim -> OCR -> marking -> complete)
// through the real routes and the real recovery worker. Only the stage modules are stubbed, and each stub writes exactly what
// the real stage writes for that outcome (complete; evaluation blocked for credits as canonicalEvaluation.service writes it;
// OCR failures with ocrFailures[].retryable as ocrPipeline writes them; thrown provider errors). No AI, OCR or email is called.
process.env.JWT_SECRET = 'teacher-upload-lifecycle-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-lifecycle-' + process.pid;
jest.setTimeout(120000);
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ ...jest.requireActual('../src/services/assessmentCreditRouter.service'), canRunAssessment: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/services/ocrPipeline.service', () => ({ ...jest.requireActual('../src/services/ocrPipeline.service'), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ ...jest.requireActual('../src/services/autoRubricDesigner.service'), autoGenerateRubricDesignerForSubmission: jest.fn(async () => null) }));

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const logger = require('../src/utils/logger');
const credits = require('../src/services/assessmentCreditRouter.service').canRunAssessment;
const ocr = require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles;
const recovery = require('../src/services/assessmentRecovery.service');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FYQAAAAASUVORK5CYII=', 'base64');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const CONFIG = { intervalMs: 3600000, leaseMs: 30 * 60 * 1000, batchSize: 10, maxAttempts: 3 };
let teacher, classDoc, assignment, token, plan, logs;

/** Per submission, the outcome of each OCR-stage run, in order (the last one repeats). */
const outcomes = new Map();
const COMPLETE = { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'completed', assessmentStatus: 'complete', assessmentCompletedAt: new Date() };
async function stage({ targetDoc, jobId }) {
  const id = String(targetDoc._id), list = outcomes.get(id) || outcomes.get(targetDoc.guest?.displayName) || ['complete'];
  if (!outcomes.has(id)) outcomes.set(id, list);
  const outcome = list.length > 1 ? list.shift() : list[0];
  const where = { _id: targetDoc._id, ocrJobId: jobId };
  if (outcome === 'complete') { await Submission.updateOne(where, { $set: COMPLETE }); return { ocrStatus: 'completed' }; }
  if (outcome === 'credits') {   // canonicalEvaluation.service: the credit check failed; assessmentStatus is not touched
    await Submission.updateOne(where, { $set: { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
      evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS', evaluationError: 'You have used all your Assessment Credits for this billing cycle.' } });
    return { ocrStatus: 'completed' };
  }
  if (outcome === 'ocr_transient' || outcome === 'ocr_permanent') {
    const retryable = outcome === 'ocr_transient';
    await Submission.updateOne(where, { $set: { ocrStatus: 'failed', ocrFailures: [{ code: retryable ? 'OCR_PROVIDER_TIMEOUT' : 'OCR_IMAGE_UNREADABLE', retryable }] } });
    return { ocrStatus: 'failed' };
  }
  if (outcome === 'throw_transient') throw Object.assign(new Error('provider timeout'), { code: 'AI_PROVIDER_TIMEOUT' });
  if (outcome === 'throw_permanent') throw Object.assign(new Error('bad request'), { code: 'AI_PROVIDER_REJECTED', retryable: false });
  throw new Error('unknown outcome ' + outcome);
}

function upload(name, email) {
  return request(app).post(`/api/assignments/${assignment._id}/teacher-uploads`).set('Authorization', `Bearer ${token}`)
    .field('name', name).field('email', email).field('requestKey', crypto.randomUUID()).field('batchId', 'batch-0001')
    .attach('files', png, { filename: 'page-1.png', contentType: 'image/png' });
}
const listItems = async () => (await request(app).get(`/api/assignments/${assignment._id}/teacher-uploads`).set('Authorization', `Bearer ${token}`)).body.data.items;
const statusOf = async id => (await listItems()).find(item => item.submissionId === String(id));
const retry = id => request(app).post(`/api/assignments/${assignment._id}/teacher-uploads/${id}/retry`).set('Authorization', `Bearer ${token}`);
/** Waits until no run holds the submission and at least `attempts` runs have started. */
async function idle(id, attempts = 1) {
  for (let i = 0; i < 500; i++) {
    const doc = await Submission.findById(id).select('analysisLeaseOwner analysisAttempt').lean();
    if (doc && !doc.analysisLeaseOwner && Number(doc.analysisAttempt || 0) >= attempts) return doc;
    await sleep(10);
  }
  throw new Error('submission never became idle');
}
/** One recovery-worker sweep, as if its backoff had elapsed. */
async function sweep() {
  await Submission.updateMany({ analysisNextRetryAt: { $ne: null } }, { $set: { analysisNextRetryAt: new Date(Date.now() - 1000) } });
  await Submission.updateMany({}, { $set: { updatedAt: new Date(Date.now() - CONFIG.leaseMs - 60 * 1000) } }, { timestamps: false });
  const worker = recovery.startAssessmentRecoveryWorker(CONFIG);
  worker.stop();
  await worker.run();
}

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH), { recursive: true, force: true });
});
beforeEach(async () => {
  process.env.OCR_SOURCE_MODE = 'legacy';
  await clearDatabase(); jest.clearAllMocks(); outcomes.clear(); await seedTestPlans();
  plan = { credits: 10 };
  credits.mockImplementation(async () => ({ allowed: plan.credits >= 1, availableCredits: plan.credits }));
  ocr.mockImplementation(stage);
  logs = [];
  for (const level of ['info', 'warn', 'error']) jest.spyOn(logger, level).mockImplementation((...args) => { logs.push(args[0]); });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher', displayName: 'Ms Rahman' });
  classDoc = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'LIFECYCLE' });
  assignment = await Assignment.create({ title: 'My Summer Holiday', class: classDoc._id, teacher: teacher._id, instructions: 'Write about a holiday.', qrToken: 'lifecycle-qr' });
  token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
});
afterEach(() => jest.restoreAllMocks());

async function threeUploads(third) {
  const ids = [];
  for (let i = 1; i <= 3; i++) {
    if (i === 3 && third) outcomes.set(`Student ${i}`, [...third]);   // set before the save: the dispatch can run before the response
    const res = await upload(`Student ${i}`, `student.${i}@example.com`);
    expect(res.status).toBe(200);
    const id = res.body.data.item.submissionId;
    ids.push(id);
    await idle(id);
  }
  return ids;
}

test('baseline: three sequential uploads all finish as Marked', async () => {
  const ids = await threeUploads();
  for (const id of ids) expect((await statusOf(id)).status).toBe('marked');
});

test('(B) the third upload\'s marking is blocked for credits: shown as Waiting for credits (not "processing" forever), Retry works once credits exist', async () => {
  // Credits run out between saving and marking (another use of the wallet), so the third evaluation is blocked.
  const ids = await threeUploads(['credits', 'complete']);
  expect((await statusOf(ids[0])).status).toBe('marked');
  const third = await statusOf(ids[2]);
  expect(third.status).toBe('waiting_credits');
  await sweep();                                              // the worker does not spin on it, and does not fail it
  expect((await statusOf(ids[2])).status).toBe('waiting_credits');
  plan.credits = 0;
  const refused = await retry(ids[2]);
  expect(refused.status).toBe(402);
  plan.credits = 5;
  const res = await retry(ids[2]);
  expect(res.status).toBe(200);
  expect(res.body.data.alreadyRequested).toBe(false);
  await idle(ids[2]);
  expect((await statusOf(ids[2])).status).toBe('marked');
});

test('(A) a transient OCR failure on every attempt: retried with backoff, then Marking failed with the provider code (not "processing" forever)', async () => {
  const ids = await threeUploads(['ocr_transient']);
  for (let i = 0; i < 4; i++) { await sweep(); await idle(ids[2]); }
  expect(ocr.mock.calls.filter(([arg]) => String(arg.targetDoc._id) === ids[2]).length).toBe(CONFIG.maxAttempts);
  const item = await statusOf(ids[2]);
  expect(item.status).toBe('failed');
  expect(item.failureCode).toBe('OCR_PROVIDER_TIMEOUT');
  outcomes.set(ids[2], ['complete']);
  expect((await retry(ids[2])).status).toBe(200);
  await idle(ids[2]);
  expect((await statusOf(ids[2])).status).toBe('marked');
});

test('(C) a permanent OCR failure fails fast (one attempt) with a safe code', async () => {
  const ids = await threeUploads(['ocr_permanent']);
  await sweep(); await idle(ids[2]);
  expect(ocr.mock.calls.filter(([arg]) => String(arg.targetDoc._id) === ids[2]).length).toBe(1);
  const item = await statusOf(ids[2]);
  expect(item.status).toBe('failed');
  expect(item.failureCode).toBe('OCR_IMAGE_UNREADABLE');
});

test('a thrown transient provider error is retried and then succeeds; a permanent one fails fast', async () => {
  const ids = await threeUploads(['throw_transient', 'complete']);
  expect((await statusOf(ids[2])).status).not.toBe('failed');
  await sweep(); await idle(ids[2], 2);
  expect((await statusOf(ids[2])).status).toBe('marked');

  outcomes.set('Student 4', ['throw_permanent']);
  const res = await upload('Student 4', 'student.4@example.com');
  const fourth = res.body.data.item.submissionId;
  await idle(fourth);
  await sweep(); await idle(fourth);
  const item = await statusOf(fourth);
  expect(item.status).toBe('failed');
  expect(item.failureCode).toBe('AI_PROVIDER_REJECTED');
  expect(ocr.mock.calls.filter(([arg]) => String(arg.targetDoc._id) === fourth).length).toBe(1);   // one run, no retries
});

test('a crashed run (lease expired) and a lost dispatch are picked up by the worker and finish', async () => {
  const ids = await threeUploads();
  await Submission.updateOne({ _id: ids[2] }, { $set: { ...Object.fromEntries(Object.keys(COMPLETE).map(k => [k, undefined])), ocrStatus: 'pending',
    assessmentStatus: 'processing', analysisLeaseOwner: 'crashed-host:1:x', analysisLeaseExpiresAt: new Date(Date.now() - 1000), analysisAttempt: 1 } });
  expect((await statusOf(ids[2])).status).toBe('reading');
  await sweep(); await idle(ids[2], 2);
  expect((await statusOf(ids[2])).status).toBe('marked');
});

test('Retry marking: works from every non-complete state, is a no-op while a run is live or already complete, and restarts only once', async () => {
  const ids = await threeUploads(['ocr_permanent']);
  await sweep(); await idle(ids[2]);
  outcomes.set(ids[2], ['complete']);
  const [a, b] = await Promise.all([retry(ids[2]), retry(ids[2])]);   // double click
  expect([a.body.data.alreadyRequested, b.body.data.alreadyRequested].sort()).toEqual([false, true]);
  await idle(ids[2]);
  expect((await statusOf(ids[2])).status).toBe('marked');
  const done = await retry(ids[2]);                                  // complete: nothing restarts
  expect(done.body.data.alreadyRequested).toBe(true);
  // A live run: no restart.
  await Submission.updateOne({ _id: ids[1] }, { $set: { assessmentStatus: 'processing', ocrStatus: 'completed', analysisLeaseOwner: 'live:1:x', analysisLeaseExpiresAt: new Date(Date.now() + 60000) } });
  const live = await retry(ids[1]);
  expect(live.status).toBe(200);
  expect(live.body.data.alreadyRequested).toBe(true);
  // Stalled with no run (lost dispatch long ago): restarts.
  await Submission.updateOne({ _id: ids[1] }, { $set: { ocrStatus: 'pending', analysisAttempt: 0, updatedAt: new Date(Date.now() - 10 * 60 * 1000) }, $unset: { analysisLeaseOwner: 1, analysisLeaseExpiresAt: 1 } }, { timestamps: false });
  expect((await statusOf(ids[1])).status).toBe('uploaded');
  // Same state but touched moments ago (a dispatch on its way): not restarted.
  await Submission.updateOne({ _id: ids[1] }, { $set: { updatedAt: new Date() } }, { timestamps: false });
  expect((await retry(ids[1])).body.data.alreadyRequested).toBe(true);
  await Submission.updateOne({ _id: ids[1] }, { $set: { updatedAt: new Date(Date.now() - 10 * 60 * 1000) } }, { timestamps: false });
  const stalled = await retry(ids[1]);
  expect(stalled.body.data.alreadyRequested).toBe(false);
  await idle(ids[1]);
  expect((await statusOf(ids[1])).status).toBe('marked');
});

test('every transition is logged with ids, statuses and codes only', async () => {
  await threeUploads(['ocr_permanent']);
  await sweep();
  const transitions = logs.filter(entry => entry && entry.event === 'teacher_upload_status');
  expect(transitions.map(entry => entry.status)).toEqual(expect.arrayContaining(['uploaded', 'marked', 'failed']));
  for (const entry of transitions) {
    expect(Object.keys(entry).every(key => ['event', 'submissionId', 'status', 'code', 'reason'].includes(key))).toBe(true);
    expect(JSON.stringify(entry)).not.toMatch(/@|Student \d/);
  }
});

test('watchdog: a quiet upload the worker will never pick up again becomes Marking failed; recent or credit-waiting work is left alone', async () => {
  const ids = await threeUploads();
  const stuck = { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'failed', evaluationStatus: 'pending', assessmentStatus: 'started', analysisAttempt: 1 };
  await Submission.updateOne({ _id: ids[0] }, { $set: stuck, $unset: { analysisLeaseOwner: 1, analysisLeaseExpiresAt: 1, analysisErrorCode: 1 } });
  await Submission.updateOne({ _id: ids[1] }, { $set: { ...stuck, evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS' } });
  // Not quiet long enough yet: untouched.
  await recovery.sweepStalledTeacherUploads(CONFIG);
  expect((await statusOf(ids[0])).status).toBe('processing');
  await sweep();
  const item = await statusOf(ids[0]);
  expect(item.status).toBe('failed');
  expect(item.failureCode).toBe('ASSESSMENT_STALLED');
  expect((await statusOf(ids[1])).status).toBe('waiting_credits');
  expect(logs.some(entry => entry?.event === 'teacher_upload_status' && entry.reason === 'watchdog' && entry.submissionId === ids[0])).toBe(true);
});

test('a member upload shows the name the teacher typed', async () => {
  const Membership = require('../src/models/membership.model');
  const member = await User.create({ firebaseUid: crypto.randomUUID(), email: 'member@example.com', role: 'student', displayName: 'Account Name' });
  await Membership.create({ student: member._id, class: classDoc._id, status: 'active' });
  const res = await upload('Typed Name', 'Member@Example.com');
  expect(res.status).toBe(200);
  await idle(res.body.data.item.submissionId);
  expect(await statusOf(res.body.data.item.submissionId)).toEqual(expect.objectContaining({ name: 'Typed Name', email: 'member@example.com', account: 'member' }));
});

test('diagnostic script: read-only, explains each upload (status, stage, lease, attempts, credits, codes) and prints no names, emails or text', async () => {
  const mongoose = require('mongoose');
  const { diagnose } = require('../scripts/diagnoseTeacherUploads');
  const ids = await threeUploads(['credits']);
  const snapshot = async () => JSON.stringify(await mongoose.connection.db.collection('submissions').find({}).sort({ _id: 1 }).toArray());
  const before = await snapshot();
  const report = await diagnose(mongoose.connection.db, String(assignment._id));
  expect(await snapshot()).toBe(before);                                   // nothing written
  expect(report.totals).toEqual(expect.objectContaining({ submissions: 3, teacherUploads: 3 }));
  expect(report.totals.byTeacherStatus).toEqual({ marked: 2, waiting_credits: 1 });
  const third = report.submissions.find(row => row.submissionId === ids[2]);
  expect(third).toEqual(expect.objectContaining({ listedForTeacher: true, inUploadStatusList: true, teacherStatus: 'waiting_credits',
    teacherFailureCode: 'INSUFFICIENT_ASSESSMENT_CREDITS', workerWillPickUp: false }));
  expect(third.evaluation).toEqual({ status: 'blocked', errorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS' });
  expect(report.credits.reservedByUnfinishedUploads).toBe(1);
  const text = JSON.stringify(report);
  expect(text).not.toMatch(/@|Student \d|Ms Rahman|holiday|You have used/i);
  expect((await diagnose(mongoose.connection.db, String(new mongoose.Types.ObjectId()))).found).toBe(false);
});
