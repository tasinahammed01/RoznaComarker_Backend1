'use strict';
// Speaking Coach requests through the REAL fetch (Node's), against a local stub OpenRouter on 127.0.0.1: no external network. The production
// paths (starting a session: the task wording; a practice check) build their requests exactly as in production, and the gateway sends them:
// the strict JSON schemas speaking_coach_tasks and speaking_coach_check are accepted and reach the provider as sent.
// And the trial's failure (AI_RESPONSE_INVALID, no HTTP status, 0 ms, nothing sent): Node's fetch refuses an Authorization header holding a
// character that is not allowed in a header (a line break, a zero-width space) before any byte leaves. The gateway now refuses such a key itself
// with its own code, naming the issue (never the key); and any error that is not the gateway's own carries its stage, name and cause code.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'speaking-coach-transport-test-secret';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-transport-${process.pid}`;
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// The real fetch, kept before the tripwire; it is only ever allowed to reach 127.0.0.1.
const nodeFetch = globalThis.fetch;
const localFetch = (url, init) => {
  if (new URL(String(url)).hostname !== '127.0.0.1') throw new Error('REAL_NETWORK_CALL_BLOCKED');
  return nodeFetch(url, init);
};
const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = nodeFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const storage = require('../src/services/audio/storage');
const processing = require('../src/services/audio/processing');
const assessment = require('../src/services/audio/speakingAssessment.service');
const deepgram = require('../src/services/audio/stt/deepgram');
const gateway = require('../src/services/aiGateway.service');
const logger = require('../src/utils/logger');
const prompt = require('../src/services/speakingCoach/prompt');
const checkPrompt = require('../src/services/speakingCoach/checkPrompt');
const coach = require('../src/services/speakingCoach/generation.service');
const attempts = require('../src/services/speakingCoach/attempt.service');
const check = require('../src/services/speakingCoach/assessment.service');

jest.setTimeout(90000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const KEY = 'sk-or-v1-test-placeholder-0000';
const GOOD = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Good']));
const CORRECTIONS = [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'It have', occurrence: 1, suggestedText: 'It has', message: 'Use has with it.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'by walk', occurrence: 1, suggestedText: 'on foot', message: 'We say on foot.' },
  { category: 'VOCABULARY', symbol: 'WC', quotedText: 'quiet', occurrence: 1, suggestedText: 'peaceful', message: 'A more exact word fits here.' }];
const ANSWER = 'My town is small and peaceful. It has one school and one shop. I go to school on foot every morning with my friend. '
  + 'There is a river near the park and people are friendly. I like my town because it is calm and green.';

const TRUNCATED = Symbol('truncated');
/** A local stub of OpenRouter's chat completions: records each request (headers and body) and answers with the next reply. */
let stub;
function startStub() {
  const state = { requests: [], replies: [] };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      state.requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
      const content = state.replies.length > 1 ? state.replies.shift() : state.replies[0];
      res.setHeader('content-type', 'application/json');
      // TRUNCATED: what Gemini returned in the trial when thinking used the output budget (finish_reason length, a cut-off reply).
      const truncated = content === TRUNCATED;
      res.end(JSON.stringify({ model: 'google/gemini-3.8-flash', choices: [{ message: { content: truncated ? '{"assessable":true,"notAss' : JSON.stringify(content) },
        finish_reason: truncated ? 'length' : 'stop' }], usage: { prompt_tokens: 1400, completion_tokens: truncated ? 1200 : 300, cost: 0.0011 } }));
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ ...state, state, server, base: `http://127.0.0.1:${server.address().port}` })));
}
const envFor = (key = KEY) => ({ ...h.TEST_ENV, OPENROUTER_API_KEY: key, OPENROUTER_BASE_URL: stub.base, ASSESSMENT_AI_MODEL: '', AUDIO_STT_ENABLED: 'true',
  SPEAKING_COACH_ENABLED: 'true' });

let f;
beforeAll(async () => { await connectInMemoryMongo(); stub = await startStub(); });
afterAll(async () => { await new Promise(resolve => stub.server.close(resolve)); await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  for (const model of [AudioRecording, AudioUsageLedger, SpeakingPracticeSession, SpeakingPracticeAttempt]) await model.createIndexes();
  stub.state.requests.length = 0; stub.state.replies.length = 0;
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => jest.restoreAllMocks());

async function assessedSubmission() {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60 });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text: TEXTS.WEAK, fillers: [] }, assessorText: TEXTS.WEAK, fluency: h.fluencyFor(TEXTS.WEAK) }, transcriptSchemaVersion: 'audio-transcript-v1', wordTimingsAvailable: true } });
  await assessment.enqueueAssessment(made.recording._id);
  await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV,
    fetchImpl: h.fakeOpenRouter(h.output({ levels: { ...GOOD, 'speaking-grammar': 'Developing', 'speaking-vocabulary': 'Developing' }, corrections: CORRECTIONS })) });
  return made;
}

describe('the production paths through the real fetch (local stub)', () => {
  test('starting a session: the task wording request reaches the provider with the strict speaking_coach_tasks schema, and its answer is used', async () => {
    const made = await assessedSubmission();
    stub.state.replies.push({ tasks: [{ taskId: 't1', prompt: 'Answer the task again and check each verb.', tip: 'Speak a little more slowly.' },
      { taskId: 't2', prompt: 'Answer again and use the new words.', tip: 'Plan where each word fits.' }] });
    const out = await coach.startSession(made.submission._id, f.student.user._id, { env: envFor(), fetchImpl: localFetch });
    const session = await SpeakingPracticeSession.findById(out.session._id).lean();
    expect(session.generation).toMatchObject({ source: 'ai' });
    expect(session.generation.errorCode).toBeUndefined();
    expect(stub.state.requests).toHaveLength(1);
    const sent = stub.state.requests[0];
    expect(sent.url).toBe('/chat/completions');
    expect(sent.authorization).toBe(`Bearer ${KEY}`);
    expect(sent.body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'speaking_coach_tasks', strict: true,
      schema: prompt.generationSchema(['t1', 't2']) } });
    // Room for thinking, and less of it: the trial truncated at 1200 with the model's default thinking.
    expect(sent.body).toMatchObject({ max_tokens: 2500, reasoning: { effort: 'low' }, provider: { require_parameters: true } });
  });

  test('a practice check: the request reaches the provider with the strict speaking_coach_check schema, and the attempt is checked', async () => {
    const made = await assessedSubmission();
    stub.state.replies.push({ tasks: [{ taskId: 't1', prompt: 'Answer the task again and check each verb.', tip: 'Speak a little more slowly.' },
      { taskId: 't2', prompt: 'Answer again and use the new words.', tip: 'Plan where each word fits.' }] });
    const { session } = await coach.startSession(made.submission._id, f.student.user._id, { env: envFor(), fetchImpl: localFetch });
    fs.mkdirSync(storage.audioRoot(), { recursive: true });
    const filename = `${crypto.randomUUID()}.wav`;
    const bytes = samples.wav(20);
    fs.writeFileSync(path.join(storage.audioRoot(), filename), bytes);
    const context = await attempts.prepareAttempt({ sessionId: session._id, taskId: 't1', actor: f.student.user._id, requestId: `req-${crypto.randomUUID()}`, env: envFor() });
    const attempt = await attempts.commitAttempt({ context, actor: f.student.user._id, upload: { filename, storedPath: storage.storedPathFor(filename), extension: '.wav',
      contentType: 'audio/wav', sizeBytes: bytes.length, durationSeconds: 20, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), commit() {} } });
    await processing.processAudioRecording(attempt.recordingId, { transcribe: async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false }), env: envFor() });
    await AudioRecording.collection.updateOne({ _id: attempt.recordingId }, { $set: { 'derived.assessorText': ANSWER, 'derived.fluency': h.fluencyFor(ANSWER) } });
    stub.state.requests.length = 0;
    stub.state.replies.length = 0;
    stub.state.replies.push({ assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: ['You checked your verbs more carefully.'],
      stillWeak: [], nextTip: 'Give one example for each idea.' });
    const out = await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    expect(out.status).toBe('ready');
    expect(stub.state.requests).toHaveLength(1);
    const levels = (await SpeakingPracticeSession.findById(session._id).lean()).sourceSnapshot.criteria.find(c => c.criterionId === 'speaking-grammar').levels.map(l => l.title);
    expect(stub.state.requests[0].body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'speaking_coach_check', strict: true,
      schema: checkPrompt.checkSchema(levels) } });
    expect(stub.state.requests[0].body).toMatchObject({ max_tokens: 3000, reasoning: { effort: 'low' }, provider: { require_parameters: true } });
  });
});

describe('a reply cut off by the output limit (the second trial: AI_RESPONSE_TRUNCATED, finish reason length)', () => {
  const CHECKED = { assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: ['You checked your verbs more carefully.'],
    stillWeak: [], nextTip: 'Give one example for each idea.' };
  const WORDING = { tasks: [{ taskId: 't1', prompt: 'Answer the task again and check each verb.', tip: 'Speak a little more slowly.' },
    { taskId: 't2', prompt: 'Answer again and use the new words.', tip: 'Plan where each word fits.' }] };
  /** A started session and one transcribed attempt waiting for its check. */
  async function waitingAttempt(env = envFor()) {
    const made = await assessedSubmission();
    stub.state.replies.push(WORDING);
    const { session } = await coach.startSession(made.submission._id, f.student.user._id, { env, fetchImpl: localFetch });
    fs.mkdirSync(storage.audioRoot(), { recursive: true });
    const filename = `${crypto.randomUUID()}.wav`;
    const bytes = samples.wav(20);
    fs.writeFileSync(path.join(storage.audioRoot(), filename), bytes);
    const context = await attempts.prepareAttempt({ sessionId: session._id, taskId: 't1', actor: f.student.user._id, requestId: `req-${crypto.randomUUID()}`, env });
    const attempt = await attempts.commitAttempt({ context, actor: f.student.user._id, upload: { filename, storedPath: storage.storedPathFor(filename), extension: '.wav',
      contentType: 'audio/wav', sizeBytes: bytes.length, durationSeconds: 20, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), commit() {} } });
    await processing.processAudioRecording(attempt.recordingId, { transcribe: async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false }), env });
    await AudioRecording.collection.updateOne({ _id: attempt.recordingId }, { $set: { 'derived.assessorText': ANSWER, 'derived.fluency': h.fluencyFor(ANSWER) } });
    stub.state.requests.length = 0; stub.state.replies.length = 0;
    return { session, attempt };
  }
  const limits = () => stub.state.requests.map(r => r.body.max_tokens);

  test('a check cut off once: retried once with twice the limit, and checked', async () => {
    const { session, attempt } = await waitingAttempt();
    stub.state.replies.push(TRUNCATED, CHECKED);
    const metric = jest.spyOn(logger, 'metric');
    const out = await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    expect(out.status).toBe('ready');
    expect(limits()).toEqual([3000, 6000]);
    expect(await SpeakingPracticeSession.findById(session._id).lean()).toMatchObject({ attemptsUsed: 1 });
    const retried = metric.mock.calls.map(([entry]) => entry).find(entry => entry?.event === 'speaking_coach_truncation_retry');
    expect(retried).toEqual({ event: 'speaking_coach_truncation_retry', feature: 'speaking_coach_check', maxOutputTokens: 3000, retryMaxOutputTokens: 6000 });
  });

  test('cut off again after the retry: the check fails clearly, the attempt is given back (not counted), and the student sees "try again"', async () => {
    const { session, attempt } = await waitingAttempt();
    stub.state.replies.push(TRUNCATED);
    const first = await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    expect(first).toMatchObject({ status: 'queued', code: 'AI_RESPONSE_TRUNCATED' });
    await SpeakingPracticeAttempt.updateOne({ _id: attempt._id }, { $set: { assessmentNextAttemptAt: new Date(Date.now() - 1000) } });
    const second = await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    expect(second).toMatchObject({ status: 'failed', code: 'AI_RESPONSE_TRUNCATED' });
    // Two check runs, each one call and one retry with the larger limit; never a third call per run.
    expect(limits()).toEqual([3000, 6000, 3000, 6000]);
    expect(await SpeakingPracticeAttempt.findById(attempt._id).lean()).toMatchObject({ status: 'failed', errorCode: 'COACH_CHECK_FAILED' });
    const refunded = await SpeakingPracticeSession.findById(session._id).lean();
    expect(refunded).toMatchObject({ attemptsUsed: 0, activeAttemptId: null });
    expect(refunded.tasks[0].attemptCount).toBe(0);
    const views = require('../src/services/speakingCoach/views');
    const failed = await SpeakingPracticeAttempt.findById(attempt._id).lean();
    const view = views.studentAttempt(failed, await SpeakingPracticeSession.findById(session._id).lean(), failed._id);
    expect(view).toMatchObject({ state: 'failed', failure: 'check', nextStep: 'try_again', canRetry: true });
    // Checking it again takes the attempt back (it counts once it has a result).
    await attempts.retryCheck({ sessionId: session._id, attemptId: attempt._id, actor: f.student.user._id });
    expect(await SpeakingPracticeSession.findById(session._id).lean()).toMatchObject({ attemptsUsed: 1 });
  });

  test('other failures are not retried with a larger limit', async () => {
    const { attempt } = await waitingAttempt();
    stub.state.replies.push({ assessable: true });          // a reply that fails validation: the gateway's own single retry only
    await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    expect(limits()).toEqual([3000, 3000]);
  });

  test('the task wording cut off once: retried with twice the limit and used; cut off twice: the templates, with the code kept', async () => {
    const made = await assessedSubmission();
    stub.state.replies.push(TRUNCATED, WORDING);
    const out = await coach.startSession(made.submission._id, f.student.user._id, { env: envFor(), fetchImpl: localFetch });
    expect(limits()).toEqual([2500, 5000]);
    expect((await SpeakingPracticeSession.findById(out.session._id).lean()).generation.source).toBe('ai');
    await SpeakingPracticeSession.deleteMany({});
    stub.state.requests.length = 0; stub.state.replies.length = 0;
    stub.state.replies.push(TRUNCATED);
    const again = await coach.startSession(made.submission._id, f.student.user._id, { env: envFor(), fetchImpl: localFetch });
    expect(limits()).toEqual([2500, 5000]);
    expect((await SpeakingPracticeSession.findById(again.session._id).lean()).generation).toMatchObject({ source: 'template', errorCode: 'AI_RESPONSE_TRUNCATED' });
  });

  test('the limits and the reasoning effort follow the settings', async () => {
    const env = { ...envFor(), SPEAKING_COACH_CHECK_MAX_OUTPUT_TOKENS: '4000', SPEAKING_COACH_TASKS_MAX_OUTPUT_TOKENS: '3500', SPEAKING_COACH_REASONING_EFFORT: 'medium' };
    const { attempt } = await waitingAttempt(env);
    stub.state.replies.push(TRUNCATED, CHECKED);
    await check.runPracticeCheck(attempt._id, { env, fetchImpl: localFetch });
    expect(limits()).toEqual([4000, 8000]);
    expect(stub.state.requests.every(r => r.body.reasoning?.effort === 'medium')).toBe(true);
  });

  test('logs carry codes and numbers only (never the cut-off text)', async () => {
    const { attempt } = await waitingAttempt();
    const spies = ['metric', 'info', 'warn'].map(level => jest.spyOn(logger, level));
    stub.state.replies.push(TRUNCATED, CHECKED);
    await check.runPracticeCheck(attempt._id, { env: envFor(), fetchImpl: localFetch });
    const logged = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
    for (const text of ['notAss', 'checked your verbs', ANSWER.slice(0, 25), KEY]) expect(logged).not.toContain(text);
  });
});

describe('a key that cannot be sent as a header (the trial failure)', () => {
  const request = () => ({ feature: checkPrompt.CHECK_FEATURE, messages: checkPrompt.checkMessages({ answer: 'synthetic' }), responseFormat: 'json',
    responseSchema: checkPrompt.checkSchema(['Excellent', 'Good', 'Developing', 'Beginning']), schemaName: checkPrompt.CHECK_FEATURE, maxOutputTokens: 1200 });
  const noRetry = env => ({ ...gateway.getAssessmentAIConfig(env), primaryRetries: 0, fallbackRetries: 0, retriesPerModel: 0 });

  test.each([
    ['an inner line break', 'sk-or-v1-test\nplaceholder'],
    ['a zero-width space', 'sk-or-v1-test​placeholder'],
    ['a non-breaking space', 'sk-or-v1-test placeholder'],
    ['a tab', 'sk-or-v1-test\tplaceholder']
  ])('%s: refused before sending with AI_PROVIDER_CREDENTIAL_INVALID naming the issue; the key is never logged or kept', async (_label, key) => {
    const warn = jest.spyOn(logger, 'warn');
    const env = envFor(key);
    const error = await gateway.generate({ ...request(), env, fetchImpl: localFetch, config: noRetry(env) }).catch(e => e);
    expect(stub.state.requests).toHaveLength(0);
    const attempt = error.attempts.at(-1);
    expect(attempt).toMatchObject({ code: 'AI_PROVIDER_CREDENTIAL_INVALID', httpStatus: null, credentialIssue: 'non_printable_characters' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('AI_PROVIDER_CREDENTIAL_INVALID');
    expect(logged).toContain('non_printable_characters');
    for (const secret of [key, 'placeholder', 'sk-or-v1']) {
      expect(logged).not.toContain(secret);
      expect(JSON.stringify(error.attempts)).not.toContain(secret);
    }
  });

  test('a plain key is sent as before (the stub answers)', async () => {
    stub.state.replies.push({ assessable: true, notAssessableReason: 'none', onTask: true, level: 'Good', improved: [], stillWeak: [], nextTip: 'Speak a little more slowly.' });
    const env = envFor();
    const out = await gateway.generate({ ...request(), env, fetchImpl: localFetch, config: noRetry(env) });
    expect(out.attemptCount).toBe(1);
    expect(stub.state.requests).toHaveLength(1);
  });

  test('any other error that is not the gateway\'s own: the server log names its stage, name and cause code; the public error does not', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const env = envFor();
    const failing = async () => { throw Object.assign(new TypeError('fetch failed: secret detail'), { cause: Object.assign(new Error('x'), { code: 'ENOTFOUND' }) }); };
    const error = await gateway.generate({ ...request(), env, fetchImpl: failing, config: noRetry(env) }).catch(e => e);
    expect(error.attempts.at(-1)).toMatchObject({ code: 'AI_RESPONSE_INVALID', httpStatus: null });
    // Transport details stay private (tests/aiRequestDiagnostics.test.js): not on the error or its attempts.
    expect(JSON.stringify(error)).not.toMatch(/TRANSPORT_FAILURE|ENOTFOUND|TypeError/);
    const failedLog = warn.mock.calls.map(([entry]) => entry).find(entry => entry?.message === 'AI gateway attempt failed');
    expect(failedLog).toMatchObject({ code: 'AI_RESPONSE_INVALID', failureStage: 'TRANSPORT_FAILURE', errorName: 'TypeError', causeCode: 'ENOTFOUND' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret detail');
    // A caller that makes the code terminal gets the original error back: the details stay off it too.
    const original = await gateway.generate({ ...request(), env, fetchImpl: failing, config: noRetry(env), terminalCodes: ['AI_RESPONSE_INVALID'] }).catch(e => e);
    expect(original).toBeInstanceOf(TypeError);
    expect(JSON.stringify(original)).not.toMatch(/TRANSPORT_FAILURE|gatewayDiagnostics/);
    expect(Object.keys(original)).not.toContain('gatewayDiagnostics');
  });
});
