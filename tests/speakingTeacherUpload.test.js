'use strict';
// Stage 9: a teacher uploads a recording on behalf of a student, mirroring the essay teacher upload (teacherUpload.service.js): the same student
// identities (a class member by email, anyone else as a guest with the typed name), the same credit rule (checked at upload, before any
// speech-to-text spend, net of uploads saved but not yet charged, under the same per-teacher lease), storage and minutes on the teacher,
// request-key idempotency, the same email states and "Save and send" semantics. In-memory MongoDB; no transcription, AI or email ever runs
// (email.service is mocked; the global fetch is a tripwire). The duration measurement is mocked as in speakingUpload.test.js.
process.env.JWT_SECRET = 'speaking-teacher-upload-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-teacher-upload-${process.pid}`;
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
const { seedSpeaking, makeAudioSubmission, person, rid } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const email = require('../src/services/email.service');
const User = require('../src/models/user.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const File = require('../src/models/File');
const storage = require('../src/services/audio/storage');
const usage = require('../src/services/audio/usage');
const access = require('../src/services/guestAccess.service');
const emailWorker = require('../src/services/teacherUploadEmail.service');
const recovery = require('../src/services/assessmentRecovery.service');
const logger = require('../src/utils/logger');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const audioFiles = () => (fs.existsSync(storage.audioRoot()) ? fs.readdirSync(storage.audioRoot()) : []);
const storageMB = async id => (await User.findById(id).lean()).usage?.storageMB || 0;
const settle = () => new Promise(resolve => setTimeout(resolve, 50));
const key = () => crypto.randomBytes(24).toString('hex');
const NOT_FOUND = { success: false, code: 'NOT_FOUND', message: 'Not found.' };
let f;

const base = (assignmentId = f.assignment._id) => `/api/speaking/assignments/${assignmentId}/teacher-uploads`;
function save({ token = f.teacher.token, assignmentId = f.assignment._id, name = 'Ana Lima', address = f.student.user.email, requestKey = key(), batchId = 'batch-0001',
  mode, send, body = samples.wav(8), filename = 'answer.wav', type = 'audio/wav' } = {}) {
  const req = request(app).post(base(assignmentId)).set(auth(token)).field('name', name).field('email', address).field('requestKey', requestKey).field('batchId', batchId);
  if (mode) req.field('mode', mode);
  if (send) req.field('send', 'true');
  return req.attach('audio', body, { filename, contentType: type });
}
async function expectNothingKept() {
  await settle();
  expect(await AudioRecording.countDocuments()).toBe(0);
  expect(await Submission.countDocuments({ sourceKind: 'audio' })).toBe(0);
  expect(await File.countDocuments({ type: 'audio' })).toBe(0);
  expect(audioFiles()).toEqual([]);
  expect(await storageMB(f.teacher.user._id)).toBe(0);
}
const stored = id => Submission.findById(id).select('+teacherUpload +guest.normalizedEmail +audioRecording').lean();

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  await AudioRecording.createIndexes(); await AudioUsageLedger.createIndexes(); await Submission.createIndexes();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 10);
  email.sendTeacherUploadFeedbackEmail.mockClear();
  email.sendTeacherUploadFeedbackEmail.mockResolvedValue({ success: true });
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; jest.restoreAllMocks(); });

describe('who may upload', () => {
  test('another teacher: 404 (nothing revealed); a student: refused; the feature off: 404 before sign-in; nothing kept', async () => {
    const other = await save({ token: f.otherTeacher.token });
    expect(other.status).toBe(404);
    expect(other.body).toEqual(expect.objectContaining({ success: false, code: 'NOT_FOUND' }));
    expect((await save({ token: f.student.token })).status).toBe(403);
    delete process.env.AUDIO_STT_ENABLED;
    const off = await request(app).get(base());
    expect(off.status).toBe(404);
    expect(off.body).toEqual(NOT_FOUND);
    await expectNothingKept();
  });

  test('a writing assignment through the speaking route is refused; the essay route still refuses a speaking assignment (unchanged)', async () => {
    const res = await save({ assignmentId: f.essay._id });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TEACHER_UPLOAD_NOT_SPEAKING');
    const essayRoute = await request(app).post(`/api/assignments/${f.assignment._id}/teacher-uploads/check`).set(auth(f.teacher.token))
      .send({ students: [{ name: 'Ana', email: f.student.user.email }] });
    expect(essayRoute.status).toBe(400);
    expect(essayRoute.body.code).toBe('TEACHER_UPLOAD_NOT_WRITING');
    await expectNothingKept();
  });
});

describe('saving a class member\'s recording', () => {
  test('a registered audio submission with the teacher-upload record; recording, file, storage and minutes on the teacher; transcription queued', async () => {
    const requestKey = key();
    const body = samples.wav(8);
    const res = await save({ requestKey, body });
    expect(res.status).toBe(200);
    expect(res.body.data.duplicate).toBe(false);
    expect(res.body.data.item).toEqual(expect.objectContaining({ kind: 'speaking', account: 'member', status: 'uploaded', emailStatus: 'none', uploadedByTeacher: true,
      name: 'Ana Lima', email: f.student.user.email }));
    const sub = await stored(res.body.data.item.submissionId);
    expect(sub).toEqual(expect.objectContaining({ sourceKind: 'audio', submissionMode: 'registered', status: 'submitted', isLate: false }));
    expect(String(sub.student)).toBe(String(f.student.user._id));
    expect(String(sub.teacherUpload.uploadedBy)).toBe(String(f.teacher.user._id));
    expect(sub.teacherUpload).toEqual(expect.objectContaining({ typedName: 'Ana Lima', batchId: 'batch-0001', contentHash: crypto.createHash('sha256').update(body).digest('hex'),
      email: expect.objectContaining({ status: 'none' }) }));
    expect(sub.teacherUpload.requestKey).toBe(access.hash(requestKey));
    expect(sub.assessmentStatus).toBeUndefined();
    const recording = await AudioRecording.findById(sub.audioRecording).lean();
    expect(String(recording.owner)).toBe(String(f.teacher.user._id));
    expect(String(recording.storageChargedTo)).toBe(String(f.teacher.user._id));
    expect(String(recording.minutesChargedTo)).toBe(String(f.teacher.user._id));
    expect(recording.status).toBe('queued');
    const file = await File.findById(recording.audioFileId).lean();
    expect(file).toEqual(expect.objectContaining({ role: 'teacher', type: 'audio' }));
    expect(String(file.uploadedBy)).toBe(String(f.teacher.user._id));
    expect(await storageMB(f.teacher.user._id)).toBeGreaterThan(0);
    expect(await storageMB(f.student.user._id)).toBe(0);
  });

  test('"Save and send": the email is queued and waits for marking (nothing is sent now)', async () => {
    const res = await save({ send: true });
    expect(res.body.data.item.emailStatus).toBe('queued');
    await emailWorker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
  });

  test('logs carry ids and codes only: never the name, the email or a file name', async () => {
    const lines = [];
    for (const level of ['info', 'warn', 'error', 'metric']) jest.spyOn(logger, level).mockImplementation(entry => { lines.push(JSON.stringify(entry)); });
    await save({ name: 'Ana Lima', filename: 'my-secret-answer.wav' });
    const all = lines.join('\n');
    expect(all).not.toContain('Ana Lima');
    expect(all).not.toContain(f.student.user.email);
    expect(all).not.toContain('my-secret-answer');
  });
});

describe('a guest (anyone who is not a class member)', () => {
  test('Save: a guest audio submission with the typed name and email', async () => {
    const res = await save({ name: 'Guest Speaker', address: 'Guest.Speaker@Example.com' });
    expect(res.status).toBe(200);
    expect(res.body.data.item).toEqual(expect.objectContaining({ account: 'guest', email: 'guest.speaker@example.com' }));
    const sub = await stored(res.body.data.item.submissionId);
    expect(sub).toEqual(expect.objectContaining({ submissionMode: 'guest', guest: expect.objectContaining({ displayName: 'Guest Speaker', normalizedEmail: 'guest.speaker@example.com' }) }));
  });

  test('"Save and send" for a guest is refused before anything is kept (guest speaking results come with stage 10)', async () => {
    const res = await save({ address: 'guest@example.com', send: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TEACHER_UPLOAD_GUEST_EMAIL_UNAVAILABLE');
    await expectNothingKept();
  });

  test('a student of another class is a guest here (as in the essay flow)', async () => {
    const res = await save({ address: f.otherStudent.user.email });
    expect(res.body.data.item.account).toBe('guest');
  });
});

describe('idempotency (the same request key)', () => {
  test('the same key and the same recording: the first result, once; the same key with another recording: refused', async () => {
    const requestKey = key(), body = samples.wav(8);
    const first = await save({ requestKey, body });
    const again = await save({ requestKey, body });
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(expect.objectContaining({ duplicate: true, item: expect.objectContaining({ submissionId: first.body.data.item.submissionId }) }));
    expect(await Submission.countDocuments({ sourceKind: 'audio' })).toBe(1);
    expect(await AudioRecording.countDocuments()).toBe(1);
    const other = await save({ requestKey, body: samples.wav(9) });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('TEACHER_UPLOAD_KEY_REUSED');
    await settle();
    expect(audioFiles().length).toBe(1);
  });
});

describe('credits and minutes (checked at upload, before any speech-to-text spend)', () => {
  test('no credits: 402 and nothing kept or queued', async () => {
    await h.personalCredits(f.teacher.user, 0);
    const res = await save();
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    await expectNothingKept();
  });

  test('a recording saved but not yet charged holds its credit: with one credit the second student is refused', async () => {
    await h.personalCredits(f.teacher.user, 1);
    expect((await save()).status).toBe(200);
    const second = await save({ name: 'Guest', address: 'second@example.com' });
    expect(second.status).toBe(402);
    expect(second.body.code).toBe('INSUFFICIENT_CREDITS');
  });

  test('the teacher\'s speech-to-text minutes used up: the fixed 429 and nothing kept', async () => {
    const { dayKey, monthKey } = usage.utcKeys(new Date());
    await AudioUsageLedger.create({ key: rid(), recordingId: new mongoose.Types.ObjectId(), uploader: new mongoose.Types.ObjectId(), minutesChargedTo: f.teacher.user._id,
      seconds: 7200, dayKey, monthKey, state: 'consumed', reservedAt: new Date(), expiresAt: new Date() });
    const res = await save();
    expect(res.status).toBe(429);
    expect(res.body.code).toBe('AUDIO_UPLOADS_UNAVAILABLE');
    await expectNothingKept();
  });
});

describe('existing work for the student', () => {
  test('the student\'s own recording: refused (open it from the submissions list)', async () => {
    await makeAudioSubmission(f, { status: 'ready' });
    const res = await save();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('STUDENT_ALREADY_SUBMITTED');
  });

  test('a teacher upload exists: "new" asks to choose; "add_pages" does not apply; "replace" swaps the recording and starts marking again', async () => {
    const first = await save({ send: true });
    const id = first.body.data.item.submissionId;
    const oldRecording = (await stored(id)).audioRecording;
    await Submission.updateOne({ _id: id }, { $set: { evaluationStatus: 'completed', assessmentStatus: 'complete', 'teacherUpload.email.status': 'held' } });
    const asNew = await save();
    expect(asNew.status).toBe(409);
    expect(asNew.body).toEqual(expect.objectContaining({ code: 'TEACHER_UPLOAD_EXISTS', details: expect.objectContaining({ submissionId: id }) }));
    const added = await save({ mode: 'add_pages' });
    expect(added.status).toBe(400);
    expect(added.body.code).toBe('TEACHER_UPLOAD_MODE_INVALID');
    const replaced = await save({ mode: 'replace', body: samples.wav(9) });
    expect(replaced.status).toBe(200);
    expect(replaced.body.data.item.submissionId).toBe(id);
    const sub = await stored(id);
    expect(String(sub.audioRecording)).not.toBe(String(oldRecording));
    expect(await AudioRecording.exists({ _id: oldRecording })).toBeNull();
    expect(sub.evaluationStatus).toBe('pending');
    expect(sub.assessmentStatus).toBeUndefined();
    expect(sub.teacherUpload.email.status).toBe('queued');
  });

  test('the student cannot replace a recording the teacher uploaded (and is told why); their status says it cannot be replaced', async () => {
    await save();
    const res = await request(app).post(`/api/speaking/${f.assignment._id}`).set(auth(f.student.token)).set('Idempotency-Key', rid())
      .attach('audio', samples.wav(8), { filename: 'mine.wav', contentType: 'audio/wav' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SPEAKING_UPLOADED_BY_TEACHER');
    const mine = await request(app).get(`/api/speaking/${f.assignment._id}/my`).set(auth(f.student.token));
    expect(mine.body.data.submission.canReplace).toBe(false);
  });
});

describe('check and list (the dialog and the submissions list)', () => {
  test('check: each row\'s account, existing work, errors, and credits net of reservations', async () => {
    await save({ name: 'Ana Lima' });
    const res = await request(app).post(`${base()}/check`).set(auth(f.teacher.token)).send({ students: [
      { name: 'Ana Lima', email: f.student.user.email }, { name: 'New Guest', email: 'new@example.com' }, { name: '', email: 'bad' }] });
    expect(res.status).toBe(200);
    const [member, guest, broken] = res.body.data.students;
    expect(member).toEqual(expect.objectContaining({ account: 'member', existing: expect.objectContaining({ pages: 1 }) }));
    expect(guest).toEqual(expect.objectContaining({ account: 'guest' }));
    expect(guest.existing).toBeUndefined();
    expect(broken.errors).toEqual(expect.objectContaining({ name: expect.any(String), email: expect.any(String) }));
    expect(res.body.data.credits).toEqual({ needed: 2, available: 9 });
  });

  test('list: every teacher upload in the essay item shape, with the speaking states mapped onto the same status names', async () => {
    const at = async (name, address, change, recordingChange) => {
      const res = await save({ name, address });
      const sub = await stored(res.body.data.item.submissionId);
      if (change) await Submission.updateOne({ _id: sub._id }, { $set: change });
      if (recordingChange) await AudioRecording.updateOne({ _id: sub.audioRecording }, { $set: recordingChange });
      return res.body.data.item.submissionId;
    };
    const ids = {
      uploaded: await at('A', 'a@example.com'),
      reading: await at('B', 'b@example.com', null, { status: 'transcribing' }),
      processing: await at('C', 'c@example.com', { evaluationStatus: 'processing', assessmentStatus: 'processing' }, { status: 'ready' }),
      waiting: await at('D', 'd@example.com', { evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS' }, { status: 'ready' }),
      marked: await at('E', 'e@example.com', { evaluationStatus: 'completed', assessmentStatus: 'complete' }, { status: 'ready' }),
      sttFailed: await at('F', 'f@example.com', null, { status: 'failed', lastErrorCode: 'AUDIO_STT_TIMEOUT' }),
      notMarked: await at('G', 'g@example.com', { evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_NOT_ENOUGH_SPEECH' }, { status: 'ready' })
    };
    const res = await request(app).get(base()).set(auth(f.teacher.token));
    const byId = Object.fromEntries(res.body.data.items.map(item => [item.submissionId, item]));
    expect(byId[ids.uploaded]).toEqual(expect.objectContaining({ status: 'uploaded', kind: 'speaking', pages: 1 }));
    expect(byId[ids.reading].status).toBe('reading');
    expect(byId[ids.processing].status).toBe('processing');
    expect(byId[ids.waiting]).toEqual(expect.objectContaining({ status: 'waiting_credits', failureCode: 'INSUFFICIENT_ASSESSMENT_CREDITS' }));
    expect(byId[ids.marked].status).toBe('marked');
    expect(byId[ids.sttFailed]).toEqual(expect.objectContaining({ status: 'failed', failureCode: 'AUDIO_STT_TIMEOUT' }));
    expect(byId[ids.notMarked]).toEqual(expect.objectContaining({ status: 'not_marked', failureCode: 'SPEAKING_NOT_ENOUGH_SPEECH' }));
    expect(JSON.stringify(res.body)).not.toMatch(/requestKey|contentHash|audioSha256|storedPath|transcript|"words"/);
  });
});

describe('Send, Resend and the email worker', () => {
  test('Send: none -> queued (once); a guest or work without a result: refused', async () => {
    const member = (await save()).body.data.item.submissionId;
    const sent = await request(app).post(`${base()}/${member}/send`).set(auth(f.teacher.token)).send({});
    expect(sent.body.data).toEqual(expect.objectContaining({ alreadyRequested: false, item: expect.objectContaining({ emailStatus: 'queued' }) }));
    expect((await request(app).post(`${base()}/${member}/send`).set(auth(f.teacher.token)).send({})).body.data.alreadyRequested).toBe(true);
    const guest = (await save({ name: 'G', address: 'g@example.com' })).body.data.item.submissionId;
    const refused = await request(app).post(`${base()}/${guest}/send`).set(auth(f.teacher.token)).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('TEACHER_UPLOAD_GUEST_EMAIL_UNAVAILABLE');
    await Submission.updateOne({ _id: member }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_NOT_ENOUGH_SPEECH', 'teacherUpload.email.status': 'none' } });
    const noResult = await request(app).post(`${base()}/${member}/send`).set(auth(f.teacher.token)).send({});
    expect(noResult.status).toBe(409);
    expect(noResult.body.code).toBe('TEACHER_UPLOAD_MARKING_FAILED');
    expect((await request(app).post(`${base()}/${member}/send`).set(auth(f.otherTeacher.token)).send({})).status).toBe(404);
  });

  test('marked: the speaking email goes to the member with a sign-in link to their speaking page; nothing from the recording', async () => {
    const id = (await save({ send: true })).body.data.item.submissionId;
    await Submission.updateOne({ _id: id }, { $set: { evaluationStatus: 'completed', assessmentStatus: 'complete', writingCorrections: [] } });
    const outcome = await emailWorker.run();
    expect(outcome.sent).toBe(1);
    const message = email.sendTeacherUploadFeedbackEmail.mock.calls[0][0];
    expect(message).toEqual(expect.objectContaining({ kind: 'speaking', to: f.student.user.email, needsLogin: true }));
    expect(message.link).toContain(`/student/my-classes/detail/my-speaking/${f.assignment._id}`);
    expect(JSON.stringify(message)).not.toMatch(/transcript|assessorText|\.wav|audio\/|mediaUrl/i);
    expect((await stored(id)).teacherUpload.email.status).toBe('sent');
  });

  test('no result (not enough speech, or transcription failed): the queued email is held, not sent; a retry queues it again', async () => {
    const short = (await save({ send: true })).body.data.item.submissionId;
    await Submission.updateOne({ _id: short }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_NOT_ENOUGH_SPEECH' } });
    const failedStt = (await save({ name: 'G', address: 'other@example.com', send: false })).body.data.item.submissionId;
    await Submission.updateOne({ _id: failedStt }, { $set: { 'teacherUpload.email.status': 'queued' } });
    await AudioRecording.updateOne({ _id: (await stored(failedStt)).audioRecording }, { $set: { status: 'failed', lastErrorCode: 'AUDIO_STT_TIMEOUT' } });
    await emailWorker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    expect((await stored(short)).teacherUpload.email.status).toBe('held');
    expect((await stored(failedStt)).teacherUpload.email.status).toBe('held');
    const retried = await request(app).post(`${base()}/${failedStt}/retry`).set(auth(f.teacher.token)).send({});
    expect(retried.status).toBe(200);
    expect((await stored(failedStt)).teacherUpload.email.status).toBe('queued');
    expect((await AudioRecording.findById((await stored(failedStt)).audioRecording).lean()).status).toBe('queued');
  });

  test('a guest speaking email is never sent, even if one ended up queued', async () => {
    const id = (await save({ name: 'G', address: 'g@example.com' })).body.data.item.submissionId;
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.status': 'queued', evaluationStatus: 'completed', assessmentStatus: 'complete' } });
    await emailWorker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    expect((await stored(id)).teacherUpload.email).toEqual(expect.objectContaining({ status: 'failed', lastErrorCode: 'GUEST_SPEAKING_UNAVAILABLE' }));
  });
});

describe('only speaking teacher uploads (the guard inventory relies on this)', () => {
  test('send and retry answer 404 for a submission that is not a recording this teacher uploaded: an essay teacher upload, a student\'s own recording', async () => {
    const essayUpload = await Submission.create({ assignment: f.assignment._id, class: f.klass._id, student: f.student.user._id, submissionMode: 'registered',
      files: [], status: 'submitted', submittedAt: new Date(), teacherUpload: { uploadedBy: f.teacher.user._id, batchId: 'batch-0001', uploadedAt: new Date(),
        email: { status: 'none' } } });
    const classmate = await person('student', 'classmate-own');
    await Membership.create({ student: classmate.user._id, class: f.klass._id, status: 'active' });
    const own = await makeAudioSubmission({ ...f, student: classmate }, { status: 'ready' });
    for (const id of [essayUpload._id, own.submission._id]) {
      for (const action of ['send', 'retry']) {
        const res = await request(app).post(`${base()}/${id}/${action}`).set(auth(f.teacher.token)).send({});
        expect({ id: String(id), action, status: res.status, code: res.body.code }).toEqual({ id: String(id), action, status: 404, code: 'NOT_FOUND' });
      }
    }
    // No side effect either: the essay upload's email was not queued, the student's recording was not requeued.
    expect((await stored(essayUpload._id)).teacherUpload.email.status).toBe('none');
    expect((await AudioRecording.findById(own.recording._id).lean()).status).toBe('ready');
  });
});

describe('Retry (marking or transcription) and the watchdog', () => {
  test('retry: a recording that could not be assessed is not retried; no credits: 402', async () => {
    const id = (await save()).body.data.item.submissionId;
    await AudioRecording.updateOne({ _id: (await stored(id)).audioRecording }, { $set: { status: 'ready' } });
    await Submission.updateOne({ _id: id }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_NOT_ENGLISH' } });
    const res = await request(app).post(`${base()}/${id}/retry`).set(auth(f.teacher.token)).send({});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ASSESSMENT_NOT_RETRYABLE');
    await Submission.updateOne({ _id: id }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: 'AI_OUTPUT_VALIDATION_FAILED' } });
    await h.personalCredits(f.teacher.user, 0);
    const broke = await request(app).post(`${base()}/${id}/retry`).set(auth(f.teacher.token)).send({});
    expect(broke.status).toBe(402);
  });

  test('the speaking page\'s own retry (retry-transcription) also queues a held email again', async () => {
    const id = (await save({ send: true })).body.data.item.submissionId;
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.status': 'held' } });
    await AudioRecording.updateOne({ _id: (await stored(id)).audioRecording }, { $set: { status: 'failed', lastErrorCode: 'AUDIO_STT_TIMEOUT' } });
    const res = await request(app).post(`/api/speaking/submissions/${id}/retry-transcription`).set(auth(f.teacher.token));
    expect(res.status).toBe(200);
    expect((await stored(id)).teacherUpload.email.status).toBe('queued');
  });

  test('the essay watchdog never fails a speaking teacher upload (speaking has its own retries and limits)', async () => {
    const id = (await save()).body.data.item.submissionId;
    const old = new Date(Date.now() - 24 * 3600 * 1000);
    await Submission.collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: { assessmentStatus: 'processing', updatedAt: old, analysisAttempt: 99 } });
    await recovery.sweepStalledTeacherUploads(undefined, new Date());
    expect((await stored(id)).assessmentStatus).toBe('processing');
  });
});
