'use strict';
// Stage 11: storage hygiene for recordings.
// - scripts/auditAudioStorage.js is READ-ONLY: it lists audio files on disk that no recording uses, and recordings whose file is missing. It
//   deletes and changes nothing (proved below by comparing the disk and the database before and after).
// - Removing a speaking submission releases the storage exactly as charged, to whoever was charged: the teacher for a guest's recording and for
//   a recording the teacher uploaded, the student for their own.
// In-memory MongoDB; no provider call (the global fetch is a tripwire).
process.env.JWT_SECRET = 'audio-storage-audit-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/audio-storage-audit-${process.pid}`;
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const User = require('../src/models/user.model');
const Submission = require('../src/models/Submission');
const AudioRecording = require('../src/models/AudioRecording');
const File = require('../src/models/File');
const storage = require('../src/services/audio/storage');
const { auditAudioStorage } = require('../scripts/auditAudioStorage');

jest.setTimeout(60000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const onDisk = () => (fs.existsSync(storage.audioRoot()) ? fs.readdirSync(storage.audioRoot()).sort() : []);
const storageMB = async id => (await User.findById(id).lean()).usage?.storageMB || 0;
async function databaseState() {
  const db = mongoose.connection.db;
  const out = {};
  for (const name of ['audiorecordings', 'files', 'submissions', 'users']) out[name] = await db.collection(name).find({}).sort({ _id: 1 }).toArray();
  return JSON.parse(JSON.stringify(out));
}
let f;
// As if run 11 minutes later: files written in the last 10 minutes are skipped (an upload in progress writes its file first).
const audit = () => auditAudioStorage({ now: Date.now() + 11 * 60 * 1000 });

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

describe('scripts/auditAudioStorage.js (read-only)', () => {
  test('a clean state: nothing to report', async () => {
    await makeAudioSubmission(f);
    const report = await audit();
    expect(report).toEqual(expect.objectContaining({ filesOnDisk: 1, recordings: 1, orphanFiles: [], missingFiles: [] }));
  });

  test('lists files nobody uses and recordings whose file is gone; deletes and changes nothing', async () => {
    const kept = await makeAudioSubmission(f);
    const lost = await makeAudioSubmission(f, { mode: 'guest' });
    fs.rmSync(lost.absolute);
    fs.writeFileSync(path.join(storage.audioRoot(), 'stray-0000.wav'), Buffer.alloc(100));
    const noFileRecord = await makeAudioSubmission({ ...f, assignment: f.essay }, { mode: 'guest' });
    await File.deleteOne({ _id: noFileRecord.file._id });
    const deleted = await makeAudioSubmission(f, { mode: 'guest' });
    await AudioRecording.updateOne({ _id: deleted.recording._id }, { $set: { audioDeletedAt: new Date() } });
    fs.rmSync(deleted.absolute);
    const diskBefore = onDisk(), dbBefore = await databaseState();

    const report = await audit();

    // The stray file, and the file whose File record is gone (nothing points at it any more): both are orphans.
    expect(report.orphanFiles.map(item => item.name).sort()).toEqual(['stray-0000.wav', path.basename(noFileRecord.absolute)].sort());
    expect(report.orphanFiles.find(item => item.name === 'stray-0000.wav').sizeBytes).toBe(100);
    expect(report.missingFiles.map(item => [item.recordingId, item.reason]).sort()).toEqual([
      [String(lost.recording._id), 'FILE_NOT_ON_DISK'], [String(noFileRecord.recording._id), 'FILE_RECORD_MISSING']].sort());
    // A recording whose audio was deleted on purpose (audioDeletedAt) is not reported.
    expect(report.missingFiles.some(item => item.recordingId === String(deleted.recording._id))).toBe(false);
    // The kept recording's file is neither an orphan nor missing; and nothing personal is printed (ids, codes, random names only).
    expect(JSON.stringify(report)).not.toMatch(/@example\.com|Guest Speaker|recording\.wav/);
    expect(onDisk()).toEqual(diskBefore);
    expect(await databaseState()).toEqual(dbBefore);
    expect(fs.existsSync(kept.absolute)).toBe(true);
  });

  test('no audio folder yet: an empty report, not an error', async () => {
    const report = await audit();
    expect(report).toEqual(expect.objectContaining({ filesOnDisk: 0, recordings: 0, orphanFiles: [], missingFiles: [] }));
  });
});

describe('removing a speaking submission releases storage to whoever was charged', () => {
  async function chargedTo(user, made, megabytes = 2) {
    await AudioRecording.updateOne({ _id: made.recording._id }, { $set: { storageChargedTo: user._id, storageChargedMB: megabytes } });
    await User.updateOne({ _id: user._id }, { $inc: { 'usage.storageMB': megabytes } });
  }
  const remove = id => request(app).delete(`/api/submissions/${id}`).set(auth(f.teacher.token));

  test('a guest recording (charged to the teacher): file, recording and the teacher\'s storage released', async () => {
    const made = await makeAudioSubmission(f, { mode: 'guest' });
    await chargedTo(f.teacher.user, made);
    expect(await storageMB(f.teacher.user._id)).toBe(2);
    const res = await remove(made.submission._id);
    expect(res.status).toBeLessThan(300);
    expect(fs.existsSync(made.absolute)).toBe(false);
    expect(await AudioRecording.countDocuments()).toBe(0);
    expect(await storageMB(f.teacher.user._id)).toBe(0);
    expect((await audit()).orphanFiles).toEqual([]);
  });

  test('a recording the teacher uploaded for a class member (charged to the teacher): the teacher\'s storage, not the student\'s', async () => {
    const made = await makeAudioSubmission(f);
    await Submission.updateOne({ _id: made.submission._id }, { $set: { teacherUpload: { uploadedBy: f.teacher.user._id, batchId: 'b-1', uploadedAt: new Date(),
      typedName: 'Ana', email: { status: 'none', attempts: 0 } } } });
    await chargedTo(f.teacher.user, made, 3);
    await User.updateOne({ _id: f.student.user._id }, { $set: { 'usage.storageMB': 5 } });
    expect((await remove(made.submission._id)).status).toBeLessThan(300);
    expect(await storageMB(f.teacher.user._id)).toBe(0);
    expect(await storageMB(f.student.user._id)).toBe(5);
    expect(fs.existsSync(made.absolute)).toBe(false);
  });
});
