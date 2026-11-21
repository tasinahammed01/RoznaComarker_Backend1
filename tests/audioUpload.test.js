'use strict';
// Audio + speech-to-text, stage 3: upload validation (middlewares/audioUpload.middleware.js) through a TEST-ONLY express app: no upload route
// is mounted in the real app yet. Synthetic bytes only. Duration measuring is injected (the real library is covered in audioDuration.test.js).
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'audio-upload-test-secret';
process.env.UPLOAD_BASE_PATH = `uploads/audio-upload-test-${process.pid}`;
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const request = require('supertest');

const { audioUpload, tooLargeMessage } = require('../src/middlewares/audioUpload.middleware');
const storage = require('../src/services/audio/storage');
const policy = require('../src/services/audio/policy');

const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const EXACT_413 = 'This recording is too large (40 MB max) or longer than 7 minutes. Save it as MP3 or M4A, or record in mono, and upload it again.';

const pad = (head, size = 2048) => Buffer.concat([head, Buffer.alloc(Math.max(0, size - head.length), 0)]);
const BYTES = {
  mp3Id3: pad(Buffer.from('ID3\x04\x00\x00\x00\x00\x00\x00', 'latin1')),
  mp3Frame: pad(Buffer.from([0xff, 0xfb, 0x90, 0x64])),
  m4a: pad(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A \x00\x00\x00\x00', 'latin1')])),
  webm: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from('webm', 'latin1')])),
  ogg: pad(Buffer.from('OggS\x00\x02', 'latin1')),
  wav: pad(Buffer.concat([Buffer.from('RIFF\x24\x08\x00\x00WAVE', 'latin1'), Buffer.from('fmt ', 'latin1')])),
  png: pad(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  flac: pad(Buffer.from('fLaC', 'latin1')),
  aacAdts: pad(Buffer.from([0xff, 0xf1, 0x50, 0x80])),
  matroska: pad(Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0xa3, 0x42, 0x82, 0x88]), Buffer.from('matroska', 'latin1')])),
  riffAvi: pad(Buffer.from('RIFF\x24\x08\x00\x00AVI ', 'latin1')),
  text: pad(Buffer.from('hello, this is not audio at all'))
};

let measure, handler, providerCall;
function testApp() {
  const app = express();
  app.post('/upload', audioUpload({ measureDuration: (...args) => measure(...args) }), (req, res, next) => handler(req, res, next));
  app.use((err, _req, res, _next) => res.status(500).json({ success: false, code: 'HANDLER_FAILED' }));
  return app;
}
const app = testApp();
const send = (buffer, filename, contentType, field = 'audio') => request(app).post('/upload').attach(field, buffer, { filename, contentType });
const stored = () => (fs.existsSync(storage.audioRoot()) ? fs.readdirSync(storage.audioRoot()) : []);

beforeEach(() => {
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  delete process.env.AUDIO_MAX_FILE_BYTES;
  delete process.env.AUDIO_MAX_DURATION_SECONDS;
  providerCall = jest.fn();
  measure = jest.fn(async () => ({ durationSeconds: 30, hasVideo: false }));
  handler = jest.fn((req, res) => { providerCall(req.audioUpload.path); req.audioUpload.commit(); res.json({ success: true, data: { ...req.audioUpload, path: undefined } }); });
});
afterAll(() => fs.rmSync(uploadRoot, { recursive: true, force: true }));

describe('accepted formats: bytes, MIME type and extension must agree', () => {
  test.each([
    ['mp3Id3', 'answer.mp3', 'audio/mpeg', 'mp3', 'audio/mpeg', '.mp3'],
    ['mp3Frame', 'answer.mp3', 'audio/mp3', 'mp3', 'audio/mpeg', '.mp3'],
    ['m4a', 'voice memo.m4a', 'audio/x-m4a', 'mp4', 'audio/mp4', '.m4a'],
    ['m4a', 'answer.m4a', 'audio/mp4', 'mp4', 'audio/mp4', '.m4a'],
    ['m4a', 'answer.mp4', 'video/mp4', 'mp4', 'audio/mp4', '.m4a'],
    ['webm', 'recording.webm', 'audio/webm', 'webm', 'audio/webm', '.webm'],
    ['webm', 'recording.webm', 'audio/webm;codecs=opus', 'webm', 'audio/webm', '.webm'],
    ['webm', 'recording.webm', 'video/webm', 'webm', 'audio/webm', '.webm'],
    ['ogg', 'answer.ogg', 'audio/ogg', 'ogg', 'audio/ogg', '.ogg'],
    ['ogg', 'answer.opus', 'audio/opus', 'ogg', 'audio/ogg', '.ogg'],
    ['wav', 'answer.WAV', 'audio/wav', 'wav', 'audio/wav', '.wav'],
    ['wav', 'answer.wav', 'audio/x-wav', 'wav', 'audio/wav', '.wav']
  ])('%s as %p (%s) is accepted as %s', async (kind, filename, mime, format, canonicalMime, extension) => {
    const res = await send(BYTES[kind], filename, mime);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ format, contentType: canonicalMime, sizeBytes: BYTES[kind].length, durationSeconds: 30, hasVideo: false });
    expect(res.body.data.filename).toMatch(new RegExp(`^[0-9a-f-]{36}\\${extension}$`));
    expect(res.body.data.sha256).toBe(crypto.createHash('sha256').update(BYTES[kind]).digest('hex'));
    expect(res.body.data.storedPath).toBe(storage.storedPathFor(res.body.data.filename));
    expect(stored()).toEqual([res.body.data.filename]);
    expect(measure).toHaveBeenCalledTimes(1);
  });

  test('the original file name is never used on disk, even a hostile one', async () => {
    const res = await send(BYTES.mp3Id3, '../../../etc/evil name.mp3', 'audio/mpeg');
    expect(res.status).toBe(200);
    expect(stored()).toEqual([res.body.data.filename]);
    expect(JSON.stringify(res.body)).not.toContain('evil');
  });
});

describe('refused types (400), and the stored file is deleted', () => {
  test.each([
    ['png', 'photo.png', 'image/png', 'AUDIO_TYPE_UNSUPPORTED'],
    ['flac', 'answer.flac', 'audio/flac', 'AUDIO_TYPE_UNSUPPORTED'],
    ['text', 'notes.mp3', 'audio/mpeg', 'AUDIO_TYPE_MISMATCH'],          // renamed text: the bytes are not audio
    ['aacAdts', 'answer.mp3', 'audio/mpeg', 'AUDIO_TYPE_MISMATCH'],      // raw AAC is not an MP3 frame
    ['matroska', 'video.webm', 'video/webm', 'AUDIO_TYPE_MISMATCH'],     // EBML, but not a WebM document
    ['riffAvi', 'clip.wav', 'audio/wav', 'AUDIO_TYPE_MISMATCH'],         // RIFF, but not WAVE
    ['mp3Id3', 'answer.wav', 'audio/wav', 'AUDIO_TYPE_MISMATCH'],        // MP3 bytes with a WAV name and type
    ['wav', 'answer.wav', 'audio/mpeg', 'AUDIO_TYPE_MISMATCH'],          // WAV bytes and name, MP3 type
    ['wav', 'answer.mp3', 'audio/wav', 'AUDIO_TYPE_MISMATCH'],           // WAV bytes and type, MP3 name
    ['wav', 'answer', 'audio/wav', 'AUDIO_TYPE_UNSUPPORTED'],            // no extension
    ['webm', 'recording.webm', 'application/octet-stream', 'AUDIO_TYPE_UNSUPPORTED']
  ])('%s as %p (%s): %s', async (kind, filename, mime, code) => {
    const res = await send(BYTES[kind], filename, mime);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code });
    expect(res.body.message).not.toContain(filename);
    expect(stored()).toEqual([]);
    expect(measure).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test.each([
    ['no file', r => r.field('requestId', 'abc'), 'AUDIO_FILE_REQUIRED'],
    ['an empty file', r => r.attach('audio', Buffer.alloc(0), { filename: 'a.mp3', contentType: 'audio/mpeg' }), 'AUDIO_FILE_EMPTY'],
    ['two files', r => r.attach('audio', BYTES.mp3Id3, { filename: 'a.mp3', contentType: 'audio/mpeg' }).attach('audio', BYTES.wav, { filename: 'b.wav', contentType: 'audio/wav' }), 'AUDIO_ONE_FILE'],
    ['the wrong field name', r => r.attach('files', BYTES.mp3Id3, { filename: 'a.mp3', contentType: 'audio/mpeg' }), 'AUDIO_ONE_FILE']
  ])('%s: 400 %s, nothing kept', async (_name, build, code) => {
    const res = await build(request(app).post('/upload'));
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code });
    expect(stored()).toEqual([]);
  });
});

describe('too large: JSON 413 with the agreed message', () => {
  test('the default message is exactly the agreed text', () => {
    expect(tooLargeMessage(policy.readLimits({}).limits)).toBe(EXACT_413);
  });

  test('a file over AUDIO_MAX_FILE_BYTES: 413, the message, and the partial file is deleted', async () => {
    process.env.AUDIO_MAX_FILE_BYTES = String(1024 * 1024);           // the smallest allowed limit, to keep the test small
    const res = await send(pad(BYTES.mp3Id3.subarray(0, 10), 1024 * 1024 + 4096), 'long.mp3', 'audio/mpeg');
    expect(res.status).toBe(413);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body).toEqual({ success: false, code: 'AUDIO_TOO_LARGE',
      message: 'This recording is too large (1 MB max) or longer than 7 minutes. Save it as MP3 or M4A, or record in mono, and upload it again.' });
    expect(stored()).toEqual([]);
    expect(measure).not.toHaveBeenCalled();
  });

  test('a file exactly at the limit is accepted; one byte more is refused', async () => {
    process.env.AUDIO_MAX_FILE_BYTES = String(1024 * 1024);
    expect((await send(pad(BYTES.mp3Id3.subarray(0, 10), 1024 * 1024), 'ok.mp3', 'audio/mpeg')).status).toBe(200);
    const over = await send(pad(BYTES.mp3Id3.subarray(0, 10), 1024 * 1024 + 1), 'over.mp3', 'audio/mpeg');
    expect(over.status).toBe(413);
    expect(over.body.code).toBe('AUDIO_TOO_LARGE');
  });
});

describe('duration is measured BEFORE any provider call', () => {
  test.each([
    [4.99, 422, 'AUDIO_TOO_SHORT'], [421.01, 413, 'AUDIO_TOO_LONG'], [3600, 413, 'AUDIO_TOO_LONG']
  ])('%p s: %i %s, the provider is never called, the file is deleted', async (seconds, status, code) => {
    measure = jest.fn(async () => ({ durationSeconds: seconds, hasVideo: false }));
    const res = await send(BYTES.webm, 'r.webm', 'audio/webm');
    expect(res.status).toBe(status);
    expect(res.body).toMatchObject({ success: false, code });
    if (code === 'AUDIO_TOO_LONG') expect(res.body.message).toBe(EXACT_413);
    expect(providerCall).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  test.each([5, 420, 421])('%p s is accepted', async (seconds) => {
    measure = jest.fn(async () => ({ durationSeconds: seconds, hasVideo: false }));
    expect((await send(BYTES.webm, 'r.webm', 'audio/webm')).status).toBe(200);
  });

  test('the duration is measured on the stored file, inside the audio folder', async () => {
    await send(BYTES.ogg, 'a.ogg', 'audio/ogg');
    const [filePath] = measure.mock.calls[0];
    expect(path.dirname(filePath)).toBe(storage.audioRoot());
  });

  test('a recording with a video track is refused (400)', async () => {
    measure = jest.fn(async () => ({ durationSeconds: 30, hasVideo: true }));
    const res = await send(BYTES.m4a, 'clip.mp4', 'video/mp4');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('AUDIO_HAS_VIDEO');
    expect(stored()).toEqual([]);
  });

  test.each([['AUDIO_UNREADABLE', 422], ['AUDIO_DURATION_UNAVAILABLE', 503]])('a measuring failure %s: %i, file deleted', async (code, status) => {
    measure = jest.fn(async () => { throw Object.assign(new Error('x'), { code }); });
    const res = await send(BYTES.wav, 'a.wav', 'audio/wav');
    expect(res.status).toBe(status);
    expect(res.body.code).toBe(code);
    expect(stored()).toEqual([]);
  });

  test('an unexpected measuring error is AUDIO_UNREADABLE, file deleted', async () => {
    measure = jest.fn(async () => { throw new Error('boom'); });
    expect((await send(BYTES.wav, 'a.wav', 'audio/wav')).body.code).toBe('AUDIO_UNREADABLE');
    expect(stored()).toEqual([]);
  });
});

describe('cleanup after validation: the next handler must commit the file to keep it', () => {
  test('not committed: deleted when the response finishes', async () => {
    handler = jest.fn((req, res) => res.status(409).json({ success: false }));
    expect((await send(BYTES.mp3Id3, 'a.mp3', 'audio/mpeg')).status).toBe(409);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stored()).toEqual([]);
  });

  test('the handler fails (next(error)): deleted', async () => {
    handler = jest.fn((_req, _res, next) => next(new Error('later stage failed')));
    expect((await send(BYTES.mp3Id3, 'a.mp3', 'audio/mpeg')).status).toBe(500);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stored()).toEqual([]);
  });

  test('committed: kept', async () => {
    const res = await send(BYTES.mp3Id3, 'a.mp3', 'audio/mpeg');
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(stored()).toEqual([res.body.data.filename]);
  });

  test('the client aborts mid-upload: the partial file is deleted', async () => {
    process.env.AUDIO_MAX_FILE_BYTES = String(5 * 1024 * 1024);
    const server = app.listen(0);
    try {
      await new Promise(resolve => {
        const http = require('http');
        const boundary = 'x-boundary';
        const req = http.request({ port: server.address().port, path: '/upload', method: 'POST',
          headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
        req.on('error', () => resolve());
        req.write(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="a.mp3"\r\nContent-Type: audio/mpeg\r\n\r\n`);
        req.write(pad(BYTES.mp3Id3.subarray(0, 10), 256 * 1024));
        setTimeout(() => { req.destroy(); resolve(); }, 100);
      });
      for (let i = 0; i < 40 && stored().length; i++) await new Promise(resolve => setTimeout(resolve, 50));
      expect(stored()).toEqual([]);
      expect(handler).not.toHaveBeenCalled();
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});

describe('logs', () => {
  test('a rejection logs codes only: never the original name', async () => {
    const lines = [];
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(level => jest.spyOn(console, level).mockImplementation((...a) => lines.push(a.join(' '))));
    try {
      await send(BYTES.text, 'secret-student-name.mp3', 'audio/mpeg');
      await send(BYTES.png, 'secret-student-name.png', 'image/png');
      measure = jest.fn(async () => ({ durationSeconds: 900, hasVideo: false }));
      await send(BYTES.webm, 'secret-student-name.webm', 'audio/webm');
    } finally { spies.forEach(spy => spy.mockRestore()); }
    const text = lines.join('\n');
    expect(text).toContain('audio_upload_rejected');
    expect(text).not.toContain('secret-student-name');
    expect(text).not.toContain(uploadRoot);
  });
});

describe('the audio folder is never served publicly', () => {
  const realApp = require('../src/app');
  const { signTestJwt } = require('./helpers/auth');
  const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
  const User = require('../src/models/user.model');
  let token;
  beforeAll(async () => {
    await connectInMemoryMongo();
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
    token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  });
  afterAll(disconnectInMemoryMongo);

  test('no express.static mount in app.js points at the audio folder (or at the uploads root)', () => {
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    const mounts = [...text.matchAll(/express\.static\(\s*path\.join\(\s*uploadsRoot,\s*"([^"]+)"\s*\)\s*\)/g)].map(m => m[1]);
    expect(mounts.sort()).toEqual(['avatars', 'class-banners', 'flashcards', 'templates']);
    expect(text.match(/express\.static\(/g)).toHaveLength(4);
  });

  test.each(['/uploads/audio/', '/files/audio/', '/uploads/avatars/../audio/', '/uploads/avatars/%2e%2e/audio/', '/api/audio/files/'])(
    'GET %s<stored file> never returns the bytes', async (prefix) => {
      const name = `${crypto.randomUUID()}.mp3`;
      fs.mkdirSync(storage.audioRoot(), { recursive: true });
      fs.writeFileSync(path.join(storage.audioRoot(), name), BYTES.mp3Id3);
      for (const headers of [{}, { Authorization: `Bearer ${token}` }]) {
        const res = await request(realApp).get(prefix + name).set(headers);
        expect(res.status).not.toBe(200);
        expect(Buffer.isBuffer(res.body) ? res.body.includes(Buffer.from('ID3')) : JSON.stringify(res.body || '').includes('ID3')).toBe(false);
      }
    });
});

describe('the existing upload middleware is unchanged', () => {
  test('same exports, image types only, 10 MB default', () => {
    const existing = require('../src/middlewares/upload.middleware');
    expect(Object.keys(existing).sort()).toEqual(['canonicalizeValidatedFile', 'detectSignatureKind', 'handleUploadError', 'setUploadType', 'upload',
      'validateUploadedFileSignature']);
    expect(existing.detectSignatureKind(BYTES.mp3Id3)).toBeNull();
    expect(existing.detectSignatureKind(BYTES.wav)).toBeNull();
  });
});
