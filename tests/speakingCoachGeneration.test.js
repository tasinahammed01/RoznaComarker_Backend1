'use strict';
// Speaking Coach: starting a practice session (services/speakingCoach/generation.service.js). In-memory MongoDB; the REAL gateway runs against
// a fake OpenRouter (no network); synthetic texts only.
// - Only once the graded result is ready; only the owner (student, or the guest holding the link); anyone else: 404.
// - Tasks from the weakest areas; their wording by AI from stored assessment data only (never the full transcript); templates when the AI
//   wording fails or is not configured, so a session never gets stuck. Idempotent: one session per submission, owner and source.
// - The graded Submission and SubmissionFeedback are never written; no credit is charged (D2).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'speaking-coach-generation-test-secret';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-generation-${process.pid}`;
const fs = require('fs');
const path = require('path');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AudioRecording = require('../src/models/AudioRecording');
const CreditWallet = require('../src/models/CreditWallet');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const assessment = require('../src/services/audio/speakingAssessment.service');
const accessContext = require('../src/services/submissionAccessContext.service');
const logger = require('../src/utils/logger');
const coach = require('../src/services/speakingCoach/generation.service');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ENV = { ...h.TEST_ENV, AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'true' };
const CORRECTIONS = [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', occurrence: 1, suggestedText: 'It has', message: 'Use has with it.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'by walk', occurrence: 1, suggestedText: 'on foot', message: 'We say on foot.' }];
const NOTICE = require('../src/config/speakingGuestNotice').SPEAKING_COACH_NOTICE_VERSION;
const GOOD = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Good']));
let f;

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans(); await AudioRecording.createIndexes(); await SpeakingPracticeSession.createIndexes();
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => jest.restoreAllMocks());

/** An assessed speaking submission (the real assessor against a fake reply). levels: { criterionId: level }. */
async function assessed({ mode = 'registered', levels = { ...GOOD, 'speaking-grammar': 'Developing', 'speaking-vocabulary': 'Developing' },
  corrections = CORRECTIONS, text = TEXTS.WEAK } = {}) {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60, mode });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text, fillers: [] }, assessorText: text, fluency: h.fluencyFor(text) }, transcriptSchemaVersion: 'audio-transcript-v1', wordTimingsAvailable: true } });
  await assessment.enqueueAssessment(made.recording._id);
  const outcome = await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output({ levels, corrections })) });
  expect(outcome.status).toBe('completed');
  return made;
}
const ORDINAL = { t1: 'first', t2: 'second', t3: 'third' };
const wording = ids => ({ tasks: ids.map(taskId => ({ taskId, prompt: `Answer the task again and focus on one clear idea in the ${ORDINAL[taskId]} part.`,
  tip: 'Take a breath before each new sentence.' })) });
const actorFor = (made, mode = 'registered') => (mode === 'guest' ? accessContext.guestContext(made.submission) : f.student.user._id);

test('before the result is ready: unavailable, and a start is refused', async () => {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60 });
  expect((await coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).state).toBe('unavailable');
  await expect(coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl: h.fakeOpenRouter(wording(['t1'])) }))
    .rejects.toMatchObject({ statusCode: 409, code: 'COACH_RESULT_NOT_READY' });
});

test.each([
  ['the submission is being assessed again', { submission: { evaluationStatus: 'processing' } }],
  ['the stored feedback is not completed', { feedback: { evaluationStatus: 'failed' } }]
])('a stored result that is not ready (%s): unavailable', async (_label, change) => {
  const made = await assessed();
  if (change.submission) await Submission.collection.updateOne({ _id: made.submission._id }, { $set: change.submission });
  if (change.feedback) await SubmissionFeedback.collection.updateOne({ submissionId: made.submission._id }, { $set: change.feedback });
  expect((await coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).state).toBe('unavailable');
  await expect(coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl: h.fakeOpenRouter(wording(['t1', 't2'])) }))
    .rejects.toMatchObject({ statusCode: 409 });
});

test('a ready result with weak areas: idle, then a ready session with AI-worded tasks', async () => {
  const made = await assessed({ corrections: [...CORRECTIONS, { category: 'VOCABULARY', symbol: 'WC', quotedText: 'quiet', occurrence: 1,
    suggestedText: 'peaceful', message: 'A more exact word fits here.' }] });
  expect((await coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).state).toBe('idle');
  const fetchImpl = h.fakeOpenRouter(wording(['t1', 't2']), { usage: { prompt_tokens: 1500, completion_tokens: 500, cost: 0.001 } });
  const out = await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl });
  expect(out.state).toBe('ready');
  const session = await SpeakingPracticeSession.findById(out.session._id).lean();
  expect(session).toMatchObject({ status: 'ready', settings: { passPercent: 70, attemptCap: 20 }, attemptsUsed: 0, currentTaskId: 't1',
    generation: { source: 'ai' } });
  expect(String(session.studentId)).toBe(String(f.student.user._id));
  expect(session.tasks.map(t => [t.taskId, t.type, t.criterionId, t.status])).toEqual([
    ['t1', 'repeat_improve', 'speaking-grammar', 'active'], ['t2', 'vocab_swap', 'speaking-vocabulary', 'locked']]);
  expect(session.tasks[1].targets).toEqual(['on foot', 'peaceful']);
  expect(session.tasks[0].prompt).toBe('Answer the task again and focus on one clear idea in the first part.');
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  // What the model read: stored assessment data, never the whole answer.
  const sent = JSON.stringify(fetchImpl.bodies[0].messages);
  expect(sent).not.toContain(TEXTS.WEAK);
  expect(sent).toContain('Grammar');
  expect(sent).toContain('wordsNotToUse');
});

test('AI wording that breaks the rules, or no AI configured: template tasks, still ready', async () => {
  const made = await assessed();
  const bad = { tasks: [{ taskId: 't1', prompt: 'Raise your score on grammar now.', tip: 'Think.' }, { taskId: 't2', prompt: 'Again.', tip: 'Tip.' }] };
  const out = await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl: h.fakeOpenRouter(bad) });
  const session = await SpeakingPracticeSession.findById(out.session._id).lean();
  expect(session).toMatchObject({ status: 'ready', generation: { source: 'template' } });
  expect(session.generation.errorCode).toBeTruthy();
  expect(session.tasks).toHaveLength(2);

  await SpeakingPracticeSession.deleteMany({});
  const noKey = { ...ENV, OPENROUTER_API_KEY: '' };
  const fetchImpl = h.fakeOpenRouter(wording(['t1', 't2']));
  const again = await coach.startSession(made.submission._id, f.student.user._id, { env: noKey, fetchImpl });
  expect((await SpeakingPracticeSession.findById(again.session._id).lean()).generation.source).toBe('template');
});

test('idempotent: a second start returns the same session without another AI call', async () => {
  const made = await assessed();
  const fetchImpl = h.fakeOpenRouter(wording(['t1', 't2']));
  const first = await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl });
  const second = await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl });
  expect(String(second.session._id)).toBe(String(first.session._id));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await SpeakingPracticeSession.countDocuments()).toBe(1);
  expect((await coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).state).toBe('ready');
});

test('two starts at the same moment: one session and one AI call', async () => {
  const made = await assessed();
  const fetchImpl = h.fakeOpenRouter(wording(['t1', 't2']));
  const both = await Promise.all([1, 2].map(() => coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl })));
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(await SpeakingPracticeSession.countDocuments()).toBe(1);
  for (const out of both) expect(['generating', 'ready']).toContain(out.state);
});

test('nothing below the pass rule: no practice needed, no session, no AI call', async () => {
  const made = await assessed({ levels: GOOD });
  const fetchImpl = h.fakeOpenRouter(wording(['t1']));
  expect((await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl })).state).toBe('no_practice_needed');
  expect((await coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).state).toBe('no_practice_needed');
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await SpeakingPracticeSession.countDocuments()).toBe(0);
});

test('the settings are copied in when the session starts', async () => {
  const made = await assessed();
  const env = { ...ENV, SPEAKING_COACH_PASS_PERCENT: '80', SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION: '7', SPEAKING_COACH_MAX_RECORDING_SECONDS: '60' };
  const out = await coach.startSession(made.submission._id, f.student.user._id, { env, fetchImpl: h.fakeOpenRouter(wording(['t1', 't2'])) });
  const session = await SpeakingPracticeSession.findById(out.session._id).lean();
  expect(session.settings).toEqual({ passPercent: 80, attemptCap: 7 });
  expect(session.tasks.every(t => t.maxSeconds === 60)).toBe(true);
});

test('anyone but the owner: 404 (another student, the teacher, a guest context of another submission)', async () => {
  const made = await assessed();
  const other = await assessed({ mode: 'guest' });
  for (const actor of [f.otherStudent.user._id, f.teacher.user._id, accessContext.guestContext(other.submission)]) {
    await expect(coach.getSession(made.submission._id, actor, { env: ENV })).rejects.toMatchObject({ statusCode: 404 });
    await expect(coach.startSession(made.submission._id, actor, { env: ENV, fetchImpl: h.fakeOpenRouter(wording(['t1', 't2'])) }))
      .rejects.toMatchObject({ statusCode: 404 });
  }
  await expect(coach.getSession(f.essay._id, f.student.user._id, { env: ENV })).rejects.toMatchObject({ statusCode: 404 });
});

test('a guest (through the link context): a guest-owned session', async () => {
  const made = await assessed({ mode: 'guest' });
  const actor = actorFor(made, 'guest');
  const out = await coach.startSession(made.submission._id, actor, { env: ENV, fetchImpl: h.fakeOpenRouter(wording(['t1', 't2'])), noticeVersion: NOTICE });
  const session = await SpeakingPracticeSession.findById(out.session._id).lean();
  expect(String(session.guestSubmissionId)).toBe(String(made.submission._id));
  expect(session.studentId).toBeUndefined();
  await expect(coach.getSession(made.submission._id, f.student.user._id, { env: ENV })).rejects.toMatchObject({ statusCode: 404 });
});

test('the graded result is never written and no credit is used; logs carry no student text', async () => {
  const made = await assessed();
  const metric = jest.spyOn(logger, 'metric'); const info = jest.spyOn(logger, 'info'); const warn = jest.spyOn(logger, 'warn');
  const before = { submission: await Submission.findById(made.submission._id).lean(), feedback: await SubmissionFeedback.findOne({ submissionId: made.submission._id }).lean(),
    wallet: await CreditWallet.findOne({ userId: f.teacher.user._id }).lean() };
  await coach.startSession(made.submission._id, f.student.user._id, { env: ENV, fetchImpl: h.fakeOpenRouter(wording(['t1', 't2'])) });
  expect(await Submission.findById(made.submission._id).lean()).toEqual(before.submission);
  expect(await SubmissionFeedback.findOne({ submissionId: made.submission._id }).lean()).toEqual(before.feedback);
  expect(await CreditWallet.findOne({ userId: f.teacher.user._id }).lean()).toEqual(before.wallet);
  const logged = JSON.stringify([...metric.mock.calls, ...info.mock.calls, ...warn.mock.calls]);
  for (const piece of ['It have', 'by walk', TEXTS.WEAK.slice(0, 30), 'Answer the task again']) expect(logged).not.toContain(piece);
  expect(logged).toContain('speaking_coach_session_started');
});

test('a disabled feature: the service still answers for tests, but the routes answer 404 (tested with the routes)', () => {
  expect(require('../src/services/speakingCoach/policy').speakingCoachEnabled({})).toBe(false);
});
