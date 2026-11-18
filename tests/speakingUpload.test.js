'use strict';
// Audio + speech-to-text, stage 5: POST /api/speaking/:assignmentId (class students), the student status, transcription retry, storage
// reserve/release on every failure path, the upload-time minute pre-check, replacement before marking, the essay recovery worker never
// selecting an audio submission, owned storage and removal. In-memory MongoDB; transcription is always an injected fake; the global fetch is a
// tripwire. The duration measurement is mocked (music-metadata cannot load inside Jest; tests/audioDuration.test.js runs the real one).
process.env.JWT_SECRET = 'speaking-upload-test-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-upload-${process.pid}`;
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
const { seedSpeaking, makeAudioSubmission, rid } = require('./helpers/speakingFixtures');
const samples = require('./helpers/audioSamples');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const File = require('../src/models/File');
const storage = require('../src/services/audio/storage');
const usage = require('../src/services/audio/usage');
const processing = require('../src/services/audio/processing');
const deepgram = require('../src/services/audio/stt/deepgram');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const { calculateOwnedStorageUsage } = require('../src/services/ownedStorage.service');

const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const ok = () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false });
const audioFiles = () => (fs.existsSync(storage.audioRoot()) ? fs.readdirSync(storage.audioRoot()) : []);
const storageMB = async id => (await User.findById(id).lean()).usage?.storageMB || 0;
const submissionsUsed = async id => (await User.findById(id).lean()).usage?.submissions || 0;
const UNAVAILABLE = 'Recording uploads are not available right now. Please try again later or ask your teacher.';
let f;

function upload({ token = f.student.token, assignmentId = f.assignment._id, key = rid(), body = samples.wav(8), name = 'answer.wav', type = 'audio/wav' } = {}) {
  const req = request(app).post(`/api/speaking/${assignmentId}`).set(auth(token));
  if (key) req.set('Idempotency-Key', key);
  return req.attach('audio', body, { filename: name, contentType: type });
}
/** Waits for the upload's response "finish" sweep (the uncommitted-file cleanup runs right after the response). */
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
async function expectNothingKept(studentId = f.student.user._id) {
  await settle();
  expect(await AudioRecording.countDocuments()).toBe(0);
  expect(await Submission.countDocuments()).toBe(0);
  expect(await File.countDocuments({ type: 'audio' })).toBe(0);
  expect(audioFiles()).toEqual([]);
  expect(await storageMB(studentId)).toBe(0);
}

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  await AudioRecording.createIndexes(); await AudioUsageLedger.createIndexes(); await Submission.createIndexes();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; jest.restoreAllMocks(); });

describe('the happy path', () => {
  test('a class student uploads: 201, the recording is stored, linked and queued; storage and the submission count are charged', async () => {
    const institutionId = new mongoose.Types.ObjectId();
    await Class.updateOne({ _id: f.klass._id }, { $set: { institutionId } });
    const res = await upload();
    expect(res.status).toBe(201);
    const recording = await AudioRecording.findOne().select('+audioSha256').lean();
    const submission = await Submission.findOne().select('+audioRecording').lean();
    expect(recording).toMatchObject({ owner: f.student.user._id, minutesChargedTo: f.teacher.user._id, institutionId, storageChargedTo: f.student.user._id,
      status: 'queued', contentType: 'audio/wav', durationSeconds: 8, submissionId: submission._id });
    expect(recording.audioSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(submission).toMatchObject({ student: f.student.user._id, assignment: f.assignment._id, class: f.klass._id, sourceKind: 'audio', status: 'submitted',
      isLate: false, audioRecording: recording._id, files: [] });
    expect(submission.ocrStatus).toBeUndefined();
    expect(submission.file).toBeUndefined();
    expect((await File.findById(recording.audioFileId).lean())).toMatchObject({ type: 'audio', uploadedBy: f.student.user._id, sizeBytes: recording.sizeBytes });
    await settle();
    expect(audioFiles()).toHaveLength(1);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(recording.storageChargedMB, 6);
    expect(recording.storageChargedMB).toBeGreaterThan(0);
    expect(await submissionsUsed(f.student.user._id)).toBe(1);
  });

  test('the student DTO: status only, no provider, hashes, lease fields, words or edits', async () => {
    const res = await upload();
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(['assignmentId', 'canReplace', 'id', 'isLate', 'recording', 'sourceKind', 'status', 'submittedAt'].sort());
    expect(Object.keys(data.recording).sort()).toEqual(['canRetry', 'contentType', 'durationSeconds', 'mediaUrl', 'state'].sort());
    expect(data).toMatchObject({ sourceKind: 'audio', status: 'submitted', canReplace: true, recording: { state: 'processing', durationSeconds: 8, canRetry: false,
      mediaUrl: `/api/audio/submissions/${data.id}/media` } });
    expect(JSON.stringify(res.body)).not.toMatch(/deepgram|openai|sha256|attemptKey|leaseUntil|requestId|words|editedRevisions|minutesChargedTo|storageCharged|uploads|\.wav/i);
  });

  test('transcription (mocked) then the student status shows ready', async () => {
    const res = await upload();
    const recording = await AudioRecording.findOne().lean();
    expect(await processing.processAudioRecording(recording._id, { transcribe: jest.fn(async () => ok()) })).toEqual({ status: 'ready' });
    const status = await request(app).get(`/api/speaking/${f.assignment._id}/my`).set(auth(f.student.token));
    expect(status.status).toBe(200);
    expect(status.body.data.submission).toMatchObject({ id: res.body.data.id, recording: { state: 'ready', canRetry: false } });
    expect(status.body.data.limits).toEqual({ maxRecordingSeconds: 420, minDurationSeconds: 5, maxFileBytes: 41943040 });
    expect(JSON.stringify(status.body)).not.toMatch(/deepgram|transcript|words|providerRequestId/i);
  });

  test('before any upload the status is { submission: null } with the assignment\'s limits', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { 'speaking.maxRecordingSeconds': 90 } });
    const status = await request(app).get(`/api/speaking/${f.assignment._id}/my`).set(auth(f.student.token));
    expect(status.body.data).toEqual({ submission: null, limits: { maxRecordingSeconds: 90, minDurationSeconds: 5, maxFileBytes: 41943040 } });
  });

  test('the same Idempotency-Key again: the same submission (200), one recording, storage charged once, the second file not kept', async () => {
    const key = rid();
    const first = await upload({ key });
    const second = await upload({ key });
    expect(second.status).toBe(200);
    expect(second.body.data.id).toBe(first.body.data.id);
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(1);
    expect(audioFiles()).toHaveLength(1);
    const recording = await AudioRecording.findOne().lean();
    expect(await storageMB(f.student.user._id)).toBeCloseTo(recording.storageChargedMB, 6);
  });

  test('an Idempotency-Key used for another assignment is refused (409) and nothing new is kept', async () => {
    const other = await Assignment.create({ title: 'Second talk', writingType: 'speaking', resourceType: 'speaking', class: f.klass._id, teacher: f.teacher.user._id,
      deadline: new Date(Date.now() + 86400000), qrToken: rid() });
    const key = rid();
    await upload({ key });
    const res = await upload({ key, assignmentId: other._id });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEAKING_REQUEST_ID_REUSED');
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(1);
    expect(audioFiles()).toHaveLength(1);
  });
});

describe('refusals before the file is accepted (nothing written, nothing reserved)', () => {
  test.each([[null], ['short'], ['has spaces in it and is long enough']])('Idempotency-Key %p: 400', async (key) => {
    const res = await upload({ key });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('SPEAKING_REQUEST_ID_REQUIRED');
    await expectNothingKept();
  });

  test('not a member of the class: 403', async () => {
    const res = await upload({ token: f.otherStudent.token });
    expect(res.status).toBe(403);
    await expectNothingKept(f.otherStudent.user._id);
  });

  test('a member who left: 403', async () => {
    await Membership.updateOne({ student: f.student.user._id }, { $set: { status: 'left' } });
    expect((await upload()).status).toBe(403);
    await expectNothingKept();
  });

  test.each([
    ['an essay assignment', () => f.essay._id],
    ['an unknown id', () => new mongoose.Types.ObjectId()]
  ])('%s: 404', async (_label, id) => {
    expect((await upload({ assignmentId: id() })).status).toBe(404);
    await expectNothingKept();
  });

  test('an inactive assignment or class: 404', async () => {
    await Class.updateOne({ _id: f.klass._id }, { $set: { isActive: false } });
    expect((await upload()).status).toBe(404);
    await expectNothingKept();
  });

  test('a teacher cannot use the class-student route (403)', async () => {
    expect((await upload({ token: f.teacher.token })).status).toBe(403);
  });

  test('signed out: 401', async () => {
    expect((await request(app).post(`/api/speaking/${f.assignment._id}`).set('Idempotency-Key', rid())).status).toBe(401);
  });

  test('while AUDIO_STT_ENABLED is off every speaking route answers 404 before sign-in', async () => {
    delete process.env.AUDIO_STT_ENABLED;
    for (const [method, url] of [['post', `/api/speaking/${f.assignment._id}`], ['get', `/api/speaking/${f.assignment._id}/my`],
      ['post', `/api/speaking/submissions/${new mongoose.Types.ObjectId()}/retry-transcription`], ['get', `/api/speaking/submissions/${new mongoose.Types.ObjectId()}`]]) {
      const res = await request(app)[method](url);
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ success: false, code: 'NOT_FOUND', message: 'Not found.' });
    }
  });

  test('the plan\'s submission limit is reached: 403', async () => {
    await User.updateOne({ _id: f.student.user._id }, { $set: { 'usage.submissions': 100 } });
    const res = await upload();
    expect(res.status).toBe(403);
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(0);
    expect(audioFiles()).toEqual([]);
  });

  describe('the teacher\'s minutes are used up (a courtesy check: the worker stays the real guard)', () => {
    const history = async (seconds, at = new Date()) => {
      const { dayKey, monthKey } = usage.utcKeys(at);
      await AudioUsageLedger.create({ key: rid(), recordingId: new mongoose.Types.ObjectId(), uploader: new mongoose.Types.ObjectId(), minutesChargedTo: f.teacher.user._id,
        seconds, dayKey, monthKey, state: 'consumed', reservedAt: at, expiresAt: at });
    };
    test('today\'s minutes used up: 429 with the fixed message, no numbers', async () => {
      await history(7200);
      const res = await upload();
      expect(res.status).toBe(429);
      expect(res.body).toEqual({ success: false, code: 'AUDIO_UPLOADS_UNAVAILABLE', message: UNAVAILABLE });
      await expectNothingKept();
    });
    test('this month\'s minutes used up: 429, same message', async () => {
      process.env.AUDIO_MONTHLY_MINUTES_PER_TEACHER = '120';
      try {
        const yesterday = new Date(Date.now() - 86400000);
        await history(7200, usage.utcKeys(yesterday).monthKey === usage.utcKeys(new Date()).monthKey ? yesterday : new Date());
        const res = await upload();
        expect(res.status).toBe(429);
        expect(res.body.message).toBe(UNAVAILABLE);
        await expectNothingKept();
      } finally { delete process.env.AUDIO_MONTHLY_MINUTES_PER_TEACHER; }
    });
    test('fewer than 5 seconds left counts as used up', async () => {
      await history(7196);
      expect((await upload()).status).toBe(429);
    });
    test('minutes partly used: accepted', async () => {
      await history(3600);
      expect((await upload()).status).toBe(201);
    });
    test('the pre-check reads the ledger with the inclusion projection and no sort', async () => {
      const spy = jest.spyOn(AudioUsageLedger, 'find');
      await upload();
      const queries = spy.mock.results.map(r => r.value).filter(q => q?.getOptions);
      expect(queries.length).toBeGreaterThan(0);
      for (const query of queries) { expect(query.getOptions().sort).toBeUndefined(); expect(query._fields).toEqual({ _id: 0, seconds: 1, dayKey: 1, state: 1 }); }
    });
  });
});

describe('refusals of the file itself (nothing kept, nothing reserved)', () => {
  test('a recording whose length cannot be read: 422 with the fixed message', async () => {
    const res = await upload({ body: samples.webm(12, { headerDuration: false }), name: 'answer.webm', type: 'audio/webm' });
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ success: false, code: 'AUDIO_UNREADABLE',
      message: "We couldn't read the length of this recording. Save it as MP3 or M4A and upload it again." });
    await expectNothingKept();
  });

  test('longer than the assignment\'s own maximum: 413', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { 'speaking.maxRecordingSeconds': 60 } });
    const res = await upload({ body: samples.wav(62) });
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('AUDIO_TOO_LONG');
    await expectNothingKept();
    expect((await upload({ body: samples.wav(61) })).status).toBe(201);           // 60 s + the 1 s tolerance
  });

  test('too short: 422', async () => {
    expect((await upload({ body: samples.wav(3) })).status).toBe(422);
    await expectNothingKept();
  });

  test('the student\'s storage is full: 413, nothing kept and usage unchanged', async () => {
    await User.updateOne({ _id: f.student.user._id }, { $set: { 'usage.storageMB': 499.99 } });
    const res = await upload();
    expect(res.status).toBe(413);
    expect(res.body.code).toBe('SPEAKING_STORAGE_FULL');
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(0);
    expect(await File.countDocuments({ type: 'audio' })).toBe(0);
    expect(audioFiles()).toEqual([]);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(499.99, 6);
  });
});

describe('a failure after the storage reservation releases it', () => {
  test.each([
    ['saving the File record', () => jest.spyOn(File, 'create').mockRejectedValueOnce(new Error('db down'))],
    ['saving the recording', () => jest.spyOn(AudioRecording, 'create').mockRejectedValueOnce(new Error('db down'))],
    ['saving the submission', () => jest.spyOn(Submission, 'create').mockRejectedValueOnce(new Error('db down'))],
    ['queuing the transcription', () => jest.spyOn(processing, 'enqueue').mockRejectedValueOnce(new Error('db down'))]
  ])('%s fails: 500, storage released, nothing kept', async (_label, breakIt) => {
    breakIt();
    const res = await upload();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain('db down');
    await expectNothingKept();
    expect(await submissionsUsed(f.student.user._id)).toBe(0);
  });
});

describe('deadline, one submission per student, replacement before marking', () => {
  test('a first upload after the due date is accepted as late', async () => {
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { deadline: new Date(Date.now() - 60000) } });
    const res = await upload();
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ status: 'late', isLate: true, canReplace: false });
  });

  test('replacing before marking: the submission points to the new recording; the old one, its file and its storage are gone', async () => {
    const first = await upload({ body: samples.wav(8) });
    const old = await AudioRecording.findOne().lean();
    const res = await upload({ body: samples.wav(12) });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(first.body.data.id);
    expect(res.body.data.recording).toMatchObject({ state: 'processing', durationSeconds: 12 });
    await settle();
    expect(await Submission.countDocuments()).toBe(1);
    const recordings = await AudioRecording.find().lean();
    expect(recordings).toHaveLength(1);
    expect(String(recordings[0]._id)).not.toBe(String(old._id));
    expect(await File.findById(old.audioFileId)).toBeNull();
    expect(audioFiles()).toHaveLength(1);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(recordings[0].storageChargedMB, 6);
    expect(await submissionsUsed(f.student.user._id)).toBe(1);
    expect(String((await Submission.findOne().select('+audioRecording').lean()).audioRecording)).toBe(String(recordings[0]._id));
  });

  test('replacing a recording that is being transcribed releases its minutes reservation', async () => {
    await upload();
    const old = await AudioRecording.findOne().lean();
    const claimed = await processing.claim(old._id);
    await usage.reserveMinutes({ recording: claimed });
    expect((await upload()).status).toBe(200);
    expect((await AudioUsageLedger.find({ recordingId: old._id }).lean()).map(r => r.state)).toEqual(['released']);
  });

  test('replacing after the due date: 403, and the new file is not kept', async () => {
    await upload();
    await Assignment.updateOne({ _id: f.assignment._id }, { $set: { deadline: new Date(Date.now() - 60000) } });
    const before = await storageMB(f.student.user._id);
    const res = await upload();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('DEADLINE_PASSED');
    await settle();
    expect(audioFiles()).toHaveLength(1);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(before, 6);
  });

  test.each([
    // Stage 6: "marked" means a stored result (a completed assessment), not the empty document an assessment run starts with.
    ['a completed assessment exists', async (submission) => { await SubmissionFeedback.collection.insertOne({ submissionId: submission._id, evaluationStatus: 'completed', createdAt: new Date() }); }],
    ['the submission has feedback', async (submission) => { await Submission.updateOne({ _id: submission._id }, { $set: { feedback: new mongoose.Types.ObjectId() } }); }]
  ])('replacing after marking (%s): 409, nothing changes, the new file and its storage are released', async (_label, mark) => {
    await upload();
    const submission = await Submission.findOne().select('+audioRecording').lean();
    await mark(submission);
    const before = await storageMB(f.student.user._id);
    const res = await upload();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEAKING_ALREADY_MARKED');
    await settle();
    expect(await AudioRecording.countDocuments()).toBe(1);
    expect(String((await Submission.findOne().select('+audioRecording').lean()).audioRecording)).toBe(String(submission.audioRecording));
    expect(audioFiles()).toHaveLength(1);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(before, 6);
  });

  test('two first uploads at the same time: one submission; the other is refused and released', async () => {
    const results = await Promise.all([upload(), upload()]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    await settle();
    expect(await Submission.countDocuments()).toBe(1);
    expect(await AudioRecording.countDocuments()).toBe(1);
    expect(audioFiles()).toHaveLength(1);
    const recording = await AudioRecording.findOne().lean();
    expect(await storageMB(f.student.user._id)).toBeCloseTo(recording.storageChargedMB, 6);
  });
});

describe('retrying a failed transcription', () => {
  const retry = (id, token) => request(app).post(`/api/speaking/submissions/${id}/retry-transcription`).set(auth(token));
  test('the student who owns it, and the owning teacher: queued again with fresh attempts', async () => {
    for (const who of ['student', 'teacher']) {
      await clearDatabase(); await seedTestPlans(); f = await seedSpeaking();
      const { submission, recording } = await makeAudioSubmission(f, { status: 'failed' });
      await AudioRecording.updateOne({ _id: recording._id }, { $set: { attempts: 3, lastErrorCode: 'AUDIO_MONTHLY_MINUTES_EXCEEDED', failedAt: new Date() } });
      const res = await retry(submission._id, f[who].token);
      expect(res.status).toBe(200);
      const doc = await AudioRecording.findById(recording._id).select('+processingQueue').lean();
      expect(doc).toMatchObject({ status: 'queued', attempts: 0, lastErrorCode: null, failedAt: null, processingQueue: true });
    }
  });

  test('only a failed one: 409 otherwise, unchanged', async () => {
    const { submission, recording } = await makeAudioSubmission(f, { status: 'ready' });
    const res = await retry(submission._id, f.student.token);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TRANSCRIPTION_NOT_FAILED');
    expect((await AudioRecording.findById(recording._id).lean()).status).toBe('ready');
  });

  test('anyone else: 404, unchanged', async () => {
    const { submission, recording } = await makeAudioSubmission(f, { status: 'failed' });
    for (const token of [f.otherStudent.token, f.otherTeacher.token]) expect((await retry(submission._id, token)).status).toBe(404);
    expect((await retry(f.essay._id, f.student.token)).status).toBe(404);
    expect((await AudioRecording.findById(recording._id).lean()).status).toBe('failed');
  });
});

describe('the teacher\'s view of a speaking submission', () => {
  test('the owning teacher sees the job state (codes, attempts); other teachers 404; students 403', async () => {
    const { submission, recording } = await makeAudioSubmission(f, { status: 'failed' });
    await AudioRecording.updateOne({ _id: recording._id }, { $set: { attempts: 2, lastErrorCode: 'AUDIO_STT_TIMEOUT' } });
    const res = await request(app).get(`/api/speaking/submissions/${submission._id}`).set(auth(f.teacher.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: String(submission._id), sourceKind: 'audio', recording: { status: 'failed', attempts: 2, lastErrorCode: 'AUDIO_STT_TIMEOUT',
      durationSeconds: 8, mediaUrl: `/api/audio/submissions/${submission._id}/media`, downloadUrl: `/api/audio/submissions/${submission._id}/download` } });
    expect(JSON.stringify(res.body)).not.toMatch(/sha256|attemptKey|leaseUntil|requestId|"words"|editedRevisions|providerRequestId|uploads|\.wav/i);
    expect((await request(app).get(`/api/speaking/submissions/${submission._id}`).set(auth(f.otherTeacher.token))).status).toBe(404);
    expect((await request(app).get(`/api/speaking/submissions/${submission._id}`).set(auth(f.student.token))).status).toBe(403);
  });
});

describe('the essay recovery worker never selects an audio submission', () => {
  test('dueWorkQuery and the stalled teacher-upload sweep do not match it', async () => {
    const recovery = require('../src/services/assessmentRecovery.service');
    const { submission } = await makeAudioSubmission(f, { status: 'queued' });
    const found = await Submission.find(recovery.dueWorkQuery(new Date(Date.now() + 365 * 86400000), 99)).select('_id').lean();
    expect(found.map(d => String(d._id))).not.toContain(String(submission._id));
    // Control: an essay submission left pending IS selected by the same query.
    const essay = await Submission.create({ student: f.otherStudent.user._id, assignment: f.essay._id, class: f.klass._id, status: 'submitted', submittedAt: new Date(),
      isLate: false, ocrStatus: 'pending' });
    const again = await Submission.find(recovery.dueWorkQuery(new Date(Date.now() + 365 * 86400000), 99)).select('_id').lean();
    expect(again.map(d => String(d._id))).toContain(String(essay._id));
    expect(again.map(d => String(d._id))).not.toContain(String(submission._id));
    const spy = jest.spyOn(Submission, 'updateOne');
    await recovery.sweepStalledTeacherUploads(undefined, new Date(Date.now() + 365 * 86400000));
    expect(spy.mock.calls.filter(([filter]) => String(filter?._id) === String(submission._id))).toEqual([]);
  });

  test('an uploaded speaking submission never gets ocrStatus, correction or assessment fields', async () => {
    await upload();
    const raw = await Submission.collection.findOne({});
    for (const key of ['ocrStatus', 'correctionStatus', 'semanticStatus', 'evaluationStatus', 'assessmentStatus', 'ocrJobId', 'file']) expect(raw[key]).toBeUndefined();
  });
});

describe('storage accounting', () => {
  test('owned storage counts the audio for the student and for the class teacher', async () => {
    const { file } = await makeAudioSubmission(f);
    const forStudent = await calculateOwnedStorageUsage(f.student.user._id);
    const forTeacher = await calculateOwnedStorageUsage(f.teacher.user._id);
    expect(forStudent).toMatchObject({ usedBytes: file.sizeBytes, fileCount: 1 });
    expect(forTeacher).toMatchObject({ usedBytes: file.sizeBytes, fileCount: 1 });
    expect(await calculateOwnedStorageUsage(f.otherTeacher.user._id)).toMatchObject({ usedBytes: 0, fileCount: 0 });
  });

  test('removing the submission deletes the recording, its file and its audio, and releases exactly the charged storage', async () => {
    await User.updateOne({ _id: f.student.user._id }, { $set: { 'usage.storageMB': 10 } });
    const res = await upload();
    const recording = await AudioRecording.findOne().lean();
    await settle();
    const charged = await storageMB(f.student.user._id);
    expect(charged).toBeCloseTo(10 + recording.storageChargedMB, 6);
    const removed = await request(app).delete(`/api/submissions/${res.body.data.id}`).set(auth(f.teacher.token));
    expect(removed.status).toBe(200);
    expect(await Submission.countDocuments()).toBe(0);
    expect(await AudioRecording.countDocuments()).toBe(0);
    expect(await File.countDocuments({ type: 'audio' })).toBe(0);
    expect(audioFiles()).toEqual([]);
    expect(await storageMB(f.student.user._id)).toBeCloseTo(10, 6);
    expect(await submissionsUsed(f.student.user._id)).toBe(0);
  });

  test('removing during transcription cancels it and releases its minutes; the ledger history is kept', async () => {
    const res = await upload();
    const recording = await AudioRecording.findOne().lean();
    const claimed = await processing.claim(recording._id);
    await usage.reserveMinutes({ recording: claimed });
    await AudioUsageLedger.create({ key: rid(), recordingId: recording._id, uploader: f.student.user._id, minutesChargedTo: f.teacher.user._id, seconds: 8,
      ...usage.utcKeys(new Date()), state: 'consumed', reservedAt: new Date(), expiresAt: new Date() });
    expect((await request(app).delete(`/api/submissions/${res.body.data.id}`).set(auth(f.teacher.token))).status).toBe(200);
    const rows = await AudioUsageLedger.find({ recordingId: recording._id }).lean();
    expect(rows.map(r => r.state).sort()).toEqual(['consumed', 'released']);
  });

  test('another teacher cannot remove it (existing rule) and nothing is deleted', async () => {
    const res = await upload();
    expect((await request(app).delete(`/api/submissions/${res.body.data.id}`).set(auth(f.otherTeacher.token))).status).toBe(403);
    expect(await AudioRecording.countDocuments()).toBe(1);
  });
});
