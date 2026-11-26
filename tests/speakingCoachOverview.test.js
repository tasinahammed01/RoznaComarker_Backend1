'use strict';
// Speaking Coach overview: the coach card is shown whenever the graded result is ready (and the coach is on), also when there is nothing to
// practise. In-memory MongoDB, a fake OpenRouter for the graded assessment, no network, synthetic texts only.
// - Students and guests: overview { reason, areas: [{ criterionId, title, strength, needsPractice }] }. strength is the level title EXACTLY as the
//   graded result shows it (criteria[].level), title the same title; needsPractice is the "Needs practice" / "Strong" label (D4 override for
//   this card, client decision 2026-11-26). Never a percent, the list of levels, a weight, the pass percent, a comment or a rubric description.
// - Reasons: no_weak_areas (every area strong), result_not_ready, no_rubric_scores; null when there is practice (idle or a session).
// - Teacher: the progress card always answers: no-practice-needed, not-started, result-not-ready, no-rubric-scores, or the session states;
//   areas with the level title and whether each needs practice (the teacher already sees both, D4).
process.env.JWT_SECRET = 'speaking-coach-overview-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-overview-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX',
  'UPLOAD_USER_RATE_LIMIT_MAX']) process.env[name] = '1000000';
jest.mock('../src/services/audio/duration', () => {
  const actual = jest.requireActual('../src/services/audio/duration');
  return { ...actual, measureAudioDuration: jest.fn(async () => ({ durationSeconds: 60, hasVideo: false })) };
});
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
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const assessment = require('../src/services/audio/speakingAssessment.service');
const access = require('../src/services/guestAccess.service');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const EXCELLENT = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Excellent']));
// The client's screenshot: 96% (every area Excellent, fluency Good: 100 - 15 x 0.25 = 96.25). Good is 75%, above the 70% pass.
const ALL_STRONG = { ...EXCELLENT, 'speaking-fluency': 'Good' };
const ONE_WEAK = { ...EXCELLENT, 'speaking-grammar': 'Developing' };
const AREA_KEYS = ['criterionId', 'needsPractice', 'strength', 'title'];
// What a student or guest must never receive from a coach route (the level title is allowed only as overview.areas[].strength, checked apart).
const FORBIDDEN = /levelTitle|levelPercent|percent|"levels"|weight|"passed"|passRule|minimumPercent|"score"|grade|"points"|comment|description|provider|"model"|sourceFingerprint|sourceSnapshot|"teacher[A-Za-z]*":|"(Excellent|Good|Developing|Beginning)"|[a-f0-9]{64}|openrouter|gemini|deepgram/i;
const withoutStrength = body => JSON.stringify(body, (k, v) => (k === 'strength' ? undefined : v));
let f;

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  for (const model of [AudioRecording, AudioUsageLedger, SpeakingPracticeSession, SpeakingPracticeAttempt]) await model.createIndexes();
  Object.assign(process.env, { AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'true', OPENROUTER_API_KEY: '' });
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; delete process.env.SPEAKING_COACH_ENABLED; jest.restoreAllMocks(); });

/** A graded speaking submission with these levels (registered student, or a guest with a private link). assess: false leaves it in assessment. */
async function graded({ levels, mode = 'registered', assess = true } = {}) {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60, mode });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text: TEXTS.WEAK, fillers: [] }, assessorText: TEXTS.WEAK, fluency: h.fluencyFor(TEXTS.WEAK) }, transcriptSchemaVersion: 'audio-transcript-v1',
    wordTimingsAvailable: true } });
  if (assess) {
    await assessment.enqueueAssessment(made.recording._id);
    await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output({ levels })) });
  }
  if (mode !== 'guest') return made;
  const issued = access.issueToken();
  await Submission.updateOne({ _id: made.submission._id }, { $set: { 'guest.accessHash': issued.accessHash, 'guest.expiresAt': issued.expiresAt } });
  await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true } });
  return { ...made, token: issued.token };
}

const coachUrl = id => `/api/speaking-coach/submissions/${id}`;
const guestUrl = id => `/api/guest/speaking/submissions/${id}/coach`;
const progressUrl = id => `/api/speaking-coach/teacher/submissions/${id}/progress`;
const studentCoach = id => request(app).get(coachUrl(id)).set(auth(f.student.token));
const teacherCard = id => request(app).get(progressUrl(id)).set(auth(f.teacher.token));
const studentResult = id => request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(f.student.token));
/** The graded result's areas as the student sees them: [criterionId, title, level]. */
const shownAreas = result => result.criteria.map(c => [c.criterionId, c.title, c.level]);

describe('a ready result where every area is strong (the 96% case)', () => {
  test('student page: the coach answers no_practice_needed with every area strong, the strength exactly as the graded result shows it', async () => {
    const made = await graded({ levels: ALL_STRONG });
    const id = String(made.submission._id);
    const result = (await studentResult(id)).body.data;
    expect(result.state).toBe('ready');
    const res = await studentCoach(id);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('no_practice_needed');
    expect(res.body.data.session).toBeNull();
    expect(res.body.data.overview.reason).toBe('no_weak_areas');
    expect(res.body.data.overview.areas.map(a => [a.criterionId, a.title, a.strength])).toEqual(shownAreas(result.result));
    expect(res.body.data.overview.areas.every(a => a.needsPractice === false)).toBe(true);
    for (const area of res.body.data.overview.areas) expect(Object.keys(area).sort()).toEqual(AREA_KEYS);
    expect(withoutStrength(res.body)).not.toMatch(FORBIDDEN);
  });

  test('teacher page: the progress card says no practice is needed (not "not started"), with each area and its level', async () => {
    const made = await graded({ levels: ALL_STRONG });
    const res = await teacherCard(made.submission._id);
    expect(res.status).toBe(200);
    expect(res.body.data.state).toBe('no-practice-needed');
    expect(res.body.data.sessionId).toBeNull();
    expect(res.body.data.areas.map(a => [a.title, a.levelTitle, a.needsPractice])).toEqual([
      ['Task completion', 'Excellent', false], ['Organisation', 'Excellent', false], ['Grammar', 'Excellent', false], ['Vocabulary', 'Excellent', false],
      ['Fluency', 'Good', false]].map(([title, level, weak]) => [expect.any(String), level, weak]));
  });

  test('start answers no_practice_needed with the same overview and creates nothing', async () => {
    const made = await graded({ levels: ALL_STRONG });
    const res = await request(app).post(`${coachUrl(made.submission._id)}/start`).set(auth(f.student.token)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'no_practice_needed', session: null, overview: { reason: 'no_weak_areas' } });
    expect(await SpeakingPracticeSession.countDocuments()).toBe(0);
  });
});

describe('one weak area', () => {
  test('idle: the weak area needs practice, the others are strong; no reason', async () => {
    const made = await graded({ levels: ONE_WEAK });
    const id = String(made.submission._id);
    const result = (await studentResult(id)).body.data.result;
    const res = await studentCoach(id);
    expect(res.body.data.state).toBe('idle');
    expect(res.body.data.overview.reason).toBeNull();
    expect(res.body.data.overview.areas.map(a => [a.criterionId, a.title, a.strength])).toEqual(shownAreas(result));
    expect(res.body.data.overview.areas.filter(a => a.needsPractice).map(a => a.criterionId)).toEqual(['speaking-grammar']);
    expect(withoutStrength(res.body)).not.toMatch(FORBIDDEN);
    const card = await teacherCard(id);
    expect(card.body.data.state).toBe('not-started');
    expect(card.body.data.areas.filter(a => a.needsPractice).map(a => a.levelTitle)).toEqual(['Developing']);
  });

  test('the overview stays with a session; marks hidden from the student change nothing in it', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { showMarksToStudent: false } });
    const made = await graded({ levels: ONE_WEAK });
    const id = String(made.submission._id);
    const result = (await studentResult(id)).body.data;
    expect(result.marksVisible).toBe(false);
    const started = await request(app).post(`${coachUrl(id)}/start`).set(auth(f.student.token)).send({});
    expect(started.body.data.state).toBe('ready');
    expect(started.body.data.overview.reason).toBeNull();
    expect(started.body.data.overview.areas.map(a => [a.criterionId, a.title, a.strength])).toEqual(shownAreas(result.result));
    const again = await studentCoach(id);
    expect(again.body.data.overview).toEqual(started.body.data.overview);
    expect(withoutStrength(again.body)).not.toMatch(FORBIDDEN);
  });
});

describe('not ready', () => {
  test('still in assessment: result_not_ready for the student, result-not-ready for the teacher, no areas', async () => {
    const made = await graded({ assess: false });
    const id = String(made.submission._id);
    expect((await studentResult(id)).body.data.state).not.toBe('ready');
    const res = await studentCoach(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'unavailable', session: null, overview: { reason: 'result_not_ready', areas: [] } });
    const card = await teacherCard(id);
    expect(card.status).toBe(200);
    expect(card.body.data).toMatchObject({ state: 'result-not-ready', areas: [] });
  });

  test('a ready result without rubric scores: no_rubric_scores (the card explains instead of hiding)', async () => {
    const made = await graded({ levels: ALL_STRONG });
    await SubmissionFeedback.updateOne({ submissionId: made.submission._id }, { $unset: { 'customRubricScores.criteria': 1 } });
    const res = await studentCoach(made.submission._id);
    expect(res.body.data).toMatchObject({ state: 'unavailable', overview: { reason: 'no_rubric_scores', areas: [] } });
    expect((await teacherCard(made.submission._id)).body.data.state).toBe('no-rubric-scores');
  });
});

describe('guests', () => {
  test('the same overview through the private link, the strength exactly as the guest result shows it', async () => {
    const made = await graded({ levels: ALL_STRONG, mode: 'guest' });
    const headers = { 'X-Guest-Token': made.token };
    // The guest page reads { ..., result: <the student result read> }; its graded areas are result.result.criteria.
    const result = (await request(app).get(`/api/guest/speaking/submissions/${made.submission._id}`).set(headers)).body.data.result;
    expect(result.state).toBe('ready');
    const res = await request(app).get(guestUrl(made.submission._id)).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ state: 'no_practice_needed', overview: { reason: 'no_weak_areas' } });
    expect(res.body.data.overview.areas.map(a => [a.criterionId, a.title, a.strength])).toEqual(shownAreas(result.result));
    expect(withoutStrength(res.body)).not.toMatch(FORBIDDEN);
    expect(withoutStrength(res.body)).not.toMatch(/"teacher|email/i);
  });

  test('coach off: the student, guest and teacher routes stay the hidden-feature 404', async () => {
    const made = await graded({ levels: ALL_STRONG, mode: 'guest' });
    delete process.env.SPEAKING_COACH_ENABLED;
    expect((await request(app).get(guestUrl(made.submission._id)).set({ 'X-Guest-Token': made.token })).body).toEqual(NOT_FOUND);
    expect((await teacherCard(made.submission._id)).body).toEqual(NOT_FOUND);
    const own = await graded({ levels: ALL_STRONG });
    expect((await studentCoach(own.submission._id)).body).toEqual(NOT_FOUND);
  });
});

describe('teacher ownership', () => {
  test('another teacher gets the 404 for every empty state', async () => {
    const strong = await graded({ levels: ALL_STRONG });
    const pending = await graded({ assess: false, mode: 'guest' });
    for (const made of [strong, pending]) {
      expect((await request(app).get(progressUrl(made.submission._id)).set(auth(f.otherTeacher.token))).body).toEqual(NOT_FOUND);
    }
  });
});
