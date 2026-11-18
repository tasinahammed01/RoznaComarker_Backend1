'use strict';
// Audio + speech-to-text, stage 5: the private playback route GET /api/audio/submissions/:submissionId/media (the student who owns it and the
// owning teacher; 404 for everyone else), Range requests, headers, and the teacher-only download. Never served from a static mount.
process.env.JWT_SECRET = 'audio-playback-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/audio-playback-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

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
const Membership = require('../src/models/membership.model');
const AudioRecording = require('../src/models/AudioRecording');
const File = require('../src/models/File');

const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const binary = (res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
let f, made;
const media = (token, headers = {}, id = made.submission._id) => request(app).get(`/api/audio/submissions/${id}/media`).set({ ...(token ? auth(token) : {}), ...headers })
  .buffer(true).parse(binary);

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  made = await makeAudioSubmission(f, { seconds: 6 });
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

describe('who may listen', () => {
  test('the student who owns it and the owning teacher: 200 with the bytes', async () => {
    for (const token of [f.student.token, f.teacher.token]) {
      const res = await media(token);
      expect(res.status).toBe(200);
      expect(Buffer.compare(res.body, made.bytes)).toBe(0);
    }
  });

  test('another student, another teacher, a student of the same class who does not own it: 404 with no bytes', async () => {
    const classmate = await require('./helpers/speakingFixtures').person('student', 'classmate');
    await Membership.create({ student: classmate.user._id, class: f.klass._id, status: 'active' });
    for (const token of [f.otherStudent.token, f.otherTeacher.token, classmate.token]) {
      const res = await media(token);
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/json/);
      expect(res.body.toString('latin1')).not.toContain('RIFF');
    }
  });

  test('signed out: 401', async () => {
    expect((await media(null)).status).toBe(401);
  });

  test('an essay submission id or an unknown id: 404', async () => {
    expect((await media(f.teacher.token, {}, new mongoose.Types.ObjectId())).status).toBe(404);
    expect((await media(f.teacher.token, {}, 'not-an-id')).status).toBe(404);
  });

  test('the audio file missing on disk, deleted, or outside the audio folder: 404', async () => {
    fs.unlinkSync(made.absolute);
    expect((await media(f.teacher.token)).status).toBe(404);
    made = await makeAudioSubmission({ ...f, student: (await require('./helpers/speakingFixtures').person('student', 's2')) }, { seconds: 6 });
    await AudioRecording.updateOne({ _id: made.recording._id }, { $set: { audioDeletedAt: new Date() } });
    expect((await media(f.teacher.token)).status).toBe(404);
    await AudioRecording.updateOne({ _id: made.recording._id }, { $set: { audioDeletedAt: null } });
    await File.updateOne({ _id: made.file._id }, { $set: { path: 'uploads/../package.json' } });
    expect((await media(f.teacher.token)).status).toBe(404);
  });

  test('while AUDIO_STT_ENABLED is off: 404 before sign-in', async () => {
    delete process.env.AUDIO_STT_ENABLED;
    expect((await media(f.teacher.token)).status).toBe(404);
  });
});

describe('headers', () => {
  test('explicit Content-Type from the stored (sniffed) format, inline, private no-store, nosniff, ranges accepted', async () => {
    const res = await media(f.student.token);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['content-disposition']).toBe('inline; filename="recording.wav"');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(Number(res.headers['content-length'])).toBe(made.bytes.length);
    expect(res.headers['content-disposition']).not.toContain(made.file.filename);
  });

  test('the content type is the stored one even if the File record says otherwise', async () => {
    await AudioRecording.updateOne({ _id: made.recording._id }, { $set: { contentType: 'audio/webm' } });
    const res = await media(f.student.token);
    expect(res.headers['content-type']).toBe('audio/webm');
    expect(res.headers['content-disposition']).toBe('inline; filename="recording.webm"');
  });
});

describe('Range', () => {
  const size = () => made.bytes.length;
  test.each([
    ['bytes=0-99', 0, 99],
    ['bytes=100-', 100, null],
    ['bytes=-50', null, null],
    ['bytes=10-999999999', 10, null]
  ])('%s: 206 with the right slice', async (range, start, end) => {
    const res = await media(f.student.token, { Range: range });
    expect(res.status).toBe(206);
    const s = start === null ? size() - 50 : start;
    const e = end === null ? size() - 1 : end;
    expect(res.headers['content-range']).toBe(`bytes ${s}-${e}/${size()}`);
    expect(Number(res.headers['content-length'])).toBe(e - s + 1);
    expect(Buffer.compare(res.body, made.bytes.subarray(s, e + 1))).toBe(0);
    expect(res.headers['content-type']).toBe('audio/wav');
  });

  test.each([['bytes=999999999-'], ['bytes=50-10'], ['bytes=-0']])('%s: 416 with the size', async (range) => {
    const res = await media(f.student.token, { Range: range });
    expect(res.status).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${size()}`);
  });

  test.each([['items=0-10'], ['bytes=0-10,20-30'], ['bytes=abc']])('%s (not a single byte range): the whole file, 200', async (range) => {
    const res = await media(f.student.token, { Range: range });
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(size());
  });

  test('HEAD: the headers and no body', async () => {
    const res = await request(app).head(`/api/audio/submissions/${made.submission._id}/media`).set(auth(f.student.token));
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(size());
    expect(res.headers['content-type']).toBe('audio/wav');
  });
});

describe('download (teacher only)', () => {
  const download = token => request(app).get(`/api/audio/submissions/${made.submission._id}/download`).set(auth(token)).buffer(true).parse(binary);
  test('the owning teacher: an attachment with a neutral name', async () => {
    const res = await download(f.teacher.token);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="speaking-${made.submission._id}.wav"`);
    expect(res.headers['content-type']).toBe('audio/wav');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(Buffer.compare(res.body, made.bytes)).toBe(0);
  });

  test('the student who owns it, other teachers and other students: 404', async () => {
    for (const token of [f.student.token, f.otherTeacher.token, f.otherStudent.token]) expect((await download(token)).status).toBe(404);
  });
});

describe('never from a static mount', () => {
  test('the stored path and file name are not reachable under /uploads, /files or the static folders', async () => {
    const stored = made.file.path.replace(/\\/g, '/');
    const name = made.file.filename;
    for (const url of [`/${stored}`, `/uploads/audio/${name}`, `/files/audio/${name}`, `/uploads/${name}`, `/api/files/audio/${name}`]) {
      for (const token of [null, f.teacher.token, f.student.token]) {
        const res = await request(app).get(url).set(token ? auth(token) : {}).buffer(true).parse(binary);
        expect({ url, status: res.status, riff: res.body.toString('latin1').includes('RIFF') }).toEqual({ url, status: res.status, riff: false });
      }
    }
  });
});
