'use strict';
// Stage 1 of "teacher uploads students' handwritten work": the data model. A teacher upload is a normal submission (registered
// or guest) carrying a teacherUpload record that is hidden from default queries, a per-assignment idempotency key, and its
// own email status. The guest result-email queue must never email a teacher upload by itself: those emails are sent only
// when the teacher chose "Save and send". Synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-model-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
jest.setTimeout(60000);
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/controllers/guestSubmission.controller', () => ({ assignmentFor: jest.fn(async () => ({ assignment: { title: 'My Summer Holiday' } })) }));

const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Submission = require('../src/models/Submission');
const { ensureTeacherUploadIndexes, TEACHER_UPLOAD_INDEX_NAMES } = require('../scripts/migrateTeacherUploadIndexes');
const email = require('../src/services/email.service').sendGuestSubmissionEmail;

const id = () => new mongoose.Types.ObjectId();
const teacherId = id(), classId = id(), assignmentId = id();

function guestSubmission(overrides = {}) {
  return { submissionMode: 'guest', assignment: assignmentId, class: classId, qrToken: 'qr-1', submittedAt: new Date(), status: 'submitted',
    guest: { displayName: 'Sam Lee', normalizedEmail: 'sam.lee@example.com', expiresAt: new Date(Date.now() + 86400000) }, ...overrides };
}
function teacherUpload(overrides = {}) {
  return { uploadedBy: teacherId, batchId: 'batch-1', requestKey: 'a'.repeat(64), contentHash: 'b'.repeat(64), uploadedAt: new Date(), ...overrides };
}

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => { await clearDatabase(); email.mockClear(); await Submission.syncIndexes(); });

describe('Submission.teacherUpload', () => {
  test('is hidden from default queries (never reaches a student payload) and readable with an explicit select', async () => {
    const doc = await Submission.create(guestSubmission({ teacherUpload: teacherUpload() }));
    const plain = await Submission.findById(doc._id).lean();
    expect(plain.teacherUpload).toBeUndefined();
    const selected = await Submission.findById(doc._id).select('+teacherUpload').lean();
    expect(String(selected.teacherUpload.uploadedBy)).toBe(String(teacherId));
    expect(selected.teacherUpload.email).toEqual(expect.objectContaining({ status: 'none', attempts: 0 }));
  });

  test('is absent on ordinary submissions', async () => {
    const doc = await Submission.create(guestSubmission());
    expect((await Submission.findById(doc._id).select('+teacherUpload').lean()).teacherUpload).toBeUndefined();
  });

  test('accepts only the known email statuses and requires the uploader, batch and time', async () => {
    await expect(Submission.create(guestSubmission({ teacherUpload: teacherUpload({ email: { status: 'delivered' } }) })))
      .rejects.toThrow(/status/);
    await expect(Submission.create(guestSubmission({ teacherUpload: teacherUpload({ uploadedBy: undefined }) })))
      .rejects.toThrow(/uploadedBy/);
    await expect(Submission.create(guestSubmission({ teacherUpload: teacherUpload({ batchId: undefined }) })))
      .rejects.toThrow(/batchId/);
    for (const status of ['none', 'queued', 'sending', 'sent', 'failed', 'held'])
      await expect(Submission.create(guestSubmission({ guest: { displayName: status, normalizedEmail: `${status}@example.com` },
        teacherUpload: teacherUpload({ requestKey: status.padEnd(64, '0'), email: { status } }) }))).resolves.toBeTruthy();
  });

  test('an idempotency key can be used once per assignment (a retried request cannot create a second submission)', async () => {
    await Submission.create(guestSubmission({ teacherUpload: teacherUpload() }));
    await expect(Submission.create(guestSubmission({ teacherUpload: teacherUpload() }))).rejects.toMatchObject({ code: 11000 });
    // The same key on another assignment, and submissions without a key, are unaffected.
    await expect(Submission.create(guestSubmission({ assignment: id(), teacherUpload: teacherUpload() }))).resolves.toBeTruthy();
    await expect(Submission.create(guestSubmission())).resolves.toBeTruthy();
    await expect(Submission.create(guestSubmission())).resolves.toBeTruthy();
  });
});

describe('guest result-email queue', () => {
  const worker = () => require('../src/services/guestResultNotification.service').run();

  test('does not email a completed teacher upload on its own', async () => {
    await Submission.create(guestSubmission({ assessmentStatus: 'complete', teacherUpload: teacherUpload() }));
    await worker();
    expect(email).not.toHaveBeenCalled();
    const doc = await Submission.findOne().lean();
    expect(doc.guest.resultEmailSentAt).toBeUndefined();
    expect(doc.guest.resultEmailLeaseUntil).toBeUndefined();
  });

  test('still emails an ordinary completed guest submission once', async () => {
    await Submission.create(guestSubmission({ assessmentStatus: 'complete' }));
    await worker(); await worker();
    expect(email).toHaveBeenCalledTimes(1);
    expect(email.mock.calls[0][0]).toEqual(expect.objectContaining({ to: 'sam.lee@example.com', resultReady: true }));
  });
});

describe('index migration', () => {
  test('creates exactly the teacher-upload indexes, and is idempotent', async () => {
    await mongoose.connection.db.dropCollection('submissions').catch(() => undefined);
    await mongoose.connection.db.createCollection('submissions');
    await ensureTeacherUploadIndexes();
    const summary = await ensureTeacherUploadIndexes();          // second run: no error, nothing changes
    const byName = Object.fromEntries(summary.map(index => [index.name, index]));
    expect(Object.keys(byName).sort()).toEqual(['_id_', ...TEACHER_UPLOAD_INDEX_NAMES].sort());
    expect(byName.teacher_upload_request_v1).toMatchObject({ key: { assignment: 1, 'teacherUpload.requestKey': 1 }, unique: true,
      partialFilterExpression: { 'teacherUpload.requestKey': { $type: 'string' } } });
    expect(byName.teacher_upload_email_queue_v1).toMatchObject({ key: { 'teacherUpload.email.status': 1, assessmentStatus: 1, 'teacherUpload.email.nextAttemptAt': 1 } });
    expect(byName.teacher_upload_list_v1).toMatchObject({ key: { assignment: 1, 'teacherUpload.uploadedBy': 1, createdAt: -1 } });
  });
});
