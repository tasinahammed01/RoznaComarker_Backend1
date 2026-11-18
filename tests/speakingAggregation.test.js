'use strict';
// Audio + speech-to-text, stage 6: speaking results stay out of essay aggregations and essay sweeps. Student and class progress, the weekly
// teacher summary, the stale-evaluation pass, the teacher's AI-settings staleness pass and the essay recovery queries ignore a completed (or
// running) speaking assessment; essay numbers are unchanged. In-memory MongoDB, mocked provider (tripwire on the global fetch).
process.env.JWT_SECRET = 'speaking-aggregation-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-aggregation-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AudioRecording = require('../src/models/AudioRecording');
const assessment = require('../src/services/audio/speakingAssessment.service');
const draftComparison = require('../src/services/draftComparison.service');
const weekly = require('../src/services/weeklyTeacherSummary.service');
const stale = require('../src/services/staleAssignmentEvaluation.service');
const recovery = require('../src/services/assessmentRecovery.service');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let f, speaking;

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans(); await AudioRecording.createIndexes();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
  speaking = await h.readyRecording(f, TEXTS.MEDIUM);
  await assessment.enqueueAssessment(speaking.recording._id);
  expect((await assessment.runSpeakingAssessment(speaking.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output()) })).status).toBe('completed');
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; jest.restoreAllMocks(); });

/** Every Submission query a function sends, with its filter. */
function capture(fn) {
  const spy = jest.spyOn(Submission, 'find');
  return fn().then(value => ({ value, filters: spy.mock.calls.map(([filter]) => filter) }));
}

describe('progress and summaries exclude speaking explicitly', () => {
  test('student progress: no speaking entry; the Submission query excludes sourceKind audio', async () => {
    const { value, filters } = await capture(() => draftComparison.studentProgress(f.klass._id, f.student.user._id, f.teacher.user));
    expect(filters.some(filter => filter?.sourceKind?.$ne === 'audio')).toBe(true);
    expect(JSON.stringify(value)).not.toContain(String(speaking.submission._id));
    expect(value.draftHistory || []).toEqual([]);
  });

  test('class progress summaries: no entry for the speaking student', async () => {
    const { value, filters } = await capture(() => draftComparison.classProgressSummaries(f.klass._id));
    expect(filters.some(filter => filter?.sourceKind?.$ne === 'audio')).toBe(true);
    expect(value.has(String(f.student.user._id))).toBe(false);
  });

  test('the weekly teacher summary query excludes speaking', async () => {
    await Submission.updateOne({ _id: speaking.submission._id }, { $set: { draftNumber: 2 } });
    const { value, filters } = await capture(() => weekly.progressForWindow({ teacherId: f.teacher.user._id, classIds: [f.klass._id], assignmentIds: [f.assignment._id],
      start: new Date(Date.now() - 86400000), end: new Date(Date.now() + 60000) }));
    expect(filters.filter(filter => filter?.assignment).every(filter => filter.sourceKind?.$ne === 'audio')).toBe(true);
    expect(value.improvedRevisions).toBe(0);
  });
});

describe('essay staleness and recovery ignore speaking', () => {
  test('the stale-evaluation pass counts nothing for a speaking result (even if called directly)', async () => {
    expect(await stale.summarize(f.assignment)).toEqual({ assignmentId: String(f.assignment._id), eligibleCount: 0, skippedOverrideCount: 0, skippedProcessingCount: 0,
      skippedNotReadyCount: 0 });
  });

  test('a teacher\'s AI-settings change (essay policy) leaves the speaking result completed', async () => {
    const res = await request(app).patch('/api/users/me').set('Authorization', `Bearer ${f.teacher.token}`).send({ aiConfig: { strictness: 'strict' } });
    expect(res.status).toBe(200);
    expect((await Submission.findById(speaking.submission._id).lean()).evaluationStatus).toBe('completed');
    expect((await SubmissionFeedback.findOne({ submissionId: speaking.submission._id }).lean()).evaluationStatus).toBe('completed');
  });

  test('the essay recovery queries never select a speaking submission, finished or running', async () => {
    const later = new Date(Date.now() + 365 * 86400000);
    for (const state of [{}, { evaluationStatus: 'processing', assessmentStatus: 'processing' }]) {
      await Submission.updateOne({ _id: speaking.submission._id }, { $set: state });
      const due = await Submission.find(recovery.dueWorkQuery(later, 99)).select('_id').lean();
      expect(due.map(d => String(d._id))).not.toContain(String(speaking.submission._id));
      const spy = jest.spyOn(Submission, 'updateOne');
      await recovery.sweepStalledTeacherUploads(undefined, later);
      expect(spy.mock.calls.filter(([filter]) => String(filter?._id) === String(speaking.submission._id))).toEqual([]);
      spy.mockRestore();
    }
  });
});
