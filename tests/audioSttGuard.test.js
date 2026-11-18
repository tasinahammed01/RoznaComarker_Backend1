'use strict';
// Audio + speech-to-text, stage 12: the suspicious-response guard for OpenRouter Scribe (services/audio/stt/transcriptGuard.js) and the retry-once
// rule in services/audio/stt/index.js. Calibrated on real responses: every real-speech run passes and both looped-speech failures fail.
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
const guard = require('../src/services/audio/stt/transcriptGuard');
const DEEPGRAM_FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const FIX = name => require(`./fixtures/audio/openrouter-scribe/${name}.cjs`);
const REAL = ['speaking-a-real-45s', 'speaking-b-real-142s', 'speaking-ababa-real-417s-run1', 'speaking-ababa-real-417s-run3'];
const LOOPED_DUPLICATED = FIX('looped-7min-duplicated');
const LOOPED_DROPOUT = FIX('looped-24mb-dropout');
const A = FIX('speaking-a-real-45s');

const KEY = 'sk-or-test-key-not-real-789';
const ENV = { AUDIO_STT_PROVIDER: 'openrouter-scribe', OPENROUTER_API_KEY: KEY };
let tmpDir, audioPath;
beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-guard-test-'));
  audioPath = path.join(tmpDir, 'recording.m4a');
  fs.writeFileSync(audioPath, Buffer.alloc(4096, 5));
});
afterAll(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

const jsonResponse = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
function fakeFetch(bodies) {
  const calls = [];
  const fn = jest.fn(async (url, init) => { calls.push({ url: String(url), init }); const body = bodies[Math.min(calls.length, bodies.length) - 1]; return jsonResponse(200, body, { 'x-generation-id': `gen-${calls.length}` }); });
  fn.calls = calls;
  return fn;
}
const inspect = (fixture, expected = fixture.duration) => guard.inspectWords(fixture.words, { providerDurationSeconds: fixture.duration, expectedDurationSeconds: expected });

// Evenly spoken synthetic words: `count` words between `from` and `to` seconds, each 0.3 s long. Default tokens are unique (no accidental repeats).
let seq = 0;
function speech(count, from, to, word = () => `w${seq++}`) {
  const step = (to - from) / count;
  return Array.from({ length: count }, (_, i) => ({ word: typeof word === 'function' ? word(i) : word, start: +(from + i * step).toFixed(3), end: +(from + i * step + Math.min(0.3, step * 0.8)).toFixed(3), confidence: 0.95 }));
}

describe('thresholds (documented in docs/audio-stt-deployment.md)', () => {
  test('the calibrated values', () => {
    expect(guard.THRESHOLDS).toEqual({
      zeroLengthRunWords: 10, zeroLengthShare: 0.02, zeroLengthMinWords: 5,
      beyondDurationSeconds: 1, overlapShare: 0.01, overlapMinPairs: 3,
      duplicateBlockWords: 20, endGapSeconds: 15, durationMismatchSeconds: 2, durationMismatchShare: 0.05,
      windowSeconds: 30, windowRulesMinSpeechSeconds: 60, dropoutRatio: 0.2, burstRatio: 2
    });
    expect(Object.isFrozen(guard.THRESHOLDS)).toBe(true);
  });
});

describe('calibration on real responses', () => {
  test.each(REAL)('%s passes', (name) => {
    const report = inspect(FIX(name));
    expect(report).toMatchObject({ ok: true, reasons: [] });
  });

  test('looped 7 min (131 zero-length words, 114 duplicated) fails on the zero-length run and share, and the crammed window', () => {
    const report = inspect(LOOPED_DUPLICATED);
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining(['ZERO_LENGTH_RUN', 'ZERO_LENGTH_SHARE', 'RATE_BURST']));
    expect(report.metrics).toMatchObject({ zeroLengthWords: 131, longestZeroLengthRun: 89 });
  });

  test('looped 24.5 MB (one 46 s loop silently lost, last word still near the end) fails on the speech-rate dropout', () => {
    const report = inspect(LOOPED_DROPOUT);
    expect(report.ok).toBe(false);
    expect(report.reasons).toEqual(expect.arrayContaining(['RATE_DROPOUT']));
    expect(report.metrics.endGapSeconds).toBeLessThan(1);                 // the end-gap check alone would have missed it
    expect(report.metrics.lowestWindowRatio).toBeLessThan(0.2);
  });

  test('real-speech margins: worst window ratio, highest burst, end gap and zero-length words stay well inside the limits', () => {
    for (const name of REAL) {
      const m = inspect(FIX(name)).metrics;
      expect(m.zeroLengthWords).toBe(0);
      expect(m.endGapSeconds).toBeLessThan(2);
      if (m.windowCount >= 2) { expect(m.lowestWindowRatio).toBeGreaterThan(0.7); expect(m.highestWindowRatio).toBeLessThan(1.6); }
    }
  });
});

describe('each rule on synthetic word lists', () => {
  const words120 = () => speech(300, 0.5, 119);

  test('a clean 2-minute answer passes', () => {
    expect(guard.inspectWords(words120(), { providerDurationSeconds: 120, expectedDurationSeconds: 120 })).toMatchObject({ ok: true, reasons: [] });
  });

  test('ZERO_LENGTH_RUN: 10 zero-length words in a row (9 do not)', () => {
    const make = n => { const w = words120(); for (let i = 100; i < 100 + n; i++) w[i] = { ...w[i], end: w[i].start }; return w; };
    expect(guard.inspectWords(make(10), { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).toContain('ZERO_LENGTH_RUN');
    expect(guard.inspectWords(make(9), { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).not.toContain('ZERO_LENGTH_RUN');
  });

  test('ZERO_LENGTH_SHARE: more than 2% and at least 5 words (scattered); a single zero-length word in a short clip is fine', () => {
    const w = words120(); for (let i = 0; i < 7; i++) w[i * 40] = { ...w[i * 40], end: w[i * 40].start };
    expect(guard.inspectWords(w, { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).toEqual(['ZERO_LENGTH_SHARE']);
    const clip = speech(18, 0, 5); clip[3] = { ...clip[3], end: clip[3].start };
    expect(guard.inspectWords(clip, { providerDurationSeconds: 5, expectedDurationSeconds: 5 }).ok).toBe(true);
  });

  test('WORDS_BEYOND_DURATION: a word ending more than 1 s after the end of the audio', () => {
    const w = words120(); w.push({ word: 'late', start: 120.5, end: 121.2, confidence: 0.9 });
    expect(guard.inspectWords(w, { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).toContain('WORDS_BEYOND_DURATION');
    const near = words120(); near.push({ word: 'edge', start: 119.5, end: 120.8, confidence: 0.9 });
    expect(guard.inspectWords(near, { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).not.toContain('WORDS_BEYOND_DURATION');
  });

  test('OVERLAPPING_WORDS: more than 1% and at least 3 overlapping pairs', () => {
    const w = words120(); for (const i of [10, 60, 110, 160]) w[i] = { ...w[i], start: w[i - 1].start + 0.05 };
    expect(guard.inspectWords(w, { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).toContain('OVERLAPPING_WORDS');
  });

  test('DUPLICATED_BLOCK: 20 words repeated back to back (19 do not; a student repeating a short phrase is normal)', () => {
    const block = n => { const head = speech(40, 0.5, 15, i => `head${i}`); const phrase = Array.from({ length: n }, (_, i) => `p${i}`);
      const rep = speech(n * 2, 15, 15 + n * 0.8, i => phrase[i % n]); const tail = speech(200, 15 + n * 0.8 + 0.5, 119, i => `tail${i}`); return [...head, ...rep, ...tail]; };
    expect(guard.inspectWords(block(20), { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).toContain('DUPLICATED_BLOCK');
    expect(guard.inspectWords(block(19), { providerDurationSeconds: 120, expectedDurationSeconds: 120 }).reasons).not.toContain('DUPLICATED_BLOCK');
  });

  test('END_GAP: speech ends more than 15 s before the end of the audio (our duration scan); 14 s is allowed', () => {
    expect(guard.inspectWords(speech(250, 0.5, 100), { providerDurationSeconds: 116, expectedDurationSeconds: 116 }).reasons).toContain('END_GAP');
    expect(guard.inspectWords(speech(250, 0.5, 100), { providerDurationSeconds: 114, expectedDurationSeconds: 114 }).reasons).not.toContain('END_GAP');
  });

  test('DURATION_MISMATCH: the provider heard a different length than our scan (over 2 s and over 5%)', () => {
    expect(guard.inspectWords(words120(), { providerDurationSeconds: 100, expectedDurationSeconds: 120 }).reasons).toContain('DURATION_MISMATCH');
    expect(guard.inspectWords(words120(), { providerDurationSeconds: 119, expectedDurationSeconds: 120 }).reasons).not.toContain('DURATION_MISMATCH');
  });

  test('RATE_DROPOUT: a 30 s window under 20% of the median rate inside the speech; RATE_BURST: over 2x', () => {
    const dropout = [...speech(150, 0.5, 60), ...speech(2, 61, 89), ...speech(150, 90, 150)];
    expect(guard.inspectWords(dropout, { providerDurationSeconds: 151, expectedDurationSeconds: 151 }).reasons).toContain('RATE_DROPOUT');
    const burst = [...speech(100, 0.5, 60), ...speech(160, 60, 90), ...speech(100, 90, 150)];
    expect(guard.inspectWords(burst, { providerDurationSeconds: 151, expectedDurationSeconds: 151 }).reasons).toContain('RATE_BURST');
  });

  test('window rules need at least 60 s of speech; silence before the first word is not a dropout', () => {
    const late = speech(120, 40, 100);                                   // 40 s of silence, then a minute of speech
    expect(guard.inspectWords(late, { providerDurationSeconds: 101, expectedDurationSeconds: 101 }).ok).toBe(true);
    const short = [...speech(60, 0.5, 20), ...speech(2, 21, 50)];
    expect(guard.inspectWords(short, { providerDurationSeconds: 51, expectedDurationSeconds: 51 }).reasons).not.toContain('RATE_DROPOUT');
  });

  test('no words at all is not suspicious (the assessment reports "not enough speech")', () => {
    expect(guard.inspectWords([], { providerDurationSeconds: 30, expectedDurationSeconds: 30 })).toMatchObject({ ok: true, reasons: [] });
  });

  test('without our duration scan, the provider duration is used', () => {
    expect(guard.inspectWords(speech(250, 0.5, 100), { providerDurationSeconds: 116 }).reasons).toContain('END_GAP');
  });
});

describe('retry once, then AUDIO_STT_UNRELIABLE_RESULT (no Deepgram fallback)', () => {
  const run = (fetchImpl, env = {}, expectedDurationSeconds = A.duration) => stt.transcribe({ filePath: audioPath, contentType: 'audio/mp4', env: { ...ENV, ...env }, fetchImpl, expectedDurationSeconds });
  // A response that fails the guard for speaking-A's length: speaking-A's words with 12 of them squashed to zero length.
  const SUSPICIOUS_A = { ...A, words: A.words.map((w, i) => (i >= 40 && i < 52 ? { ...w, end: w.start } : w)) };

  test('a clean first answer: one request', async () => {
    const fetchImpl = fakeFetch([A]);
    const out = await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out.transcript.words).toHaveLength(132);
  });

  test('suspicious then clean: two requests in the same attempt, the second answer is stored', async () => {
    const fetchImpl = fakeFetch([SUSPICIOUS_A, A]);
    const out = await run(fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(out.transcript.words.every(w => w.end > w.start)).toBe(true);
    expect(out.transcript.providerRequestId).toBe('gen-2');
    expect(out.attempts).toEqual([{ provider: 'openrouter-scribe', outcome: 'suspicious', code: 'AUDIO_STT_UNRELIABLE_RESULT' }, { provider: 'openrouter-scribe', outcome: 'ok', code: null }]);
  });

  test('suspicious twice: exactly two requests, then AUDIO_STT_UNRELIABLE_RESULT (permanent), reason codes attached', async () => {
    const fetchImpl = fakeFetch([SUSPICIOUS_A, SUSPICIOUS_A, A]);
    const error = await run(fetchImpl).catch(e => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ name: 'SttError', code: 'AUDIO_STT_UNRELIABLE_RESULT', retryable: false, provider: 'openrouter-scribe' });
    expect(error.reasons).toEqual(expect.arrayContaining(['ZERO_LENGTH_RUN']));
    expect(error.message).toBe('The speech-to-text result looked incomplete or garbled.');
  });

  test('a provider error on the retry keeps that error (e.g. 503 stays retryable for the job worker)', async () => {
    let n = 0;
    const fetchImpl = jest.fn(async () => (++n === 1 ? jsonResponse(200, SUSPICIOUS_A) : jsonResponse(503, {})));
    const error = await run(fetchImpl).catch(e => e);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(error).toMatchObject({ code: 'AUDIO_STT_PROVIDER_ERROR', retryable: true });
  });

  test('the real looped failures: both refused after one retry', async () => {
    for (const body of [LOOPED_DUPLICATED, LOOPED_DROPOUT]) {
      const fetchImpl = fakeFetch([body]);
      const error = await run(fetchImpl, {}, body.duration).catch(e => e);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(error.code).toBe('AUDIO_STT_UNRELIABLE_RESULT');
    }
  });

  test('Deepgram is never guarded or retried (its behaviour is unchanged)', async () => {
    const squashed = JSON.parse(JSON.stringify(DEEPGRAM_FIXTURE));
    for (const w of squashed.results.channels[0].alternatives[0].words) w.end = w.start;
    const fetchImpl = jest.fn(async () => jsonResponse(200, squashed));
    const out = await stt.transcribe({ filePath: audioPath, contentType: 'audio/webm', env: { DEEPGRAM_API_KEY: 'dg-test' }, fetchImpl, expectedDurationSeconds: 8.2 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(out.transcript.provider).toBe('deepgram');
  });

  test('logs: reason codes and numbers only (no transcript text, no key)', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(level => jest.spyOn(console, level).mockImplementation((...args) => lines.push(args.join(' '))));
    try { await run(fakeFetch([SUSPICIOUS_A])).catch(() => {}); } finally { spies.forEach(spy => spy.mockRestore()); }
    const text = lines.join('\n');
    expect(text).toContain('audio_stt_unreliable_result');
    expect(text).toContain('ZERO_LENGTH_RUN');
    for (const forbidden of ['grandmother', 'village', 'Um,', KEY, 'Bearer ']) expect({ forbidden, found: text.includes(forbidden) }).toEqual({ forbidden, found: false });
  });
});

describe('dev-only switch to trigger the guard on purpose (AUDIO_STT_GUARD_FORCE_SUSPICIOUS)', () => {
  const run = (env) => stt.transcribe({ filePath: audioPath, contentType: 'audio/mp4', env: { ...ENV, ...env }, fetchImpl: fakeFetch([A]), expectedDurationSeconds: A.duration });

  test('honoured only with NODE_ENV=development or test: two requests, then AUDIO_STT_UNRELIABLE_RESULT (FORCED_FOR_TESTING)', async () => {
    for (const nodeEnv of ['development', 'test']) {
      const error = await run({ NODE_ENV: nodeEnv, AUDIO_STT_GUARD_FORCE_SUSPICIOUS: 'true' }).catch(e => e);
      expect(error).toMatchObject({ code: 'AUDIO_STT_UNRELIABLE_RESULT', reasons: ['FORCED_FOR_TESTING'] });
    }
  });

  test('refused in production (and when NODE_ENV is unset): the answer is used normally', async () => {
    for (const nodeEnv of ['production', undefined, 'staging']) {
      const out = await run({ NODE_ENV: nodeEnv, AUDIO_STT_GUARD_FORCE_SUSPICIOUS: 'true' });
      expect(out.transcript.words).toHaveLength(132);
    }
  });
});
