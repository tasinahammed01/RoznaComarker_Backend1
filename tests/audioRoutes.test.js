'use strict';
// /api/audio over HTTP, stage 0: the feature switch and the config endpoint. While AUDIO_STT_ENABLED is off, every /api/audio route answers
// 404 with the same body as the reference-files routes, before sign-in is checked. The mount in app.js changes nothing for any other route.
process.env.JWT_SECRET = 'audio-routes-test-secret';
process.env.NODE_ENV = 'test';
delete process.env.AUDIO_STT_ENABLED;

const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');

const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const auth = token => ({ Authorization: `Bearer ${token}` });
let teacherToken, studentToken;

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  delete process.env.AUDIO_STT_ENABLED;
  delete process.env.REFERENCE_FILES_ENABLED;
  const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
  const student = await User.create({ firebaseUid: crypto.randomUUID(), email: 'student@example.com', role: 'student' });
  teacherToken = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  studentToken = signTestJwt({ id: student._id, role: 'student', firebaseUid: student.firebaseUid });
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

const PROBES = [
  ['get', '/api/audio/config'], ['get', '/api/audio'], ['get', '/api/audio/anything'], ['post', '/api/audio/recordings'],
  ['put', '/api/audio/recordings/abc'], ['delete', '/api/audio/recordings/abc'], ['patch', '/api/audio/x/y/z']
];

describe('feature off (default)', () => {
  test.each(PROBES)('%s %s answers 404 signed out, as a teacher and as a student', async (method, url) => {
    for (const headers of [{}, auth(teacherToken), auth(studentToken)]) {
      const res = await request(app)[method](url).set(headers);
      expect({ url, status: res.status, body: res.body }).toEqual({ url, status: 404, body: NOT_FOUND });
    }
  });

  test('the 404 is the same as a disabled reference-files route', async () => {
    const reference = await request(app).get('/api/reference-files/classes/abc').set(auth(teacherToken));
    const audio = await request(app).get('/api/audio/config').set(auth(teacherToken));
    expect(reference.status).toBe(404);
    expect(audio.status).toBe(reference.status);
    expect(audio.body).toEqual(reference.body);
  });

  test('the switch is read per request (turning it on needs no restart of the router)', async () => {
    expect((await request(app).get('/api/audio/config').set(auth(teacherToken))).status).toBe(404);
    process.env.AUDIO_STT_ENABLED = 'true';
    expect((await request(app).get('/api/audio/config').set(auth(teacherToken))).status).toBe(200);
  });
});

describe('feature on', () => {
  beforeEach(() => { process.env.AUDIO_STT_ENABLED = 'true'; });

  test('config needs sign-in', async () => {
    const res = await request(app).get('/api/audio/config');
    expect(res.status).toBe(401);
  });

  test('config is teacher-only in this stage (students get 403)', async () => {
    const res = await request(app).get('/api/audio/config').set(auth(studentToken));
    expect(res.status).toBe(403);
  });

  test('a teacher gets the enabled flag and the limits only', async () => {
    process.env.DEEPGRAM_API_KEY = 'dg-test-value-not-real';
    try {
      const res = await request(app).get('/api/audio/config').set(auth(teacherToken));
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toContain('no-store');
      expect(res.body).toEqual({ success: true, data: { enabled: true, maxFileBytes: 41943040, maxDurationSeconds: 420, minDurationSeconds: 5,
        dailyMinutesPerTeacher: 120, monthlyMinutesPerTeacher: 1500 } });
      expect(JSON.stringify(res.body)).not.toContain('dg-test-value-not-real');
    } finally { delete process.env.DEEPGRAM_API_KEY; }
  });

  test('no other audio route exists yet: unknown paths are 404 (upload routes arrive in a later stage)', async () => {
    for (const [method, url] of PROBES.filter(([, url]) => url !== '/api/audio/config')) {
      const res = await request(app)[method](url).set(auth(teacherToken));
      expect({ url, status: res.status }).toEqual({ url, status: 404 });
    }
  });
});

describe('regression: the mount changes nothing for other routes', () => {
  test.each([false, true])('with AUDIO_STT_ENABLED=%p other routes answer exactly as before', async (enabled) => {
    if (enabled) process.env.AUDIO_STT_ENABLED = 'true';
    const health = await request(app).get('/api/health');
    expect(health.status).toBe(200);
    const unknown = await request(app).get('/api/no-such-route-here').set(auth(teacherToken));
    expect(unknown.status).toBe(404);
    expect(unknown.body.message).toBe('Route not found');
    // A path that only starts like the audio mount is not captured by it.
    const lookalike = await request(app).get('/api/audiobooks').set(auth(teacherToken));
    expect(lookalike.status).toBe(404);
    expect(lookalike.body.message).toBe('Route not found');
    const referenceConfig = await request(app).get('/api/reference-files/config').set(auth(teacherToken));
    expect(referenceConfig.status).toBe(200);
    expect(referenceConfig.body).toEqual({ success: true, data: { enabled: false } });
    const me = await request(app).get('/api/reference-files/config');
    expect(me.status).toBe(401);
  });

  test('the audio router is mounted once, at /api/audio, with one app.use line', () => {
    const fs = require('fs');
    const path = require('path');
    const text = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');
    expect(text.match(/audio\.routes/g)).toHaveLength(1);
    expect(text).toMatch(/^app\.use\('\/api\/audio', require\('\.\/routes\/audio\.routes'\)\);$/m);
  });
});
