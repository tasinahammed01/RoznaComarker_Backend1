'use strict';
// The synthetic speaking benchmark (tests/fixtures/audio/speakingBenchmark.cjs) through the whole pipeline with MOCKED model replies: what is
// assessed, refused without AI, or rejected; scores, charges and stored corrections for each case. No network (tripwire), no real AI.
process.env.JWT_SECRET = 'speaking-benchmark-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-benchmark-${process.pid}`;
const fs = require('fs');
const path = require('path');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const CASES = require('./fixtures/audio/speakingBenchmark.cjs');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const CreditTransaction = require('../src/models/CreditTransaction');
const AudioRecording = require('../src/models/AudioRecording');
const assessment = require('../src/services/audio/speakingAssessment.service');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => { await clearDatabase(); await seedTestPlans(); await AudioRecording.createIndexes(); });

test('the benchmark has at least 12 transcripts covering the required kinds', () => {
  expect(CASES.length).toBeGreaterThanOrEqual(12);
  const names = CASES.map(c => c.name).join(' | ');
  for (const kind of ['weak', 'medium', 'strong', 'filler-heavy', 'off-topic', 'too short', 'repeated', 'prompt injection', 'mixed language', 'very long',
    'varied long answer', 'fast speaker'])
    expect(names).toContain(kind);
});

test('every case: the recording is at least as long as the speech in its fluency figures, and within the default 7 minute limit', () => {
  for (const item of CASES) {
    const { fluency, seconds } = h.caseRecording(item);
    expect({ name: item.name, longEnough: seconds >= fluency.speakingSeconds, withinLimit: seconds <= 420 })
      .toEqual({ name: item.name, longEnough: true, withinLimit: true });
  }
});

test('the varied long answers: no repeated sentence, the stated length and pace', () => {
  const varied = CASES.filter(c => c.name.startsWith('varied long answer'));
  expect(varied).toHaveLength(2);
  for (const item of varied) {
    const sentences = item.text.split(/(?<=[.!?;])\s+/);
    expect(new Set(sentences).size).toBe(sentences.length);
  }
  const [normal, fast] = varied.map(item => h.caseRecording(item).fluency);
  expect(normal.spokenWords).toBeGreaterThanOrEqual(950);
  expect(normal.spokenWords).toBeLessThanOrEqual(1050);
  expect(normal.wordsPerMinute).toBeCloseTo(150, 0);
  expect(fast.spokenWords).toBeGreaterThanOrEqual(1150);
  expect(fast.spokenWords).toBeLessThanOrEqual(1250);
  expect(fast.wordsPerMinute).toBeCloseTo(175, 0);
});

describe.each(CASES.map(c => [c.name, c]))('%s', (_name, item) => {
  test('pipeline outcome, charge and stored result', async () => {
    const f = await seedSpeaking();
    await h.personalCredits(f.teacher.user, 3);
    const made = await h.readyRecording(f, item.text, h.caseRecording(item));
    await assessment.enqueueAssessment(made.recording._id);
    const fetchImpl = h.fakeOpenRouter(item.reply ? item.reply(h) : h.output());
    const outcome = await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl });
    expect(outcome.status).toBe(item.expect.status);
    if (item.expect.code) expect(outcome.code).toBe(item.expect.code);
    if (item.expect.calls !== undefined) expect(fetchImpl).toHaveBeenCalledTimes(item.expect.calls);
    const debits = await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' });
    expect(debits).toBe(item.expect.status === 'completed' ? 1 : 0);
    const sub = await Submission.findById(made.submission._id).lean();
    if (item.expect.status !== 'completed') {
      expect(sub.writingCorrections || []).toEqual([]);
      expect(['failed', 'blocked']).toContain(sub.evaluationStatus);
      return;
    }
    const fb = await SubmissionFeedback.findOne({ submissionId: made.submission._id }).lean();
    const [low, high] = item.expect.score;
    expect(fb.overallScore).toBeGreaterThanOrEqual(low);
    expect(fb.overallScore).toBeLessThanOrEqual(high);
    if (item.expect.corrections !== undefined) expect(sub.writingCorrections).toHaveLength(item.expect.corrections);
    for (const c of sub.writingCorrections) expect(item.text.slice(c.startChar, c.endChar)).toBe(c.quotedText);
    if (item.expect.relevance) expect(fb.scoringAudit.relevance).toBe(item.expect.relevance);
    expect(fb.rubricScores.MECHANICS.maxScore).toBe(0);
    expect(fb.rubricScores.PRESENTATION.maxScore).toBe(0);
  });
});
