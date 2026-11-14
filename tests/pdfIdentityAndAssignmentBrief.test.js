'use strict';
// Feedback PDF identity and assignment description, through the real download routes (student, guest link, teacher) with the PDF
// generator intercepted (it receives the view model; its HTML is rendered with the real template, no browser). Covers: "Student
// email" filled for a guest, a class member and a teacher upload, shown only to the people who may download that PDF, never another
// student's; the "Teacher" field never falls back to the teacher's email; the assignment description present (escaped, line breaks
// kept), absent (no empty heading) and long (wrapped and clipped); the cache key follows the new identity; and no teacher email in
// any student-facing response. Synthetic data only.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'pdf-identity-brief-secret';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/pdf-identity-brief-' + process.pid;
const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-identity-brief-'));
const app = require('../src/app');
const renderer = require('../src/modules/submissionFeedbackPdfGenerator');
const pdfCache = require('../src/services/submissionFeedbackPdfCache.service');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const TEACHER_EMAIL = 'teacher@example.com';                  // the fixture teacher's account email
let fixture, captured;
const jwt = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
const asUser = (id, user) => request(app).get(`/api/pdf/download/${id}`).set('Authorization', `Bearer ${jwt(user)}`);
const asGuest = (id, token = fixture.guestToken) => request(app).get(`/api/guest/submissions/${id}/pdf`).set('X-Guest-Token', token);
const cacheRoot = process.env.PDF_FEEDBACK_CACHE_DIR;
async function pdfOf(call) {
  captured = null;
  process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(cacheRoot, 'each-'));   // a fresh cache: every download really renders
  const res = await call;
  expect(res.status).toBe(200);
  expect(captured).not.toBeNull();
  return { vm: captured, html: renderSubmissionFeedbackReportHtml(captured) };
}

beforeAll(async () => {
  await connectInMemoryMongo();
  jest.spyOn(renderer, 'generateSubmissionFeedbackPdf').mockImplementation(async (viewModel, outputPath) => {
    captured = viewModel;
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, Buffer.from('%PDF-1.4\n% synthetic\n%%EOF\n'));
    return outputPath;
  });
});
afterAll(async () => { jest.restoreAllMocks(); await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.rmSync(cacheRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase();
  fixture = await seedAnnotationFixture({ uploadRoot });
  await User.updateOne({ _id: fixture.teacher._id }, { $set: { displayName: '' } });     // no display name: the email must not appear instead
  await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { instructions: 'Write about your weekend.\nUse the past tense <b>and</b> 150 words.' } });
});

describe('Student email', () => {
  test('class member: the account email, for the student and for the teacher', async () => {
    for (const user of [fixture.student, fixture.teacher]) {
      const { vm, html } = await pdfOf(asUser(fixture.IDS.registered, user));
      expect(vm.submission.studentEmail).toBe('student@example.com');
      expect(html).toContain('<small>Student email</small>student@example.com');
    }
  });
  test('guest: the address typed with the submission, through the guest\'s own link and for the teacher', async () => {
    for (const call of [() => asGuest(fixture.IDS.guest), () => asUser(fixture.IDS.guest, fixture.teacher)]) {
      const { vm } = await pdfOf(call());
      expect(vm.submission.studentEmail).toBe('guest.student@example.com');
    }
  });
  test('teacher uploads: the typed address (guest) or the matched account email (member)', async () => {
    const upload = { uploadedBy: fixture.teacher._id, batchId: 'batch-1', uploadedAt: new Date(), typedName: 'Typed', email: { status: 'sent' } };
    await Submission.updateMany({ _id: { $in: [fixture.IDS.guest, fixture.IDS.registered] } }, { $set: { teacherUpload: upload } });
    expect((await pdfOf(asUser(fixture.IDS.guest, fixture.teacher))).vm.submission.studentEmail).toBe('guest.student@example.com');
    expect((await pdfOf(asUser(fixture.IDS.registered, fixture.teacher))).vm.submission.studentEmail).toBe('student@example.com');
  });
  test('never another student\'s email: other people cannot download, and each PDF carries only its own address', async () => {
    expect((await asUser(fixture.IDS.guest, fixture.student)).status).toBe(403);           // a student cannot download the guest's PDF
    expect((await asUser(fixture.IDS.registered, fixture.otherTeacher)).status).toBe(403);  // nor another teacher
    expect((await asGuest(fixture.IDS.registered)).status).not.toBe(200);                    // the guest link opens only its own submission
    const member = await pdfOf(asUser(fixture.IDS.registered, fixture.student));
    expect(JSON.stringify(member.vm)).not.toContain('guest.student@example.com');
    const guest = await pdfOf(asGuest(fixture.IDS.guest));
    expect(guest.vm.submission.studentEmail).toBe('guest.student@example.com');
    expect(JSON.stringify(guest.vm)).not.toContain('"student@example.com"');            // the member's address, as a whole value
  });
});

describe('Teacher field: never the teacher\'s email', () => {
  test('no display name: the neutral label "Teacher"; with one: the name; never the email, in any audience', async () => {
    for (const call of [() => asUser(fixture.IDS.registered, fixture.student), () => asGuest(fixture.IDS.guest), () => asUser(fixture.IDS.registered, fixture.teacher)]) {
      const { vm, html } = await pdfOf(call());
      expect(vm.submission.teacherName).toBe('Teacher');
      expect(html).not.toContain(TEACHER_EMAIL);
      expect(JSON.stringify(vm)).not.toContain(TEACHER_EMAIL);
    }
    await User.updateOne({ _id: fixture.teacher._id }, { $set: { displayName: 'Ms Rahman' } });
    expect((await pdfOf(asUser(fixture.IDS.registered, fixture.student))).vm.submission.teacherName).toBe('Ms Rahman');
  });
  test('student-facing responses never contain the teacher\'s email', async () => {
    const studentAuth = { Authorization: `Bearer ${jwt(fixture.student)}` };
    const responses = [
      await request(app).get(`/api/submissions/assignment/${fixture.IDS.assignment}/my`).set(studentAuth),
      await request(app).get(`/api/assignments/${fixture.IDS.assignment}`).set(studentAuth),
      await request(app).get(`/api/feedback/${fixture.IDS.registered}`).set(studentAuth),
      await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/presentation`).set('X-Guest-Token', fixture.guestToken),
      await request(app).get(`/api/guest/submissions/${fixture.IDS.guest}`).set('X-Guest-Token', fixture.guestToken),
    ];
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(TEACHER_EMAIL);
    }
  });
  test('the worksheet class report uses the same neutral fallback (source check)', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/modules/worksheetPdfGenerator.js'), 'utf8');
    expect(source).not.toMatch(/teacher\.displayName \|\| teacher\.email/);
  });
});

describe('Assignment description', () => {
  test('present: an "Assignment description" block on the cover, escaped, line breaks kept', async () => {
    const { vm, html } = await pdfOf(asUser(fixture.IDS.registered, fixture.student));
    expect(vm.submission.assignmentInstructions).toBe('Write about your weekend.\nUse the past tense <b>and</b> 150 words.');
    const block = /<div class="assignment-brief"><small>Assignment description<\/small><p>([\s\S]*?)<\/p><\/div>/.exec(html);
    expect(block[1]).toBe('Write about your weekend.\nUse the past tense &lt;b&gt;and&lt;/b&gt; 150 words.');
    expect(html.indexOf('assignment-brief">')).toBeLessThan(html.indexOf('results-summary">'));
    expect(html).toMatch(/\.assignment-brief p\{[^}]*white-space:pre-wrap[^}]*overflow-wrap:anywhere/);
    expect(html).toMatch(/\.assignment-brief\{[^}]*break-inside:auto/);
  });
  test('absent (empty or spaces): no block and no empty heading', async () => {
    for (const instructions of ['', '   \n  ']) {
      await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { instructions } });
      const { html } = await pdfOf(asUser(fixture.IDS.registered, fixture.student));
      expect(html).not.toContain('Assignment description');
      expect(html).not.toContain('class="assignment-brief"');
    }
  });
  test('long: kept up to 6000 characters, then clipped with an ellipsis', async () => {
    const long = 'Plan your paragraphs carefully. '.repeat(400);
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { instructions: long } });
    const { html } = await pdfOf(asUser(fixture.IDS.registered, fixture.student));
    const shown = /<div class="assignment-brief"><small>Assignment description<\/small><p>([\s\S]*?)<\/p><\/div>/.exec(html)[1];
    expect(shown.endsWith('…')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(6001);
  });
  test('never rubric internals or teacher-only fields', async () => {
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { rubric: 'PRIVATE RUBRIC TEXT' } });
    const { html } = await pdfOf(asGuest(fixture.IDS.guest));
    expect(html).not.toContain('PRIVATE RUBRIC TEXT');
    expect(html).not.toContain(TEACHER_EMAIL);
  });
});

test('the cache key follows the new identity and renderer version (old PDFs regenerate)', () => {
  expect(pdfCache.PDF_RENDERER_VERSION).toBe('feedback-pdf-v4');
  expect(renderer.PDF_RENDERER_VERSION).toBe('feedback-pdf-v4');
  const submission = { _id: fixture.IDS.guest, submittedAt: new Date('2026-01-01T00:00:00Z') };
  const base = { submission, submissionFeedback: null, feedback: null, marksVisible: true, audience: 'guest', legendIdentity: 'l', fileIdentity: [] };
  const before = pdfCache.cacheIdentity({ ...base, identity: { studentEmail: '', teacherName: 'teacher@example.com' } });
  const after = pdfCache.cacheIdentity({ ...base, identity: { studentEmail: 'guest.student@example.com', teacherName: 'Teacher' } });
  expect(after.cacheKey).not.toBe(before.cacheKey);
  expect(after.pdfRendererVersion).toBe('feedback-pdf-v4');
});
