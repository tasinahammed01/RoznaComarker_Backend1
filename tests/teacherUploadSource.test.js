'use strict';
// Teacher uploads and the handwriting check (OCR_SOURCE_MODE=gpt_vision_exact). Root cause of OCR_GPT_SOURCE_PREFLIGHT_REQUIRED on
// teacher uploads: the student and guest flows run the page check (/image-preflight) before saving, and the save stores the check's
// proof on each File (gptSourcePreflight); OCR accepts a page only with that proof. The teacher path never ran the check, so every
// teacher-uploaded page was refused by OCR. These tests drive the real routes, the real OCR pipeline and the real evidence store;
// only the AI provider (aiGateway) and Google geometry are stubbed. Synthetic data only.
process.env.JWT_SECRET = 'teacher-upload-source-test';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-upload-source-test-' + process.pid;
jest.setTimeout(90000);
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn(async () => {}) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/services/aiGateway.service', () => ({ providerAttempt: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherUploadFeedbackEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/notification.service', () => ({ createNotification: jest.fn(async () => null) }));
const mockGoogleGeometry = jest.fn(async () => [{ fullTextAnnotation: { pages: [] } }]);
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockGoogleGeometry })) }));

const sharp = require('sharp');
const request = require('supertest');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
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
const gateway = require('../src/services/aiGateway.service');
const credits = require('../src/services/assessmentCreditRouter.service').canRunAssessment;
const dispatch = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const c = require('../src/services/gptVisionExact/contract');
const ocr = require('../src/services/ocrPipeline.service');

const transcript = 'Society always expect\npowerfull Say';
const reading = () => ({ version: c.VERSION, activeTranscript: transcript, uncertainties: [],
  physicalLines: transcript.split('\n').map(text => ({ segments: [{ classification: 'STUDENT_ACTIVE_TEXT', text, confidence: 1 }] })) });
const providerValue = v => process.env.OCR_GPT_VISION_MODEL === c.QWEN_MODEL ? { version: c.QWEN_WIRE_VERSION, physicalLines: v.physicalLines, uncertainties: v.uncertainties } : v;

let teacher, otherTeacher, member, classDoc, assignment, token, otherToken, page, serial = 0;
const base = (id = assignment._id) => `/api/assignments/${id}/teacher-uploads`;
const guest = { name: 'Sam Lee', email: 'sam.lee@example.com' };
const preflight = ({ bytes = page, who = guest, phase = 'source', auth = token, id } = {}) => request(app).post(`${base(id)}/image-preflight`)
  .set('Authorization', `Bearer ${auth}`).field('name', who.name).field('email', who.email).field('phase', phase)
  .attach('file', bytes, { filename: 'page-1.png', contentType: 'image/png' });
const save = ({ pages = [page], who = guest, send = false, auth = token } = {}) => {
  let req = request(app).post(base()).set('Authorization', `Bearer ${auth}`).field('name', who.name).field('email', who.email)
    .field('requestKey', crypto.randomUUID()).field('batchId', 'batch-0001');
  if (send) req = req.field('send', 'true');
  for (const bytes of pages) req = req.attach('files', bytes, { filename: 'page-1.png', contentType: 'image/png' });
  return req;
};
const retry = (id, auth = token) => request(app).post(`${base()}/${id}/retry`).set('Authorization', `Bearer ${auth}`);
async function runOcr(id) {
  const doc = await Submission.findById(id);
  await ocr.runOcrAndPersistForFiles({ fileIds: doc.files, targetDoc: doc, jobId: doc.ocrJobId });
  return Submission.findById(id).lean();
}
const storedRoot = () => path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');

beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  delete process.env.OCR_SOURCE_MODE;
  await disconnectInMemoryMongo();
  fs.rmSync(path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH), { recursive: true, force: true });   // this test's folder only
});
beforeEach(async () => {
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  process.env.OCR_SOURCE_MODE = 'gpt_vision_exact';
  process.env.OCR_GPT_VISION_MODEL = process.env.TEST_EXACT_SOURCE_MODEL || 'openai/gpt-6-astra';
  process.env.OPENROUTER_API_KEY = 'mock-only';
  credits.mockResolvedValue({ allowed: true, availableCredits: 100 });
  gateway.providerAttempt.mockImplementation(async o => ({ returnedModel: o.entry.model, content: JSON.stringify(providerValue(reading())) }));
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher', displayName: 'Ms Rahman' });
  otherTeacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'other@example.com', role: 'teacher' });
  member = await User.create({ firebaseUid: crypto.randomUUID(), email: 'member@example.com', role: 'student', displayName: 'Mia Member' });
  classDoc = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'SRC-' + (++serial) });
  await Membership.create({ student: member._id, class: classDoc._id, status: 'active' });
  assignment = await Assignment.create({ title: 'My Summer Holiday', class: classDoc._id, teacher: teacher._id, instructions: 'Write about a holiday.', qrToken: 'src-' + serial });
  token = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });
  otherToken = signTestJwt({ id: otherTeacher._id, role: 'teacher', firebaseUid: otherTeacher.firebaseUid });
  page = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 200, g: 40 + serial, b: 90 } } }).png().toBuffer();
});

describe('root cause', () => {
  test('a teacher-uploaded page stored without a page check is refused by OCR (OCR_GPT_SOURCE_PREFLIGHT_REQUIRED)', async () => {
    // What every teacher upload looked like before the fix: a File without gptSourcePreflight.
    const file = await File.create({ originalName: 'p.png', filename: 'p.png', path: 'x', url: 'x', uploadedBy: teacher._id, role: 'teacher', type: 'submissions' });
    fs.mkdirSync(storedRoot(), { recursive: true }); fs.writeFileSync(path.join(storedRoot(), 'legacy.png'), page);
    await File.updateOne({ _id: file._id }, { $set: { path: path.posix.join(process.env.UPLOAD_BASE_PATH, 'submissions', 'legacy.png') } });
    const doc = await Submission.create({ assignment: assignment._id, class: classDoc._id, submissionMode: 'guest', guest: { displayName: 'Sam Lee', normalizedEmail: guest.email },
      files: [file._id], file: file._id, submittedAt: new Date(), status: 'submitted', ocrStatus: 'pending', ocrJobId: 'job-1',
      teacherUpload: { uploadedBy: teacher._id, batchId: 'batch-0001', uploadedAt: new Date() } });
    const after = await runOcr(doc._id);
    expect(after.ocrStatus).toBe('failed');
    expect(JSON.stringify([after.ocrErrorCode, after.ocrFailures])).toContain('OCR_GPT_SOURCE_PREFLIGHT_REQUIRED');
    expect(gateway.providerAttempt).not.toHaveBeenCalled();      // OCR never reads an unchecked page itself
  });
});

describe('upload with the student page check', () => {
  test.each([['a guest', guest], ['a class member', { name: 'Mia Member', email: 'member@example.com' }]])(
    'for %s: check, save, then OCR reads the page with no extra paid read', async (_label, who) => {
      const basic = await preflight({ who, phase: 'basic' });
      expect(basic.status).toBe(200);
      expect(basic.body.data).toMatchObject({ sourceReadStatus: 'CHECKING', canSubmit: false });
      expect(gateway.providerAttempt).not.toHaveBeenCalled();
      const checked = await preflight({ who });
      expect(checked.body.data).toMatchObject({ sourceReadStatus: 'PASSED', canSubmit: true, ready: true });
      expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);

      const saved = await save({ who });
      expect(saved.status).toBe(200);
      const id = saved.body.data.item.submissionId;
      const file = await File.findById((await Submission.findById(id).lean()).files[0]).select('+gptSourcePreflight').lean();
      expect(file.gptSourcePreflight).toMatchObject({ uploaderId: String(teacher._id), assignmentId: String(assignment._id),
        ownerId: who === guest ? `guest:${c.sha(guest.email)}` : String(member._id) });
      expect(dispatch).toHaveBeenCalledTimes(1);

      const after = await runOcr(id);
      expect(after.ocrStatus).toBe('completed');
      expect(after.sourceTranscriptExact).toBe(transcript);
      expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);   // the check's reading is reused, never bought twice
    });

  test('pages that were never checked are refused at save with a clear "check again", and nothing is kept', async () => {
    const res = await save();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'TEACHER_UPLOAD_RECHECK_REQUIRED', message: 'The handwriting check for these pages is out of date. Check the pages again, then save.' });
    expect(await Submission.countDocuments()).toBe(0);
    expect(await File.countDocuments()).toBe(0);
    expect(gateway.providerAttempt).not.toHaveBeenCalled();       // the save never buys a reading (run:false)
  });

  test('a check goes out of date when the assignment text changes, or when it was made for a different student', async () => {
    await preflight();
    await Assignment.updateOne({ _id: assignment._id }, { $set: { instructions: 'Write about your best day.' } });
    expect((await save()).body.code).toBe('TEACHER_UPLOAD_RECHECK_REQUIRED');
    await preflight();                                            // checked again for this assignment text
    expect((await save({ who: { name: 'Ana Other', email: 'ana@example.com' } })).body.code).toBe('TEACHER_UPLOAD_RECHECK_REQUIRED');
    expect((await save()).status).toBe(200);
  });

  test('the page check is the owner\'s only: 401 signed out, 403 for students, 404 for another teacher, and no reading is bought', async () => {
    const stored = () => (fs.existsSync(storedRoot()) ? fs.readdirSync(storedRoot()).length : 0), before = stored();
    expect((await request(app).post(`${base()}/image-preflight`).attach('file', page, 'p.png')).status).toBe(401);
    const studentToken = signTestJwt({ id: member._id, role: 'student', firebaseUid: member.firebaseUid });
    expect((await preflight({ auth: studentToken })).status).toBe(403);
    expect((await preflight({ auth: otherToken })).status).toBe(404);
    expect((await preflight({ id: new mongoose.Types.ObjectId() })).status).toBe(404);
    expect((await preflight({ who: { name: 'Sam', email: 'not-an-email' } })).status).toBe(400);
    expect(gateway.providerAttempt).not.toHaveBeenCalled();
    expect(stored()).toBe(before);                                // refused uploads leave no file behind
  });
});

describe('retry marking', () => {
  async function failedUpload({ send = true } = {}) {
    // An upload saved before the fix (no proof on its files) whose marking failed, like the reported one.
    await preflight(); const saved = await save({ send }); const id = saved.body.data.item.submissionId;
    const doc = await Submission.findById(id).lean();
    await File.updateMany({ _id: { $in: doc.files } }, { $unset: { gptSourcePreflight: 1 } });
    await require('../src/models/SourceFidelityEvidence').deleteMany({});
    await Submission.updateOne({ _id: id }, { $set: { assessmentStatus: 'failed', assessmentErrorCode: 'OCR_GPT_SOURCE_PREFLIGHT_REQUIRED', ocrStatus: 'failed' } });
    gateway.providerAttempt.mockClear(); dispatch.mockClear();
    return id;
  }

  test('checks the stored pages, restarts marking once, and OCR then succeeds', async () => {
    const id = await failedUpload();
    const res = await retry(id);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ alreadyRequested: false, item: { status: 'uploaded' } });
    expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const doc = await Submission.findById(id).select('+teacherUpload').lean();
    expect(doc.assessmentStatus).toBe('started');
    const after = await runOcr(id);
    expect(after.ocrStatus).toBe('completed');
    expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
    // A second click is answered as-is: no second restart, no second reading.
    expect((await retry(id)).body.data.alreadyRequested).toBe(true);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('needs one available credit and changes nothing without it (credits are charged only when marking succeeds)', async () => {
    const id = await failedUpload();
    credits.mockResolvedValue({ allowed: false, availableCredits: 0 });
    const res = await retry(id);
    expect(res.status).toBe(402);
    expect(res.body.code).toBe('INSUFFICIENT_CREDITS');
    expect((await Submission.findById(id).lean()).assessmentStatus).toBe('failed');
    expect(gateway.providerAttempt).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('an unreadable page keeps the upload failed and says why', async () => {
    const id = await failedUpload();
    gateway.providerAttempt.mockImplementation(async o => ({ returnedModel: o.entry.model,
      content: JSON.stringify(providerValue({ ...reading(), uncertainties: [{ physicalLineIndex: 0, segmentIndex: 0, reason: 'illegible' }] })) }));
    const res = await retry(id);
    expect([422, 503]).toContain(res.status);
    expect(res.body.message).toEqual(expect.any(String));
    expect((await Submission.findById(id).lean()).assessmentStatus).toBe('failed');
    expect(dispatch).not.toHaveBeenCalled();
  });

  test('only the owner can retry (404), and work that did not fail is answered as-is', async () => {
    const id = await failedUpload();
    expect((await retry(id, otherToken)).status).toBe(404);
    expect((await retry(new mongoose.Types.ObjectId())).status).toBe(404);
    await preflight({ who: { name: 'Mia Member', email: 'member@example.com' } });
    const ok = (await save({ who: { name: 'Mia Member', email: 'member@example.com' } })).body.data.item.submissionId;
    expect((await retry(ok)).body.data.alreadyRequested).toBe(true);
  });
});

describe('the feedback email when marking fails', () => {
  test('a queued email is held (not left queued), Send is refused, and Retry marking queues it again to be sent once', async () => {
    await preflight(); const id = (await save({ send: true })).body.data.item.submissionId;
    await Submission.updateOne({ _id: id }, { $set: { assessmentStatus: 'failed' } });
    await require('../src/services/teacherUploadEmail.service').run();
    expect((await Submission.findById(id).select('+teacherUpload').lean()).teacherUpload.email.status).toBe('held');
    expect(require('../src/services/email.service').sendTeacherUploadFeedbackEmail).not.toHaveBeenCalled();
    const listed = await request(app).get(base()).set('Authorization', `Bearer ${token}`);
    expect(listed.body.data.items[0]).toMatchObject({ status: 'failed', emailStatus: 'held' });
    const send = await request(app).post(`${base()}/${id}/send`).set('Authorization', `Bearer ${token}`);
    expect(send.status).toBe(409);
    expect(send.body.code).toBe('TEACHER_UPLOAD_MARKING_FAILED');
    expect((await retry(id)).status).toBe(200);
    expect((await Submission.findById(id).select('+teacherUpload').lean()).teacherUpload.email.status).toBe('queued');
  });
});
