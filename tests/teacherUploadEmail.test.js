'use strict';
// Stage 4: the feedback-email worker for work a teacher uploaded. Sent exactly once when marking is complete and only when the
// teacher asked (never for a plain Save); retried with backoff and a limit; no duplicates on parallel runs or restarts; Resend;
// at most 60 per teacher in 10 minutes; the emailed link opens the finished feedback, and expired or lost links can be
// recovered. Email is mocked; in-memory database; synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-email-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-email-test-' + process.pid;
jest.setTimeout(60000);
jest.mock('../src/services/email.service', () => ({
  sendTeacherUploadFeedbackEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })),
  sendGuestSubmissionEmail: jest.fn(async () => ({ success: true }))
}));

const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const User = require('../src/models/user.model');
const access = require('../src/services/guestAccess.service');
const worker = require('../src/services/teacherUploadEmail.service');
const uploads = require('../src/services/teacherUpload.service');
const email = require('../src/services/email.service');

const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture;
const id = () => new mongoose.Types.ObjectId();
const minutes = n => n * 60 * 1000;

/** A teacher upload (guest by default) with the given email status and marking state. */
function upload(over = {}) {
  const { status = 'queued', assessmentStatus = 'complete', teacherId = fixture.teacher._id, email: guestEmail = `s-${Math.random().toString(36).slice(2)}@example.com`, ...rest } = over;
  return Submission.create({ assignment: fixture.IDS.assignment, class: fixture.IDS.class, submissionMode: 'guest', submittedAt: new Date(), status: 'submitted',
    assessmentStatus, guest: { displayName: 'Sam Lee', normalizedEmail: guestEmail },
    teacherUpload: { uploadedBy: teacherId, batchId: 'batch-0001', uploadedAt: new Date(), email: { status, ...(status === 'queued' ? { requestedAt: new Date() } : {}) } }, ...rest });
}
const emailOf = async doc => (await Submission.findById(doc._id).select('+teacherUpload').lean()).teacherUpload.email;
const linkFrom = call => new URL(call.link);

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks();
  email.sendTeacherUploadFeedbackEmail.mockResolvedValue({ success: true });
  fixture = await seedAnnotationFixture({ uploadRoot });
  await User.updateOne({ _id: fixture.teacher._id }, { $set: { displayName: 'Ms Rahman' } });
  await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { title: 'My Summer Holiday' } });
});

describe('when to send', () => {
  test('a plain Save is never emailed, even after marking', async () => {
    const saved = await upload({ status: 'none' });
    expect(await worker.run()).toEqual(expect.objectContaining({ sent: 0 }));
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    expect((await emailOf(saved)).status).toBe('none');
  });

  test('"Save and send" waits for marking, then sends once with the teacher, assignment and a working private link', async () => {
    const queued = await upload({ assessmentStatus: 'processing', email: 'sam@example.com' });
    await worker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    await Submission.updateOne({ _id: queued._id }, { $set: { assessmentStatus: 'complete' } });
    expect((await worker.run()).sent).toBe(1);
    await worker.run();
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(1);
    const sent = email.sendTeacherUploadFeedbackEmail.mock.calls[0][0];
    expect(sent).toEqual(expect.objectContaining({ to: 'sam@example.com', studentName: 'Sam Lee', teacherName: 'Ms Rahman', assignmentTitle: 'My Summer Holiday', needsLogin: false }));
    const url = linkFrom(sent);
    expect(url.pathname).toBe(`/guest/results/${queued._id}`);
    await expect(access.authorize(String(queued._id), url.hash.slice(1))).resolves.toBeTruthy();
    expect(await emailOf(queued)).toEqual(expect.objectContaining({ status: 'sent', attempts: 1 }));
  });

  test('a class member is emailed a link to their submission in the app (sign in), not a private link', async () => {
    await Submission.deleteMany({ student: fixture.student._id });
    const member = await Submission.create({ assignment: fixture.IDS.assignment, class: fixture.IDS.class, submissionMode: 'registered', student: fixture.student._id,
      submittedAt: new Date(), status: 'submitted', assessmentStatus: 'complete',
      teacherUpload: { uploadedBy: fixture.teacher._id, batchId: 'batch-0001', uploadedAt: new Date(), email: { status: 'queued' } } });
    await worker.run();
    const sent = email.sendTeacherUploadFeedbackEmail.mock.calls[0][0];
    expect(sent).toEqual(expect.objectContaining({ to: 'student@example.com', needsLogin: true }));
    expect(sent.link).toBe(`https://school.example/student/my-classes/detail/my-submissions/${fixture.IDS.assignment}?classId=${fixture.IDS.class}`);
    expect((await emailOf(member)).status).toBe('sent');
  });
});

describe('exactly once', () => {
  test('parallel workers send each email once', async () => {
    const docs = await Promise.all([1, 2, 3, 4, 5].map(() => upload()));
    await Promise.all([worker.run(), worker.run(), worker.run()]);
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(5);
    expect(new Set(email.sendTeacherUploadFeedbackEmail.mock.calls.map(([m]) => m.to)).size).toBe(5);
    for (const doc of docs) expect((await emailOf(doc)).status).toBe('sent');
  });

  test('after a crash mid-send the email is never resent by itself; it is marked for the teacher to resend', async () => {
    const stuck = await upload();
    await Submission.updateOne({ _id: stuck._id }, { $set: { 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': new Date(Date.now() - 1000) } });
    await worker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    expect(await emailOf(stuck)).toEqual(expect.objectContaining({ status: 'failed', lastErrorCode: 'DELIVERY_UNCERTAIN' }));
    // One still within its lease (another worker is sending it) is left alone.
    const live = await upload();
    await Submission.updateOne({ _id: live._id }, { $set: { 'teacherUpload.email.status': 'sending', 'teacherUpload.email.leaseUntil': new Date(Date.now() + minutes(4)) } });
    await worker.run();
    expect((await emailOf(live)).status).toBe('sending');
  });
});

describe('failures, retries and Resend', () => {
  test('retries with backoff, then fails with a safe code after the attempt limit; Resend starts over', async () => {
    email.sendTeacherUploadFeedbackEmail.mockResolvedValue({ success: false, code: 'SMTP_CONNECTION_FAILED' });
    const doc = await upload();
    let now = new Date();
    await worker.run({ now });
    let state = await emailOf(doc);
    expect(state).toEqual(expect.objectContaining({ status: 'queued', attempts: 1, lastErrorCode: 'SMTP_CONNECTION_FAILED' }));
    expect(state.nextAttemptAt.getTime() - now.getTime()).toBe(worker.BACKOFF_MS[0]);
    await worker.run({ now });                                         // not due yet
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(1);
    for (let attempt = 2; attempt <= worker.MAX_ATTEMPTS; attempt++) {
      now = new Date((await emailOf(doc)).nextAttemptAt.getTime() + 1);
      await worker.run({ now });
    }
    state = await emailOf(doc);
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(worker.MAX_ATTEMPTS);
    expect(state).toEqual(expect.objectContaining({ status: 'failed', attempts: worker.MAX_ATTEMPTS, lastErrorCode: 'SMTP_CONNECTION_FAILED' }));
    await worker.run({ now: new Date(now.getTime() + minutes(120)) });
    expect(email.sendTeacherUploadFeedbackEmail).toHaveBeenCalledTimes(worker.MAX_ATTEMPTS);
    // The private links issued for failed sends were removed again.
    expect((await Submission.findById(doc._id).select('+guest.recoveryAccess').lean()).guest.recoveryAccess || []).toEqual([]);

    // Resend: queued again with a fresh attempt count, then sent.
    email.sendTeacherUploadFeedbackEmail.mockResolvedValue({ success: true });
    const resent = await uploads.requestSend({ teacher: fixture.teacher, assignmentId: fixture.IDS.assignment, submissionId: doc._id });
    expect(resent).toEqual(expect.objectContaining({ alreadyRequested: false, item: expect.objectContaining({ emailStatus: 'queued' }) }));
    expect((await emailOf(doc)).attempts).toBe(0);
    await worker.run();
    expect(await emailOf(doc)).toEqual(expect.objectContaining({ status: 'sent', attempts: 1 }));
  });

  test('a recipient that cannot exist fails at once (no pointless retries)', async () => {
    const ghost = await Submission.create({ assignment: fixture.IDS.assignment, class: fixture.IDS.class, submissionMode: 'registered', student: id(),
      submittedAt: new Date(), status: 'submitted', assessmentStatus: 'complete',
      teacherUpload: { uploadedBy: fixture.teacher._id, batchId: 'batch-0001', uploadedAt: new Date(), email: { status: 'queued' } } });
    await worker.run();
    expect(email.sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    expect(await emailOf(ghost)).toEqual(expect.objectContaining({ status: 'failed', lastErrorCode: 'RECIPIENT_MISSING' }));
  });
});

describe('rate limit: 60 per teacher in 10 minutes', () => {
  test('the 61st waits without using an attempt; another teacher is not affected; it goes out once the window allows', async () => {
    const other = await User.create({ firebaseUid: 'other-email-teacher', email: 'other.teacher@example.com', role: 'teacher', displayName: 'Mr Khan' });
    await Promise.all(Array.from({ length: 61 }, () => upload()));
    const theirs = await upload({ teacherId: other._id });
    const now = new Date();
    const outcome = await worker.run({ now, batchSize: 100 });
    expect(outcome).toEqual(expect.objectContaining({ sent: 61, deferred: 1 }));
    const waiting = await Submission.find({ 'teacherUpload.email.status': 'queued' }).select('+teacherUpload').lean();
    expect(waiting).toHaveLength(1);
    expect(String(waiting[0].teacherUpload.uploadedBy)).toBe(String(fixture.teacher._id));
    expect(waiting[0].teacherUpload.email.attempts).toBe(0);
    expect((await emailOf(theirs)).status).toBe('sent');
    await worker.run({ now: new Date(now.getTime() + minutes(1) + 1) });            // still inside the window
    expect((await emailOf(waiting[0])).status).toBe('queued');
    await worker.run({ now: new Date(now.getTime() + worker.RATE_WINDOW_MS + 1) });  // the window has moved on
    expect((await emailOf(waiting[0])).status).toBe('sent');
  });

  test('the quota is atomic under parallel reservations', async () => {
    const teacher = id(), now = new Date();
    const results = await Promise.all(Array.from({ length: 80 }, () => worker.reserveQuota(teacher, now)));
    expect(results.filter(Boolean)).toHaveLength(worker.RATE_LIMIT);
  });
});

describe('the emailed link', () => {
  const open = (submissionId, token) => request(app).get(`/api/guest/submissions/${submissionId}`).set('X-Guest-Token', token);
  async function teacherUploadedFinishedWork() {
    // The fixture's guest submission is fully marked (corrections and feedback); make it a teacher upload on an assignment that
    // does not accept guest submissions.
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { allowGuestSubmission: false } });
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: {
      teacherUpload: { uploadedBy: fixture.teacher._id, batchId: 'batch-0001', uploadedAt: new Date(), email: { status: 'queued', attempts: 0 } } } });
    await worker.run();
    return linkFrom(email.sendTeacherUploadFeedbackEmail.mock.calls.at(-1)[0]).hash.slice(1);
  }

  test('opens the finished feedback', async () => {
    const token = await teacherUploadedFinishedWork();
    const res = await open(fixture.IDS.guest, token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual(expect.objectContaining({ title: 'My Summer Holiday', name: 'Guest Student' }));
    expect(res.body.data.feedback).toBeTruthy();
    expect(JSON.stringify(res.body)).not.toMatch(/teacherUpload|uploadedBy|teacher@example.com/);
  });

  test('while marking runs again (pages replaced) it answers with the progress, not an error', async () => {
    const token = await teacherUploadedFinishedWork();
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: { assessmentStatus: 'started', evaluationStatus: 'pending', ocrStatus: 'pending' } });
    const res = await open(fixture.IDS.guest, token);
    expect(res.status).toBe(200);
    expect(res.body.data.status).not.toBe('ready');
    expect(res.body.data.feedback).toBeNull();
  });

  test('an expired link is refused with a plain message, and a new link can be requested for teacher-uploaded work', async () => {
    const token = await teacherUploadedFinishedWork();
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $set: { 'guest.recoveryAccess.$[].expiresAt': new Date(Date.now() - 1000) } });
    const expired = await open(fixture.IDS.guest, token);
    expect(expired.status).toBe(410);
    expect(expired.body.message).toBe('This link is invalid or has expired. Request a new link from your assignment page.');
    const recovery = await require('../src/services/guestRecovery.service').resendGuestLink({ emailNormalized: 'guest.student@example.com', submissionId: String(fixture.IDS.guest) });
    expect(recovery.sent).toBe(true);
    expect(email.sendGuestRecoveryEmail).toHaveBeenCalledTimes(1);
  });

  test('the "all my submissions" portal lists teacher-uploaded work even when the assignment is closed to guests', async () => {
    await teacherUploadedFinishedWork();
    const listed = await require('../src/services/recoveryPortal.service').listAssignments('guest.student@example.com');
    expect(listed.map(item => item.id)).toEqual([String(fixture.IDS.guest)]);
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $unset: { teacherUpload: 1 } });   // an ordinary guest submission stays hidden
    expect(await require('../src/services/recoveryPortal.service').listAssignments('guest.student@example.com')).toEqual([]);
  });
});
