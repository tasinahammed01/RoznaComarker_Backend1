'use strict';
// Audio + speech-to-text, stage 12: the OpenRouter ElevenLabs Scribe v2 adapter (services/audio/stt/openrouterScribe.js), chosen only with
// AUDIO_STT_PROVIDER=openrouter-scribe. Real (redacted) responses from tests/fixtures/audio/openrouter-scribe; every provider call goes to an
// injected fake fetch, and a tripwire blocks the real network.
process.env.NODE_ENV = 'test';
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const os = require('os');
const path = require('path');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => {
  globalThis.fetch = jest.fn(async () => realNetwork());
  jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(realNetwork);
  jest.spyOn(tls, 'connect').mockImplementation(realNetwork);
});
afterAll(() => { globalThis.fetch = originalFetch; jest.restoreAllMocks(); });
afterEach(() => { expect(realNetwork).not.toHaveBeenCalled(); realNetwork.mockClear(); });

const stt = require('../src/services/audio/stt');
const scribe = require('../src/services/audio/stt/openrouterScribe');
const transcript = require('../src/services/audio/stt/transcript');
const policy = require('../src/services/audio/policy');
const logger = require('../src/utils/logger');
const A = require('./fixtures/audio/openrouter-scribe/speaking-a-real-45s.cjs');
const B = require('./fixtures/audio/openrouter-scribe/speaking-b-real-142s.cjs');
const ERRORS = require('./fixtures/audio/openrouter-scribe/errors.cjs');

const KEY = 'sk-or-test-key-not-real-789';
const ENV = { AUDIO_STT_PROVIDER: 'openrouter-scribe', OPENROUTER_API_KEY: KEY };   // no DEEPGRAM_API_KEY on purpose
const SECRET_NAME = 'amina-private-recording-name.m4a';
let tmpDir, audioPath;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-scribe-test-'));
  audioPath = path.join(tmpDir, SECRET_NAME);
  fs.writeFileSync(audioPath, Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A ', 'latin1'), Buffer.alloc(4096, 3)]));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeFetch(handler) {
  const calls = [];
  const fn = jest.fn(async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); });
  fn.calls = calls;
  return fn;
}
const okWith = (body, headers = { 'x-generation-id': 'gen-stt-test-0001' }) => fakeFetch(() => jsonResponse(200, body, headers));
const run = ({ env = {}, ...rest } = {}) => stt.transcribe({ filePath: audioPath, contentType: 'audio/mp4', env: { ...ENV, ...env }, expectedDurationSeconds: A.duration, ...rest });

describe('provider choice and keys', () => {
  test('policy accepts AUDIO_STT_PROVIDER=openrouter-scribe (any case); the default stays deepgram', () => {
    expect(policy.PROVIDERS).toContain('openrouter-scribe');
    expect(policy.readLimits({ AUDIO_STT_PROVIDER: 'OpenRouter-Scribe' })).toMatchObject({ limits: { sttProvider: 'openrouter-scribe' }, issues: [] });
    expect(policy.readLimits({}).limits.sttProvider).toBe('deepgram');
  });

  test('works without a Deepgram key: one request to OpenRouter, none to Deepgram', async () => {
    const fetchImpl = okWith(A);
    const out = await run({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.calls[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
    expect(out.attempts).toEqual([{ provider: 'openrouter-scribe', outcome: 'ok', code: null }]);
    expect(out.transcript.provider).toBe('openrouter-scribe');
  });

  test('a missing OpenRouter key fails before any request, naming the variable only', async () => {
    const fetchImpl = okWith(A);
    const error = await stt.transcribe({ filePath: audioPath, contentType: 'audio/mp4', env: { AUDIO_STT_PROVIDER: 'openrouter-scribe' }, fetchImpl }).catch(e => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_NOT_CONFIGURED', retryable: false, provider: 'openrouter-scribe' });
    expect(error.message).toContain('OPENROUTER_API_KEY');
  });

  test('the OpenAI fallback cannot be switched on behind Scribe (it exists only behind Deepgram)', () => {
    const { limits, issues } = policy.readLimits({ AUDIO_STT_PROVIDER: 'openrouter-scribe', AUDIO_STT_FALLBACK_ENABLED: 'true' });
    expect(limits).toMatchObject({ sttFallbackEnabled: false, sttFallbackProvider: null });
    expect(issues).toEqual(['AUDIO_STT_FALLBACK_ENABLED']);
  });
});

describe('the request', () => {
  test('multipart: model, file without its real name, verbose_json, word and segment timings, English, zero data retention, no fallbacks', async () => {
    const fetchImpl = okWith(A);
    await run({ fetchImpl });
    const { init } = fetchImpl.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe('elevenlabs/scribe-v2');
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('file').name).toBe('audio.m4a');
    expect(init.body.get('response_format')).toBe('verbose_json');
    expect(init.body.getAll('timestamp_granularities[]')).toEqual(['word', 'segment']);
    expect(init.body.get('language')).toBe('en');
    expect(JSON.parse(init.body.get('provider'))).toEqual({ zdr: true, allow_fallbacks: false });
    expect([...init.body.keys()].sort()).toEqual(['file', 'language', 'model', 'provider', 'response_format', 'timestamp_granularities[]', 'timestamp_granularities[]'].sort());
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('AUDIO_STT_OPENROUTER_MODEL picks another model; an invalid value falls back to elevenlabs/scribe-v2', () => {
    expect(scribe.modelFor({ AUDIO_STT_OPENROUTER_MODEL: 'elevenlabs/scribe-v2-medical' })).toBe('elevenlabs/scribe-v2-medical');
    for (const bad of ['', 'scribe', 'https://evil.example/x', 'a/b c', '../x/y', 'x'.repeat(130) + '/y']) {
      expect(scribe.modelFor({ AUDIO_STT_OPENROUTER_MODEL: bad })).toBe('elevenlabs/scribe-v2');
    }
  });

  test('the endpoint is fixed (an OPENROUTER_BASE_URL meant for other features never redirects audio)', async () => {
    const fetchImpl = okWith(A);
    await run({ fetchImpl, env: { OPENROUTER_BASE_URL: 'https://proxy.example/api/v1' } });
    expect(fetchImpl.calls[0].url).toBe('https://openrouter.ai/api/v1/audio/transcriptions');
  });
});

describe('file size: the upload limit is min(AUDIO_MAX_FILE_BYTES, provider cap 20 MB) for this provider', () => {
  test('defaults: 20 MB cap with Scribe, unchanged 40 MB with Deepgram', () => {
    expect(scribe.DEFAULT_MAX_BYTES).toBe(20 * 1024 * 1024);
    expect(policy.readLimits({ AUDIO_STT_PROVIDER: 'openrouter-scribe' }).limits.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(policy.readLimits({}).limits.maxFileBytes).toBe(41943040);
  });

  test('AUDIO_STT_OPENROUTER_MAX_FILE_BYTES lowers it; AUDIO_MAX_FILE_BYTES still wins when smaller; out of range is ignored by name', () => {
    expect(policy.readLimits({ AUDIO_STT_PROVIDER: 'openrouter-scribe', AUDIO_STT_OPENROUTER_MAX_FILE_BYTES: String(5 * 1024 * 1024) }).limits.maxFileBytes).toBe(5 * 1024 * 1024);
    expect(policy.readLimits({ AUDIO_STT_PROVIDER: 'openrouter-scribe', AUDIO_MAX_FILE_BYTES: String(2 * 1024 * 1024) }).limits.maxFileBytes).toBe(2 * 1024 * 1024);
    const over = policy.readLimits({ AUDIO_STT_PROVIDER: 'openrouter-scribe', AUDIO_STT_OPENROUTER_MAX_FILE_BYTES: String(30 * 1024 * 1024) });
    expect(over.limits.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(over.issues).toEqual(['AUDIO_STT_OPENROUTER_MAX_FILE_BYTES']);
    // With Deepgram the OpenRouter cap does not apply.
    expect(policy.readLimits({ AUDIO_STT_OPENROUTER_MAX_FILE_BYTES: String(5 * 1024 * 1024) }).limits.maxFileBytes).toBe(41943040);
  });

  test('the signed-in client sees the capped limit and never a provider name', () => {
    const shown = policy.publicConfig({ AUDIO_STT_ENABLED: 'true', AUDIO_STT_PROVIDER: 'openrouter-scribe', OPENROUTER_API_KEY: KEY }, { role: 'teacher' });
    expect(shown.maxFileBytes).toBe(20 * 1024 * 1024);
    expect(JSON.stringify(shown).toLowerCase()).not.toMatch(/openrouter|scribe|elevenlabs|deepgram|sk-or/);
  });

  test('over the cap at request time: refused before sending, permanent, the friendly size code', async () => {
    const fetchImpl = okWith(A);
    const error = await scribe.transcribe({ audio: { size: 20 * 1024 * 1024 + 1 }, contentType: 'audio/wav', env: ENV, fetchImpl, signal: new AbortController().signal, timeoutMs: 1000 })
      .catch(e => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', retryable: false });
  });

  test('the provider\'s own 400 "exceeds the 25 MB multipart upload limit" maps to the same code (permanent)', async () => {
    const error = await run({ fetchImpl: fakeFetch(() => jsonResponse(400, ERRORS.tooLarge400)) }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', retryable: false, httpStatus: 400 });
  });
});

describe('normalisation into the stored schema (real response, speaking-A)', () => {
  let out;
  beforeAll(async () => { out = (await run({ fetchImpl: okWith(A) })).transcript; });

  test('top-level fields: provider, model, request id from the generation header, English, duration, word timings on', () => {
    expect(out).toMatchObject({ transcriptSchemaVersion: 'audio-transcript-v1', provider: 'openrouter-scribe', model: 'elevenlabs/scribe-v2',
      providerModelVersion: null, providerRequestId: 'gen-stt-test-0001', language: 'en', durationSeconds: 44.617125, wordTimingsAvailable: true,
      speakingCoachDataAvailable: true });
    expect(out.languageConfidence).toBeGreaterThan(0.9);
    expect(out.words).toHaveLength(132);
  });

  test('each token splits into plain text (lower case, no surrounding punctuation) and the punctuated form; confidence kept', () => {
    expect(out.words[0]).toEqual({ index: 0, text: 'um', punctuated: 'Um,', start: 0.12, end: 0.24, confidence: A.words[0].confidence, isFiller: true });
    const village = out.words.find(w => w.punctuated === 'village.');
    expect(village).toMatchObject({ text: 'village', isFiller: false });
    expect(out.words.find(w => w.punctuated === "grandmother's").text).toBe("grandmother's");
    expect(out.words.every(w => w.confidence >= 0 && w.confidence <= 1)).toBe(true);
    expect(out.rawText.startsWith('Um, my favorite place in the world')).toBe(true);
  });

  test('all 12 spoken fillers are recognised (um and uh)', () => {
    expect(out.words.filter(w => w.isFiller).map(w => w.text)).toEqual(['um', 'uh', 'um', 'uh', 'um', 'uh', 'um', 'uh', 'um', 'uh', 'um', 'uh']);
  });

  test('utterances are derived from sentence ends and gaps of 1 s or more (Scribe returns one segment)', () => {
    expect(A.segments).toHaveLength(1);
    expect(out.utterances).toHaveLength(11);
    expect(out.utterances[0]).toEqual({ index: 0, start: 0.12, end: out.words[10].end, confidence: expect.any(Number), wordStartIndex: 0, wordEndIndex: 10,
      text: "Um, my favorite place in the world is my grandmother's village." });
    for (let i = 0; i < out.utterances.length; i++) {
      const u = out.utterances[i];
      expect(u.index).toBe(i);
      expect(u.text).toBe(out.words.slice(u.wordStartIndex, u.wordEndIndex + 1).map(w => w.punctuated).join(' '));
      if (i > 0) expect(u.wordStartIndex).toBe(out.utterances[i - 1].wordEndIndex + 1);
    }
    expect(out.utterances[out.utterances.length - 1].wordEndIndex).toBe(out.words.length - 1);
  });

  test('speaking-B: 23 utterances, a gap of 1 s splits even without a full stop', async () => {
    const b = (await run({ fetchImpl: okWith(B), expectedDurationSeconds: B.duration })).transcript;
    expect(b.utterances).toHaveLength(23);
    expect(b.utterances.some(u => !/[.!?]$/.test(u.text) && b.words[u.wordEndIndex + 1] && b.words[u.wordEndIndex + 1].start - b.words[u.wordEndIndex].end >= 1)).toBe(true);
  });

  test('the raw transcript is deeply immutable and passes the derived-text and metrics functions', () => {
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out.words[0])).toBe(true);
    expect(Object.isFrozen(out.utterances[0])).toBe(true);
    const texts = transcript.deriveTexts(out);
    expect(texts.assessorText.startsWith('My favorite place in the world')).toBe(true);
    expect(texts.displayText.fillers).toHaveLength(12);
    expect(transcript.fluencyMetrics(out)).toMatchObject({ available: true, totalWords: 132, fillerCount: 12, spokenWords: 120 });
  });
});

describe('normalisation edge cases (synthetic bodies)', () => {
  const body = (words, extra = {}) => ({ text: words.map(w => w.word).join(' '), language: 'eng', language_confidence: 0.99, duration: 10, segments: [{ id: 0, start: 0, end: 10, text: '' }],
    words, usage: { seconds: 10, cost: 0.0006 }, ...extra });
  const w = (word, start, end, confidence = 0.9, extra = {}) => ({ word, start, end, confidence, ...extra });

  test('times are clamped to [0, duration]; punctuation-only tokens and audio events are skipped', () => {
    const out = scribe.normalize(body([w('(laughs)', 0, 0.5, 0.9, { type: 'audio_event' }), w('Hello', -0.05, 0.4), w('—', 0.4, 0.45), w('world.', 9.8, 10.4)]),
      { model: 'elevenlabs/scribe-v2' });
    expect(out.words.map(x => [x.text, x.punctuated, x.start, x.end])).toEqual([['hello', 'Hello', 0, 0.4], ['world', 'world.', 9.8, 10]]);
    expect(out.words.map(x => x.index)).toEqual([0, 1]);
  });

  test('a word without a valid confidence is an unreadable answer (retryable), not a crash', () => {
    expect(() => scribe.normalize(body([w('Hello', 0, 0.4, undefined)]), { model: 'm' })).toThrow(expect.objectContaining({ code: 'AUDIO_STT_BAD_RESPONSE' }));
    expect(() => scribe.normalize({ text: 'x' }, { model: 'm' })).toThrow(expect.objectContaining({ code: 'AUDIO_STT_BAD_RESPONSE' }));
  });

  test('no speech: an empty, valid transcript', () => {
    const out = scribe.normalize(body([], { text: '' }), { model: 'elevenlabs/scribe-v2' });
    expect(out).toMatchObject({ words: [], utterances: [], wordTimingsAvailable: true, rawText: '' });
  });

  test('the two-letter language code is stored (eng -> en)', () => {
    expect(scribe.normalize(body([w('Hello.', 0, 0.4)]), { model: 'm' }).language).toBe('en');
  });
});

describe('fillers (one set, used by the fluency metrics)', () => {
  test('mm, hmm, mhm, er, erm, uh and um are fillers, whatever the punctuation or capitals; real words are not', () => {
    for (const filler of ['mm', 'hmm', 'mhm', 'er', 'erm', 'uh', 'um']) expect(transcript.FILLERS.has(filler)).toBe(true);
    const make = (token, index) => scribe.normalize({ text: token, language: 'eng', duration: 5, words: [{ word: token, start: 0, end: 0.3, confidence: 0.9 }] }, { model: 'm' }).words[0];
    for (const token of ['Um,', 'mm,', 'Hmm.', 'Er,', 'erm', 'Mhm.', 'uh']) expect(make(token).isFiller).toBe(true);
    for (const token of ['umbrella', 'Mmm-hmm-no', 'error', 'her', 'summer,']) expect(make(token).isFiller).toBe(false);
  });

  test('the metrics and derived-text versions are bumped (filler set changed); a stored v1 result is left as it is', () => {
    expect(transcript.FLUENCY_METRICS_VERSION).toBe('audio-fluency-v2');
    expect(transcript.DERIVED_TEXT_VERSION).toBe('audio-derived-text-v2');
    expect(transcript.fluencyMetrics({ wordTimingsAvailable: false, words: [] }).metricsVersion).toBe('audio-fluency-v2');
  });
});

describe('error mapping', () => {
  const statusOf = (status, body = {}, headers = {}) => run({ fetchImpl: fakeFetch(() => jsonResponse(status, body, headers)) }).catch(e => e);

  test('400 bad audio: the existing permanent refusal', async () => {
    expect(await statusOf(400, ERRORS.badAudio400)).toMatchObject({ code: 'AUDIO_STT_REJECTED', retryable: false, httpStatus: 400 });
  });

  test('402 (credits / in-flight budget): an operational, retryable error; Retry-After honoured; an ops warning is logged', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const error = await statusOf(402, ERRORS.inFlightBudget402, { 'retry-after': '120' });
      expect(error).toMatchObject({ code: 'AUDIO_STT_PROVIDER_CREDITS', retryable: true, retryAfterMs: 120000, httpStatus: 402 });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'audio_stt_provider_credits', provider: 'openrouter-scribe', retryAfterMs: 120000 }));
    } finally { warn.mockRestore(); }
  });

  test('404 at data-policy filtering (no zero-retention endpoint): a configuration error, not the student\'s', async () => {
    expect(await statusOf(404, ERRORS.dataPolicy404)).toMatchObject({ code: 'AUDIO_STT_NOT_CONFIGURED', retryable: false, httpStatus: 404 });
  });

  test('401 (bad key): a configuration error', async () => {
    expect(await statusOf(401, { error: { code: 401, message: 'No auth credentials found' } })).toMatchObject({ code: 'AUDIO_STT_NOT_CONFIGURED', retryable: false });
  });

  test.each([[408, 'AUDIO_STT_TIMEOUT'], [429, 'AUDIO_STT_RATE_LIMITED'], [500, 'AUDIO_STT_PROVIDER_ERROR'], [502, 'AUDIO_STT_PROVIDER_ERROR'],
    [503, 'AUDIO_STT_PROVIDER_ERROR'], [504, 'AUDIO_STT_PROVIDER_ERROR'], [524, 'AUDIO_STT_PROVIDER_ERROR'], [529, 'AUDIO_STT_PROVIDER_ERROR']])('%i is retryable (%s)', async (status, code) => {
    expect(await statusOf(status, ERRORS.rateLimited429, { 'retry-after': '30' })).toMatchObject({ code, retryable: true, httpStatus: status });
  });

  test('a 429 Retry-After is a capped hint', async () => {
    expect((await statusOf(429, ERRORS.rateLimited429, { 'retry-after': '30' })).retryAfterMs).toBe(30000);
  });

  test('an unreadable 200 body is AUDIO_STT_BAD_RESPONSE (retryable)', async () => {
    const error = await run({ fetchImpl: fakeFetch(() => new Response('<html>oops</html>', { status: 200 })) }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_STT_BAD_RESPONSE', retryable: true });
  });

  test('a provider that never answers times out (AUDIO_STT_TIMEOUT_MS behaviour kept)', async () => {
    const fetchImpl = fakeFetch((url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const error = await run({ fetchImpl, timeoutMs: 30 }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_STT_TIMEOUT', retryable: true });
  });
});

describe('logs', () => {
  test('never transcript text, the file name, the path or the key; the provider usage (seconds, cost) is recorded as a metric', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(level => jest.spyOn(console, level).mockImplementation((...args) => lines.push(args.join(' '))));
    try {
      await run({ fetchImpl: okWith(A) });
      await run({ fetchImpl: fakeFetch(() => jsonResponse(400, ERRORS.badAudio400)) }).catch(() => {});
      await run({ fetchImpl: fakeFetch(() => jsonResponse(402, ERRORS.inFlightBudget402, { 'retry-after': '120' })) }).catch(() => {});
    } finally { spies.forEach(spy => spy.mockRestore()); }
    const text = lines.join('\n');
    for (const forbidden of ['grandmother', 'village', 'Um,', SECRET_NAME, 'amina', tmpDir, KEY, 'Bearer ', 'malformed', 'in-flight']) {
      expect({ forbidden, found: text.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
    expect(text).toContain('audio_stt_attempt');
    expect(text).toContain('audio_stt_provider_usage');
    expect(text).toContain('0.0027266');
  });
});
