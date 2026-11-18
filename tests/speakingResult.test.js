'use strict';
// Audio + speech-to-text, stage 6: reading a speaking result. GET /api/speaking/submissions/:id/result for the owning student and the owning
// teacher (404 for anyone else), every state (assessing, ready, blocked, not enough speech, failed), strict student DTOs (no provider, model,
// prompt version, hashes, lease fields, raw words, edit revisions or teacher-only data), marks hidden when the teacher hides them, and
// POST /api/speaking/submissions/:id/retry-assessment (owning teacher; failed or blocked only).
process.env.JWT_SECRET = 'speaking-result-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-result-${process.pid}`;
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
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const AudioRecording = require('../src/models/AudioRecording');
const assessment = require('../src/services/audio/speakingAssessment.service');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const CORRECTIONS = [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', occurrence: 1, suggestedText: 'It has', message: 'Use has with it.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'by walk', occurrence: 1, suggestedText: 'on foot', message: 'We say on foot.' }];
let f;
const result = (id, token) => request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(token));
const retry = (id, token) => request(app).post(`/api/speaking/submissions/${id}/retry-assessment`).set(auth(token));

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans(); await AudioRecording.createIndexes();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

async function assessedSubmission(text = TEXTS.WEAK, reply = h.output({ level: 'Developing', corrections: CORRECTIONS })) {
  const made = await h.readyRecording(f, text);
  await assessment.enqueueAssessment(made.recording._id);
  const outcome = await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(reply) });
  return { ...made, outcome };
}
const FORBIDDEN = /gemini|openrouter|openai|deepgram|speaking-assessment-prompt|speaking-assessment-schema|[a-f0-9]{64}|attemptKey|leaseUntil|assessmentQueue|"words"|editedRevisions|scoringAudit|evaluationAttempts|teacherEvaluation|evaluationJobId|evaluationProvider|evaluationModel|sourceHash|requestId|providerRequestId|storageCharged|minutesChargedTo|MECHANICS|PRESENTATION|Spelling|Handwriting/i;

describe('a ready result', () => {
  test('the owning student: the rubric result, categories that apply, corrections at offsets in the assessed text, fluency figures', async () => {
    const { submission } = await assessedSubmission();
    const res = await result(submission._id, f.student.token);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(['assessedText', 'corrections', 'fluency', 'marksVisible', 'message', 'result', 'state', 'submissionId'].sort());
    expect(data).toMatchObject({ submissionId: String(submission._id), state: 'ready', marksVisible: true, message: null, assessedText: TEXTS.WEAK });
    expect(Object.keys(data.result).sort()).toEqual(['actionSteps', 'assessedAt', 'categories', 'criteria', 'grade', 'improvements', 'maxScore', 'overallScore', 'strengths',
      'summary', 'teacherComments'].sort());
    expect(data.result.overallScore).toBe(50);
    expect(data.result.criteria).toHaveLength(5);
    expect(data.result.criteria[0]).toEqual({ criterionId: 'speaking-task', title: 'Task and content', level: 'Developing', weightPercent: 25, points: 12.5,
      comment: expect.any(String) });
    expect(data.result.categories.map(c => c.key)).toEqual(['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY']);
    expect(data.corrections.map(c => Object.keys(c).sort().join(','))).toEqual(Array(2).fill('category,endChar,id,message,quotedText,startChar,suggestedText,symbol,symbolLabel'));
    for (const c of data.corrections) expect(data.assessedText.slice(c.startChar, c.endChar)).toBe(c.quotedText);
    expect(Object.keys(data.fluency).sort()).toEqual(['fillersPer100Words', 'longestPauseSeconds', 'pausesOverOneSecond', 'repetitions', 'wordsPerMinute'].sort());
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });

  test('marks hidden by the teacher (showMarksToStudent false): no score, grade or points; comments and corrections stay', async () => {
    const { submission } = await assessedSubmission();
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { showMarksToStudent: false } });
    const data = (await result(submission._id, f.student.token)).body.data;
    expect(data.marksVisible).toBe(false);
    expect(JSON.stringify(data.result)).not.toMatch(/overallScore|"grade"|"points"|"score"|maxScore/);
    expect(data.result.criteria[0]).toEqual({ criterionId: 'speaking-task', title: 'Task and content', level: 'Developing', weightPercent: 25, comment: expect.any(String) });
    expect(data.corrections).toHaveLength(2);
  });

  test('the owning teacher: the same result with the job state; still no provider, model, prompt version or hashes', async () => {
    const { submission } = await assessedSubmission();
    const res = await result(submission._id, f.teacher.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'ready', marksVisible: true, errorCode: null, runStatus: 'complete', relevance: 'on_topic', droppedCorrections: 0,
      rubricSource: 'default', canRetryAssessment: false });
    expect(res.body.data.result.overallScore).toBe(50);
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });

  test('anyone else: 404; signed out: 401; an essay submission id: 404; while the feature is off: 404', async () => {
    const { submission } = await assessedSubmission();
    for (const token of [f.otherStudent.token, f.otherTeacher.token]) expect((await result(submission._id, token)).status).toBe(404);
    expect((await request(app).get(`/api/speaking/submissions/${submission._id}/result`)).status).toBe(401);
    const essay = await Submission.create({ student: f.student.user._id, assignment: f.essay._id, class: f.klass._id, status: 'submitted', submittedAt: new Date(), isLate: false });
    expect((await result(essay._id, f.student.token)).status).toBe(404);
    delete process.env.AUDIO_STT_ENABLED;
    expect((await result(submission._id, f.student.token)).status).toBe(404);
  });
});

describe('every state', () => {
  test('transcribing: the recording is not ready yet', async () => {
    const { submission } = await makeAudioSubmission(f, { status: 'queued' });
    expect((await result(submission._id, f.student.token)).body.data).toMatchObject({ state: 'transcribing', result: null, corrections: [], assessedText: null });
  });

  test('transcription failed', async () => {
    const { submission } = await makeAudioSubmission(f, { status: 'failed' });
    expect((await result(submission._id, f.student.token)).body.data.state).toBe('transcription_failed');
  });

  test('assessing: queued or running', async () => {
    const made = await h.readyRecording(f, TEXTS.MEDIUM);
    await assessment.enqueueAssessment(made.recording._id);
    expect((await result(made.submission._id, f.student.token)).body.data).toMatchObject({ state: 'assessing', result: null });
    await Submission.updateOne({ _id: made.submission._id }, { $set: { evaluationStatus: 'processing' } });
    expect((await result(made.submission._id, f.teacher.token)).body.data.state).toBe('assessing');
  });

  test('blocked (no credits): the teacher sees blocked and the code; the student only sees that the teacher has it, never credits', async () => {
    await h.personalCredits(f.teacher.user, 0);
    const { submission } = await assessedSubmission(TEXTS.MEDIUM, h.output());
    const teacher = (await result(submission._id, f.teacher.token)).body.data;
    expect(teacher).toMatchObject({ state: 'blocked', errorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS', canRetryAssessment: true, result: null });
    const student = (await result(submission._id, f.student.token)).body.data;
    expect(student).toMatchObject({ state: 'awaiting_teacher', result: null });
    expect(JSON.stringify(student)).not.toMatch(/credit|INSUFFICIENT|billing/i);
  });

  test('not enough speech: the same clear state and message for both', async () => {
    const { submission } = await assessedSubmission('My town is small. I like it.', h.output());
    for (const token of [f.student.token, f.teacher.token]) {
      const data = (await result(submission._id, token)).body.data;
      expect(data).toMatchObject({ state: 'not_enough_speech', message: assessment.TERMINAL_MESSAGES.SPEAKING_NOT_ENOUGH_SPEECH, result: null });
    }
    expect((await result(submission._id, f.teacher.token)).body.data.canRetryAssessment).toBe(false);
  });

  test('not assessable (not English): the clear state and message', async () => {
    const { submission } = await assessedSubmission(TEXTS.SPANISH, h.output({ assessable: false, reason: 'not_english' }));
    expect((await result(submission._id, f.student.token)).body.data).toMatchObject({ state: 'not_assessable', message: assessment.TERMINAL_MESSAGES.SPEAKING_NOT_ENGLISH });
  });

  test('failed: the teacher sees the code and can retry; the student sees that the teacher has it', async () => {
    const { submission } = await assessedSubmission(TEXTS.MEDIUM, '{"broken":true}');
    expect((await result(submission._id, f.teacher.token)).body.data).toMatchObject({ state: 'failed', errorCode: 'AI_OUTPUT_VALIDATION_FAILED', canRetryAssessment: true });
    expect((await result(submission._id, f.student.token)).body.data).toMatchObject({ state: 'awaiting_teacher' });
  });
});

describe('retry the assessment (owning teacher)', () => {
  test('failed or blocked: queued again (200), then a run can complete', async () => {
    const { submission, recording } = await assessedSubmission(TEXTS.MEDIUM, '{"broken":true}');
    const res = await retry(submission._id, f.teacher.token);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('assessing');
    const doc = await AudioRecording.findById(recording._id).select('+assessmentQueue').lean();
    expect(doc).toMatchObject({ assessmentQueue: true, assessmentAttempts: 0 });
    expect((await assessment.runSpeakingAssessment(recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output()) })).status).toBe('completed');
  });

  test('not for a completed result or not enough speech (409); the student and other teachers get 404', async () => {
    const done = await assessedSubmission();
    expect((await retry(done.submission._id, f.teacher.token)).status).toBe(409);
    for (const token of [f.student.token, f.otherTeacher.token]) expect((await retry(done.submission._id, token)).status).toBe(404);
  });

  test('not for not enough speech (409)', async () => {
    const short = await assessedSubmission('My town is small. I like it.', h.output());
    const res = await retry(short.submission._id, f.teacher.token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSESSMENT_NOT_RETRYABLE');
  });
});
