'use strict';
// Speaking Coach attempts (services/speakingCoach/attempt.service.js, assessment.service.js, the worker hook in services/audio/processing.js).
// In-memory MongoDB; the REAL gateway runs against a fake OpenRouter and the speech-to-text provider is an injected fake (no network);
// synthetic texts only.
// - Upload rules: owner only (404), the active task only, one attempt in progress per session, the attempt cap, the teacher's practice minutes.
// - The recording is a 'practice' recording (no submission, no storage charge, the practice minutes); once transcribed it is NEVER queued for
//   the graded assessment, and its audio file is deleted (D1).
// - The check: the practised criterion's level under the pass rule (D3: 4-level, 3-level and custom rubrics), on task, and for a vocabulary
//   swap the target words used; a comparison with the previous attempt; the next task, completion (the teacher is notified) or the cap.
// - Not enough speech: decided without AI. A failed check can be retried without using the cap; a failed transcription gives the attempt back.
// - The graded Submission and SubmissionFeedback are never written; no credit is used; logs carry no student text.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'speaking-coach-attempt-test-secret';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-attempt-${process.pid}`;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const File = require('../src/models/File');
const CreditWallet = require('../src/models/CreditWallet');
const Notification = require('../src/models/notification.model');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const storage = require('../src/services/audio/storage');
const processing = require('../src/services/audio/processing');
const assessment = require('../src/services/audio/speakingAssessment.service');
const deepgram = require('../src/services/audio/stt/deepgram');
const { SttError } = require('../src/services/audio/stt/errors');
const accessContext = require('../src/services/submissionAccessContext.service');
const logger = require('../src/utils/logger');
const coach = require('../src/services/speakingCoach/generation.service');
const attempts = require('../src/services/speakingCoach/attempt.service');
const check = require('../src/services/speakingCoach/assessment.service');

jest.setTimeout(90000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ENV = { ...h.TEST_ENV, AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'true' };
const GOOD = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Good']));
const CORRECTIONS = [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', occurrence: 1, suggestedText: 'It has', message: 'Use has with it.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'by walk', occurrence: 1, suggestedText: 'on foot', message: 'We say on foot.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'quiet', occurrence: 1, suggestedText: 'peaceful', message: 'A more exact word fits here.' }];
const NOTICE = require('../src/config/speakingGuestNotice').SPEAKING_COACH_NOTICE_VERSION;
const ATTEMPT_TEXT = 'My town is small and peaceful. It has one school and one shop. I go to school on foot every morning with my friend. '
  + 'There is a river near the park and people are friendly. I like my town because it is calm and green.';
let f;

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  for (const model of [AudioRecording, AudioUsageLedger, SpeakingPracticeSession, SpeakingPracticeAttempt]) await model.createIndexes();
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => jest.restoreAllMocks());

/** An assessed speaking submission and a started session (grammar weak -> repeat and improve; vocabulary weak -> vocabulary swap). */
async function startedSession({ mode = 'registered', levels = { ...GOOD, 'speaking-grammar': 'Developing', 'speaking-vocabulary': 'Developing' }, env = ENV } = {}) {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60, mode });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text: TEXTS.WEAK, fillers: [] }, assessorText: TEXTS.WEAK, fluency: h.fluencyFor(TEXTS.WEAK) }, transcriptSchemaVersion: 'audio-transcript-v1',
    wordTimingsAvailable: true } });
  await assessment.enqueueAssessment(made.recording._id);
  await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output({ levels, corrections: CORRECTIONS })) });
  const actor = mode === 'guest' ? accessContext.guestContext(made.submission) : f.student.user._id;
  const started = await coach.startSession(made.submission._id, actor, { env, fetchImpl: h.fakeOpenRouter({ status: 500 }), noticeVersion: NOTICE });
  return { ...made, actor, session: started.session };
}

/** A practice upload as the upload middleware leaves it (a real WAV file in the audio folder). */
function upload(seconds = 20) {
  fs.mkdirSync(storage.audioRoot(), { recursive: true });
  const filename = `${crypto.randomUUID()}.wav`;
  const bytes = samples.wav(seconds);
  fs.writeFileSync(path.join(storage.audioRoot(), filename), bytes);
  return { filename, storedPath: storage.storedPathFor(filename), extension: '.wav', contentType: 'audio/wav', sizeBytes: bytes.length, durationSeconds: seconds,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), committed: false, commit: jest.fn(function commit() { this.committed = true; }) };
}
const rid = () => `req-${crypto.randomUUID()}`;

async function uploadAttempt(s, taskId = 't1', { requestId = rid(), seconds = 20 } = {}) {
  const context = await attempts.prepareAttempt({ sessionId: s.session._id, taskId, actor: s.actor, requestId, env: ENV });
  if (context.replay) return context.replay;
  return attempts.commitAttempt({ context, upload: upload(seconds), actor: s.actor });
}

const fakeTranscribe = async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false });
/** The worker transcribes the attempt's recording; then its assessed text and fluency are set to synthetic values. */
async function transcribed(attempt, text = ATTEMPT_TEXT, fluency = h.fluencyFor(text)) {
  const outcome = await processing.processAudioRecording(attempt.recordingId, { transcribe: fakeTranscribe, env: ENV });
  expect(outcome.status).toBe('ready');
  await AudioRecording.collection.updateOne({ _id: attempt.recordingId }, { $set: { 'derived.assessorText': text, 'derived.fluency': fluency } });
}

/** The check model's output. */
const checkOutput = ({ level = 'Good', onTask = true, assessable = true, reason = 'none', improved = ['You joined your ideas more clearly this time.'],
  stillWeak = ['Add one more reason to support your main idea.'], nextTip = 'Next time, try to give an example for each idea.' } = {}) =>
  (assessable ? { assessable, notAssessableReason: 'none', onTask, level, improved, stillWeak, nextTip }
    : { assessable, notAssessableReason: reason, onTask: false, level: 'Beginning', improved: [], stillWeak: [], nextTip: 'Try again with a longer answer.' });

async function checked(attempt, reply = checkOutput(), env = ENV) {
  const fetchImpl = h.fakeOpenRouter(reply, { usage: { prompt_tokens: 1500, completion_tokens: 350, cost: 0.0009 } });
  const out = await check.runPracticeCheck(attempt._id, { env, fetchImpl });
  return { out, fetchImpl, attempt: await SpeakingPracticeAttempt.findById(attempt._id).lean(), session: await SpeakingPracticeSession.findById(attempt.sessionId).lean() };
}

describe('uploading an attempt', () => {
  test('a practice recording: no submission, no storage charge, the teacher\'s practice minutes; the session counts it and holds it as in progress', async () => {
    const s = await startedSession();
    const before = await Submission.findById(s.submission._id).lean();
    const attempt = await uploadAttempt(s);
    expect(attempt).toMatchObject({ status: 'transcribing', attemptNumber: 1, taskId: 't1' });
    const recording = await AudioRecording.findById(attempt.recordingId).lean();
    expect(recording).toMatchObject({ purpose: 'practice', submissionId: null, storageChargedMB: 0, status: 'queued' });
    expect(String(recording.practiceAttemptId)).toBe(String(attempt._id));
    expect(String(recording.minutesChargedTo)).toBe(String(f.teacher.user._id));
    const session = await SpeakingPracticeSession.findById(s.session._id).lean();
    expect(session.attemptsUsed).toBe(1);
    expect(String(session.activeAttemptId)).toBe(String(attempt._id));
    expect(session.tasks[0].attemptCount).toBe(1);
    expect(await Submission.findById(s.submission._id).lean()).toEqual(before);
  });

  test('the same request again: the same attempt (no second recording)', async () => {
    const s = await startedSession();
    const requestId = rid();
    const first = await uploadAttempt(s, 't1', { requestId });
    const again = await attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't1', actor: s.actor, requestId, env: ENV });
    expect(String(again.replay._id)).toBe(String(first._id));
    expect(await AudioRecording.countDocuments({ purpose: 'practice' })).toBe(1);
  });

  test('refusals: not the owner (404), a locked task, another attempt in progress, no practice minutes left, an invalid request id', async () => {
    const s = await startedSession();
    const prepare = over => attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't1', actor: s.actor, requestId: rid(), env: ENV, ...over });
    for (const actor of [f.otherStudent.user._id, f.teacher.user._id]) await expect(prepare({ actor })).rejects.toMatchObject({ statusCode: 404 });
    await expect(prepare({ sessionId: h.objectId() })).rejects.toMatchObject({ statusCode: 404 });
    await expect(prepare({ taskId: 't2' })).rejects.toMatchObject({ statusCode: 409, code: 'COACH_TASK_NOT_ACTIVE' });
    await expect(prepare({ requestId: 'short' })).rejects.toMatchObject({ statusCode: 400, code: 'COACH_REQUEST_ID_REQUIRED' });
    await uploadAttempt(s);
    await expect(prepare({})).rejects.toMatchObject({ statusCode: 409, code: 'COACH_ATTEMPT_IN_PROGRESS' });
    await SpeakingPracticeSession.updateOne({ _id: s.session._id }, { $set: { activeAttemptId: null } });
    // The teacher's practice minutes for today are used up (one minute cap, sixty seconds used): refused before the file is read.
    await AudioUsageLedger.create({ key: 'k', recordingId: h.objectId(), uploader: h.objectId(), minutesChargedTo: f.teacher.user._id, seconds: 60,
      ...require('../src/services/audio/usage').utcKeys(new Date()), state: 'consumed', reservedAt: new Date(), expiresAt: new Date(), purpose: 'practice' });
    const oneMinute = { ...ENV, SPEAKING_COACH_DAILY_MINUTES_PER_TEACHER: '1', SPEAKING_COACH_MONTHLY_MINUTES_PER_TEACHER: '1' };
    await expect(prepare({ env: oneMinute })).rejects.toMatchObject({ statusCode: 429, code: 'COACH_MINUTES_UNAVAILABLE' });
    await expect(prepare({})).resolves.toBeTruthy();       // the default practice cap still has minutes
  });

  test('two uploads at the same moment: one attempt, the other refused', async () => {
    const s = await startedSession();
    const contexts = await Promise.all([1, 2].map(() => attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't1', actor: s.actor, requestId: rid(), env: ENV })));
    const results = await Promise.allSettled(contexts.map(context => attempts.commitAttempt({ context, upload: upload(), actor: s.actor })));
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(r => r.status === 'rejected').reason).toMatchObject({ statusCode: 409, code: 'COACH_ATTEMPT_IN_PROGRESS' });
    expect(await SpeakingPracticeAttempt.countDocuments()).toBe(1);
    expect(await AudioRecording.countDocuments({ purpose: 'practice' })).toBe(1);
    expect((await SpeakingPracticeSession.findById(s.session._id).lean()).attemptsUsed).toBe(1);
  });

  test('a guest attempt: the recording belongs to the teacher', async () => {
    const s = await startedSession({ mode: 'guest' });
    const attempt = await uploadAttempt(s);
    expect(String(attempt.guestSubmissionId)).toBe(String(s.submission._id));
    expect(String((await AudioRecording.findById(attempt.recordingId).lean()).owner)).toBe(String(f.teacher.user._id));
    await expect(attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't1', actor: f.student.user._id, requestId: rid(), env: ENV }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('the worker', () => {
  test('a transcribed practice recording is queued for its practice check, never for the graded assessment, and its audio is deleted', async () => {
    const s = await startedSession();
    const graded = await Submission.findById(s.submission._id).lean();
    const attempt = await uploadAttempt(s);
    const recordingBefore = await AudioRecording.findById(attempt.recordingId).lean();
    const file = await File.findById(recordingBefore.audioFileId).lean();
    const absolute = storage.resolveStoredAudioPath(file.path);
    expect(fs.existsSync(absolute)).toBe(true);
    await processing.processAudioRecording(attempt.recordingId, { transcribe: fakeTranscribe, env: ENV });
    const recording = await AudioRecording.findById(attempt.recordingId).select('+assessmentQueue +derived').lean();
    expect(recording.status).toBe('ready');
    expect(recording.assessmentQueue).toBeUndefined();
    expect(recording.audioDeletedAt).toBeInstanceOf(Date);
    expect(recording.audioDeletionReason).toBe('practice_transcribed');
    expect(recording.derived.assessorText).toBeTruthy();
    expect(await File.findById(file._id)).toBeNull();
    expect(fs.existsSync(absolute)).toBe(false);
    const queued = await SpeakingPracticeAttempt.findById(attempt._id).select('+assessmentQueue').lean();
    expect(queued).toMatchObject({ status: 'assessing', assessmentQueue: true });
    expect(await Submission.findById(s.submission._id).lean()).toEqual(graded);
    const ledger = await AudioUsageLedger.findOne({ recordingId: attempt.recordingId }).lean();
    expect(ledger).toMatchObject({ purpose: 'practice', state: 'consumed' });
  });

  test('the sweep checks due practice attempts (with the feature on)', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const out = await check.sweepPracticeChecks({ env: ENV, fetchImpl: h.fakeOpenRouter(checkOutput()) });
    expect(out).toMatchObject({ processed: 1 });
    expect((await SpeakingPracticeAttempt.findById(attempt._id).lean()).status).toBe('ready');
  });

  test('a transcription that fails for good: the attempt fails, the cap is given back, the audio is deleted', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    const failing = async () => { throw new SttError('AUDIO_STT_REJECTED', { retryable: false }); };
    await processing.processAudioRecording(attempt.recordingId, { transcribe: failing, env: ENV });
    await check.sweepPracticeChecks({ env: ENV, fetchImpl: h.fakeOpenRouter(checkOutput()) });
    expect(await SpeakingPracticeAttempt.findById(attempt._id).lean()).toMatchObject({ status: 'failed', errorCode: 'COACH_TRANSCRIPTION_FAILED' });
    const session = await SpeakingPracticeSession.findById(s.session._id).lean();
    expect(session).toMatchObject({ attemptsUsed: 0, activeAttemptId: null });
    expect(session.tasks[0].attemptCount).toBe(0);
    expect((await AudioRecording.findById(attempt.recordingId).lean()).audioDeletedAt).toBeInstanceOf(Date);
  });
});

describe('the check', () => {
  test('4-level rubric: Good passes; the task is passed and the next one opens', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const { attempt: a, session, fetchImpl } = await checked(attempt, checkOutput({ level: 'Good' }));
    expect(a).toMatchObject({ status: 'ready', result: { levelTitle: 'Good', levelPercent: 75, passed: true, onTask: true } });
    expect(a.result.feedback).toEqual({ improved: ['You joined your ideas more clearly this time.'], stillWeak: ['Add one more reason to support your main idea.'],
      nextTip: 'Next time, try to give an example for each idea.' });
    expect(session.tasks.map(t => t.status)).toEqual(['passed', 'active']);
    expect(session).toMatchObject({ currentTaskId: 't2', activeAttemptId: null, status: 'ready' });
    // The check read this attempt's answer and stored assessment data; never the graded answer.
    const sent = JSON.stringify(fetchImpl.bodies[0].messages);
    expect(sent).toContain('peaceful');
    expect(sent).not.toContain(TEXTS.WEAK);
  });

  test('4-level rubric: Developing does not pass; the task stays open', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const { attempt: a, session } = await checked(attempt, checkOutput({ level: 'Developing' }));
    expect(a.result).toMatchObject({ levelTitle: 'Developing', passed: false });
    expect(session.tasks.map(t => t.status)).toEqual(['active', 'locked']);
    expect(session.currentTaskId).toBe('t1');
  });

  test('off task: not passed even at a passing level', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const { attempt: a } = await checked(attempt, checkOutput({ level: 'Excellent', onTask: false }));
    expect(a.result).toMatchObject({ passed: false, onTask: false });
  });

  test.each([
    ['3 levels: the middle level passes (D3, second-highest rule)', [['Strong', 100], ['Fair', 66.67], ['Weak', 33.33]], 'Fair', true],
    ['3 levels: the lowest level does not pass', [['Strong', 100], ['Fair', 66.67], ['Weak', 33.33]], 'Weak', false],
    ['custom 5 levels: 80 passes', [['A', 100], ['B', 80], ['C', 60], ['D', 40], ['E', 20]], 'B', true],
    ['custom 5 levels: 60 does not pass', [['A', 100], ['B', 80], ['C', 60], ['D', 40], ['E', 20]], 'C', false]
  ])('%s', async (_label, levels, reached, passed) => {
    const s = await startedSession();
    await SpeakingPracticeSession.updateOne({ _id: s.session._id, 'sourceSnapshot.criteria.criterionId': 'speaking-grammar' },
      { $set: { 'sourceSnapshot.criteria.$.levels': levels.map(([title, percent]) => ({ title, percent, description: `${title} speaking.` })) } });
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const { attempt: a } = await checked(attempt, checkOutput({ level: reached, improved: ['You joined your ideas more clearly this time.'] }));
    expect(a.result.passed).toBe(passed);
  });

  test('a vocabulary swap passes only with the target words used', async () => {
    const s = await startedSession();
    await SpeakingPracticeSession.updateOne({ _id: s.session._id }, { $set: { 'tasks.0.status': 'passed', 'tasks.1.status': 'active', currentTaskId: 't2' } });
    const first = await uploadAttempt(s, 't2');
    await transcribed(first, 'My town is small. It has one school. I go to school by bus. People are friendly and kind to visitors in the town.');
    const without = await checked(first, checkOutput({ level: 'Good' }));
    expect(without.attempt.result).toMatchObject({ passed: false, vocab: { used: [], missing: ['on foot', 'peaceful'] } });
    const second = await uploadAttempt(s, 't2');
    await transcribed(second);
    const withWords = await checked(second, checkOutput({ level: 'Good' }));
    expect(withWords.attempt.result).toMatchObject({ passed: true, vocab: { used: ['on foot', 'peaceful'], missing: [] } });
  });

  test('compared with the previous attempt: fewer long pauses and fillers', async () => {
    const s = await startedSession();
    const first = await uploadAttempt(s);
    await transcribed(first, ATTEMPT_TEXT, { ...h.fluencyFor(ATTEMPT_TEXT), pausesOverThreshold: 4, fillersPer100Words: 9, longestPauseSeconds: 3.2 });
    await checked(first, checkOutput({ level: 'Developing' }));
    const second = await uploadAttempt(s);
    await transcribed(second, ATTEMPT_TEXT, { ...h.fluencyFor(ATTEMPT_TEXT), pausesOverThreshold: 1, fillersPer100Words: 3, longestPauseSeconds: 1.2 });
    const { attempt: a, fetchImpl } = await checked(second, checkOutput({ level: 'Developing' }));
    expect(a.result.fluencyChange).toEqual({ fewerLongPauses: true, fewerFillers: true, shorterLongestPause: true });
    const data = JSON.parse(fetchImpl.bodies[0].messages[1].content.replace(/^[^{]*/u, ''));
    expect(data.before).toMatchObject({ levelReached: 'Developing', fluency: { pausesOverOneSecond: 4 } });
    expect(data.now.fluency).toMatchObject({ pausesOverOneSecond: 1 });
  });

  test('every task passed: the session is completed and the teacher is notified once', async () => {
    const s = await startedSession();
    for (const taskId of ['t1', 't2']) {
      const attempt = await uploadAttempt(s, taskId);
      await transcribed(attempt);
      await checked(attempt, checkOutput({ level: 'Excellent' }));
    }
    const session = await SpeakingPracticeSession.findById(s.session._id).lean();
    expect(session).toMatchObject({ status: 'completed', endedReason: 'completed', currentTaskId: null });
    expect(session.completedAt).toBeInstanceOf(Date);
    const notes = await Notification.find({ recipient: f.teacher.user._id, type: 'adaptive_completed' }).lean();
    expect(notes).toHaveLength(1);
    expect(notes[0].title).toBe('Speaking practice completed');
    await expect(attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't2', actor: s.actor, requestId: rid(), env: ENV }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COACH_SESSION_NOT_OPEN' });
  });

  test('the attempt cap: the session ends as capped and no more uploads are taken', async () => {
    const s = await startedSession({ env: { ...ENV, SPEAKING_COACH_MAX_ATTEMPTS_PER_SUBMISSION: '2' } });
    for (let i = 0; i < 2; i++) {
      const attempt = await uploadAttempt(s);
      await transcribed(attempt);
      await checked(attempt, checkOutput({ level: 'Beginning' }));
    }
    expect(await SpeakingPracticeSession.findById(s.session._id).lean()).toMatchObject({ status: 'capped', endedReason: 'capped', attemptsUsed: 2 });
    await expect(attempts.prepareAttempt({ sessionId: s.session._id, taskId: 't1', actor: s.actor, requestId: rid(), env: ENV }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COACH_SESSION_NOT_OPEN' });
  });

  test('not enough speech: not assessable without an AI call; it counts toward the cap', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt, 'My town is small.');
    const { attempt: a, fetchImpl, session } = await checked(attempt);
    expect(a).toMatchObject({ status: 'not_assessable', notAssessableReason: 'not_enough_speech' });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(session).toMatchObject({ attemptsUsed: 1, activeAttemptId: null });
  });

  test('the model says not assessable (not English): not assessable', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const { attempt: a } = await checked(attempt, checkOutput({ assessable: false, reason: 'not_english' }));
    expect(a).toMatchObject({ status: 'not_assessable', notAssessableReason: 'not_english' });
  });

  test('a reply that breaks the rules (a level title, a score): retried once, then the attempt fails and is given back (not counted); checking it again counts it once', async () => {
    const s = await startedSession();
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    const bad = checkOutput({ improved: ['That was good work.'] });
    const first = await checked(attempt, bad);
    expect(first.out.status).toBe('queued');
    await SpeakingPracticeAttempt.updateOne({ _id: attempt._id }, { $set: { assessmentNextAttemptAt: new Date(Date.now() - 1000) } });
    const second = await checked(attempt, checkOutput({ improved: ['Your score went up.'] }));
    expect(second.attempt).toMatchObject({ status: 'failed', errorCode: 'COACH_CHECK_FAILED' });
    expect(second.session).toMatchObject({ attemptsUsed: 0, activeAttemptId: null });
    await attempts.retryCheck({ sessionId: s.session._id, attemptId: attempt._id, actor: s.actor });
    expect((await SpeakingPracticeSession.findById(s.session._id).lean()).attemptsUsed).toBe(1);
    const third = await checked(attempt, checkOutput({ level: 'Good' }));
    expect(third.attempt).toMatchObject({ status: 'ready', result: { passed: true } });
    await expect(attempts.retryCheck({ sessionId: s.session._id, attemptId: attempt._id, actor: s.actor }))
      .rejects.toMatchObject({ statusCode: 409, code: 'COACH_RETRY_NOT_ALLOWED' });
  });

  test('isolation: the graded result and credits are unchanged; logs carry no student text', async () => {
    const s = await startedSession();
    const metric = jest.spyOn(logger, 'metric'); const info = jest.spyOn(logger, 'info'); const warn = jest.spyOn(logger, 'warn');
    const before = { submission: await Submission.findById(s.submission._id).lean(), feedback: await SubmissionFeedback.findOne({ submissionId: s.submission._id }).lean(),
      wallet: await CreditWallet.findOne({ userId: f.teacher.user._id }).lean() };
    const attempt = await uploadAttempt(s);
    await transcribed(attempt);
    await checked(attempt);
    expect(await Submission.findById(s.submission._id).lean()).toEqual(before.submission);
    expect(await SubmissionFeedback.findOne({ submissionId: s.submission._id }).lean()).toEqual(before.feedback);
    expect(await CreditWallet.findOne({ userId: f.teacher.user._id }).lean()).toEqual(before.wallet);
    const logged = JSON.stringify([...metric.mock.calls, ...info.mock.calls, ...warn.mock.calls]);
    for (const piece of ['peaceful', 'on foot', 'joined your ideas', 'example for each idea']) expect(logged).not.toContain(piece);
    expect(logged).toContain('speaking_coach_attempt_checked');
  });
});
