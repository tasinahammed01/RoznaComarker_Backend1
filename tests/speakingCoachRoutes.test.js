'use strict';
// Speaking Coach HTTP routes: /api/speaking-coach (students, and the owning teacher's progress) and /api/guest/speaking/submissions/:id/coach
// (guests through their private link). In-memory MongoDB; the REAL gateway against a fake OpenRouter, an injected speech-to-text fake; no
// network; synthetic texts only.
// - SPEAKING_COACH_ENABLED off (the default): every coach route answers the hidden-feature 404 before sign-in.
// - Students: owner only (404 for another student). Strict DTOs: never a level percent (the level title only as the overview strength the result already shows), a pass flag, a score, provider, model,
//   prompt, hash, teacher id or internal field (D4).
// - Teachers: the owning teacher's progress and attempt history with the level reached, pass or not, and the pass rule (D3); 404 for another teacher.
// - Guests: the practice notice (versioned) must be accepted before the first practice recording; the graded consent is unchanged.
// - The graded result reads the same before and after practice.
process.env.JWT_SECRET = 'speaking-coach-routes-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-routes-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX',
  'UPLOAD_USER_RATE_LIMIT_MAX']) process.env[name] = '1000000';
// The duration measurement is mocked as in speakingUpload.test.js (music-metadata cannot load inside Jest; tests/audioDuration.test.js runs the
// real one): the WAV header gives the duration.
jest.mock('../src/services/audio/duration', () => {
  const actual = jest.requireActual('../src/services/audio/duration');
  const measureAudioDuration = jest.fn(async (filePath) => {
    const buf = require('fs').readFileSync(filePath);
    if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') throw Object.assign(new Error('unreadable'), { code: 'AUDIO_UNREADABLE' });
    return { durationSeconds: buf.readUInt32LE(40) / buf.readUInt32LE(28), hasVideo: false };
  });
  return { ...actual, measureAudioDuration };
});
const fs = require('fs');
const path = require('path');
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
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const Submission = require('../src/models/Submission');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const assessment = require('../src/services/audio/speakingAssessment.service');
const processing = require('../src/services/audio/processing');
const deepgram = require('../src/services/audio/stt/deepgram');
const access = require('../src/services/guestAccess.service');
const check = require('../src/services/speakingCoach/assessment.service');
const notice = require('../src/config/speakingGuestNotice');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const GOOD = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Good']));
const CORRECTIONS = [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', occurrence: 1, suggestedText: 'It has', message: 'Use has with it.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'by walk', occurrence: 1, suggestedText: 'on foot', message: 'We say on foot.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'quiet', occurrence: 1, suggestedText: 'peaceful', message: 'A more exact word fits here.' }];
const ATTEMPT_TEXT = 'My town is small and peaceful. It has one school and one shop. I go to school on foot every morning with my friend. '
  + 'There is a river near the park and people are friendly. I like my town because it is calm and green.';
// What a student or guest must never receive from a coach route.
const FORBIDDEN = /levelTitle|levelPercent|"passed"|passRule|minimumPercent|passPercent|"score"|grade|provider|"model"|promptVersion|"generation"|sourceFingerprint|sourceSnapshot|"teacher[A-Za-z]*":|minutesChargedTo|recordingId|assessmentQueue|assessmentLease|requestId|errorCode|activeAttemptId|"(Excellent|Good|Developing|Beginning)"|[a-f0-9]{64}|openrouter|gemini|deepgram/i;
// The coach card's overview may name each area's level title (overview.areas[].strength, the same as the graded result shows: checked in
// speakingCoachOverview.test.js); everything else in the body stays under FORBIDDEN.
const withoutStrength = body => JSON.stringify(body, (k, v) => (k === 'strength' ? undefined : v));
let f;
let gatewayFetch;

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

async function assessed({ mode = 'registered', levels = { ...GOOD, 'speaking-grammar': 'Developing', 'speaking-vocabulary': 'Developing' } } = {}) {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60, mode });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text: TEXTS.WEAK, fillers: [] }, assessorText: TEXTS.WEAK, fluency: h.fluencyFor(TEXTS.WEAK) }, transcriptSchemaVersion: 'audio-transcript-v1',
    wordTimingsAvailable: true } });
  await assessment.enqueueAssessment(made.recording._id);
  await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output({ levels, corrections: CORRECTIONS })) });
  if (mode !== 'guest') return made;
  const issued = access.issueToken();
  await Submission.updateOne({ _id: made.submission._id }, { $set: { 'guest.accessHash': issued.accessHash, 'guest.expiresAt': issued.expiresAt } });
  await require('../src/models/assignment.model').updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true } });
  return { ...made, token: issued.token };
}

const coachBase = '/api/speaking-coach';
const guestBase = id => `/api/guest/speaking/submissions/${id}/coach`;
const key = () => `key-${crypto.randomUUID()}`;
const uploadTo = (url, headers) => request(app).post(url).set(headers).set('Idempotency-Key', key())
  .attach('audio', samples.wav(20), { filename: 'practice.wav', contentType: 'audio/wav' });

/** The worker: transcribe the latest attempt's recording (fake provider), set synthetic text, then check it with a fake model reply. */
async function workAttempt(reply = { assessable: true, notAssessableReason: 'none', onTask: true, level: 'Excellent',
  improved: ['You joined your ideas more clearly this time.'], stillWeak: [], nextTip: 'Next time, try to give an example for each idea.' }) {
  const attempt = await SpeakingPracticeAttempt.findOne().sort({ createdAt: -1 }).lean();
  await processing.processAudioRecording(attempt.recordingId, { transcribe: async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false }),
    env: process.env });
  await AudioRecording.collection.updateOne({ _id: attempt.recordingId }, { $set: { 'derived.assessorText': ATTEMPT_TEXT, 'derived.fluency': h.fluencyFor(ATTEMPT_TEXT) } });
  gatewayFetch = h.fakeOpenRouter(reply);
  await check.runPracticeCheck(attempt._id, { env: h.TEST_ENV, fetchImpl: gatewayFetch });
  return attempt;
}

describe('switched off (the default)', () => {
  test('every coach route answers the hidden-feature 404, before sign-in', async () => {
    delete process.env.SPEAKING_COACH_ENABLED;
    const made = await assessed();
    const id = String(made.submission._id);
    for (const [method, url] of [['get', `${coachBase}/submissions/${id}`], ['post', `${coachBase}/submissions/${id}/start`],
      ['get', `${coachBase}/teacher/submissions/${id}/progress`], ['get', `${coachBase}/sessions/${id}/attempts/${id}`], ['get', guestBase(id)],
      ['post', `${guestBase(id)}/start`]]) {
      for (const headers of [{}, auth(f.student.token), auth(f.teacher.token)]) {
        const res = await request(app)[method](url).set(headers);
        expect({ url, status: res.status, body: res.body }).toEqual({ url, status: 404, body: NOT_FOUND });
      }
    }
  });
});

describe('students', () => {
  test('the whole flow: idle, start, record, check, the next task, completed; strict DTOs throughout', async () => {
    const made = await assessed();
    const id = String(made.submission._id);
    const gradedBefore = (await request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(f.student.token))).body;
    const bodies = [];
    const keep = res => { bodies.push(res.body); return res; };

    const idle = keep(await request(app).get(`${coachBase}/submissions/${id}`).set(auth(f.student.token)));
    expect(idle.status).toBe(200);
    expect(idle.headers['cache-control']).toBe('private, no-store');
    expect(idle.body.data).toMatchObject({ state: 'idle', session: null });

    const started = keep(await request(app).post(`${coachBase}/submissions/${id}/start`).set(auth(f.student.token)).send({}));
    expect(started.status).toBe(200);
    const session = started.body.data.session;
    expect(started.body.data.state).toBe('ready');
    expect(Object.keys(session).sort()).toEqual(['activeAttempt', 'attemptsLeft', 'attemptsUsed', 'currentTaskId', 'endedReason', 'id', 'lastAttempt', 'tasks'].sort());
    expect(session.tasks.map(t => [t.taskId, t.type, t.status])).toEqual([['t1', 'repeat_improve', 'current'], ['t2', 'vocab_swap', 'locked']]);
    expect(Object.keys(session.tasks[0]).sort()).toEqual(['area', 'attemptCount', 'maxSeconds', 'order', 'prompt', 'status', 'targets', 'taskId', 'tip', 'type'].sort());
    expect(session.tasks[1].targets).toEqual(['on foot', 'peaceful']);

    const uploaded = keep(await uploadTo(`${coachBase}/sessions/${session.id}/tasks/t1/attempts`, auth(f.student.token)));
    expect(uploaded.status).toBe(202);
    expect(uploaded.body.data.attempt).toMatchObject({ taskId: 't1', attemptNumber: 1, state: 'processing' });
    const busy = await uploadTo(`${coachBase}/sessions/${session.id}/tasks/t1/attempts`, auth(f.student.token));
    expect(busy.status).toBe(409);
    expect(busy.body.code).toBe('COACH_ATTEMPT_IN_PROGRESS');

    await workAttempt();
    const attemptId = uploaded.body.data.attempt.id;
    const read = keep(await request(app).get(`${coachBase}/sessions/${session.id}/attempts/${attemptId}`).set(auth(f.student.token)));
    expect(read.status).toBe(200);
    expect(read.body.data.attempt).toMatchObject({ state: 'ready', nextStep: 'next_task',
      feedback: { improved: ['You joined your ideas more clearly this time.'], stillWeak: [], nextTip: 'Next time, try to give an example for each idea.' } });
    expect(read.body.data.session.tasks.map(t => t.status)).toEqual(['done', 'current']);

    keep(await uploadTo(`${coachBase}/sessions/${session.id}/tasks/t2/attempts`, auth(f.student.token)));
    await workAttempt();
    const done = keep(await request(app).get(`${coachBase}/submissions/${id}`).set(auth(f.student.token)));
    expect(done.body.data.state).toBe('completed');
    expect(done.body.data.session.lastAttempt).toMatchObject({ nextStep: 'finished', vocab: { used: ['on foot', 'peaceful'], missing: [] } });

    for (const body of bodies) expect(withoutStrength(body)).not.toMatch(FORBIDDEN);
    expect((await request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(f.student.token))).body).toEqual(gradedBefore);
  });

  test('another student, a missing session or attempt: 404 with nothing told apart', async () => {
    const made = await assessed();
    const id = String(made.submission._id);
    const started = await request(app).post(`${coachBase}/submissions/${id}/start`).set(auth(f.student.token)).send({});
    const sessionId = started.body.data.session.id;
    for (const [method, url] of [['get', `${coachBase}/submissions/${id}`], ['post', `${coachBase}/submissions/${id}/start`],
      ['get', `${coachBase}/sessions/${sessionId}/attempts/${sessionId}`]]) {
      const res = await request(app)[method](url).set(auth(f.otherStudent.token));
      expect(res.status).toBe(404);
      expect(res.body).toEqual(NOT_FOUND);
    }
    const upload = await uploadTo(`${coachBase}/sessions/${sessionId}/tasks/t1/attempts`, auth(f.otherStudent.token));
    expect(upload.status).toBe(404);
    expect(await SpeakingPracticeAttempt.countDocuments()).toBe(0);
    expect((await request(app).get(`${coachBase}/submissions/${h.objectId()}`).set(auth(f.student.token))).body).toEqual(NOT_FOUND);
  });

  test('not ready yet: unavailable; a start is refused with 409', async () => {
    const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60 });
    const get = await request(app).get(`${coachBase}/submissions/${made.submission._id}`).set(auth(f.student.token));
    expect(get.body.data).toEqual({ state: 'unavailable', session: null, overview: { reason: 'result_not_ready', areas: [] } });
    const start = await request(app).post(`${coachBase}/submissions/${made.submission._id}/start`).set(auth(f.student.token)).send({});
    expect(start.status).toBe(409);
    expect(start.body.code).toBe('COACH_RESULT_NOT_READY');
  });

  test('a not-assessable attempt says why, with no AI call', async () => {
    const made = await assessed();
    const started = await request(app).post(`${coachBase}/submissions/${made.submission._id}/start`).set(auth(f.student.token)).send({});
    const sessionId = started.body.data.session.id;
    const up = await uploadTo(`${coachBase}/sessions/${sessionId}/tasks/t1/attempts`, auth(f.student.token));
    const attempt = await SpeakingPracticeAttempt.findById(up.body.data.attempt.id).lean();
    await processing.processAudioRecording(attempt.recordingId, { transcribe: async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false }),
      env: process.env });
    await AudioRecording.collection.updateOne({ _id: attempt.recordingId }, { $set: { 'derived.assessorText': 'My town is small.' } });
    await check.runPracticeCheck(attempt._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter({ status: 500 }) });
    const read = await request(app).get(`${coachBase}/sessions/${sessionId}/attempts/${attempt._id}`).set(auth(f.student.token));
    expect(read.body.data.attempt).toMatchObject({ state: 'not_assessable', reason: 'not_enough_speech', nextStep: 'try_again' });
  });
});

describe('teachers', () => {
  test('the owning teacher: progress with the level reached, pass or not, and the pass rule; attempt history with the answer text', async () => {
    const made = await assessed();
    const id = String(made.submission._id);
    const empty = await request(app).get(`${coachBase}/teacher/submissions/${id}/progress`).set(auth(f.teacher.token));
    expect(empty.body.data).toMatchObject({ state: 'not-started', sessionId: null });
    const started = await request(app).post(`${coachBase}/submissions/${id}/start`).set(auth(f.student.token)).send({});
    await uploadTo(`${coachBase}/sessions/${started.body.data.session.id}/tasks/t1/attempts`, auth(f.student.token));
    await workAttempt({ assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: [], stillWeak: ['Add one more reason.'],
      nextTip: 'Give an example for each idea.' });
    const res = await request(app).get(`${coachBase}/teacher/submissions/${id}/progress`).set(auth(f.teacher.token));
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data).toMatchObject({ state: 'in-progress', sourceStatus: 'current', settings: { passPercent: 70, attemptCap: 20 },
      summary: { totalTasks: 2, passedTasks: 1, attemptsUsed: 1, attemptCap: 20 } });
    expect(data.tasks[0]).toMatchObject({ taskId: 't1', type: 'repeat_improve', area: 'Grammar', status: 'passed', attemptCount: 1, latestLevel: 'Good', passed: true,
      originalLevel: 'Developing', passRule: { rule: 'threshold', minimumPercent: 70 } });
    expect(data.tasks[0].passRuleText).toBe('Passes at 70% or above.');
    const history = await request(app).get(`${coachBase}/teacher/sessions/${data.sessionId}/tasks/t1/attempts`).set(auth(f.teacher.token));
    expect(history.status).toBe(200);
    expect(history.body.data.attempts[0]).toMatchObject({ attemptNumber: 1, state: 'ready', levelTitle: 'Good', passed: true, onTask: true, answerText: ATTEMPT_TEXT,
      feedback: { stillWeak: ['Add one more reason.'] } });
    expect(JSON.stringify(history.body)).not.toMatch(/provider|"model"|promptVersion|assessmentLease|requestId|recordingId|[a-f0-9]{64}/);
  });

  test('the second-highest rule is spelled out for the teacher', async () => {
    const made = await assessed();
    await request(app).post(`${coachBase}/submissions/${made.submission._id}/start`).set(auth(f.student.token)).send({});
    await SpeakingPracticeSession.updateOne({}, { $set: { 'tasks.0.passRule': { rule: 'second_highest', minimumPercent: 66.67 } } });
    const res = await request(app).get(`${coachBase}/teacher/submissions/${made.submission._id}/progress`).set(auth(f.teacher.token));
    expect(res.body.data.tasks[0].passRuleText)
      .toBe('No level of this criterion falls between 70% and 100%, so the second-highest level (66.67%) and above passes.');
  });

  test('both the assignment and the class must be the teacher\'s: a class moved to another teacher shows the progress to neither', async () => {
    const made = await assessed();
    await require('../src/models/class.model').updateOne({ _id: f.klass._id }, { $set: { teacher: f.otherTeacher.user._id } });
    for (const token of [f.teacher.token, f.otherTeacher.token]) {
      const res = await request(app).get(`${coachBase}/teacher/submissions/${made.submission._id}/progress`).set(auth(token));
      expect(res.status).toBe(404);
    }
  });

  test('another teacher: 404; a student: 403 (teacher route)', async () => {
    const made = await assessed();
    const other = await request(app).get(`${coachBase}/teacher/submissions/${made.submission._id}/progress`).set(auth(f.otherTeacher.token));
    expect(other.status).toBe(404);
    expect(other.body).toEqual(NOT_FOUND);
    expect((await request(app).get(`${coachBase}/teacher/submissions/${made.submission._id}/progress`).set(auth(f.student.token))).status).toBe(403);
  });
});

describe('guests', () => {
  test('the notice is shown and must be accepted before practice; then the guest practises through the link', async () => {
    const made = await assessed({ mode: 'guest' });
    const headers = { 'X-Guest-Token': made.token };
    const idle = await request(app).get(guestBase(made.submission._id)).set(headers);
    expect(idle.status).toBe(200);
    expect(idle.body.data).toMatchObject({ state: 'idle', notice: { version: notice.SPEAKING_COACH_NOTICE_VERSION, text: notice.SPEAKING_COACH_NOTICE_TEXT, accepted: false } });
    const refused = await request(app).post(`${guestBase(made.submission._id)}/start`).set(headers).send({});
    expect(refused.status).toBe(400);
    expect(refused.body.code).toBe('COACH_NOTICE_REQUIRED');
    const old = await request(app).post(`${guestBase(made.submission._id)}/start`).set(headers).send({ noticeVersion: notice.SPEAKING_GUEST_NOTICE_VERSION });
    expect(old.status).toBe(400);
    const started = await request(app).post(`${guestBase(made.submission._id)}/start`).set(headers).send({ noticeVersion: notice.SPEAKING_COACH_NOTICE_VERSION });
    expect(started.status).toBe(200);
    expect(started.body.data.notice.accepted).toBe(true);
    const stored = await SpeakingPracticeSession.findOne().lean();
    expect(stored.guestNotice.version).toBe(notice.SPEAKING_COACH_NOTICE_VERSION);
    expect(stored.guestNotice.acceptedAt).toBeInstanceOf(Date);
    const sessionId = started.body.data.session.id;
    const up = await uploadTo(`${guestBase(made.submission._id)}/sessions/${sessionId}/tasks/t1/attempts`, headers);
    expect(up.status).toBe(202);
    await workAttempt();
    const read = await request(app).get(`${guestBase(made.submission._id)}/sessions/${sessionId}/attempts/${up.body.data.attempt.id}`).set(headers);
    expect(read.body.data.attempt.state).toBe('ready');
    for (const body of [idle.body, started.body, up.body, read.body]) expect(withoutStrength(body)).not.toMatch(FORBIDDEN);
    // The graded consent is unchanged and still valid for graded recordings.
    expect(notice.SPEAKING_GUEST_NOTICE_VERSION).toBe('speaking-guest-2026-11');
  });

  test('a session accepted under an older practice notice: uploads wait until the current notice is accepted', async () => {
    const made = await assessed({ mode: 'guest' });
    const headers = { 'X-Guest-Token': made.token };
    const started = await request(app).post(`${guestBase(made.submission._id)}/start`).set(headers).send({ noticeVersion: notice.SPEAKING_COACH_NOTICE_VERSION });
    await SpeakingPracticeSession.updateOne({}, { $set: { 'guestNotice.version': 'speaking-coach-guest-old' } });
    const up = await uploadTo(`${guestBase(made.submission._id)}/sessions/${started.body.data.session.id}/tasks/t1/attempts`, headers);
    expect(up.status).toBe(409);
    expect(up.body.code).toBe('COACH_NOTICE_REQUIRED');
    const again = await request(app).post(`${guestBase(made.submission._id)}/start`).set(headers).send({ noticeVersion: notice.SPEAKING_COACH_NOTICE_VERSION });
    expect(again.body.data.notice.accepted).toBe(true);
    expect((await uploadTo(`${guestBase(made.submission._id)}/sessions/${started.body.data.session.id}/tasks/t1/attempts`, headers)).status).toBe(202);
  });

  test('another guest, no link, or a student: one 404', async () => {
    const mine = await assessed({ mode: 'guest' });
    const other = await assessed({ mode: 'guest' });
    for (const headers of [{ 'X-Guest-Token': other.token }, {}, auth(f.student.token)]) {
      const res = await request(app).get(guestBase(mine.submission._id)).set(headers);
      expect(res.status).toBe(404);
    }
  });
});
