'use strict';
// Audio + speech-to-text, stage 3: measuring duration before any provider call (services/audio/duration.js). music-metadata is ESM-only and
// the repo is CommonJS, so it is loaded with a dynamic import(). Jest's CommonJS runtime cannot run that import, so unit tests inject the loader;
// one gated integration test runs the real library in a separate Node process (AUDIO_LIBRARY_INTEGRATION=1).
process.env.NODE_ENV = 'test';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const duration = require('../src/services/audio/duration');
const policy = require('../src/services/audio/policy');

const LIMITS = policy.readLimits({}).limits;
const fakeLibrary = format => ({ parseFile: jest.fn(async () => ({ format })) });

describe('measureAudioDuration (library injected)', () => {
  test('scans the whole file (Chrome WebM has no duration in its header) and skips cover art', async () => {
    const library = fakeLibrary({ duration: 61.25, hasAudio: true, hasVideo: false });
    const result = await duration.measureAudioDuration('/x/a.webm', { load: async () => library });
    expect(result).toEqual({ durationSeconds: 61.25, hasVideo: false });
    expect(library.parseFile).toHaveBeenCalledWith('/x/a.webm', { duration: true, skipCovers: true });
  });

  test.each([
    [{ duration: 10, hasVideo: true }, true],
    [{ duration: 10, trackInfo: [{ type: 'video' }, { type: 'audio' }] }, true],
    [{ duration: 10, trackInfo: [{ type: 'audio' }] }, false],
    [{ duration: 10 }, false]
  ])('video detection %#', async (format, hasVideo) => {
    expect((await duration.measureAudioDuration('/x', { load: async () => fakeLibrary(format) })).hasVideo).toBe(hasVideo);
  });

  test.each([[{}], [{ duration: NaN }], [{ duration: -1 }], [{ duration: Infinity }], [{ hasAudio: false, duration: 10 }]])(
    'no usable duration or no audio is AUDIO_UNREADABLE (%#)', async (format) => {
      await expect(duration.measureAudioDuration('/x', { load: async () => fakeLibrary(format) })).rejects.toMatchObject({ code: 'AUDIO_UNREADABLE' });
    });

  test('a parse error is AUDIO_UNREADABLE and its text is not passed on', async () => {
    const library = { parseFile: jest.fn(async () => { throw new Error('parse failure in /home/app/uploads/audio/secret-name.webm'); }) };
    const error = await duration.measureAudioDuration('/x', { load: async () => library }).catch(e => e);
    expect(error).toMatchObject({ code: 'AUDIO_UNREADABLE' });
    expect(error.message).not.toContain('secret-name');
  });

  test('a loader failure is AUDIO_DURATION_UNAVAILABLE (a server problem, not the file)', async () => {
    await expect(duration.measureAudioDuration('/x', { load: async () => { throw new Error('ERR_REQUIRE_ESM'); } }))
      .rejects.toMatchObject({ code: 'AUDIO_DURATION_UNAVAILABLE' });
  });

  test('the default loader uses a dynamic import() and caches it', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'audio', 'duration.js'), 'utf8');
    expect(source).toMatch(/import\('music-metadata'\)/);
    expect(source).not.toMatch(/require\(['"]music-metadata['"]\)/);
  });
});

describe('checkDuration: at least 5 s; at most 420 s plus the 1 s tolerance', () => {
  test.each([
    [4.99, 'AUDIO_TOO_SHORT'], [5, null], [60, null], [420, null], [421, null], [421.01, 'AUDIO_TOO_LONG'], [3600, 'AUDIO_TOO_LONG']
  ])('%p s: %p', (seconds, code) => {
    expect(duration.checkDuration(seconds, LIMITS)).toEqual(code ? { ok: false, code } : { ok: true });
  });

  test('a lower AUDIO_MAX_DURATION_SECONDS is honoured', () => {
    const limits = policy.readLimits({ AUDIO_MAX_DURATION_SECONDS: '60' }).limits;
    expect(duration.checkDuration(61, limits)).toEqual({ ok: true });
    expect(duration.checkDuration(61.5, limits)).toEqual({ ok: false, code: 'AUDIO_TOO_LONG' });
  });
});

// Gated: runs the REAL library, in a separate Node process (no Jest VM), on WAV files generated here. No network, no real recordings.
const integration = process.env.AUDIO_LIBRARY_INTEGRATION === '1' ? describe : describe.skip;
integration('music-metadata really loads (dynamic import from CommonJS) and measures duration', () => {
  let dir;
  const wav = (seconds, sampleRate = 8000) => {
    const data = Buffer.alloc(Math.round(seconds * sampleRate), 0x80);              // 8-bit mono silence
    const header = Buffer.alloc(44);
    header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8); header.write('fmt ', 12);
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate, 28); header.writeUInt16LE(1, 32); header.writeUInt16LE(8, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
    return Buffer.concat([header, data]);
  };
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-duration-it-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  test.each([[6, 6], [430, 430]])('a %p s WAV measures %p s', (seconds, expected) => {
    const file = path.join(dir, `tone-${seconds}.wav`);
    fs.writeFileSync(file, wav(seconds));
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'audio', 'duration.js'))})`
      + `.measureAudioDuration(${JSON.stringify(file)}).then(r => process.stdout.write(JSON.stringify(r)), e => { process.stdout.write(JSON.stringify({ error: e.code })); })`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.hasVideo).toBe(false);
    expect(result.durationSeconds).toBeCloseTo(expected, 2);
  });
});
