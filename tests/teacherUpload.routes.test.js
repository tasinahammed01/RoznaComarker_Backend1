'use strict';
// Stage 2 of "teacher uploads students' handwritten work": the backend. Owner-only access (404 otherwise), server-side
// validation, image-only uploads by real signature, size and count limits, idempotent saves, credits enforced under parallel
// saves, replace / add pages, idempotent send, and guest feedback links that stay readable for teacher uploads only.
// External services are mocked (marking dispatch, credits, email); synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-routes-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-test-' + process.pid;
process.env.MAX_FILE_SIZE = String(200 * 1024);       // read when the upload middleware loads: 200 KB per file in this test
jest.setTimeout(60000);
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })) }));
// The basic image checks are the student flow's own (tested there); the handwriting check has its own suite (teacherUploadSource).
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));

const request = require('supertest');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const File = require('../src/models/File');
const access = require('../src/services/guestAccess.service');
const dispatch = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const credits = require('../src/services/assessmentCreditRouter.service').canRunAssessment;

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FYQAAAAASUVORK5CYII=', 'base64');
const otherPng = Buffer.concat([png, Buffer.from('second page')]);
const pdf = Buffer.from('%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF');
const photo = Buffer.concat([png, Buffer.alloc(150 * 1024)]);   // ~0.15 MB: storage is counted in MB with 2 decimals
const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(16)]);
const webp = Buffer.concat([Buffer.from('RIFF'), Buffer.from([26, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(18)]);
const root = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');
const storedCount = () => (fs.existsSync(root) ? fs.readdirSync(root).length : 0);

let teacher, otherTeacher, student, classDoc, assignment, token, otherToken, studentToken;
const base = (assignmentId = assignment._id) => `/api/assignments/${assignmentId}/teacher-uploads`;
const key = () => crypto.randomUUID();
function upload({ assignmentId, auth = token, name = 'Sam Lee', email = 'sam.lee@example.com', requestKey = key(), batchId = 'batch-0001',
  mode, send, files = [{ bytes: png, name: 'page-1.png', type: 'image/png' }] } = {}) {
  let req = request(app).post(base(assignmentId)).set('Authorization', `Bearer ${auth}`)
    .field('name', name).field('email', email).field('requestKey', requestKey).field('batchId', batchId);
  if (mode) req = req.field('mode', mode);
  if (send) req = req.field('send', 'true');
  for (const file of files) req = req.attach('files', file.bytes, { filename: file.name, contentType: file.type });
  return req;
}
const sendEmail = (submissionId, auth = token) => request(app).post(`${base()}/${submissionId}/send`).set('Authorization', `Bearer ${auth}`);
const check = (students, auth = token, assignmentId) => request(app).post(`${base(assignmentId)}/check`).set('Authorization', `Bearer ${auth}`).send({ students });

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH), { recursive: true, force: true });   // this test's folder only
});
beforeEach(async () => {
  process.env.GUEST_SUBMISSION_ENABLED = 'true';
  process.env.OCR_SOURCE_MODE = 'legacy';        // whatever the local .env says: the handwriting check is covered in teacherUploadSource
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  credits.mockResolvedValue({ allowed: true, availableCredits: 100 });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher', displayName: 'Ms Rahman' });
  otherTeacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'other.teacher@example.com', role: 'teacher' });
  student = await User.create({ firebaseUid: crypto.randomUUID(), email: 'member@example.com', role: 'student', displayName: 'Mia Member' });
  classDoc = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'TEACHER-UPLOAD' });
  await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
  assignment = await Assignment.create({ title: 'My Summer Holiday', class: classDoc._id, teacher: teacher._id, instructions: 'Write about a holiday.',
    qrToken: 'teacher-upload-qr', deadline: new Date(Date.now() - 86400000) });
  token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  otherToken = signTestJwt({ id: otherTeacher._id, role: 'teacher', firebaseUid: otherTeacher.firebaseUid });
  studentToken = signTestJwt({ id: student._id, role: 'student', firebaseUid: student.firebaseUid });
});

describe('access', () => {
  test('requires a signed-in teacher', async () => {
    expect((await request(app).get(base())).status).toBe(401);
    expect((await request(app).get(base()).set('Authorization', `Bearer ${studentToken}`)).status).toBe(403);
  });

  test('another teacher gets 404 on every endpoint, and nothing is stored', async () => {
    const own = await upload();
    const before = storedCount();
    expect((await request(app).get(base()).set('Authorization', `Bearer ${otherToken}`)).status).toBe(404);
    expect((await check([{ name: 'A', email: 'a@example.com' }], otherToken)).status).toBe(404);
    expect((await upload({ auth: otherToken, email: 'x@example.com' })).status).toBe(404);
    expect((await sendEmail(own.body.data.item.submissionId, otherToken)).status).toBe(404);
    expect(await Submission.countDocuments()).toBe(1);
    expect(storedCount()).toBe(before);
  });

  test('an assignment whose class belongs to another teacher, or an archived/inactive class, is 404', async () => {
    const foreignClass = await Class.create({ name: 'Not mine', teacher: otherTeacher._id, joinCode: 'NOT-MINE' });
    const mixed = await Assignment.create({ title: 'Mixed', class: foreignClass._id, teacher: teacher._id, instructions: 'x', qrToken: 'mixed-qr' });
    expect((await upload({ assignmentId: mixed._id })).status).toBe(404);
    await Class.updateOne({ _id: classDoc._id }, { $set: { isActive: false } });
    expect((await upload()).status).toBe(404);
    expect((await request(app).get(base('not-an-id')).set('Authorization', `Bearer ${token}`)).status).toBe(404);
    expect(await Submission.countDocuments()).toBe(0);
  });

  test('only writing assignments accept student work', async () => {
    const flashcards = await Assignment.create({ title: 'Cards', class: classDoc._id, teacher: teacher._id, instructions: 'x', qrToken: 'cards-qr', resourceType: 'flashcard' });
    const res = await upload({ assignmentId: flashcards._id });
    expect(res.status).toBe(400); expect(res.body.code).toBe('TEACHER_UPLOAD_NOT_WRITING');
  });
});

describe('check (server-side validation)', () => {
  test('validates every row, finds duplicates case-insensitively, and reports account kind, existing work and credits', async () => {
    await upload({ email: 'existing@example.com', name: 'Erin Existing' });
    credits.mockResolvedValue({ allowed: true, availableCredits: 3 });
    const res = await check([
      { name: '  Sam   Lee ', email: ' SAM.Lee@Example.com ' },
      { name: 'Sam Again', email: 'sam.lee@example.com' },
      { name: '<script>x</script>', email: 'not-an-email' },
      { name: 'Header', email: 'a@b.com\r\nBcc: victim@example.com' },
      { name: 'Mia Member', email: 'member@example.com' },
      { name: 'Erin Existing', email: 'existing@example.com' }
    ]);
    expect(res.status).toBe(200);
    const [sam, again, bad, header, member, existing] = res.body.data.students;
    expect(sam).toMatchObject({ name: 'Sam Lee', email: 'sam.lee@example.com', account: 'guest' });
    expect(sam.errors).toBeUndefined();
    expect(again.errors.email).toMatch(/already in row 1/);
    expect(bad.errors).toEqual({ name: expect.stringMatching(/< or >/), email: expect.stringMatching(/valid email/) });
    expect(header.errors.email).toMatch(/valid email/);
    expect(member).toMatchObject({ account: 'member' });
    expect(existing.existing).toEqual({ submissionId: expect.any(String), pages: 1 });
    // 3 valid rows need 3 credits; 1 of the 3 available is already reserved by the pending upload.
    expect(res.body.data.credits).toEqual({ needed: 3, available: 2 });
  });

  test('rejects a malformed or oversized list', async () => {
    expect((await check('nope')).status).toBe(400);
    expect((await check([])).status).toBe(400);
    expect((await check(Array.from({ length: 101 }, (_, i) => ({ name: `S${i}`, email: `s${i}@example.com` })))).status).toBe(400);
  });

  test('a student who submitted their own work cannot be uploaded over', async () => {
    await Submission.create({ assignment: assignment._id, class: classDoc._id, student: student._id, submissionMode: 'registered', submittedAt: new Date(), status: 'submitted' });
    const res = await check([{ name: 'Mia Member', email: 'member@example.com' }]);
    expect(res.body.data.students[0].errors.email).toMatch(/already submitted their own work/);
    const save = await upload({ name: 'Mia Member', email: 'member@example.com' });
    expect(save.status).toBe(409); expect(save.body.code).toBe('STUDENT_ALREADY_SUBMITTED');
  });
});

describe('upload', () => {
  test('saves a guest submission owned by the teacher, starts marking once, is never late, and reserves storage', async () => {
    const res = await upload({ files: [{ bytes: photo, name: 'p1.png', type: 'image/png' }, { bytes: otherPng, name: 'p2.png', type: 'image/png' }] });
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ duplicate: false, item: expect.objectContaining({ name: 'Sam Lee', email: 'sam.lee@example.com',
      account: 'guest', pages: 2, status: 'uploaded', emailStatus: 'none', uploadedByTeacher: true }) });
    const doc = await Submission.findById(res.body.data.item.submissionId).select('+teacherUpload +guest.normalizedEmail').lean();
    expect(doc).toMatchObject({ submissionMode: 'guest', status: 'submitted', isLate: false, assessmentStatus: 'started', ocrStatus: 'pending' });
    expect(doc.guest).toMatchObject({ displayName: 'Sam Lee', normalizedEmail: 'sam.lee@example.com' });
    expect(String(doc.teacherUpload.uploadedBy)).toBe(teacher.id);
    expect((await File.find()).every(file => String(file.uploadedBy) === teacher.id && file.role === 'teacher')).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect((await User.findById(teacher._id)).usage.storageMB).toBeCloseTo(0.15, 2);
    expect(JSON.stringify(res.body)).not.toMatch(/requestKey|contentHash|uploadedBy"|teacher@example.com/);
  });

  test('a class member gets a normal registered submission', async () => {
    const res = await upload({ name: 'Mia Member', email: 'member@example.com' });
    expect(res.status).toBe(200); expect(res.body.data.item.account).toBe('member');
    const doc = await Submission.findById(res.body.data.item.submissionId).lean();
    expect(doc.submissionMode).toBe('registered'); expect(String(doc.student)).toBe(student.id);
  });

  test('"Save and send" queues the email with the submission', async () => {
    const res = await upload({ send: true });
    expect(res.body.data.item.emailStatus).toBe('queued');
  });

  test('a retried request (same key, same pages) returns the same submission and stores nothing new', async () => {
    const requestKey = key();
    const first = await upload({ requestKey });
    const filesAfterFirst = storedCount();
    const again = await upload({ requestKey });
    expect(again.status).toBe(200); expect(again.body.data.duplicate).toBe(true);
    expect(again.body.data.item.submissionId).toBe(first.body.data.item.submissionId);
    expect(await Submission.countDocuments()).toBe(1); expect(await File.countDocuments()).toBe(1);
    expect(storedCount()).toBe(filesAfterFirst); expect(dispatch).toHaveBeenCalledTimes(1);
    // Parallel retries of a new key also create exactly one submission.
    const parallelKey = key();
    const results = await Promise.all([1, 2, 3].map(() => upload({ requestKey: parallelKey, email: 'twin@example.com', name: 'Twin' })));
    expect(results.map(r => r.status)).toEqual([200, 200, 200]);
    expect(new Set(results.map(r => r.body.data.item.submissionId)).size).toBe(1);
    expect(await Submission.countDocuments({ 'guest.normalizedEmail': 'twin@example.com' }).select('+guest.normalizedEmail')).toBe(1);
  });

  test('the same key with different pages is refused', async () => {
    const requestKey = key();
    await upload({ requestKey });
    const res = await upload({ requestKey, files: [{ bytes: otherPng, name: 'p.png', type: 'image/png' }] });
    expect(res.status).toBe(409); expect(res.body.code).toBe('TEACHER_UPLOAD_KEY_REUSED');
  });

  test('accepts a PDF, like the student upload screen', async () => {
    const res = await upload({ files: [{ bytes: pdf, name: 'essay.pdf', type: 'application/pdf' }] });
    expect(res.status).toBe(200);
    expect(res.body.data.item.pages).toBe(1);
  });

  test.each([
    ['a WebP photo', webp, 'page.webp', 'image/webp'],
    ['a HEIC photo', heic, 'IMG_0001.HEIC', 'image/heic'],
    ['a text file renamed .jpg', Buffer.from('hello world, not an image'), 'page.jpg', 'image/jpeg']
  ])('refuses %s with "Please use JPG, PNG or PDF." and keeps nothing', async (_label, bytes, name, type) => {
    const before = storedCount();
    const res = await upload({ files: [{ bytes: png, name: 'ok.png', type: 'image/png' }, { bytes, name, type }] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ code: 'UNSUPPORTED_FILE_TYPE', message: 'Please use JPG, PNG or PDF.' });
    expect(await Submission.countDocuments()).toBe(0); expect(await File.countDocuments()).toBe(0);
    expect(storedCount()).toBe(before);
  });

  test('refuses an oversized image and too many images, and keeps nothing', async () => {
    const before = storedCount();
    const big = Buffer.concat([png, Buffer.alloc(300 * 1024)]);
    const tooBig = await upload({ files: [{ bytes: big, name: 'big.png', type: 'image/png' }] });
    expect(tooBig.status).toBe(413); expect(tooBig.body).toMatchObject({ code: 'FILE_TOO_LARGE', message: 'Each image must be 1 MB or smaller.' });
    const many = await upload({ files: Array.from({ length: 21 }, (_, i) => ({ bytes: png, name: `p${i}.png`, type: 'image/png' })) });
    expect(many.status).toBe(400); expect(many.body.code).toBe('TEACHER_UPLOAD_TOO_MANY_FILES');
    const none = await upload({ files: [] });
    expect(none.status).toBe(400); expect(none.body.code).toBe('TEACHER_UPLOAD_NO_FILES');
    expect(await Submission.countDocuments()).toBe(0); expect(storedCount()).toBe(before);
  });

  test('refuses invalid student details and references on the server', async () => {
    const before = storedCount();
    expect((await upload({ name: '<b>Sam</b>' })).body.code).toBe('TEACHER_UPLOAD_STUDENT_INVALID');
    expect((await upload({ email: 'sam@example.com>, x@y.com' })).body.code).toBe('TEACHER_UPLOAD_STUDENT_INVALID');
    expect((await upload({ requestKey: 'short' })).status).toBe(400);
    expect((await upload({ batchId: '../../x' })).status).toBe(400);
    expect((await upload({ mode: 'overwrite-everything' })).status).toBe(400);
    expect(await Submission.countDocuments()).toBe(0); expect(storedCount()).toBe(before);
  });
});

describe('credits', () => {
  test('running out partway: the students already saved stay saved, the rest are refused and leave nothing behind', async () => {
    credits.mockResolvedValue({ allowed: true, availableCredits: 2 });
    const before = storedCount();
    const responses = [];
    for (const i of [1, 2, 3]) responses.push(await upload({ name: `Student ${i}`, email: `student${i}@example.com`, files: [{ bytes: photo, name: 'p.png', type: 'image/png' }] }));
    expect(responses.map(r => r.status)).toEqual([200, 200, 402]);
    expect(responses[2].body.code).toBe('INSUFFICIENT_CREDITS');
    expect(await Submission.countDocuments()).toBe(2); expect(await File.countDocuments()).toBe(2);
    expect(storedCount()).toBe(before + 2);
    expect((await User.findById(teacher._id)).usage.storageMB).toBeCloseTo(0.3, 2);   // two photos; the refused one released its reservation
  });

  test('parallel saves cannot overspend: with 2 credits, exactly 2 of 4 parallel uploads are saved', async () => {
    credits.mockResolvedValue({ allowed: true, availableCredits: 2 });
    const results = await Promise.all([1, 2, 3, 4].map(i => upload({ name: `Parallel ${i}`, email: `parallel${i}@example.com` })));
    expect(results.filter(r => r.status === 200)).toHaveLength(2);
    expect(results.filter(r => r.status === 402)).toHaveLength(2);
    expect(await Submission.countDocuments()).toBe(2);
  });

  test('a finished (charged) upload no longer reserves a credit; an institution cap is respected', async () => {
    credits.mockResolvedValue({ allowed: true, availableCredits: 1 });
    const first = await upload();
    expect((await upload({ email: 'next@example.com' })).status).toBe(402);
    await Submission.updateOne({ _id: first.body.data.item.submissionId }, { $set: { assessmentStatus: 'complete' } });
    expect((await upload({ email: 'next@example.com' })).status).toBe(200);
    credits.mockResolvedValue({ allowed: true, availableCredits: 50, myLimit: 10, myUsage: 10 });
    expect((await upload({ email: 'capped@example.com' })).status).toBe(402);
  });
});

describe('existing work for the same student', () => {
  test('asks to replace or add, then adds pages or replaces them (old files removed)', async () => {
    const before = storedCount();
    const first = await upload();
    const id = first.body.data.item.submissionId;
    const again = await upload();
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ code: 'TEACHER_UPLOAD_EXISTS', details: { submissionId: id, pages: 1 } });
    const added = await upload({ mode: 'add_pages', files: [{ bytes: otherPng, name: 'p2.png', type: 'image/png' }] });
    expect(added.status).toBe(200); expect(added.body.data.item).toMatchObject({ submissionId: id, pages: 2 });
    expect(dispatch).toHaveBeenCalledTimes(2);
    const oldFiles = await File.find().lean();
    const replaced = await upload({ mode: 'replace', files: [{ bytes: Buffer.concat([png, Buffer.from('v3')]), name: 'new.png', type: 'image/png' }] });
    expect(replaced.status).toBe(200); expect(replaced.body.data.item).toMatchObject({ submissionId: id, pages: 1 });
    expect(await Submission.countDocuments()).toBe(1);
    const remaining = await File.find().lean();
    expect(remaining).toHaveLength(1);
    expect(oldFiles.every(file => !remaining.some(r => String(r._id) === String(file._id)))).toBe(true);
    expect(storedCount()).toBe(before + 1);
    const doc = await Submission.findById(id).lean();
    expect(doc).toMatchObject({ assessmentStatus: 'started', ocrStatus: 'pending', ocrPages: [] });
  });
});

describe('send', () => {
  test('double send (parallel and repeated) queues the email once', async () => {
    const saved = await upload();
    const id = saved.body.data.item.submissionId;
    const [a, b] = await Promise.all([sendEmail(id), sendEmail(id)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.data.alreadyRequested, b.body.data.alreadyRequested].sort()).toEqual([false, true]);
    const once = (await Submission.findById(id).select('+teacherUpload').lean()).teacherUpload.email;
    expect(once.status).toBe('queued');
    const repeat = await sendEmail(id);
    expect(repeat.body.data.alreadyRequested).toBe(true);
    expect((await Submission.findById(id).select('+teacherUpload').lean()).teacherUpload.email.requestedAt).toEqual(once.requestedAt);
  });

  test('a sent email is never re-queued; a failed one can be resent', async () => {
    const id = (await upload()).body.data.item.submissionId;
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.status': 'sent', 'teacherUpload.email.sentAt': new Date() } });
    expect((await sendEmail(id)).body.data).toMatchObject({ alreadyRequested: true, item: { emailStatus: 'sent' } });
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.status': 'failed', 'teacherUpload.email.lastErrorCode': 'SMTP' } });
    expect((await sendEmail(id)).body.data).toMatchObject({ alreadyRequested: false, item: { emailStatus: 'queued' } });
  });

  test('an uncertain delivery is flagged (and only that failure), without exposing the raw error code; Resend clears it', async () => {
    const id = (await upload()).body.data.item.submissionId;
    const listed = async () => (await request(app).get(base()).set('Authorization', `Bearer ${token}`)).body;
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.status': 'failed', 'teacherUpload.email.lastErrorCode': 'SMTP_CONNECTION_FAILED' } });
    expect((await listed()).data.items[0]).toMatchObject({ emailStatus: 'failed', emailDeliveryUncertain: false });
    await Submission.updateOne({ _id: id }, { $set: { 'teacherUpload.email.lastErrorCode': 'DELIVERY_UNCERTAIN' } });
    const body = await listed();
    expect(body.data.items[0]).toMatchObject({ emailStatus: 'failed', emailDeliveryUncertain: true });
    expect(JSON.stringify(body)).not.toMatch(/lastErrorCode|DELIVERY_UNCERTAIN|SMTP_/);
    expect((await sendEmail(id)).body.data.item).toMatchObject({ emailStatus: 'queued', emailDeliveryUncertain: false });
  });

  test('only uploads of this teacher on this assignment can be sent', async () => {
    const guest = await Submission.create({ assignment: assignment._id, class: classDoc._id, submissionMode: 'guest', submittedAt: new Date(), status: 'submitted',
      guest: { displayName: 'QR Guest', normalizedEmail: 'qr@example.com' } });
    expect((await sendEmail(guest._id)).status).toBe(404);
    expect((await sendEmail('not-an-id')).status).toBe(404);
  });
});

describe('list', () => {
  test('lists only this teacher\'s uploads on this assignment with statuses and credits', async () => {
    const saved = await upload();
    await upload({ name: 'Mia Member', email: 'member@example.com' });
    await Submission.updateOne({ _id: saved.body.data.item.submissionId }, { $set: { assessmentStatus: 'complete' } });
    const otherAssignment = await Assignment.create({ title: 'Other', class: classDoc._id, teacher: teacher._id, instructions: 'x', qrToken: 'other-qr' });
    await upload({ assignmentId: otherAssignment._id, email: 'elsewhere@example.com' });
    const res = await request(app).get(base()).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map(item => item.email).sort()).toEqual(['member@example.com', 'sam.lee@example.com']);
    expect(res.body.data.items.find(item => item.email === 'sam.lee@example.com').status).toBe('marked');
    expect(res.body.data.items.find(item => item.email === 'member@example.com')).toMatchObject({ account: 'member', name: 'Mia Member', status: 'uploaded' });
    expect(res.body.data.credits).toEqual(expect.objectContaining({ available: expect.any(Number) }));
    expect(JSON.stringify(res.body)).not.toMatch(/requestKey|contentHash|batchId/);
  });
});

describe('guest feedback links', () => {
  async function linkFor(submissionId) {
    const issued = access.issueToken();
    await Submission.updateOne({ _id: submissionId }, { $set: { 'guest.resultAccessHash': issued.accessHash, 'guest.resultExpiresAt': issued.expiresAt } });
    return issued.token;
  }
  const open = (id, tokenValue) => request(app).get(`/api/guest/submissions/${id}`).set('X-Guest-Token', tokenValue);

  test('a teacher upload stays readable when its assignment does not accept guest submissions; the server-wide switch still applies', async () => {
    const uploaded = (await upload()).body.data.item.submissionId;
    const qrGuest = await Submission.create({ assignment: assignment._id, class: classDoc._id, submissionMode: 'guest', submittedAt: new Date(), status: 'submitted',
      guest: { displayName: 'QR Guest', normalizedEmail: 'qr@example.com' } });
    const uploadedToken = await linkFor(uploaded), guestToken = await linkFor(qrGuest._id);
    await Assignment.updateOne({ _id: assignment._id }, { $set: { allowGuestSubmission: false } });
    // The assignment is closed to guests: only the teacher upload is readable through its link.
    expect([403, 404, 410]).not.toContain((await open(uploaded, uploadedToken)).status);
    expect((await open(qrGuest._id, guestToken)).status).toBe(404);
    // Writes through the link still follow the assignment setting, for teacher uploads too.
    const revise = await request(app).post(`/api/guest/submissions/${uploaded}/revise`).set('X-Guest-Token', uploadedToken)
      .set('Idempotency-Key', key()).attach('files', png, { filename: 'r.png', contentType: 'image/png' });
    expect([403, 404]).toContain(revise.status);
    // The server-wide guest switch is an emergency stop: it closes every login-free link, teacher uploads included.
    process.env.GUEST_SUBMISSION_ENABLED = 'false';
    expect((await open(uploaded, uploadedToken)).status).toBe(403);
    process.env.GUEST_SUBMISSION_ENABLED = 'true';
    // A wrong token never opens a teacher upload.
    expect((await open(uploaded, access.issueToken().token)).status).toBe(410);
  });
});
