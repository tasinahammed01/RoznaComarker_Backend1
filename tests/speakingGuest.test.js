'use strict';
// Stage 10a: guests for speaking assignments. The essay guest flow (guestSubmission.controller.js) mirrored for one recording: the assignment's
// guest link (qrToken), the same guest identity, request key and per-IP limits; the upload checks (type, size, duration); minutes, storage and
// credits on the teacher, credits checked before anything is kept (so before any speech-to-text spend); a required, versioned consent; the
// guest's own result and playback (404 for anyone else); the guest result email; the recovery link and the recovery portal.
// In-memory MongoDB; email.service is mocked; no transcription or AI provider is called (the global fetch is a tripwire; marking runs against an
// injected fake). The duration measurement is mocked as in speakingUpload.test.js.
process.env.JWT_SECRET = 'speaking-guest-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-guest-${process.pid}`;
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
jest.mock('../src/services/audio/duration', () => {
  const actual = jest.requireActual('../src/services/audio/duration');
  const measureAudioDuration = jest.fn(async (filePath) => {
    const buf = require('fs').readFileSync(filePath);
    if (buf.subarray(0, 4).toString('latin1') !== 'RIFF') throw Object.assign(new Error('unreadable'), { code: 'AUDIO_UNREADABLE' });
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
const { seedSpeaking, makeAudioSubmission, person } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const email = require('../src/services/email.service');
const User = require('../src/models/user.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const RecoveryToken = require('../src/models/RecoveryToken');
const RecoverySession = require('../src/models/RecoverySession');
const File = require('../src/models/File');
const storage = require('../src/services/audio/storage');
const usage = require('../src/services/audio/usage');
const access = require('../src/services/guestAccess.service');
const assessment = require('../src/services/audio/speakingAssessment.service');
const guestResults = require('../src/services/guestResultNotification.service');
const notice = require('../src/config/speakingGuestNotice');
const logger = require('../src/utils/logger');

jest.setTimeout(90000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const audioFiles = () => (fs.existsSync(storage.audioRoot()) ? fs.readdirSync(storage.audioRoot()) : []);
const storageMB = async id => (await User.findById(id).lean()).usage?.storageMB || 0;
const settle = (ms = 50) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async check => { for (let i = 0; i < 300; i++) { if (await check()) return; await settle(10); } throw new Error('timeout'); };
const key = () => crypto.randomBytes(24).toString('hex');
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
const DENIED = { success: false, code: 'GUEST_LINK_INVALID', message: 'This link is invalid or has expired. Request a new link.' };
const NOTICE = 'Your recording and its transcript are saved with your submission and shared with your teacher. The audio is sent to a speech-to-text '
  + 'service to create the transcript, and the result is marked with AI to help your teacher. It is kept until your teacher deletes the submission. '
  + 'If you are under 18, ask a parent or guardian before recording.';
// What a guest must never receive: provider/model/prompt names, hashes, leases, raw words, internal ids and fields, credits, the cap value.
const FORBIDDEN = /gemini|openrouter|openai|deepgram|speaking-assessment-prompt|[a-f0-9]{64}|attemptKey|leaseUntil|assessmentQueue|"words"|editedRevisions|scoringAudit|evaluationAttempts|evaluationJobId|evaluationProvider|evaluationModel|sourceHash|requestId|storageCharged|minutesChargedTo|accessHash|requestHash|normalizedEmail|consent|credit|uncappedScore|"cap"|teacherId|"teacher"|errorCode|runStatus/i;
let f;

const base = '/api/guest/speaking';
const entry = (qr = f.assignment.qrToken) => request(app).get(`${base}/assignments/${qr}`);
function submit({ qr = f.assignment.qrToken, idempotencyKey = key(), name = 'Dee Guest', address = 'dee.guest@example.com', consent = 'true',
  consentVersion = notice.SPEAKING_GUEST_NOTICE_VERSION, body = samples.wav(8), filename = 'answer.wav', type = 'audio/wav' } = {}) {
  const req = request(app).post(`${base}/assignments/${qr}/submit`);
  if (idempotencyKey) req.set('Idempotency-Key', idempotencyKey);
  req.field('name', name).field('email', address);
  if (consent !== null) req.field('consent', consent);
  if (consentVersion !== null) req.field('consentVersion', consentVersion);
  return req.attach('audio', body, { filename, contentType: type });
}
const tokenOf = link => new URL(link).hash.slice(1);
const idOf = link => new URL(link).pathname.split('/').pop();
const result = (id, token, headers = {}) => request(app).get(`${base}/submissions/${id}`).set(token ? { 'X-Guest-Token': token } : {}).set(headers);
const media = (id, token, headers = {}) => request(app).get(`${base}/submissions/${id}/media`).set(token ? { 'X-Guest-Token': token } : {}).set(headers);
async function expectNothingKept() {
  await settle();
  expect(await AudioRecording.countDocuments()).toBe(0);
  expect(await Submission.countDocuments({ sourceKind: 'audio' })).toBe(0);
  expect(await File.countDocuments({ type: 'audio' })).toBe(0);
  expect(audioFiles()).toEqual([]);
  expect(await storageMB(f.teacher.user._id)).toBe(0);
}
/** The transcription worker's result, stored as it stores it (no provider call). */
async function transcribed(recordingId, text) {
  await AudioRecording.collection.updateOne({ _id: recordingId }, { $set: { status: 'ready', readyAt: new Date(), derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text, fillers: [] }, assessorText: text, fluency: h.fluencyFor(text) }, transcriptSchemaVersion: 'audio-transcript-v1', wordTimingsAvailable: true },
  $unset: { processingQueue: 1 } });
}
async function mark(recordingId, reply = h.output()) {
  await assessment.enqueueAssessment(recordingId);
  return assessment.runSpeakingAssessment(recordingId, { env: h.TEST_ENV, fetchImpl: h.fakeOpenRouter(reply) });
}
const TEXT = 'My town is next to a wide river and there are many old bridges. On weekends people walk along the river and buy fresh fish. '
  + 'The market opens early and the streets are busy with bicycles. In the evening families sit outside and talk with their neighbours.';
/** A guest's speaking submission made through the real upload; returns { id, token, link, recordingId }. */
async function guestUpload(over = {}) {
  const res = await submit(over);
  expect(res.status).toBe(200);
  const link = res.body.data.returnUrl;
  const sub = await Submission.findById(idOf(link)).select('+audioRecording').lean();
  return { id: idOf(link), token: tokenOf(link), link, recordingId: sub.audioRecording, res };
}

beforeAll(async () => { await connectInMemoryMongo(); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  await AudioRecording.createIndexes(); await AudioUsageLedger.createIndexes(); await Submission.createIndexes();
  await Promise.all([RecoveryToken.init(), RecoverySession.init()]);
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await Assignment.updateMany({}, { $set: { allowGuestSubmission: true } });
  f.assignment = await Assignment.findById(f.assignment._id).lean();
  await h.personalCredits(f.teacher.user, 10);
  jest.clearAllMocks();
  for (const fn of Object.values(email)) fn.mockResolvedValue({ success: true });
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; jest.restoreAllMocks(); });

describe('the guest link of a speaking assignment', () => {
  test('entry: the assignment details, the recording limits and the versioned consent notice; nothing about the teacher or the class', async () => {
    const res = await entry();
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.body.data).toEqual({ kind: 'speaking', title: 'Describe your town', instructions: '', deadline: expect.any(String), allowGuestSubmission: true,
      limits: { maxRecordingSeconds: expect.any(Number), minDurationSeconds: expect.any(Number), maxFileBytes: expect.any(Number) },
      consent: { version: notice.SPEAKING_GUEST_NOTICE_VERSION, text: NOTICE } });
    expect(notice.SPEAKING_GUEST_NOTICE_TEXT).toBe(NOTICE);
    // No ids, no teacher or class field, no email: only the keys above (checked exactly) and the notice text.
    expect(JSON.stringify(res.body)).not.toMatch(/[a-fd]{24}|speaking-teacher@|"(teacher|class|qrToken)"/i);
  });

  test('refused the same way as essays: guests not allowed, an inactive assignment, an essay assignment here, an unknown token', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: false } });
    expect((await entry()).status).toBe(404);
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: true, isActive: false } });
    expect((await entry()).status).toBe(404);
    expect((await entry(f.essay.qrToken)).status).toBe(404);
    expect((await entry('no-such-token')).status).toBe(404);
  });

  test('the essay guest routes still refuse a speaking assignment (unchanged)', async () => {
    const essayEntry = await request(app).get(`/api/guest/assignments/${f.assignment.qrToken}`);
    expect(essayEntry.status).toBe(404);
    const essaySubmit = await request(app).post(`/api/guest/assignments/${f.assignment.qrToken}/submit`).set('Idempotency-Key', key())
      .field('name', 'Dee').field('email', 'dee@example.com').attach('files', samples.wav(8), { filename: 'a.wav', contentType: 'audio/wav' });
    expect(essaySubmit.status).toBe(404);
    await expectNothingKept();
  });

  test('switches: speech-to-text off -> the hidden-feature 404; guest submission off -> the essay 403', async () => {
    delete process.env.AUDIO_STT_ENABLED;
    const off = await entry();
    expect(off.status).toBe(404);
    expect(off.body).toEqual(NOT_FOUND);
    process.env.AUDIO_STT_ENABLED = 'true';
    process.env.GUEST_SUBMISSION_ENABLED = 'false';
    try {
      const guestsOff = await entry();
      expect(guestsOff.status).toBe(403);
      expect(guestsOff.body.code).toBe('GUEST_SUBMISSION_UNAVAILABLE');
    } finally { process.env.GUEST_SUBMISSION_ENABLED = 'true'; }
  });
});

describe('a guest uploads a recording', () => {
  test('saved as a guest audio submission; recording, file, storage and minutes on the teacher; consent stored (version and time); return link emailed', async () => {
    const before = Date.now();
    const { id, token, link, recordingId, res } = await guestUpload();
    expect(res.body.data).toEqual(expect.objectContaining({ received: true, emailSent: true }));
    expect(link).toMatch(/^https:\/\/school\.example\/guest\/speaking\/[a-f\d]{24}#[\w-]{43}$/);
    const sub = await Submission.findById(id).select('+guest.normalizedEmail +guest.consent +guestRequestKey').lean();
    expect(sub).toEqual(expect.objectContaining({ submissionMode: 'guest', sourceKind: 'audio', status: 'submitted', isLate: false, qrToken: f.assignment.qrToken }));
    expect(sub.guest).toEqual(expect.objectContaining({ displayName: 'Dee Guest', normalizedEmail: 'dee.guest@example.com' }));
    expect(sub.guest.consent).toEqual({ version: notice.SPEAKING_GUEST_NOTICE_VERSION, acceptedAt: expect.any(Date) });
    expect(sub.guest.consent.acceptedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(sub.student).toBeUndefined();
    // Consent is never read back unless asked for.
    expect((await Submission.findById(id).lean()).guest.consent).toBeUndefined();
    const recording = await AudioRecording.findById(recordingId).lean();
    for (const field of ['owner', 'storageChargedTo', 'minutesChargedTo']) expect(String(recording[field])).toBe(String(f.teacher.user._id));
    expect(recording.status).toBe('queued');
    const file = await File.findById(recording.audioFileId).lean();
    expect(file).toEqual(expect.objectContaining({ role: 'teacher', type: 'audio' }));
    expect(await storageMB(f.teacher.user._id)).toBeGreaterThan(0);
    expect(email.sendGuestSubmissionEmail).toHaveBeenCalledWith({ to: 'dee.guest@example.com', assignmentTitle: 'Describe your town', returnUrl: link, kind: 'speaking' });
    expect(email.sendTeacherSubmissionEmail).toHaveBeenCalledWith(expect.objectContaining({ to: f.teacher.user.email, studentName: 'Dee Guest' }));
    expect(await access.authorize(id, token)).toBeTruthy();
  });

  test('consent is required, with the current notice version: refused (400) and nothing kept', async () => {
    for (const over of [{ consent: null }, { consent: 'false' }, { consentVersion: null }, { consentVersion: 'speaking-guest-old' }]) {
      const res = await submit(over);
      expect(res.status).toBe(400);
      expect(res.body).toEqual(expect.objectContaining({ success: false, code: 'SPEAKING_CONSENT_REQUIRED' }));
    }
    await expectNothingKept();
    expect(email.sendGuestSubmissionEmail).not.toHaveBeenCalled();
  });

  test('the guest identity and the request key are checked as for essays: refused and nothing kept', async () => {
    expect((await submit({ name: '   ' })).status).toBe(400);
    expect((await submit({ address: 'not-an-email' })).status).toBe(400);
    const noKey = await submit({ idempotencyKey: null });
    expect(noKey.status).toBe(400);
    expect((await submit({ idempotencyKey: 'short' })).status).toBe(400);
    await expectNothingKept();
  });

  test('the upload checks apply (type, too short): refused, nothing kept', async () => {
    const wrongType = await submit({ body: Buffer.from('not audio at all, just text'), filename: 'notes.txt', type: 'text/plain' });
    expect(wrongType.status).toBe(400);
    expect(wrongType.body.code).toBe('AUDIO_TYPE_UNSUPPORTED');
    const short = await submit({ body: samples.wav(2) });
    expect(short.status).toBe(422);
    expect(short.body.code).toBe('AUDIO_TOO_SHORT');
    await expectNothingKept();
  });

  test('the same request key and recording: the first result once; the same key with another recording: refused', async () => {
    const idempotencyKey = key();
    const body = samples.wav(8);
    const first = await submit({ idempotencyKey, body });
    const again = await submit({ idempotencyKey, body });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(expect.objectContaining({ received: true, duplicate: true }));
    expect(await Submission.countDocuments({ sourceKind: 'audio' })).toBe(1);
    expect(await AudioRecording.countDocuments()).toBe(1);
    const other = await submit({ idempotencyKey, body: samples.wav(9) });
    expect(other.status).toBe(409);
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(1);
    expect(first.status).toBe(200);
  });

  test('no assessment credits: refused (the essay 403 and code) before anything is kept, so no speech-to-text is spent', async () => {
    await h.personalCredits(f.teacher.user, 0);
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('INSUFFICIENT_ASSESSMENT_CREDITS');
    await expectNothingKept();
  });

  test('the teacher\'s speech-to-text minutes used up: the fixed 429 before the file is read; nothing kept', async () => {
    jest.spyOn(usage, 'readUsage').mockResolvedValue({ capped: true, daySeconds: 0, monthSeconds: 0 });
    const res = await submit();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AUDIO_UPLOADS_UNAVAILABLE');
    await expectNothingKept();
  });

  test('the teacher\'s storage full: refused, nothing kept, the teacher\'s storage unchanged', async () => {
    await User.updateOne({ _id: f.teacher.user._id }, { $set: { 'usage.storageMB': 1e9 } });
    const res = await submit();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('TEACHER_STORAGE_FULL');
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(0);
    expect(audioFiles()).toEqual([]);
    expect(await storageMB(f.teacher.user._id)).toBe(1e9);
  });

  test('the speaking upload route refuses an essay assignment', async () => {
    const res = await submit({ qr: f.essay.qrToken });
    expect(res.status).toBe(404);
    await expectNothingKept();
  });

  test('the owning teacher sees it in their speaking view, with the guest\'s display name only', async () => {
    const { id } = await guestUpload();
    const view = await request(app).get(`/api/speaking/submissions/${id}`).set(auth(f.teacher.token));
    expect(view.status).toBe(200);
    expect(view.body.data).toEqual(expect.objectContaining({ studentName: 'Dee Guest', studentId: null }));
    expect(JSON.stringify(view.body)).not.toContain('dee.guest@example.com');
  });

  test('logs carry ids and codes only: never the name, the email, the token or a file name', async () => {
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'metric']) jest.spyOn(logger, level).mockImplementation(entry => { lines.push(JSON.stringify(entry)); });
    const { token } = await guestUpload({ filename: 'my-secret-answer.wav' });
    await submit({ consent: 'false' });
    const all = lines.join('\n');
    for (const secret of ['Dee Guest', 'dee.guest@example.com', 'my-secret-answer', token]) expect(all).not.toContain(secret);
  });
});

describe('marking a guest recording', () => {
  test('a guest recording is marked and charged once (the feedback is stored as a guest\'s, with no student id)', async () => {
    const { id, recordingId } = await guestUpload();
    await transcribed(recordingId, TEXT);
    const outcome = await mark(recordingId);
    expect(outcome).toEqual(expect.objectContaining({ status: 'completed' }));
    const sub = await Submission.findById(id).lean();
    expect(sub).toEqual(expect.objectContaining({ evaluationStatus: 'completed', assessmentStatus: 'complete' }));
    const feedback = await require('../src/models/SubmissionFeedback').findOne({ submissionId: id }).lean();
    expect(feedback).toEqual(expect.objectContaining({ submissionMode: 'guest', evaluationStatus: 'completed' }));
    expect(feedback.studentId).toBeUndefined();
  });
});

describe('the guest\'s own result and playback', () => {
  test('result: the assignment, the recording state and, once marked, the student result; nothing internal', async () => {
    const { id, token, recordingId } = await guestUpload();
    const waiting = await result(id, token);
    expect(waiting.status).toBe(200);
    expect(waiting.headers['cache-control']).toBe('private, no-store');
    expect(waiting.body.data).toEqual(expect.objectContaining({ kind: 'speaking', title: 'Describe your town', name: 'Dee Guest', uploadedByTeacher: false,
      recording: expect.objectContaining({ state: 'processing', mediaUrl: `/api/guest/speaking/submissions/${id}/media` }),
      result: expect.objectContaining({ state: 'transcribing', result: null }) }));
    await transcribed(recordingId, TEXT);
    await mark(recordingId, h.output({ corrections: [{ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'there are', occurrence: 1, suggestedText: 'there are', message: 'Fine.' }] }));
    const ready = await result(id, token);
    expect(ready.body.data.result).toEqual(expect.objectContaining({ state: 'ready', marksVisible: true, assessedText: TEXT,
      result: expect.objectContaining({ overallScore: expect.any(Number), criteria: expect.any(Array) }) }));
    expect(ready.body.data.recording.state).toBe('ready');
    expect(JSON.stringify(ready.body)).not.toMatch(FORBIDDEN);
    expect(JSON.stringify(ready.body)).not.toContain('dee.guest@example.com');
  });

  test('marks hidden by the teacher: no score in the guest result', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { showMarksToStudent: false } });
    const { id, token, recordingId } = await guestUpload();
    await transcribed(recordingId, TEXT);
    await mark(recordingId);
    const res = await result(id, token);
    expect(res.body.data.result.marksVisible).toBe(false);
    expect(res.body.data.result.result.overallScore).toBeUndefined();
  });

  test('not enough speech: the fixed message; credits waiting: never says why (the teacher\'s business)', async () => {
    const short = await guestUpload();
    await transcribed(short.recordingId, 'Hello my town.');
    await mark(short.recordingId);
    const res = await result(short.id, short.token);
    expect(res.body.data.result).toEqual(expect.objectContaining({ state: 'not_enough_speech', message: expect.any(String) }));
    const blocked = await guestUpload();
    await transcribed(blocked.recordingId, TEXT);
    await h.personalCredits(f.teacher.user, 0);
    await mark(blocked.recordingId);
    const waiting = await result(blocked.id, blocked.token);
    expect(waiting.body.data.result.state).toBe('awaiting_teacher');
    expect(JSON.stringify(waiting.body)).not.toMatch(/credit/i);
  });

  test('another guest\'s link, no link, a student, the owning teacher or another teacher: the same 404; an essay guest submission here: 404', async () => {
    const mine = await guestUpload();
    const theirs = await guestUpload({ name: 'Eve Guest', address: 'eve.guest@example.com' });
    const answers = [await result(mine.id, theirs.token), await result(mine.id), await result(mine.id, null, auth(f.student.token)),
      await result(mine.id, null, auth(f.teacher.token)), await result(mine.id, null, auth(f.otherTeacher.token)),
      await result(mine.id, 'x'.repeat(43)), await result('0'.repeat(24), mine.token)];
    for (const res of answers) { expect(res.status).toBe(404); expect(res.body).toEqual(DENIED); }
    const issued = access.issueToken();
    const essayGuest = await Submission.create({ submissionMode: 'guest', assignment: f.essay._id, class: f.klass._id, qrToken: f.essay.qrToken, submittedAt: new Date(),
      status: 'submitted', guest: { displayName: 'Essay Guest', normalizedEmail: 'essay.guest@example.com', accessHash: issued.accessHash, expiresAt: issued.expiresAt } });
    const essayHere = await result(essayGuest._id, issued.token);
    expect(essayHere.status).toBe(404);
    expect(essayHere.body).toEqual(DENIED);
    // ...and the essay guest result page still serves it.
    expect((await request(app).get(`/api/guest/submissions/${essayGuest._id}`).set('X-Guest-Token', issued.token)).status).toBe(200);
  });

  test('a revoked link: 404; an expired link: 404', async () => {
    const revoked = await guestUpload();
    expect((await request(app).post(`/api/submissions/${revoked.id}/guest-access/revoke`).set(auth(f.teacher.token))).status).toBe(200);
    expect((await result(revoked.id, revoked.token)).status).toBe(404);
    const expired = await guestUpload({ address: 'old.guest@example.com' });
    await Submission.collection.updateOne({ _id: new (require('mongoose').Types.ObjectId)(expired.id) }, { $set: { 'guest.expiresAt': new Date(Date.now() - 1000) } });
    expect((await result(expired.id, expired.token)).status).toBe(404);
  });

  test('playback: the owner guest only; whole file and byte ranges; private, no-store, nosniff, the stored content type', async () => {
    const { id, token } = await guestUpload({ body: samples.wav(8) });
    const whole = await media(id, token);
    expect(whole.status).toBe(200);
    expect(whole.headers).toEqual(expect.objectContaining({ 'content-type': 'audio/wav', 'x-content-type-options': 'nosniff', 'cache-control': 'private, no-store',
      'accept-ranges': 'bytes', 'content-disposition': 'inline; filename="recording.wav"' }));
    const size = Number(whole.headers['content-length']);
    expect(size).toBeGreaterThan(44);
    const part = await media(id, token, { Range: 'bytes=0-99' });
    expect(part.status).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 0-99/${size}`);
    expect(Number(part.headers['content-length'])).toBe(100);
    expect((await media(id, token, { Range: `bytes=${size + 10}-` })).status).toBe(416);
    const other = await guestUpload({ name: 'Eve Guest', address: 'eve.guest@example.com' });
    for (const res of [await media(id, other.token), await media(id), await media(id, null, auth(f.student.token)), await media(id, null, auth(f.otherTeacher.token))]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual(DENIED);
    }
  });

  test('a recovery-portal session opens the result (read-only) for its own email only', async () => {
    const { id } = await guestUpload();
    const res = await request(app).post('/api/recovery/request').send({ email: 'dee.guest@example.com' });
    expect(res.status).toBe(202);
    await waitFor(() => email.sendRecoveryPortalEmail.mock.calls.length > 0);
    const portalToken = new URL(email.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link).hash.slice(1);
    const session = (await request(app).post('/api/recovery/exchange').send({ token: portalToken })).body.data.session;
    const read = await result(id, null, { 'X-Recovery-Session': session });
    expect(read.status).toBe(200);
    expect(read.body.data.kind).toBe('speaking');
  });
});

describe('guest emails', () => {
  test('the result email: once marking is complete, the speaking wording and a working link to the guest speaking page; sent once', async () => {
    const { id, recordingId } = await guestUpload();
    email.sendGuestSubmissionEmail.mockClear();
    await guestResults.run();
    expect(email.sendGuestSubmissionEmail).not.toHaveBeenCalled();
    await transcribed(recordingId, TEXT);
    await mark(recordingId);
    await guestResults.run();
    expect(email.sendGuestSubmissionEmail).toHaveBeenCalledTimes(1);
    const sent = email.sendGuestSubmissionEmail.mock.calls[0][0];
    expect(sent).toEqual({ to: 'dee.guest@example.com', assignmentTitle: 'Describe your town', returnUrl: expect.stringMatching(new RegExp(`^https://school\\.example/guest/speaking/${id}#[\\w-]{43}$`)),
      resultReady: true, kind: 'speaking' });
    expect((await result(id, tokenOf(sent.returnUrl))).status).toBe(200);
    await guestResults.run();
    expect(email.sendGuestSubmissionEmail).toHaveBeenCalledTimes(1);
    expect((await Submission.findById(id).lean()).guest.resultEmailSentAt).toBeInstanceOf(Date);
  });

  test('a speaking recording that could not be marked gets no result email (nothing is ready)', async () => {
    const { recordingId } = await guestUpload();
    email.sendGuestSubmissionEmail.mockClear();
    await transcribed(recordingId, 'Hello my town.');
    await mark(recordingId);
    await guestResults.run();
    expect(email.sendGuestSubmissionEmail).not.toHaveBeenCalled();
  });
});

describe('recovery links for speaking guests', () => {
  test('"Lost your link?" on the speaking guest page: the same public answer; the email has a new link to the speaking page', async () => {
    const { id } = await guestUpload();
    const res = await request(app).post(`${base}/assignments/${f.assignment.qrToken}/recover`).send({ email: 'dee.guest@example.com' });
    expect(res.status).toBe(200);
    const unknown = await request(app).post(`${base}/assignments/${f.assignment.qrToken}/recover`).send({ email: 'nobody@example.com' });
    expect(unknown.body).toEqual(res.body);
    await waitFor(() => email.sendGuestRecoveryEmail.mock.calls.length > 0);
    expect(email.sendGuestRecoveryEmail).toHaveBeenCalledTimes(1);
    const link = email.sendGuestRecoveryEmail.mock.calls[0][0].link;
    expect(link).toMatch(new RegExp(`^https://school\\.example/guest/speaking/${id}#[\\w-]{43}$`));
    expect((await result(id, tokenOf(link))).status).toBe(200);
  });

  test('the per-submission resend (the existing route) gives a speaking link for a speaking submission', async () => {
    const { id } = await guestUpload();
    expect((await request(app).post(`/api/guest/submissions/${id}/recover`).send({ email: 'dee.guest@example.com' })).status).toBe(200);
    await waitFor(() => email.sendGuestRecoveryEmail.mock.calls.length > 0);
    const link = email.sendGuestRecoveryEmail.mock.calls[0][0].link;
    expect(link).toMatch(new RegExp(`/guest/speaking/${id}#`));
    expect((await result(id, tokenOf(link))).status).toBe(200);
  });

  test('the teacher-sent recovery link for a speaking guest opens the speaking page', async () => {
    const { id } = await guestUpload();
    const res = await request(app).post(`/api/submissions/${id}/guest-access/recovery-link`).set(auth(f.teacher.token)).send({});
    expect(res.status).toBe(200);
    const link = email.sendTeacherRecoveryEmail.mock.calls[0][0].link;
    expect(link).toMatch(new RegExp(`/guest/speaking/${id}#`));
    expect((await result(id, tokenOf(link))).status).toBe(200);
  });
});

describe('the recovery portal lists speaking work with its type', () => {
  async function portalList(address) {
    await request(app).post('/api/recovery/request').send({ email: address });
    await waitFor(() => email.sendRecoveryPortalEmail.mock.calls.length > 0);
    const token = new URL(email.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link).hash.slice(1);
    const session = (await request(app).post('/api/recovery/exchange').send({ token })).body.data.session;
    return (await request(app).get('/api/recovery/assignments').set('X-Recovery-Session', session)).body.data.assignments;
  }

  test('a guest recording: kind speaking and its status (processing, then ready); an essay row keeps its exact shape (no kind)', async () => {
    const { id, recordingId } = await guestUpload({ address: 'both@example.com' });
    const issued = access.issueToken();
    const essayGuest = await Submission.create({ submissionMode: 'guest', assignment: f.essay._id, class: f.klass._id, qrToken: f.essay.qrToken, submittedAt: new Date(Date.now() - 60000),
      status: 'submitted', assessmentStatus: 'processing', guest: { displayName: 'Both', normalizedEmail: 'both@example.com', accessHash: issued.accessHash, expiresAt: issued.expiresAt } });
    let rows = await portalList('both@example.com');
    expect(rows).toEqual([
      { id, assignmentTitle: 'Describe your town', className: 'Speaking 9B', submittedAt: expect.any(String), status: 'processing', kind: 'speaking' },
      { id: String(essayGuest._id), assignmentTitle: 'River essay', className: 'Speaking 9B', submittedAt: expect.any(String), status: 'processing' }]);
    await transcribed(recordingId, TEXT);
    await mark(recordingId);
    email.sendRecoveryPortalEmail.mockClear();
    await RecoveryToken.deleteMany({}); await require('../src/models/RecoveryEmailWindow').deleteMany({});
    rows = await portalList('both@example.com');
    expect(rows[0]).toEqual(expect.objectContaining({ id, kind: 'speaking', status: 'ready' }));
  });

  test('a guest recording the teacher uploaded is listed as speaking (it opens the speaking page), and one that could not be marked as failed', async () => {
    const made = await makeAudioSubmission(f, { mode: 'guest' });
    await Submission.updateOne({ _id: made.submission._id }, { $set: { teacherUpload: { uploadedBy: f.teacher.user._id, batchId: 'b-1', uploadedAt: new Date(),
      typedName: 'Guest Speaker', email: { status: 'none', attempts: 0 } }, evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_NOT_ENOUGH_SPEECH' } });
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { allowGuestSubmission: false } });
    const rows = await portalList('guest.speaker@example.com');
    expect(rows).toEqual([expect.objectContaining({ id: String(made.submission._id), kind: 'speaking', status: 'failed' })]);
  });

  test('a class member\'s own speaking work: "Sign in to view" with kind speaking; their essay work unchanged', async () => {
    await makeAudioSubmission(f);
    await Submission.create({ student: f.student.user._id, assignment: f.essay._id, class: f.klass._id, status: 'submitted', submittedAt: new Date(Date.now() - 60000) });
    const rows = await portalList(f.student.user.email);
    expect(rows).toEqual([
      { id: 'account-1', access: 'signIn', assignmentTitle: 'Describe your town', className: 'Speaking 9B', submittedAt: expect.any(String), kind: 'speaking' },
      { id: 'account-2', access: 'signIn', assignmentTitle: 'River essay', className: 'Speaking 9B', submittedAt: expect.any(String) }]);
  });
});

describe('the teacher allows guests on a speaking assignment', () => {
  test('create and update accept allowGuestSubmission for speaking; other non-essay types still never allow it', async () => {
    const created = await request(app).post('/api/assignments').set(auth(f.teacher.token)).send({ title: 'Talk about food', classId: String(f.klass._id),
      resourceType: 'speaking', writingType: 'speaking', deadline: new Date(Date.now() + 86400000).toISOString(), allowGuestSubmission: true, speaking: {} });
    expect(created.status).toBeLessThan(300);
    const id = created.body.data?._id || created.body.data?.assignment?._id;
    expect((await Assignment.findById(id).lean()).allowGuestSubmission).toBe(true);
    const off = await request(app).patch(`/api/assignments/${id}`).set(auth(f.teacher.token)).send({ allowGuestSubmission: false });
    expect(off.status).toBeLessThan(300);
    expect((await Assignment.findById(id).lean()).allowGuestSubmission).toBe(false);
    const on = await request(app).patch(`/api/assignments/${id}`).set(auth(f.teacher.token)).send({ allowGuestSubmission: true });
    expect(on.status).toBeLessThan(300);
    expect((await Assignment.findById(id).lean()).allowGuestSubmission).toBe(true);
    const sheet = await Assignment.create({ title: 'Sheet', resourceType: 'worksheet', resourceId: String(f.klass._id), class: f.klass._id, teacher: f.teacher.user._id,
      deadline: new Date(Date.now() + 86400000), qrToken: crypto.randomUUID() });
    await request(app).patch(`/api/assignments/${sheet._id}`).set(auth(f.teacher.token)).send({ allowGuestSubmission: true });
    expect((await Assignment.findById(sheet._id).lean()).allowGuestSubmission).toBe(false);
  });
});

void person;
