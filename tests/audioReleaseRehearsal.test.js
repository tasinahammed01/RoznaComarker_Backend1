'use strict';
// Stage 11: release rehearsal, in process.
// A. AUDIO_STT_ENABLED unset (the deploy state): every audio and speaking route answers the hidden-feature 404 (same body, signed in or not),
//    the audio worker does not start, speaking assignments cannot be created, and the essay guest page still opens.
// B. AUDIO_STT_ENABLED=true with mocks: the speaking flows end to end, once each: a student's recording, a guest's recording through the guest
//    link, and a recording a teacher uploads with "Save and send": upload, transcription (fake provider), marking (fake model), results,
//    playback, emails (mocked). No real network call is possible (the global fetch is a tripwire).
process.env.JWT_SECRET = 'audio-release-rehearsal-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/audio-rehearsal-${process.pid}`;
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
jest.mock('../src/services/audio/duration', () => {
  const actual = jest.requireActual('../src/services/audio/duration');
  const measureAudioDuration = jest.fn(async (filePath) => {
    const buf = require('fs').readFileSync(filePath);
    return { durationSeconds: buf.readUInt32LE(40) / buf.readUInt32LE(28), hasVideo: false };
  });
  return { ...actual, measureAudioDuration };
});
jest.mock('../src/services/email.service', () => ({
  sendTeacherUploadFeedbackEmail: jest.fn(async () => ({ success: true })),
  sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })),
  sendTeacherRecoveryEmail: jest.fn(async () => ({ success: true }))
}));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 100000 }),
    createEmailRateLimiter: options => original.createEmailRateLimiter({ ...options, limit: 100000 }) };
});
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const email = require('../src/services/email.service');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const processing = require('../src/services/audio/processing');
const assessment = require('../src/services/audio/speakingAssessment.service');
const deepgram = require('../src/services/audio/stt/deepgram');
const guestResults = require('../src/services/guestResultNotification.service');
const teacherUploadEmail = require('../src/services/teacherUploadEmail.service');
const notice = require('../src/config/speakingGuestNotice');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const ANSWER = 'My town is next to a wide river and there are many old bridges. On weekends people walk along the river and buy fresh fish. '
  + 'The market opens early and the streets are busy with bicycles. In the evening families sit outside and talk with their neighbours. '
  + 'If I could change one thing, I would build a second bridge for buses and bicycles.';
let f;

/** A Deepgram-shaped answer for ANSWER (the fixture's shape, its words replaced), normalised as the adapter does. */
function fakeTranscribe() {
  const words = ANSWER.split(/\s+/).map((punctuated, index) => ({ word: punctuated.replace(/[^\w']/g, '').toLowerCase(), punctuated_word: punctuated,
    start: index * 0.4, end: index * 0.4 + 0.35, confidence: 0.95 }));
  const body = JSON.parse(JSON.stringify(FIXTURE));
  Object.assign(body.results.channels[0].alternatives[0], { transcript: ANSWER, words });
  delete body.results.utterances;
  return jest.fn(async () => ({ transcript: deepgram.normalize(body), attempts: [{ provider: 'deepgram', outcome: 'ok', code: null }], fallbackUsed: false }));
}
/** The worker's two steps for one recording: transcription (fake provider), then marking (fake model). */
async function transcribeAndMark(recordingId) {
  expect(await processing.processAudioRecording(recordingId, { transcribe: fakeTranscribe() })).toEqual(expect.objectContaining({ status: 'ready' }));
  await assessment.enqueueAssessment(recordingId);
  return assessment.runSpeakingAssessment(recordingId, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(h.output()) });
}
const recordingOf = async id => (await Submission.findById(id).select('+audioRecording').lean()).audioRecording;

/** Every route of the routers mounted under these prefixes (read from app.js and the route files, as the guard inventory does). */
function featureRoutes() {
  const src = path.join(__dirname, '..', 'src');
  const appText = fs.readFileSync(path.join(src, 'app.js'), 'utf8');
  const out = [];
  for (const mount of appText.matchAll(/app\.use\(\s*['"](\/api\/(?:audio|speaking|guest\/speaking)[^'"]*)['"],\s*require\(['"]\.\/routes\/([\w.\-/]+)['"]\)\s*\)/g)) {
    const text = fs.readFileSync(path.join(src, 'routes', mount[2].endsWith('.js') ? mount[2] : `${mount[2]}.js`), 'utf8');
    for (const m of text.matchAll(/router\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/g)) out.push([m[1], `${mount[1]}${m[2] === '/' ? '' : m[2]}`]);
  }
  return out;
}
const fill = route => route.replace(/:(\w+)/g, (_, name) => (/Id$/.test(name) ? 'a'.repeat(24) : 'x'.repeat(36)));

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  await AudioRecording.createIndexes(); await AudioUsageLedger.createIndexes(); await Submission.createIndexes();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  delete process.env.AUDIO_STT_ENABLED;
  f = await seedSpeaking();
  await Assignment.updateMany({}, { $set: { allowGuestSubmission: true } });
  await h.personalCredits(f.teacher.user, 20);
  jest.clearAllMocks();
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

describe('A. deployed with AUDIO_STT_ENABLED unset', () => {
  test('every audio and speaking route answers the hidden-feature 404 (signed in as a teacher, a student, or not at all)', async () => {
    const routes = featureRoutes();
    expect(routes.length).toBe(19);   // every route of /api/audio, /api/speaking (and its teacher uploads) and /api/guest/speaking
    expect(routes.map(([, route]) => route)).toEqual(expect.arrayContaining(['/api/audio/config', '/api/speaking/:assignmentId', '/api/guest/speaking/assignments/:qrToken/submit',
      '/api/speaking/assignments/:assignmentId/teacher-uploads']));
    for (const [method, route] of routes) {
      for (const headers of [auth(f.teacher.token), auth(f.student.token), {}]) {
        const res = await request(app)[method](fill(route)).set(headers);
        expect({ route: `${method} ${route}`, status: res.status, body: res.body }).toEqual({ route: `${method} ${route}`, status: 404, body: NOT_FOUND });
      }
    }
  });

  test('the audio worker does not start, and the server starts it only through the flag check', () => {
    expect(processing.startAudioWorkerIfEnabled({})).toBeNull();
    expect(processing.startAudioWorkerIfEnabled({ AUDIO_STT_ENABLED: 'false' })).toBeNull();
    const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
    expect(server).toContain("require('./services/audio/processing').startAudioWorkerIfEnabled()");
    expect(server).not.toMatch(/startAudioWorker\(/);
  });

  test('a speaking assignment cannot be created; an essay assignment and the essay guest page work as before', async () => {
    const deadline = new Date(Date.now() + 86400000).toISOString();
    const speaking = await request(app).post('/api/assignments').set(auth(f.teacher.token)).send({ title: 'Talk', classId: String(f.klass._id), deadline,
      instructions: 'Speak for two minutes.', resourceType: 'speaking' });
    expect(speaking.status).toBeGreaterThanOrEqual(400);
    expect(await Assignment.countDocuments({ title: 'Talk' })).toBe(0);
    const essay = await request(app).post('/api/assignments').set(auth(f.teacher.token)).send({ title: 'River essay 2', classId: String(f.klass._id), deadline,
      instructions: 'Write about the river.', writingType: 'essay', resourceType: 'essay' });
    expect(essay.status).toBeLessThan(300);
    const guestPage = await request(app).get(`/api/guest/assignments/${f.essay.qrToken}`);
    expect(guestPage.status).toBe(200);
    expect(guestPage.body.data.title).toBe('River essay');
  });
});

describe('B. AUDIO_STT_ENABLED=true, with mocks: the speaking flows end to end', () => {
  beforeEach(() => { process.env.AUDIO_STT_ENABLED = 'true'; });

  test('a class student: upload, transcription, marking, the result for the student and the teacher, playback', async () => {
    const upload = await request(app).post(`/api/speaking/${f.assignment._id}`).set(auth(f.student.token)).set('Idempotency-Key', `rec_${crypto.randomUUID().replace(/-/g, '')}`)
      .attach('audio', samples.wav(20), { filename: 'answer.wav', contentType: 'audio/wav' });
    expect(upload.status).toBe(201);
    const id = upload.body.data.id;
    expect((await transcribeAndMark(await recordingOf(id))).status).toBe('completed');
    const student = await request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(f.student.token));
    expect(student.body.data).toEqual(expect.objectContaining({ state: 'ready', assessedText: expect.stringContaining('My town is next to a wide river') }));
    expect(student.body.data.result.overallScore).toEqual(expect.any(Number));
    const teacher = await request(app).get(`/api/speaking/submissions/${id}/result`).set(auth(f.teacher.token));
    expect(teacher.body.data.state).toBe('ready');
    const play = await request(app).get(`/api/audio/submissions/${id}/media`).set(auth(f.student.token)).set('Range', 'bytes=0-9');
    expect(play.status).toBe(206);
    expect(play.headers['x-content-type-options']).toBe('nosniff');
  });

  test('a guest through the guest link: consent, upload, transcription, marking, the result email and the guest result page', async () => {
    const upload = await request(app).post(`/api/guest/speaking/assignments/${f.assignment.qrToken}/submit`).set('Idempotency-Key', crypto.randomBytes(24).toString('hex'))
      .field('name', 'Dee Guest').field('email', 'dee.guest@example.com').field('consent', 'true').field('consentVersion', notice.SPEAKING_GUEST_NOTICE_VERSION)
      .attach('audio', samples.wav(20), { filename: 'answer.wav', contentType: 'audio/wav' });
    expect(upload.status).toBe(200);
    const link = new URL(upload.body.data.returnUrl);
    const id = link.pathname.split('/').pop();
    expect((await transcribeAndMark(await recordingOf(id))).status).toBe('completed');
    await guestResults.run();
    expect(email.sendGuestSubmissionEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'dee.guest@example.com', resultReady: true, kind: 'speaking' }));
    const page = await request(app).get(`/api/guest/speaking/submissions/${id}`).set('X-Guest-Token', link.hash.slice(1));
    expect(page.status).toBe(200);
    expect(page.body.data.result.state).toBe('ready');
  });

  test('a teacher uploads for a class member with "Save and send": transcription, marking, then the feedback email', async () => {
    const upload = await request(app).post(`/api/speaking/assignments/${f.assignment._id}/teacher-uploads`).set(auth(f.teacher.token))
      .field('name', 'Ana Lima').field('email', f.student.user.email).field('requestKey', crypto.randomUUID()).field('batchId', 'batch-rehearsal').field('send', 'true')
      .attach('audio', samples.wav(20), { filename: 'answer.wav', contentType: 'audio/wav' });
    expect(upload.status).toBe(200);
    const id = upload.body.data.item.submissionId;
    expect((await transcribeAndMark(await recordingOf(id))).status).toBe('completed');
    await teacherUploadEmail.run();
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'speaking', to: f.student.user.email }));
  });
});
