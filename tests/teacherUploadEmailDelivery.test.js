'use strict';
// "Email sent" must mean the SMTP server accepted THIS recipient. The real email service and worker run against a mocked SMTP
// transport (nodemailer); nothing is ever sent. Covers: sent only on an accepted recipient; failed at once (Resend shown) when the
// recipient is rejected, nobody is accepted or the reply is not 2xx; times, counts, SMTP codes and messageId stored and logged
// without the address; "Resend email" on an email already sent (cool-down, idempotent request id, route); and no duplicate
// sending when the recovery-era run() and the new timer run at the same time. Synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-delivery-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-delivery-' + process.pid;
process.env.SMTP_USER = 'sender@example.com';
process.env.SMTP_PASS = 'test-only-password';
process.env.TEACHER_UPLOAD_SEND_RATE_LIMIT_MAX = '1000';
jest.setTimeout(60000);
jest.mock('nodemailer', () => {
  const transport = { sendMail: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const request = require('supertest');
const nodemailer = require('nodemailer');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const Submission = require('../src/models/Submission');
const email = require('../src/services/email.service');
const worker = require('../src/services/teacherUploadEmail.service');
const uploads = require('../src/services/teacherUpload.service');

const transport = nodemailer.transport;
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const ADDRESS = 'sam.lee@example.com';
const OK = { accepted: [ADDRESS], rejected: [], response: '250 2.0.0 Ok: queued as 4F2A1', messageId: '<synthetic-1@example.com>' };
let fixture;

function upload(status = 'queued', extra = {}) {
  return Submission.create({ assignment: fixture.IDS.assignment, class: fixture.IDS.class, submissionMode: 'guest', submittedAt: new Date(), status: 'submitted',
    assessmentStatus: 'complete', guest: { displayName: 'Sam Lee', normalizedEmail: ADDRESS },
    teacherUpload: { uploadedBy: fixture.teacher._id, batchId: 'batch-0001', uploadedAt: new Date(), email: { status, requestedAt: new Date(), ...extra } } });
}
const emailOf = async doc => (await Submission.findById(doc._id).select('+teacherUpload').lean()).teacherUpload.email;
const logged = () => JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); transport.sendMail.mockReset(); transport.sendMail.mockResolvedValue(OK);
  jest.spyOn(logger, 'info'); jest.spyOn(logger, 'warn');
  await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
});
afterEach(() => { logger.info.mockRestore?.(); logger.warn.mockRestore?.(); });

describe('deliveryOutcome (what counts as accepted)', () => {
  test.each([
    ['accepted with a 2xx reply', OK, null],
    ['accepted, address in another case and with spaces', { ...OK, accepted: [' Sam.Lee@Example.COM '] }, null],
    ['rejected recipient', { accepted: [], rejected: [ADDRESS], response: '550 5.1.1 User unknown' }, 'PROVIDER_REJECTED'],
    ['no accepted recipient and nothing rejected', { accepted: [], rejected: [], response: '250 Ok' }, 'NO_ACCEPTED_RECIPIENT'],
    ['no lists at all', { messageId: '<x@example.com>' }, 'NO_ACCEPTED_RECIPIENT'],
    ['another address accepted, not this one', { ...OK, accepted: ['someone.else@example.com'] }, 'NO_ACCEPTED_RECIPIENT'],
    ['accepted but the final reply is not 2xx', { ...OK, response: '451 4.7.1 Try again later' }, 'SMTP_NOT_ACCEPTED'],
  ])('%s', (_name, result, code) => {
    const outcome = email.deliveryOutcome(result, ADDRESS);
    expect(outcome.code).toBe(code);
    expect(outcome.delivered).toBe(code === null);
    expect(JSON.stringify(outcome.details)).not.toContain('sam.lee');
  });
  test('details: counts, SMTP code, enhanced status and messageId; never the server text', () => {
    expect(email.deliveryOutcome(OK, ADDRESS).details).toEqual({ acceptedCount: 1, rejectedCount: 0, responseCode: 250, enhancedStatus: '2.0.0', messageId: '<synthetic-1@example.com>' });
  });
});

describe('the worker records "sent" only for an accepted recipient', () => {
  test('accepted: sent, with queued/send times, duration, counts, SMTP code and messageId stored and logged without the address', async () => {
    const doc = await upload();
    expect((await worker.run()).sent).toBe(1);
    const state = await emailOf(doc);
    expect(state).toEqual(expect.objectContaining({ status: 'sent', acceptedCount: 1, rejectedCount: 0, smtpResponseCode: 250, smtpEnhancedStatus: '2.0.0',
      messageId: '<synthetic-1@example.com>' }));
    expect(state.sendStartedAt).toBeInstanceOf(Date);
    expect(state.sentAt.getTime()).toBeGreaterThanOrEqual(state.sendStartedAt.getTime());
    expect(state.durationMs).toBeGreaterThanOrEqual(0);
    const line = logger.info.mock.calls.map(([entry]) => entry).find(entry => entry?.event === 'teacher_upload_email_sent');
    expect(line).toEqual(expect.objectContaining({ submissionId: String(doc._id), smtpResponseCode: 250, acceptedCount: 1, messageId: '<synthetic-1@example.com>' }));
    expect(line.queuedAt).toBeTruthy(); expect(line.sentAt).toBeTruthy();
    expect(logged()).not.toContain('sam.lee'); expect(logged()).not.toContain('Ok: queued');
  });

  test.each([
    ['rejected', { accepted: [], rejected: [ADDRESS], response: '550 5.1.1 User unknown' }, 'PROVIDER_REJECTED'],
    ['empty accepted list', { accepted: [], rejected: [], response: '250 Ok', messageId: '<x@example.com>' }, 'NO_ACCEPTED_RECIPIENT'],
    ['not a 2xx reply', { ...OK, response: '451 4.7.1 Try again later' }, 'SMTP_NOT_ACCEPTED'],
  ])('%s: failed at once with a safe code (Resend appears), the unused link removed, nothing marked sent', async (_name, result, code) => {
    transport.sendMail.mockResolvedValue(result);
    const doc = await upload();
    expect((await worker.run()).failed).toBe(1);
    const state = await emailOf(doc);
    expect(state).toEqual(expect.objectContaining({ status: 'failed', lastErrorCode: code, attempts: 1 }));
    expect(state.sentAt).toBeUndefined();
    expect((await Submission.findById(doc._id).select('+guest.recoveryAccess').lean()).guest.recoveryAccess || []).toEqual([]);
    const listed = (await uploads.list({ teacher: fixture.teacher, assignmentId: fixture.IDS.assignment })).items[0];
    expect(listed).toEqual(expect.objectContaining({ emailStatus: 'failed', emailSentAt: null }));
    expect(logged()).not.toContain('sam.lee'); expect(logged()).not.toContain('User unknown');
  });

  test('a connection failure is still retried with backoff (it may be temporary)', async () => {
    transport.sendMail.mockRejectedValue(Object.assign(new Error('synthetic'), { code: 'ECONNREFUSED' }));
    const doc = await upload();
    expect((await worker.run()).retry).toBe(1);
    expect(await emailOf(doc)).toEqual(expect.objectContaining({ status: 'queued', lastErrorCode: 'SMTP_CONNECTION_FAILED' }));
  });
});

describe('no duplicate sending', () => {
  test('the new timer and run() passes at the same time send each email exactly once (atomic claim)', async () => {
    const docs = await Promise.all([1, 2, 3, 4].map(() => upload()));
    transport.sendMail.mockImplementation(async options => { await new Promise(r => setTimeout(r, 20)); return { ...OK, accepted: [options.to] }; });
    const timer = worker.startTeacherUploadEmailWorker({ intervalMs: 60 * 60 * 1000 });
    try {
      await Promise.all([timer.tick(), worker.run(), worker.run(), timer.tick()]);
      // The timer's own first pass started with it and may still be running: wait until nothing is queued or sending.
      for (let i = 0; i < 100 && await Submission.exists({ 'teacherUpload.email.status': { $in: ['queued', 'sending'] } }); i++) await new Promise(r => setTimeout(r, 20));
    } finally { timer.stop(); }
    expect(transport.sendMail).toHaveBeenCalledTimes(4);
    for (const doc of docs) expect(await emailOf(doc)).toEqual(expect.objectContaining({ status: 'sent', attempts: 1 }));
    await worker.run();
    expect(transport.sendMail).toHaveBeenCalledTimes(4);
  });
  test('the timer runs one pass at a time in a process: a tick during a pass is a no-op', async () => {
    await upload();
    let release;
    transport.sendMail.mockImplementation(() => new Promise(resolve => { release = () => resolve(OK); }));
    const timer = worker.startTeacherUploadEmailWorker({ intervalMs: 60 * 60 * 1000 });
    try {
      await new Promise(r => setTimeout(r, 50));
      expect(await timer.tick()).toEqual({ skipped: true });
      release();
    } finally { timer.stop(); }
    expect(timer.intervalMs).toBe(60 * 60 * 1000);
    expect(worker.WORKER_INTERVAL_MS).toBe(30 * 1000);
  });
  test('the recovery worker no longer sends these emails (only the timer does)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/assessmentRecovery.service.js'), 'utf8');
    expect(source).not.toMatch(/teacherUploadEmail\.service'\)\.run\(/);
    expect(fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8')).toMatch(/startTeacherUploadEmailWorker\(\)/);
  });
});

describe('Resend email on an email that was already sent', () => {
  const resend = (doc, requestId = crypto.randomUUID(), now = new Date()) =>
    uploads.requestSend({ teacher: fixture.teacher, assignmentId: fixture.IDS.assignment, submissionId: doc._id, resend: true, requestId, now });

  test('within a minute of sending: refused with the wait; afterwards queued once, sent again with a new working link', async () => {
    const doc = await upload();
    await worker.run();
    const firstSentAt = (await emailOf(doc)).sentAt;
    await expect(resend(doc, crypto.randomUUID(), new Date(firstSentAt.getTime() + 30 * 1000)))
      .rejects.toMatchObject({ statusCode: 429, code: 'TEACHER_UPLOAD_RESEND_COOLDOWN', details: { retryAfterSeconds: 30 } });
    const later = new Date(firstSentAt.getTime() + 61 * 1000);
    const requested = await resend(doc, crypto.randomUUID(), later);
    expect(requested).toEqual(expect.objectContaining({ alreadyRequested: false, item: expect.objectContaining({ emailStatus: 'queued' }) }));
    expect((await emailOf(doc)).attempts).toBe(0);
    await worker.run();
    expect(transport.sendMail).toHaveBeenCalledTimes(2);
    const state = await emailOf(doc);
    expect(state.status).toBe('sent');
    expect(state.sentAt.getTime()).toBeGreaterThan(firstSentAt.getTime());
    const links = (await Submission.findById(doc._id).select('+guest.recoveryAccess').lean()).guest.recoveryAccess;
    expect(links).toHaveLength(2);                                   // the earlier link keeps working
  });

  test('the same request id twice (double click, retry) queues and sends only once', async () => {
    const doc = await upload('sent', { sentAt: new Date(Date.now() - 5 * 60 * 1000) });
    const id = crypto.randomUUID();
    expect((await resend(doc, id)).alreadyRequested).toBe(false);
    expect((await resend(doc, id)).alreadyRequested).toBe(true);
    await worker.run();
    expect((await resend(doc, id)).alreadyRequested).toBe(true);    // even after it went out
    await worker.run();
    expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });

  test('a plain Send (no resend flag) never re-sends a sent email; a bad request id is refused', async () => {
    const doc = await upload('sent', { sentAt: new Date(Date.now() - 5 * 60 * 1000) });
    expect((await uploads.requestSend({ teacher: fixture.teacher, assignmentId: fixture.IDS.assignment, submissionId: doc._id })).alreadyRequested).toBe(true);
    await expect(resend(doc, 'not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
    await worker.run();
    expect(transport.sendMail).not.toHaveBeenCalled();
  });

  test('through the route: owner only (another teacher 404, a student 403); 429 carries retryAfterSeconds', async () => {
    const doc = await upload('sent', { sentAt: new Date() });
    const url = `/api/assignments/${fixture.IDS.assignment}/teacher-uploads/${doc._id}/send`;
    const jwt = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
    const body = { resend: true, requestId: crypto.randomUUID() };
    expect((await request(app).post(url).set('Authorization', `Bearer ${jwt(fixture.otherTeacher)}`).send(body)).status).toBe(404);
    expect((await request(app).post(url).set('Authorization', `Bearer ${jwt(fixture.student)}`).send(body)).status).toBe(403);
    const early = await request(app).post(url).set('Authorization', `Bearer ${jwt(fixture.teacher)}`).send(body);
    expect(early.status).toBe(429);
    expect(early.body).toEqual(expect.objectContaining({ code: 'TEACHER_UPLOAD_RESEND_COOLDOWN', details: { retryAfterSeconds: expect.any(Number) } }));
    await Submission.updateOne({ _id: doc._id }, { $set: { 'teacherUpload.email.sentAt': new Date(Date.now() - 2 * 60 * 1000) } });
    const ok = await request(app).post(url).set('Authorization', `Bearer ${jwt(fixture.teacher)}`).send(body);
    expect(ok.status).toBe(200);
    expect(ok.body.data.item.emailStatus).toBe('queued');
  });
});
