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
  test('asks for the full duration scan (MP3 without a Xing header needs it) and skips cover art', async () => {
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

// music-metadata is pinned exactly to 12.3.2 (a cooldown: 12.5.0 was three days old). Production installs with npm ci from the lockfile.
describe('music-metadata pin', () => {
  test('package.json and package-lock.json pin music-metadata to exactly 12.3.2', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
    expect(pkg.dependencies['music-metadata']).toBe('12.3.2');
    expect(lock.packages[''].dependencies['music-metadata']).toBe('12.3.2');
    expect(lock.packages['node_modules/music-metadata'].version).toBe('12.3.2');
  });
});

// Gated: runs the REAL library, in a separate Node process (no Jest VM), on synthetic files generated here (tests/helpers/audioSamples.js).
// No network, no real recordings.
const integration = process.env.AUDIO_LIBRARY_INTEGRATION === '1' ? describe : describe.skip;
integration('music-metadata really loads (dynamic import from CommonJS) and measures duration', () => {
  const samples = require('./helpers/audioSamples');
  let dir;
  beforeAll(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'audio-duration-it-')); });
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));
  const measure = (name, buffer) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, buffer);
    const script = `require(${JSON.stringify(path.join(__dirname, '..', 'src', 'services', 'audio', 'duration.js'))})`
      + `.measureAudioDuration(${JSON.stringify(file)}).then(r => process.stdout.write(JSON.stringify(r)), e => { process.stdout.write(JSON.stringify({ error: e.code })); })`;
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 60000 });
    expect(run.status).toBe(0);
    return JSON.parse(run.stdout);
  };

  test('the installed library is 12.3.2', () => {
    // read from disk: the package's exports map does not expose package.json
    expect(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'node_modules', 'music-metadata', 'package.json'), 'utf8')).version).toBe('12.3.2');
  });

  test.each([
    ['tone-6.wav', 6, () => samples.wav(6)],
    ['tone-430.wav', 430, () => samples.wav(430)],
    ['cbr-6.mp3', 6, () => samples.mp3(6)],
    ['vbr-no-xing-430.mp3', 430, () => samples.mp3(430, { vbr: true })],      // whole-file frame scan: no header gives the duration
    ['opus-10.ogg', 10, () => samples.oggOpus(10)],
    ['header-duration-12.webm', 12, () => samples.webm(12)]
  ])('%s measures %p s', (name, expected, build) => {
    const result = measure(name, build());
    expect(result.hasVideo).toBe(false);
    expect(Math.abs(result.durationSeconds - expected)).toBeLessThan(0.05);
  });

  test('a WebM with a video track is reported as video', () => {
    expect(measure('video.webm', samples.webm(8, { video: true })).hasVideo).toBe(true);
  });

  // KNOWN GAP (both 12.3.2 and 12.5.0): the Matroska parser reads only the header Duration and skips clusters, so a WebM without it
  // (Chrome MediaRecorder output) cannot be measured and is refused as unreadable. Must be solved before in-browser recording ships.
  test('a WebM without a header Duration (Chrome MediaRecorder style) is AUDIO_UNREADABLE', () => {
    expect(measure('no-header-duration-12.webm', samples.webm(12, { headerDuration: false }))).toEqual({ error: 'AUDIO_UNREADABLE' });
  });
});
