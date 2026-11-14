'use strict';
// Audio + speech-to-text, stage 1: the provider adapter (services/audio/stt). Fixtures only: every provider call goes to an injected fake fetch.
// A tripwire replaces the global fetch and blocks raw sockets, so any real network call fails the test (and one test proves the default client
// IS that global fetch, so production uses the same path the tripwire guards).
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
let expectNetworkTripwire = false;
afterEach(() => {
  if (!expectNetworkTripwire) expect(realNetwork).not.toHaveBeenCalled();
  expectNetworkTripwire = false;
  realNetwork.mockClear();
});

const stt = require('../src/services/audio/stt');
const deepgram = require('../src/services/audio/stt/deepgram');
const openai = require('../src/services/audio/stt/openai');
const transcript = require('../src/services/audio/stt/transcript');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');

const KEYS = { DEEPGRAM_API_KEY: 'dg-test-key-not-real-123', OPENAI_API_KEY: 'sk-test-key-not-real-456' };
const SECRET_NAME = 'jamal-recording-private-name.webm';
let tmpDir, audioPath;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-stt-test-'));
  audioPath = path.join(tmpDir, SECRET_NAME);
  fs.writeFileSync(audioPath, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeFetch(handler) {
  const calls = [];
  const fn = jest.fn(async (url, init) => { calls.push({ url: String(url), init }); return handler(String(url), init, calls.length); });
  fn.calls = calls;
  return fn;
}
const okDeepgram = () => fakeFetch(() => jsonResponse(200, FIXTURE, { 'dg-request-id': 'hdr-request-id' }));
const run = ({ env = {}, ...rest } = {}) => stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', env: { ...KEYS, ...env }, ...rest });

describe('Deepgram request', () => {
  test('always sends the approved parameters, speaker labels off, and nothing else', async () => {
    const fetchImpl = okDeepgram();
    await run({ fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init } = fetchImpl.calls[0];
    const parsed = new URL(url);
    expect(`${parsed.origin}${parsed.pathname}`).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ model: 'nova-3', language: 'en', punctuate: 'true', smart_format: 'true',
      filler_words: 'true', utterances: 'true', mip_opt_out: 'true', diarize: 'false' });
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Token ${KEYS.DEEPGRAM_API_KEY}`);
    expect(init.headers['Content-Type']).toBe('audio/webm');
    expect(init.body).toBeInstanceOf(Blob);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test('the parameters cannot be changed from the environment', () => {
    const { url } = deepgram.buildRequest({ env: { ...KEYS, DEEPGRAM_MODEL: 'whisper', AUDIO_STT_LANGUAGE: 'bn' }, contentType: 'audio/mpeg' });
    expect(new URL(url).searchParams.get('model')).toBe('nova-3');
    expect(new URL(url).searchParams.get('language')).toBe('en');
    expect(new URL(url).searchParams.get('mip_opt_out')).toBe('true');
    expect(new URL(url).searchParams.get('filler_words')).toBe('true');
  });

  test('a missing key fails before any request, naming the variable only', async () => {
    const fetchImpl = okDeepgram();
    const error = await stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', env: {}, fetchImpl }).catch(e => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_NOT_CONFIGURED', retryable: false });
    expect(error.message).toContain('DEEPGRAM_API_KEY');
  });
});

describe('normalisation into the stored schema', () => {
  let result;
  beforeAll(async () => { result = (await run({ fetchImpl: okDeepgram() })).transcript; });

  test('top-level fields', () => {
    expect(result).toMatchObject({ transcriptSchemaVersion: transcript.TRANSCRIPT_SCHEMA_VERSION, provider: 'deepgram', model: 'nova-3',
      providerModelVersion: '2025-01-01.0', providerRequestId: '0b3f2c1e-1111-4222-8333-944455556666', language: 'en', languageConfidence: null,
      durationSeconds: 8.2, wordTimingsAvailable: true, speakingCoachDataAvailable: true });
    expect(transcript.TRANSCRIPT_SCHEMA_VERSION).toBe('audio-transcript-v1');
    expect(transcript.SERVER_ONLY_FIELDS).toEqual(['provider', 'model', 'providerModelVersion', 'providerRequestId']);
  });

  test('every word: text, punctuated, start, end, confidence, isFiller', () => {
    expect(result.words).toHaveLength(21);
    expect(result.words[0]).toEqual({ index: 0, text: 'um', punctuated: 'Um,', start: 0.4, end: 0.7, confidence: 0.91, isFiller: true });
    expect(result.words[8]).toEqual({ index: 8, text: 'market', punctuated: 'market.', start: 2.25, end: 2.8, confidence: 0.99, isFiller: false });
    expect(result.words.filter(w => w.isFiller).map(w => w.index)).toEqual([0, 9, 12]);
  });

  test('utterances point at word ranges', () => {
    expect(result.utterances).toEqual([
      { index: 0, start: 0.4, end: 2.8, confidence: 0.96, wordStartIndex: 0, wordEndIndex: 8, text: 'Um, so I I went to the the market.' },
      { index: 1, start: 4.2, end: 7.8, confidence: 0.97, wordStartIndex: 9, wordEndIndex: 20, text: 'Uh, it was, uh, very busy. Then I went I went home.' }
    ]);
  });

  test('the raw transcript is deeply immutable', () => {
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.words)).toBe(true);
    expect(Object.isFrozen(result.words[0])).toBe(true);
    expect(Object.isFrozen(result.utterances[0])).toBe(true);
    expect(() => { 'use strict'; result.words[0].text = 'changed'; }).toThrow(TypeError);
  });

  test('the request id falls back to the response header when the body has none', () => {
    const body = JSON.parse(JSON.stringify(FIXTURE)); delete body.metadata.request_id;
    expect(deepgram.normalize(body, { headerRequestId: 'hdr-1' }).providerRequestId).toBe('hdr-1');
  });

  test('a detected language is kept with its confidence', () => {
    const body = JSON.parse(JSON.stringify(FIXTURE));
    Object.assign(body.results.channels[0], { detected_language: 'en', language_confidence: 0.93 });
    expect(deepgram.normalize(body)).toMatchObject({ language: 'en', languageConfidence: 0.93 });
  });

  test('no speech gives an empty, valid transcript (not an error)', () => {
    const body = JSON.parse(JSON.stringify(FIXTURE));
    body.results.channels[0].alternatives[0] = { transcript: '', confidence: 0, words: [] }; body.results.utterances = [];
    const empty = deepgram.normalize(body);
    expect(empty.words).toEqual([]);
    expect(transcript.deriveTexts(empty)).toMatchObject({ rawText: '', assessorText: '', displayText: { text: '', fillers: [] } });
  });

  test.each([
    ['no results', b => { delete b.results; }],
    ['no channels', b => { b.results.channels = []; }],
    ['a word without timings', b => { delete b.results.channels[0].alternatives[0].words[3].start; }],
    ['a word ending before it starts', b => { b.results.channels[0].alternatives[0].words[3].end = 0.1; }],
    ['a confidence above 1', b => { b.results.channels[0].alternatives[0].words[3].confidence = 1.5; }]
  ])('a malformed response (%s) is AUDIO_STT_BAD_RESPONSE', (_name, change) => {
    const body = JSON.parse(JSON.stringify(FIXTURE)); change(body);
    expect(() => deepgram.normalize(body)).toThrow(expect.objectContaining({ code: 'AUDIO_STT_BAD_RESPONSE' }));
  });
});

describe('derived texts (pure, from the stored word list only)', () => {
  const words = deepgram.normalize(FIXTURE);

  test('rawText is verbatim, fillers included', () => {
    expect(transcript.deriveTexts(words).rawText).toBe('Um, so I I went to the the market. Uh, it was, uh, very busy. Then I went I went home.');
  });

  test('displayText hides fillers and keeps their positions for a toggle', () => {
    const { displayText } = transcript.deriveTexts(words);
    expect(displayText.text).toBe('So I I went to the the market. It was, very busy. Then I went I went home.');
    expect(displayText.fillers).toEqual([
      { wordIndex: 0, offset: 0, text: 'Um,' },
      { wordIndex: 9, offset: 31, text: 'Uh,' },
      { wordIndex: 12, offset: 39, text: 'uh,' }
    ]);
    // Each offset is the start of the word the filler stood before.
    expect(displayText.text.slice(31, 33)).toBe('It');
    expect(displayText.text.slice(39, 43)).toBe('very');
  });

  test('assessorText: punctuated, fillers removed, repetitions and self-corrections kept', () => {
    const { assessorText } = transcript.deriveTexts(words);
    expect(assessorText).toBe('So I I went to the the market. It was, very busy. Then I went I went home.');
    expect(assessorText).toContain('I I went');
    expect(assessorText).toContain('the the market');
    expect(assessorText).toContain('I went I went');
    expect(assessorText).not.toMatch(/\b(um|uh)\b/i);
  });

  test('a filler that ended a sentence gives its full stop to the word before it', () => {
    const tiny = { words: [
      { index: 0, text: 'yes', punctuated: 'Yes', start: 0, end: 0.3, confidence: 0.9, isFiller: false },
      { index: 1, text: 'uh', punctuated: 'uh.', start: 0.4, end: 0.6, confidence: 0.9, isFiller: true },
      { index: 2, text: 'no', punctuated: 'No,', start: 0.7, end: 0.9, confidence: 0.9, isFiller: false },
      { index: 3, text: 'um', punctuated: 'um.', start: 1.0, end: 1.2, confidence: 0.9, isFiller: true }
    ] };
    expect(transcript.deriveTexts(tiny).displayText.text).toBe('Yes. No.');
  });

  test('derived texts are versioned and never change the raw words', () => {
    const before = JSON.stringify(words);
    const derived = transcript.deriveTexts(words);
    expect(derived.derivedTextVersion).toBe('audio-derived-text-v1');
    expect(JSON.stringify(words)).toBe(before);
  });
});

describe('fluency metrics (no AI, from the raw timings)', () => {
  test('from the fixture', () => {
    expect(transcript.fluencyMetrics(deepgram.normalize(FIXTURE))).toEqual({
      metricsVersion: 'audio-fluency-v1', available: true, totalWords: 21, spokenWords: 18, fillerCount: 3,
      speakingSeconds: 7.4, wordsPerMinute: 145.9, fillersPer100Words: 14.3,
      pauseThresholdSeconds: 1, pausesOverThreshold: 1, longestPauseSeconds: 1.4, totalPauseSecondsOverThreshold: 1.4, repetitionCount: 3
    });
  });

  test('unavailable without word timings (OpenAI fallback)', () => {
    expect(transcript.fluencyMetrics({ wordTimingsAvailable: false, words: [] })).toEqual({ metricsVersion: 'audio-fluency-v1', available: false,
      reason: 'WORD_TIMINGS_UNAVAILABLE' });
  });

  test('no words gives zeros, never NaN', () => {
    const metrics = transcript.fluencyMetrics({ wordTimingsAvailable: true, words: [] });
    expect(metrics).toMatchObject({ available: true, totalWords: 0, spokenWords: 0, wordsPerMinute: 0, fillersPer100Words: 0, repetitionCount: 0 });
    expect(JSON.stringify(metrics)).not.toContain('null');
  });

  test('repetitions: single words and two-word phrases, fillers in between ignored', () => {
    const make = list => ({ wordTimingsAvailable: true, words: list.map((text, index) => ({ index, text, punctuated: text, start: index, end: index + 0.5,
      confidence: 0.9, isFiller: ['um', 'uh'].includes(text) })) });
    expect(transcript.fluencyMetrics(make(['the', 'the', 'the'])).repetitionCount).toBe(2);
    expect(transcript.fluencyMetrics(make(['i', 'um', 'i', 'went'])).repetitionCount).toBe(1);
    expect(transcript.fluencyMetrics(make(['we', 'went', 'we', 'went', 'out'])).repetitionCount).toBe(1);
    expect(transcript.fluencyMetrics(make(['a', 'b', 'c', 'd'])).repetitionCount).toBe(0);
  });
});

describe('error mapping', () => {
  test.each([
    [400, 'AUDIO_STT_REJECTED', false], [401, 'AUDIO_STT_REJECTED', false], [403, 'AUDIO_STT_REJECTED', false], [404, 'AUDIO_STT_REJECTED', false],
    [413, 'AUDIO_STT_REJECTED', false], [422, 'AUDIO_STT_REJECTED', false],
    [408, 'AUDIO_STT_TIMEOUT', true], [429, 'AUDIO_STT_RATE_LIMITED', true],
    [500, 'AUDIO_STT_PROVIDER_ERROR', true], [502, 'AUDIO_STT_PROVIDER_ERROR', true], [503, 'AUDIO_STT_PROVIDER_ERROR', true]
  ])('HTTP %i: %s, retryable=%p', async (status, code, retryable) => {
    const error = await run({ fetchImpl: fakeFetch(() => jsonResponse(status, { err_msg: 'Synthetic provider text: market busy' })) }).catch(e => e);
    expect(error).toMatchObject({ name: 'SttError', code, retryable, httpStatus: status, provider: 'deepgram', retryAfterMs: null });
    expect(error.message).not.toContain('Synthetic provider text');
  });

  describe('Retry-After is a hint, capped at the backoff ceiling (5 min)', () => {
    const NOW = Date.parse('2026-11-15T10:00:00Z');
    const withHeader = (status, value) => fakeFetch(() => jsonResponse(status, {}, { 'retry-after': value }));
    test.each([
      [429, '30', 30000], [429, '0', 0], [503, '120', 120000], [408, '7', 7000],
      [429, '86400', 300000],                                        // a day is capped at the ceiling
      [429, 'Sun, 15 Nov 2026 10:01:00 GMT', 60000],                 // an HTTP date, 60 s from now
      [429, 'Sun, 15 Nov 2026 09:00:00 GMT', 0],                     // a date in the past means "now"
      [429, 'Wed, 15 Nov 2028 10:00:00 GMT', 300000],                // far future: capped
      [429, 'soon', null], [429, '-5', null], [429, '1.5', null], [429, '', null]
    ])('HTTP %i with Retry-After %p gives retryAfterMs %p', async (status, value, expected) => {
      const error = await run({ fetchImpl: withHeader(status, value), now: () => NOW }).catch(e => e);
      expect(error).toMatchObject({ retryable: true, retryAfterMs: expected });
    });

    test('a permanent 4xx ignores Retry-After', async () => {
      const error = await run({ fetchImpl: withHeader(400, '30'), now: () => NOW }).catch(e => e);
      expect(error).toMatchObject({ code: 'AUDIO_STT_REJECTED', retryable: false, retryAfterMs: null });
    });

    test('the hint is parsed by a pure helper (used by the worker later)', () => {
      const { retryAfterHintMs } = require('../src/services/audio/stt/errors');
      expect(retryAfterHintMs('45', NOW)).toBe(45000);
      expect(retryAfterHintMs('999999', NOW)).toBe(300000);
      expect(retryAfterHintMs(null, NOW)).toBeNull();
    });
  });

  test('a network failure is retryable', async () => {
    const error = await run({ fetchImpl: fakeFetch(() => { throw new TypeError('fetch failed'); }) }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_STT_NETWORK', retryable: true });
  });

  test('a provider that never answers times out (retryable), and the timer covers a stalled body too', async () => {
    const hang = fakeFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const first = await run({ fetchImpl: hang, timeoutMs: 50 }).catch(e => e);
    expect(first).toMatchObject({ code: 'AUDIO_STT_TIMEOUT', retryable: true });
    const stalledBody = fakeFetch((_url, init) => ({ ok: true, status: 200, headers: new Headers(),
      text: () => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))) }));
    const second = await run({ fetchImpl: stalledBody, timeoutMs: 50 }).catch(e => e);
    expect(second).toMatchObject({ code: 'AUDIO_STT_TIMEOUT', retryable: true });
  });

  test('the default timeout is AUDIO_STT_TIMEOUT_MS (5 min unless set)', () => {
    expect(stt.effectiveTimeoutMs({})).toBe(300000);
    expect(stt.effectiveTimeoutMs({ AUDIO_STT_TIMEOUT_MS: '120000' })).toBe(120000);
    expect(stt.effectiveTimeoutMs({ AUDIO_STT_TIMEOUT_MS: 'bad' })).toBe(300000);
  });

  test('a caller cancel is not retryable and is not a timeout', async () => {
    const controller = new AbortController();
    const hang = fakeFetch((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const pending = run({ fetchImpl: hang, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await pending.catch(e => e)).toMatchObject({ code: 'AUDIO_STT_CANCELLED', retryable: false });
  });

  test('an unreadable body is AUDIO_STT_BAD_RESPONSE (retryable)', async () => {
    const error = await run({ fetchImpl: fakeFetch(() => new Response('<html>not json</html>', { status: 200 })) }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_STT_BAD_RESPONSE', retryable: true });
  });
});

describe('fallback (explicit opt-in only; never by default; no loop)', () => {
  const openaiOk = (url) => (url.startsWith('https://api.openai.com/')
    ? jsonResponse(200, { text: 'So I went to the market.', usage: { type: 'duration', seconds: 8 } }, { 'x-request-id': 'oa-req-1' })
    : jsonResponse(503, {}));
  const openaiCalls = fetchImpl => fetchImpl.calls.filter(call => call.url.startsWith('https://api.openai.com/'));
  const ON = { AUDIO_STT_FALLBACK_ENABLED: 'true' };

  test('flag off (default), key set: OpenAI is never called and never receives audio', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    expect(await run({ fetchImpl }).catch(e => e)).toMatchObject({ code: 'AUDIO_STT_PROVIDER_ERROR', retryable: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
  });

  test.each(['false', '1', 'yes', ''])('flag %p: OpenAI is never called', async (value) => {
    const fetchImpl = fakeFetch(openaiOk);
    await run({ fetchImpl, env: { AUDIO_STT_FALLBACK_ENABLED: value } }).catch(() => {});
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
  });

  test('flag on, OPENAI_API_KEY missing: OpenAI is never called; the primary error is returned', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    const error = await stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', fetchImpl,
      env: { DEEPGRAM_API_KEY: KEYS.DEEPGRAM_API_KEY, ...ON } }).catch(e => e);
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
    expect(error).toMatchObject({ code: 'AUDIO_STT_PROVIDER_ERROR', retryable: true, provider: 'deepgram' });
    expect(error.primaryCode).toBeUndefined();
  });

  test('flag on, key blank: OpenAI is never called', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    await run({ fetchImpl, env: { ...ON, OPENAI_API_KEY: '   ' } }).catch(() => {});
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
  });

  test('flag on and key set, but the primary succeeded: OpenAI is never called', async () => {
    const fetchImpl = okDeepgram();
    const out = await run({ fetchImpl, env: ON });
    expect(out.fallbackUsed).toBe(false);
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
  });

  test('flag on and key set: a retryable primary failure tries OpenAI once', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    const out = await run({ fetchImpl, env: ON });
    expect(openaiCalls(fetchImpl)).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.fallbackUsed).toBe(true);
    expect(out.attempts).toEqual([{ provider: 'deepgram', outcome: 'failed', code: 'AUDIO_STT_PROVIDER_ERROR' }, { provider: 'openai', outcome: 'ok', code: null }]);
    expect(out.transcript).toMatchObject({ provider: 'openai', model: 'gpt-4o-transcribe', providerRequestId: 'oa-req-1', wordTimingsAvailable: false,
      speakingCoachDataAvailable: false, words: [], language: 'en', durationSeconds: 8, rawText: 'So I went to the market.' });
    expect(transcript.deriveTexts(out.transcript)).toMatchObject({ rawText: 'So I went to the market.', assessorText: 'So I went to the market.',
      displayText: { text: 'So I went to the market.', fillers: [] } });
  });

  test('flag on and key set: a permanent primary failure (400) does not use the fallback', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(400, {}));
    expect(await run({ fetchImpl, env: ON }).catch(e => e)).toMatchObject({ code: 'AUDIO_STT_REJECTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('flag on and key set: a caller cancel does not use the fallback', async () => {
    const controller = new AbortController();
    const fetchImpl = fakeFetch((url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
    const pending = run({ fetchImpl, env: ON, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    expect(await pending.catch(e => e)).toMatchObject({ code: 'AUDIO_STT_CANCELLED' });
    expect(openaiCalls(fetchImpl)).toHaveLength(0);
  });

  test('flag on and key set: a 429 is retryable, so the fallback is used', async () => {
    const fetchImpl = fakeFetch(url => (url.startsWith('https://api.openai.com/') ? openaiOk(url) : jsonResponse(429, {})));
    expect((await run({ fetchImpl, env: ON })).fallbackUsed).toBe(true);
  });

  test('both failing: two calls in total, retryable stays true, both codes kept', async () => {
    const fetchImpl = fakeFetch(() => jsonResponse(500, {}));
    const error = await run({ fetchImpl, env: ON }).catch(e => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: 'AUDIO_STT_PROVIDER_ERROR', retryable: true, provider: 'openai', primaryCode: 'AUDIO_STT_PROVIDER_ERROR' });
  });

  test('OpenAI request: multipart, English, json, key as Bearer', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    await stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', env: { ...KEYS, AUDIO_STT_PROVIDER: 'openai' }, fetchImpl });
    const { url, init } = fetchImpl.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.headers.Authorization).toBe(`Bearer ${KEYS.OPENAI_API_KEY}`);
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe('gpt-4o-transcribe');
    expect(init.body.get('language')).toBe('en');
    expect(init.body.get('response_format')).toBe('json');
    expect(init.body.get('file')).toBeInstanceOf(Blob);
    expect(init.body.get('file').name).toBe('audio.webm');
  });

  test('OpenAI refuses files over its 25 MB limit before sending (permanent)', async () => {
    const fetchImpl = fakeFetch(openaiOk);
    const error = await openai.transcribe({ audio: { size: 26 * 1024 * 1024 }, contentType: 'audio/wav', env: KEYS, fetchImpl, signal: new AbortController().signal })
      .catch(e => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_FILE_TOO_LARGE_FOR_PROVIDER', retryable: false });
  });
});

describe('logs and network', () => {
  test('logs never contain transcript text, the file name, the path or a key', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(level => jest.spyOn(console, level).mockImplementation((...args) => lines.push(args.join(' '))));
    try {
      await run({ fetchImpl: okDeepgram() });
      await run({ fetchImpl: fakeFetch(() => jsonResponse(500, { err_msg: 'market busy' })) }).catch(() => {});
      await run({ fetchImpl: fakeFetch(() => jsonResponse(503, {})), env: { AUDIO_STT_FALLBACK_ENABLED: 'true' } }).catch(() => {});
    } finally { spies.forEach(spy => spy.mockRestore()); }
    const text = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const forbidden of ['market', 'busy', 'Um,', SECRET_NAME, 'jamal', tmpDir, KEYS.DEEPGRAM_API_KEY, KEYS.OPENAI_API_KEY, 'Token ', 'Bearer ']) {
      expect({ forbidden, found: text.includes(forbidden) }).toEqual({ forbidden, found: false });
    }
    expect(text).toContain('audio_stt_attempt');
  });

  test('without an injected client the real global fetch is used, and the tripwire blocks it', async () => {
    expectNetworkTripwire = true;
    const error = await stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', env: KEYS }).catch(e => e);
    expect(globalThis.fetch).toHaveBeenCalled();
    expect(realNetwork).toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_NETWORK', retryable: true });
  });

  test('a missing audio file fails without a provider call', async () => {
    const fetchImpl = okDeepgram();
    const error = await stt.transcribe({ filePath: path.join(tmpDir, 'missing.webm'), contentType: 'audio/webm', env: KEYS, fetchImpl }).catch(e => e);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(error).toMatchObject({ code: 'AUDIO_STT_FILE_UNAVAILABLE', retryable: false });
    expect(error.message).not.toContain('missing.webm');
  });
});
