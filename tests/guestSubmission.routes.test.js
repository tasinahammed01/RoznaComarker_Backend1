'use strict';
process.env.JWT_SECRET = 'guest-submission-test-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/guest-test-' + process.pid;
jest.setTimeout(60000);
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ ...jest.requireActual('../src/services/canonicalCorrectionsPipeline.service'), generateAndPersist: jest.fn(async () => {}) }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 1000 }) };
});
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
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const File = require('../src/models/File');
const access = require('../src/services/guestAccess.service');
const context = require('../src/services/submissionAccessContext.service');
const dispatch = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const email = require('../src/services/email.service').sendGuestSubmissionEmail;
const accounting = require('../src/services/assessmentCreditRouter.service');
const preflight = require('../src/services/imagePreflight.service').evaluateImage;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6FYQAAAAASUVORK5CYII=', 'base64');
let teacher, assignment, classDoc;
const root = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');
const url = suffix => `/api/guest/assignments/share-token${suffix || ''}`;
const send = (key = crypto.randomUUID(), fields = {}) => {
  let req = request(app).post(url('/submit')).set('Idempotency-Key', key)
    .field('name', fields.name ?? 'Guest Student').field('email', fields.email ?? 'guest@example.com');
  return req.attach('files', fields.bytes || png, { filename: 'writing.png', contentType: 'image/png' });
};
beforeAll(async () => { await connectInMemoryMongo(); await Submission.init(); });
afterAll(async () => {
  await disconnectInMemoryMongo();
  // Delete only this test's flat Multer output; never touch user uploads.
  if (fs.existsSync(root)) for (const name of fs.readdirSync(root)) fs.unlinkSync(path.join(root, name));
});
beforeEach(async () => {
  process.env.GUEST_SUBMISSION_ENABLED = 'true';
  jest.restoreAllMocks();
  await clearDatabase(); jest.clearAllMocks(); await seedTestPlans();
  accounting.canRunAssessment.mockResolvedValue({ allowed: true });
  preflight.mockResolvedValue({ ready: true, checks: [] }); email.mockResolvedValue({ success: true });
  teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'teacher@example.com', role: 'teacher' });
  classDoc = await Class.create({ name: 'Writing', teacher: teacher._id, joinCode: 'GUEST-TEST' });
  assignment = await Assignment.create({ title: 'Guest essay', class: classDoc._id, teacher: teacher._id,
    instructions: 'Write an essay.', rubric: 'PRIVATE RUBRIC', qrToken: 'share-token', allowGuestSubmission: true });
});

test('guest drafts reuse the normal revision handler, snapshot and idempotent pipeline dispatch', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl);
  const doc = await Submission.findOne();
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowResubmission: true, requireAdaptiveBeforeResubmission: false } });
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: 'complete', ocrStatus: 'completed',
    correctionStatus: 'failed', evaluationStatus: 'completed', transcriptText: 'First draft.' } });
  const key = crypto.randomUUID();
  const revise = (reference = key, token = link.hash.slice(1)) => request(app).post(`/api/guest/submissions/${doc.id}/revise`)
    .set('X-Guest-Token', token).set('Idempotency-Key', reference).attach('files', png, { filename: 'revision.png', contentType: 'image/png' });
  const response = await revise();
  expect(response.status).toBe(200); expect(response.body.data.received).toBe(true);
  expect(JSON.stringify(response.body)).not.toContain(teacher.email);
  const revised = await Submission.findById(doc._id);
  expect(revised.draftNumber).toBe(2); expect(revised.student).toBeUndefined();
  expect(revised.assessmentStatus).toBe('started');
  const snapshot = await require('../src/models/SubmissionRevision').findOne({ sourceSubmissionId: doc._id });
  expect(snapshot.submissionMode).toBe('guest'); expect(snapshot.transcriptText).toBe('First draft.');
  expect(snapshot.student).toBeUndefined(); expect(await User.countDocuments()).toBe(1);
  expect((await revise()).body.data.duplicate).toBe(true);
  expect((await Submission.findById(doc._id)).draftNumber).toBe(2);
  expect(dispatch).toHaveBeenCalledTimes(2); expect(email).toHaveBeenCalledTimes(2);
  expect((await revise(crypto.randomUUID(), access.issueToken().token)).status).toBe(410);
});

test('guest revision permission blocks uploads before persistence', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl);
  const doc = await Submission.findOne();
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowResubmission: false } });
  const response = await request(app).post(`/api/guest/submissions/${doc.id}/revise`).set('X-Guest-Token', link.hash.slice(1))
    .set('Idempotency-Key', crypto.randomUUID()).attach('files', png, { filename: 'draft.png', contentType: 'image/png' });
  expect(response.status).toBe(403); expect(await File.countDocuments()).toBe(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('parallel guest revision retries are serialized without a second accepted draft', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl); const doc = await Submission.findOne();
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowResubmission: true, requireAdaptiveBeforeResubmission: false } });
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: 'complete', ocrStatus: 'completed', correctionStatus: 'failed' } });
  const key = crypto.randomUUID();
  const revise = () => request(app).post(`/api/guest/submissions/${doc.id}/revise`).set('X-Guest-Token', link.hash.slice(1))
    .set('Idempotency-Key', key).attach('files', png, { filename: 'draft.png', contentType: 'image/png' });
  const responses = await Promise.all([revise(), revise()]);
  expect(responses.some(response => response.status === 200)).toBe(true);
  expect(responses.every(response => [200, 409].includes(response.status))).toBe(true);
  expect((await revise()).body.data.duplicate).toBe(true);
  expect((await Submission.findById(doc._id)).draftNumber).toBe(2);
  expect(dispatch).toHaveBeenCalledTimes(2);
  expect(await File.countDocuments()).toBe(2);
});

test('guest draft upload enforces adaptive prerequisites and late-draft policy', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl); const doc = await Submission.findOne();
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowResubmission: true, requireAdaptiveBeforeResubmission: true } });
  const revise = () => request(app).post(`/api/guest/submissions/${doc.id}/revise`).set('X-Guest-Token', link.hash.slice(1))
    .set('Idempotency-Key', crypto.randomUUID()).attach('files', png, { filename: 'draft.png', contentType: 'image/png' });
  expect((await revise()).body.code).toBe('ADAPTIVE_PRACTICE_REQUIRED');
  await Assignment.updateOne({ _id: assignment._id }, { $set: { requireAdaptiveBeforeResubmission: false, deadline: new Date(0), allowLateResubmission: false } });
  expect((await revise()).status).toBe(403);
  expect(await File.countDocuments()).toBe(1); expect(dispatch).toHaveBeenCalledTimes(1);
});

test('result-ready email is leased, restart-retryable and preserves the original private link', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl);
  const doc = await Submission.findOne();
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: 'complete' } });
  email.mockClear();
  const worker = require('../src/services/guestResultNotification.service');
  await Promise.all([worker.run(), worker.run()]);
  expect(email).toHaveBeenCalledTimes(1);
  expect(email.mock.calls[0][0].resultReady).toBe(true);
  const ready = new URL(email.mock.calls[0][0].returnUrl);
  await expect(access.authorize(doc.id, ready.hash.slice(1))).resolves.toBeTruthy();
  await expect(access.authorize(doc.id, link.hash.slice(1))).resolves.toBeTruthy();
  await worker.run(); expect(email).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('result-email failures retry after cooldown and global disabling prevents delivery', async () => {
  await send(); const doc = await Submission.findOne();
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: 'complete' } });
  email.mockClear(); email.mockResolvedValueOnce({ success: false });
  const worker = require('../src/services/guestResultNotification.service');
  await worker.run(); await worker.run(); expect(email).toHaveBeenCalledTimes(1);
  await Submission.updateOne({ _id: doc._id }, { $set: { 'guest.resultEmailNextAttemptAt': new Date(0) } });
  process.env.GUEST_SUBMISSION_ENABLED = 'false';
  await worker.run(); expect(email).toHaveBeenCalledTimes(1);
  process.env.GUEST_SUBMISSION_ENABLED = 'true';
  await worker.run(); expect(email).toHaveBeenCalledTimes(2);
  expect((await Submission.findById(doc._id)).guest.resultEmailSentAt).toBeTruthy();
});
test('public assignment DTO contains only entry metadata', async () => {
  const res = await request(app).get(url());
  expect(res.status).toBe(200);
  expect(Object.keys(res.body.data).sort()).toEqual(['allowGuestSubmission', 'instructions', 'title']);
  expect(JSON.stringify(res.body)).not.toContain('PRIVATE RUBRIC');
  expect(JSON.stringify(res.body)).not.toContain('teacher@example.com');
});
test.each([false, undefined])('guest setting %s fails closed', async enabled => {
  if (enabled === undefined) await Assignment.collection.updateOne({ _id: assignment._id }, { $unset: { allowGuestSubmission: 1 } });
  else await Assignment.updateOne({ _id: assignment._id }, { $set: { allowGuestSubmission: enabled } });
  expect((await request(app).get(url())).status).toBe(404);
  expect((await send()).status).toBe(404);
  expect(await Submission.countDocuments()).toBe(0); expect(dispatch).not.toHaveBeenCalled();
});
test('successful upload uses real owner storage and shared worker without a guest User', async () => {
  const issue = jest.spyOn(access, 'issueToken');
  const res = await send();
  expect(res.status).toBe(200); expect(res.body.data.emailSent).toBe(true);
  const doc = await Submission.findOne().select('+guest.accessHash +guest.normalizedEmail');
  expect(doc.submissionMode).toBe('guest'); expect(doc.student).toBeUndefined();
  expect(doc.guest.normalizedEmail).toBe('guest@example.com'); expect(await User.countDocuments()).toBe(1);
  expect(String((await File.findOne()).uploadedBy)).toBe(teacher.id);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(issue).toHaveBeenCalledTimes(1);
  expect(doc.fileContentIdentity).toBe(crypto.createHash('sha256').update(crypto.createHash('sha256').update(png).digest('hex')).digest('hex'));
  expect(email).toHaveBeenCalledWith(expect.objectContaining({ to: 'guest@example.com', returnUrl: res.body.data.returnUrl }));
  const link = new URL(res.body.data.returnUrl);
  expect(doc.guest.accessHash).toBe(access.hash(link.hash.slice(1)));
  expect((await request(app).get('/api/guest/submissions/' + doc.id).set('X-Guest-Token', link.hash.slice(1))).status).toBe(200);
});
test('concurrent duplicate HTTP uploads produce one submission and one dispatch/email', async () => {
  const key = crypto.randomUUID();
  const responses = await Promise.all([send(key), send(key), send(key)]);
  expect(responses.map(r => r.status)).toEqual([200, 200, 200]);
  expect(await Submission.countDocuments()).toBe(1); expect(await File.countDocuments()).toBe(1);
  expect(dispatch).toHaveBeenCalledTimes(1); expect(email).toHaveBeenCalledTimes(1);
  expect(require('../src/services/email.service').sendTeacherSubmissionEmail).toHaveBeenCalledTimes(1);
  expect(await require('../src/models/notification.model').countDocuments({ recipient: teacher._id, type: 'assignment_submitted' })).toBe(1);
});

test('shared result presentation, feedback and media are scoped and provider-free reads', async () => {
  const accepted = await send();
  const link = new URL(accepted.body.data.returnUrl);
  const id = link.pathname.split('/').pop();
  const token = link.hash.slice(1);
  const base = '/api/guest/submissions/' + id;
  const view = await request(app).get(base + '/presentation').set('X-Guest-Token', token);
  expect(view.status).toBe(200);
  expect(view.body.data.assignment.title).toBe(assignment.title);
  expect(view.body.data.submission.fileUrl).toContain(base + '/media/');
  const encoded = JSON.stringify(view.body);
  for (const secret of [teacher.email, 'guest@example.com', token, 'accessHash', 'uploadedBy', 'studentSourceEvidence']) expect(encoded).not.toContain(secret);
  const file = await request(app).get(view.body.data.submission.fileUrl).set('X-Guest-Token', token);
  expect(file.status).toBe(200);
  expect(file.body).toEqual(png);
  expect((await request(app).get(base + '/feedback').set('X-Guest-Token', token)).status).toBe(200);
  expect((await request(app).get(base + '/media/' + new (require('mongoose').Types.ObjectId)() + '/page.png')
    .set('X-Guest-Token', token)).status).toBe(404);
  expect((await request(app).get(base + '/presentation').set('X-Guest-Token', access.issueToken().token)).status).toBe(410);
  expect(dispatch).toHaveBeenCalledTimes(1);
});

test('teacher disabling guest permission blocks every scoped return resource', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl);
  const base = '/api/guest/submissions/' + link.pathname.split('/').pop();
  await Assignment.updateOne({ _id: assignment._id }, { $set: { allowGuestSubmission: false } });
  for (const suffix of ['', '/presentation', '/feedback', '/ocr-corrections', '/pdf', '/practice', '/drafts']) {
    expect((await request(app).get(base + suffix).set('X-Guest-Token', link.hash.slice(1))).status).toBe(404);
  }
});

test('expired submission-specific recovery requires matching email and rotates only that submission', async () => {
  const accepted = await send(); const link = new URL(accepted.body.data.returnUrl);
  const id = link.pathname.split('/').pop();
  await Submission.updateOne({ _id: id }, { $set: { 'guest.expiresAt': new Date(0) } });
  email.mockClear();
  const endpoint = '/api/guest/submissions/' + id + '/recover';
  const missing = await request(app).post(endpoint).send({ email: 'unrelated@example.com' });
  await new Promise(resolve => setTimeout(resolve, 60));
  expect(email).not.toHaveBeenCalled();
  const matching = await request(app).post(endpoint).send({ email: 'guest@example.com' });
  expect(matching.body).toEqual(missing.body);
  for (let i = 0; i < 30 && !email.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  expect(email).toHaveBeenCalledTimes(1);
  const rotated = new URL(email.mock.calls[0][0].returnUrl);
  expect(rotated.pathname).toBe(link.pathname);
  expect(rotated.hash).not.toBe(link.hash);
  expect((await request(app).get('/api/guest/submissions/' + id + '/presentation').set('X-Guest-Token', rotated.hash.slice(1))).status).toBe(200);
});

(process.env.GUEST_BROWSER_QA === '1' ? test : test.skip)('production Angular guest lifecycle uses shared upload and result components', async () => {
  const express = require('express');
  const frontend = express();
  const build = path.resolve(__dirname, '../../RoznaComarker/dist/rozna-comarker-fe/browser');
  frontend.use(express.static(build));
  frontend.get(/.*/, (_req, res) => res.sendFile(path.join(build, 'index.html')));
  const listen = (server, port) => new Promise((resolve, reject) => {
    const listener = server.listen(port, '127.0.0.1', () => resolve(listener)); listener.on('error', reject);
  });
  const api = await listen(app, 0);
  const site = await listen(frontend, 4200);
  let browser;
  let stage = 'entry';
  try {
    browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1100 });
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await page.setRequestInterception(true);
    page.on('request', req => {
      const target = new URL(req.url());
      if (target.pathname.startsWith('/api/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
      if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
      // Resolve optional remote CSS locally so Angular's media=print onload
      // optimization completes without requesting fonts/icons from the network.
      if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
      return req.abort();
    });
    await page.goto('http://localhost:4200/student/assignments/qr/share-token', { waitUntil: 'networkidle0' });
    await page.waitForSelector('#guest-name');
    await page.type('#guest-name', 'Synthetic Guest');
    await page.type('#guest-email', 'guest@example.com');
    await page.click('.submit-button');
    await page.waitForSelector('app-upload-essay-form input[type=file]');
    const fixture = path.join(root, 'browser-source.png');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(fixture, await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="white"/><text x="40" y="80" font-size="24">A synthetic writing sample.</text></svg>')).png().toBuffer());
    const picker = await page.$('app-upload-essay-form input[type=file]');
    await picker.uploadFile(fixture);
    await page.waitForFunction(() => !document.querySelector('.submit-button')?.disabled);
    await page.click('.submit-button');
    stage = 'accepted';
    await page.waitForSelector('.confirmation a');
    expect(email).toHaveBeenCalledTimes(1);
    const link = new URL(await page.$eval('.confirmation a', anchor => anchor.href));
    const doc = await Submission.findOne();
    const teacherList = await request(app).get(`/api/submissions/assignment/${assignment.id}`).set('Authorization', `Bearer ${signTestJwt(teacher)}`);
    expect(teacherList.status).toBe(200);
    expect(teacherList.body.data.some(item => item._id === doc.id && item.guest.displayName === 'Synthetic Guest')).toBe(true);
    await Submission.updateOne({ _id: doc._id }, { $set: {
      assessmentStatus: 'complete', evaluationStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
      ocrStatus: 'completed', transcriptText: 'A synthetic writing sample.', correctionSourceHash: 'browser-fixture',
      correctionTranscriptLayoutVersion: require('../src/utils/ocrTranscriptNormalizer').CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      writingCorrections: [], ocrPages: [{ fileId: doc.file, pageNumber: 1, text: 'A synthetic writing sample.', words: [] }] } });
    await Feedback.create({ submissionMode: 'guest', submissionId: doc._id, classId: doc.class, teacherId: teacher._id,
      overriddenByTeacher: true, overallScore: 82, evaluationStatus: 'completed', evaluationSourceHash: 'browser-fixture',
      rubricScores: { GRAMMAR: { score: 20, maxScore: 25, feedback: 'Clear writing.' } },
      detailedFeedback: { status: 'completed', sourceHash: 'browser-fixture', version: 'canonical-detailed-feedback-1',
        strengths: ['Clear writing.'], areasForImprovement: [], actionSteps: [] }, teacherComments: 'Fixture review complete.' });
    await page.goto('http://localhost:4200' + link.pathname + link.hash, { waitUntil: 'networkidle0' });
    stage = 'result image';
    await page.waitForSelector('app-my-submission-page app-correction-overlay img');
    await page.waitForFunction(() => document.querySelector('app-correction-overlay img')?.naturalWidth > 0);
    stage = 'teacher feedback';
    await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(input => input.value.includes('Fixture review complete.')));
    expect(page.url()).not.toContain(link.hash);
    const evidence = path.resolve(__dirname, '../../output/guest-production-qa'); fs.mkdirSync(evidence, { recursive: true });
    await page.screenshot({ path: path.join(evidence, 'shared-result-desktop.png'), fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await page.waitForFunction(() => getComputedStyle(document.querySelector('.btn-primary')).backgroundColor === 'rgb(0, 128, 129)');
    await page.screenshot({ path: path.join(evidence, 'shared-result-mobile.png'), fullPage: true });
    await page.reload({ waitUntil: 'networkidle0' });
    await page.waitForSelector('app-my-submission-page app-correction-overlay img');
    stage = 'feedback PDF';
    process.env.ENABLE_TEST_PDF_HTTP = 'true';
    process.env.PDF_CHROME_NO_SANDBOX = 'true';
    process.env.PDF_FEEDBACK_CACHE_DIR = path.resolve(__dirname, '../../tmp/guest-pdf-qa-cache');
    const pdf = await request(app).get(`/api/guest/submissions/${doc.id}/pdf`).set('X-Guest-Token', link.hash.slice(1))
      .buffer(true).parse((res, done) => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    expect(pdf.status).toBe(200); expect(pdf.body.subarray(0, 4).toString()).toBe('%PDF');
    fs.writeFileSync(path.join(evidence, 'feedback.pdf'), pdf.body);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(failures).toEqual([]);
  } catch (error) {
    const pages = browser ? await browser.pages() : [];
    const active = pages[pages.length - 1];
    if (active) {
      const evidence = path.resolve(__dirname, '../../output/guest-production-qa'); fs.mkdirSync(evidence, { recursive: true });
      await active.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
      fs.writeFileSync(path.join(evidence, 'failure.txt'), `Stage: ${stage}\n${await active.$eval('body', body => body.innerText)}`);
    }
    throw error;
  } finally {
    if (browser) await browser.close();
    await require('../src/services/pdfBrowserManager.service').closeBrowser();
    delete process.env.ENABLE_TEST_PDF_HTTP; delete process.env.PDF_CHROME_NO_SANDBOX; delete process.env.PDF_FEEDBACK_CACHE_DIR;
    await Promise.all([new Promise(resolve => api.close(resolve)), new Promise(resolve => site.close(resolve))]);
  }
}, 120000);
test('same reference with changed identity is rejected and does not dispatch again', async () => {
  const key = crypto.randomUUID(); await send(key);
  expect((await send(key, { email: 'other@example.com' })).status).toBe(409);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('email delivery failure preserves valid submission and provides a return link', async () => {
  email.mockResolvedValue({ success: false });
  const res = await send(); expect(res.status).toBe(200); expect(res.body.data.emailSent).toBe(false);
  expect(res.body.data.returnUrl).toContain('#'); expect(await Submission.countDocuments()).toBe(1);
});

test.each(['completed', 'failed', 'rotated', 'revoked'])('fresh return-link lifecycle survives worker persistence (%s)', async mode => {
  email.mockResolvedValue({ success: false });
  const response = await send();
  expect(response.status).toBe(200);
  const link = new URL(response.body.data.returnUrl);
  // Angular's DefaultUrlSerializer decodes the entire fragment; there is no token= prefix.
  let token = decodeURIComponent(link.hash.slice(1));
  const id = link.pathname.split('/').pop();
  const targetDoc = await Submission.findById(id);
  expect(targetDoc.guest.accessHash).toBeUndefined();
  expect(targetDoc.guest.normalizedEmail).toBeUndefined();
  const get = value => request(app).get(`/api/guest/submissions/${id}`).set('X-Guest-Token', value);
  expect((await get(token)).status).toBe(200);
  const vision = require('../src/services/visionOcr.service');
  vision.extractOcrFromImageFile.mockImplementationOnce(async () => {
    // These changes happen after the worker read, as a real recovery/revocation can.
    if (mode === 'rotated') {
      const issued = access.issueToken(); token = issued.token;
      await Submission.updateOne({ _id: id }, { $set: { 'guest.accessHash': issued.accessHash,
        'guest.expiresAt': issued.expiresAt, 'guest.recoveredAt': new Date() } });
    }
    if (mode === 'revoked') await Submission.updateOne({ _id: id }, { $set: { 'guest.revokedAt': new Date() }, $unset: { 'guest.accessHash': 1 } });
    if (mode === 'failed') throw Object.assign(new Error('Synthetic OCR failure'), { code: 'OCR_PROVIDER_FAILED' });
    return { fullText: 'A clear paragraph about a place that matters to this student.', words: [], pages: [{ pageNumber: 1, words: [] }] };
  });
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({
    targetDoc, fileIds: targetDoc.files, jobId: targetDoc.ocrJobId });
  const stored = await Submission.collection.findOne({ _id: targetDoc._id });
  // Check HTTP access first so the original regression proves the observed 410.
  expect((await get(token)).status).toBe(mode === 'revoked' ? 410 : 200);
  expect(stored.guest.normalizedEmail).toBe('guest@example.com');
  expect(stored.guest.requestHash).toBeTruthy();
  expect(stored.guestRequestKey).toBeTruthy();
  expect(JSON.stringify(stored)).not.toContain(token);
  if (mode === 'revoked') {
    expect(stored.guest.revokedAt).toBeTruthy();
    expect((await get(token)).status).toBe(410);
  } else {
    expect(stored.guest.accessHash === access.hash(token)).toBe(true);
    expect((await get(token)).status).toBe(200);
    if (mode === 'rotated') expect((await get(link.hash.slice(1))).status).toBe(410);
  }
  expect(stored.ocrStatus).toBe(mode === 'failed' ? 'failed' : 'completed');
  expect((await request(app).get(`/api/guest/submissions/${id}`)).status).toBe(410);
  expect((await get(access.issueToken().token)).status).toBe(410);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(await Submission.countDocuments()).toBe(1);
});
test.each(['identity', 'preflight', 'signature', 'credits'])('%s failure cannot dispatch assessment or consume credits', async failure => {
  const fields = {};
  if (failure === 'identity') fields.name = '   ';
  if (failure === 'signature') fields.bytes = Buffer.from('not a writing image');
  if (failure === 'preflight') preflight.mockResolvedValue({ ready: false, checks: [{ required: true, status: 'fail' }] });
  if (failure === 'credits') accounting.canRunAssessment.mockResolvedValue({ allowed: false });
  const res = await send(undefined, fields); expect(res.status).toBeGreaterThanOrEqual(400);
  expect(await Submission.countDocuments()).toBe(0); expect(dispatch).not.toHaveBeenCalled(); expect(email).not.toHaveBeenCalled();
});
test('guest token cannot list submissions, use teacher APIs or change assignment settings', async () => {
  const res = await send(); const token = new URL(res.body.data.returnUrl).hash.slice(1);
  expect((await request(app).get(`/api/submissions/assignment/${assignment.id}`).set('Authorization', 'Bearer ' + token)).status).toBe(401);
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization', 'Bearer ' + token).send({ allowGuestSubmission: true })).status).toBe(401);
  expect((await request(app).get('/api/submissions/my').set('X-Guest-Token', token)).status).toBe(401);
});
test('only assignment teacher can update guest setting and revoke a guest link', async () => {
  const other = await User.create({ firebaseUid: crypto.randomUUID(), email: 'other@example.com', role: 'teacher' });
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization', 'Bearer ' + signTestJwt(other)).send({ allowGuestSubmission: false })).status).toBe(404);
  const res = await send(); const link = new URL(res.body.data.returnUrl); const doc = await Submission.findOne();
  expect((await request(app).post(`/api/submissions/${doc.id}/guest-access/revoke`).set('Authorization', 'Bearer ' + signTestJwt(other))).status).toBeGreaterThanOrEqual(400);
  expect((await request(app).post(`/api/submissions/${doc.id}/guest-access/revoke`).set('Authorization', 'Bearer ' + signTestJwt(teacher))).status).toBe(200);
  expect((await request(app).get(`/api/guest/submissions/${doc.id}`).set('X-Guest-Token', link.hash.slice(1))).status).toBe(410);
});
test('guest ownership capabilities cannot be forged and never authorize another submission/session', async () => {
  await send(); const doc = await Submission.findOne();
  const actor = context.guestContext(doc);
  expect(context.ownsSubmission(doc, actor)).toBe(true);
  expect(context.ownsSubmission({ _id: 'different', submissionMode: 'guest' }, actor)).toBe(false);
  expect(context.ownsSession({ submissionId: doc.id, guestSubmissionId: doc.id }, actor)).toBe(true);
  expect(context.ownsSession({ submissionId: 'different', guestSubmissionId: 'different' }, actor)).toBe(false);
  expect(context.isGuest({ submissionId: doc.id })).toBe(false);
  expect(context.ownsSubmission(doc, undefined)).toBe(false);
});
test('teacher can enable/disable guests and invalid setting types are rejected', async () => {
  const auth = 'Bearer ' + signTestJwt(teacher);
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization', auth).send({ allowGuestSubmission: false })).status).toBe(200);
  expect((await request(app).get(url())).status).toBe(404);
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization', auth).send({ allowGuestSubmission: true })).status).toBe(200);
  expect((await request(app).get(url())).status).toBe(200);
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization', auth).send({ allowGuestSubmission: 'yes' })).status).toBe(400);
});
test('marks and draft progress respect teacher visibility without exposing guest email or token hashes', async () => {
  const response = await send(); const doc = await Submission.findOne();
  const token = new URL(response.body.data.returnUrl).hash.slice(1);
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: 'complete', evaluationStatus: 'completed',
    correctionStatus: 'completed', semanticStatus: 'completed' } });
  await Feedback.create({ submissionMode: 'guest', submissionId: doc._id, classId: doc.class,
    teacherId: teacher._id, overriddenByTeacher: true, overallScore: 91,
    detailedFeedback: { status: 'completed', strengths: [{ explanation: 'Good support.', score: 19 }], areasForImprovement: [], actionSteps: [] },
    teacherComments: 'Well done.' });
  await Assignment.updateOne({ _id: assignment._id }, { $set: { showMarksToStudent: false } });
  const hidden = await request(app).get(`/api/guest/submissions/${doc.id}`).set('X-Guest-Token', token);
  expect(hidden.status).toBe(200); expect(hidden.body.data.marksVisible).toBe(false);
  expect(hidden.body.data.feedback.overallScore).toBeUndefined();
  expect(hidden.body.data.feedback.detailedFeedback.strengths[0].score).toBeUndefined();
  expect(hidden.body.data.feedback.teacherComments).toBe('Well done.');
  expect(JSON.stringify(hidden.body)).not.toContain('guest@example.com');
  expect(JSON.stringify(hidden.body)).not.toContain('accessHash');
  const drafts = await request(app).get(`/api/guest/submissions/${doc.id}/drafts`).set('X-Guest-Token', token);
  expect(drafts.body.data.code).toBe('MARKS_HIDDEN');
});
test('recovery acknowledges generically, rotates once, and cannot restore revoked access', async () => {
  const response = await send(); const doc = await Submission.findOne();
  const creditsBefore = await require('../src/models/CreditTransaction').countDocuments();
  const oldToken = new URL(response.body.data.returnUrl).hash.slice(1);
  email.mockClear();
  const recovered = await request(app).post(url('/recover')).send({ email: 'GUEST@example.com' });
  expect(recovered.status).toBe(200);
  for (let i = 0; i < 100 && !email.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(email).toHaveBeenCalledTimes(1);
  const newToken = new URL(email.mock.calls[0][0].returnUrl).hash.slice(1);
  expect(newToken).not.toBe(oldToken);
  await expect(access.authorize(doc.id, oldToken)).rejects.toMatchObject({ statusCode: 410 });
  await expect(access.authorize(doc.id, newToken)).resolves.toBeTruthy();
  const unknown = await request(app).post(url('/recover')).send({ email: 'unknown@example.com' });
  expect(unknown.body).toEqual(recovered.body);
  await request(app).post(url('/recover')).send({ email: 'guest@example.com' });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(email).toHaveBeenCalledTimes(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(accounting.canRunAssessment).toHaveBeenCalledTimes(1);
  expect(await Submission.countDocuments()).toBe(1);
  expect(await require('../src/models/CreditTransaction').countDocuments()).toBe(creditsBefore);
});
test('guest practice attempts reuse existing grading with exact submission/session ownership', async () => {
  const response = await send(); const doc = await Submission.findOne();
  const token = new URL(response.body.data.returnUrl).hash.slice(1);
  const Session = require('../src/models/AdaptivePracticeSession');
  const session = await Session.create({ submissionId: doc._id, guestSubmissionId: doc._id,
    assignmentId: assignment._id, status: 'ready', sourceFingerprint: 'guest-practice',
    sourceSnapshot: { transcriptFingerprint: 'transcript', feedbackId: new (require('mongoose').Types.ObjectId)(), feedbackUpdatedAt: new Date(),
      skills: [{ id: 'GRAMMAR', category: 'Grammar', earnedPoints: 10, maximumPoints: 25, percentage: 40, status: 'priority' }] },
    activities: [{ activityId: 'grammar', skillId: 'GRAMMAR', category: 'Grammar', title: 'Verb agreement',
      description: 'Choose the correct verb.', evidence: 'They is ready.', difficulty: 'foundational',
      questions: [{ questionId: 'q1', questionType: 'mcq', task: 'They ___ ready.', tip: 'Check subject agreement.',
        checklist: ['Use a plural verb.'], modelAnswer: 'They are ready.', options: [{ id: 'a', text: 'is' }, { id: 'b', text: 'are' }], correctOptionId: 'b' }] }] });
  const checked = await request(app).post(`/api/guest/submissions/${doc.id}/practice/${session.id}/grammar`)
    .set('X-Guest-Token', token).send({ questionId: 'q1', response: 'b' });
  expect(checked.status).toBe(200); expect(checked.body.data.attempt.result.passed).toBe(true);
  expect(checked.body.data.attempt.studentId).toBeUndefined();
  await Session.updateOne({ _id: session._id }, { $set: { guestSubmissionId: new (require('mongoose').Types.ObjectId)() } });
  expect((await request(app).post(`/api/guest/submissions/${doc.id}/practice/${session.id}/grammar`)
    .set('X-Guest-Token', token).send({ questionId: 'q1', response: 'b' })).status).toBe(403);
});
test('public throttling rejects excessive requests', async () => {
  const express = require('express'); const isolated = express();
  const limiter = jest.requireActual('../src/middlewares/rateLimit.middleware').createSensitiveRateLimiter({ limit: 2, windowMs: 60000 });
  isolated.get('/limited', limiter, (_req, res) => res.json({ ok: true }));
  expect((await request(isolated).get('/limited')).status).toBe(200);
  expect((await request(isolated).get('/limited')).status).toBe(200);
  expect((await request(isolated).get('/limited')).status).toBe(429);
});
test.each(['archived', 'inactive-owner'])('%s context cannot accept guest uploads', async state => {
  if (state === 'archived') await Class.updateOne({ _id: classDoc._id }, { $set: { status: 'archived' } });
  else await User.updateOne({ _id: teacher._id }, { $set: { isActive: false } });
  expect((await request(app).get(url())).status).toBe(404);
  expect((await send()).status).toBe(404);
  expect(await Submission.countDocuments()).toBe(0);
  expect(dispatch).not.toHaveBeenCalled();
});
test('assignment disabled during image preflight is checked again before persistence', async () => {
  preflight.mockImplementationOnce(async () => {
    await Assignment.updateOne({ _id: assignment._id }, { $set: { allowGuestSubmission: false } });
    return { ready: true, checks: [] };
  });
  expect((await send()).status).toBe(404);
  expect(await Submission.countDocuments()).toBe(0);
  expect(await File.countDocuments()).toBe(0);
  expect(dispatch).not.toHaveBeenCalled();
});
test('a second-file persistence failure cleans partial File records, bytes and storage reservation', async () => {
  const before = (await User.findById(teacher._id)).usage.storageMB;
  const filesBefore = fs.existsSync(root) ? fs.readdirSync(root).sort() : [];
  const bytes = Buffer.alloc(100 * 1024); png.copy(bytes);
  const createFile = File.create.bind(File);
  jest.spyOn(File, 'create').mockImplementationOnce((...args) => createFile(...args))
    .mockRejectedValueOnce(new Error('simulated storage failure'));
  const res = await request(app).post(url('/submit')).set('Idempotency-Key', crypto.randomUUID())
    .field('name', 'Guest').field('email', 'guest@example.com')
    .attach('files', bytes, { filename: 'one.png', contentType: 'image/png' })
    .attach('files', bytes, { filename: 'two.png', contentType: 'image/png' });
  expect(res.status).toBe(503);
  expect(await Submission.countDocuments()).toBe(0);
  expect(await File.countDocuments()).toBe(0);
  expect((await User.findById(teacher._id)).usage.storageMB).toBeCloseTo(before, 10);
  expect(fs.readdirSync(root).sort()).toEqual(filesBefore);
  expect(dispatch).not.toHaveBeenCalled();
});
test('a committed source survives a dispatch exception and the same request cannot create a second source', async () => {
  dispatch.mockImplementationOnce(() => { throw new Error('simulated scheduling interruption'); });
  const key = crypto.randomUUID();
  expect((await send(key)).status).toBe(503);
  const doc = await Submission.findOne(); const file = await File.findOne();
  expect(doc).toBeTruthy(); expect(fs.existsSync(path.resolve(__dirname, '..', file.path))).toBe(true);
  const retry = await send(key);
  expect(retry.status).toBe(200); expect(retry.body.data.duplicate).toBe(true);
  expect(await Submission.countDocuments()).toBe(1); expect(await File.countDocuments()).toBe(1);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
test('HTTP return links reject another submission, random, expired and revoked tokens', async () => {
  const first = await send(); const token = new URL(first.body.data.returnUrl).hash.slice(1);
  const one = await Submission.findOne();
  await send(); const two = await Submission.findOne({ _id: { $ne: one._id } });
  const get = (id, bearer) => request(app).get(`/api/guest/submissions/${id}`).set('X-Guest-Token', bearer);
  expect((await get(two.id, token)).status).toBe(410);
  expect((await get(one.id, access.issueToken().token)).status).toBe(410);
  await Submission.updateOne({ _id: one._id }, { $set: { 'guest.expiresAt': new Date(0) } });
  expect((await get(one.id, token)).status).toBe(410);
  await Submission.updateOne({ _id: one._id }, { $set: { 'guest.expiresAt': new Date(Date.now() + 60000), 'guest.revokedAt': new Date() } });
  expect((await get(one.id, token)).status).toBe(410);
});
test.each(['blocked', 'failed', 'stale'])('guest results expose safe %s processing state without stale feedback', async mode => {
  const response = await send(); const doc = await Submission.findOne();
  await Submission.updateOne({ _id: doc._id }, { $set: { assessmentStatus: mode === 'stale' ? 'complete' : 'started',
    evaluationStatus: mode, evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS',
    evaluationError: 'PRIVATE provider error and internal details' } });
  const res = await request(app).get(`/api/guest/submissions/${doc.id}`)
    .set('X-Guest-Token', new URL(response.body.data.returnUrl).hash.slice(1));
  expect(res.status).toBe(200); expect(res.body.data.feedback).toBeNull();
  expect(res.body.data.status).toBe(mode === 'stale' ? 'processing' : mode);
  if (mode === 'blocked') expect(res.body.data.processingMessage).toContain('teacher to add credits');
  expect(JSON.stringify(res.body)).not.toContain('PRIVATE');
});
test('recovery cannot reissue revoked access, and provider failure never changes its generic response', async () => {
  const created = await send(); const doc = await Submission.findOne();
  email.mockClear(); email.mockResolvedValue({ success: false });
  await Submission.updateOne({ _id: doc._id }, { $set: { 'guest.revokedAt': new Date() } });
  const revoked = await request(app).post(url('/recover')).send({ email: 'guest@example.com' });
  const invalid = await request(app).post(url('/recover')).send({ email: 'invalid' });
  await new Promise(resolve => setTimeout(resolve, 100));
  expect(revoked.body).toEqual(invalid.body); expect(email).not.toHaveBeenCalled();
  await expect(access.authorize(doc.id, new URL(created.body.data.returnUrl).hash.slice(1))).rejects.toMatchObject({ statusCode: 410 });
  await Submission.updateOne({ _id: doc._id }, { $unset: { 'guest.revokedAt': 1 } });
  const failedDelivery = await request(app).post(url('/recover')).send({ email: 'guest@example.com' });
  for (let i = 0; i < 100 && !email.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  expect(failedDelivery.body).toEqual(invalid.body); expect(email).toHaveBeenCalledTimes(1);
  expect(await Submission.countDocuments()).toBe(1);
});
test.each(['missing', 'extra-key', 'narrow-partial'])('guest submission fails closed with %s uniqueness index', async mode => {
  const indexes = await Submission.collection.indexes();
  const changed = indexes.filter(index => !index.key.guestRequestKey);
  const guestIndex = indexes.find(index => index.key.guestRequestKey);
  if (mode === 'extra-key') changed.push({ ...guestIndex, key: { ...guestIndex.key, submittedAt: 1 } });
  if (mode === 'narrow-partial') changed.push({ ...guestIndex,
    partialFilterExpression: { guestRequestKey: { $type: 'string' }, submissionMode: 'registered' } });
  jest.spyOn(Submission.collection, 'indexes').mockResolvedValue(changed);
  const response = await send();
  expect(response.status).toBe(503); expect(response.body.code).toBe('GUEST_INDEX_SETUP_REQUIRED');
  expect(await Submission.countDocuments()).toBe(0); expect(dispatch).not.toHaveBeenCalled();
});
test('unsupported MIME and oversized uploads cannot create an assessment', async () => {
  const invalid = await request(app).post(url('/submit')).set('Idempotency-Key', crypto.randomUUID())
    .field('name', 'Guest').field('email', 'guest@example.com')
    .attach('files', Buffer.from('executable'), { filename: 'file.exe', contentType: 'application/octet-stream' });
  expect(invalid.status).toBeGreaterThanOrEqual(400);
  const tooLarge = Buffer.alloc(10 * 1024 * 1024 + 1); png.copy(tooLarge);
  expect((await send(undefined, { bytes: tooLarge })).status).toBe(413);
  expect(dispatch).not.toHaveBeenCalled(); expect(await Submission.countDocuments()).toBe(0);
});

test('global disabled state overrides a persisted guest assignment without mutating its guest data', async () => {
  await send(); const before=await Submission.findOne({submissionMode:'guest'}).select('+guest.accessHash').lean();
  const assignmentBefore=await Assignment.findById(assignment._id).lean();
  process.env.GUEST_SUBMISSION_ENABLED='false';jest.clearAllMocks();
  expect((await request(app).get(url())).status).toBe(403);expect((await send()).status).toBe(403);
  expect(await Submission.countDocuments()).toBe(1);
  expect((await Submission.findById(before._id).select('+guest.accessHash').lean()).guest).toEqual(before.guest);
  expect((await Assignment.findById(assignment._id).lean()).allowGuestSubmission).toBe(assignmentBefore.allowGuestSubmission);
  expect(email).not.toHaveBeenCalled();expect(dispatch).not.toHaveBeenCalled();
  process.env.GUEST_SUBMISSION_ENABLED='true';expect((await request(app).get(url())).status).toBe(200);
});

test('disabled flag rejects new guest opt-in but preserves normal teacher updates and historical opt-in',async()=>{
  process.env.GUEST_SUBMISSION_ENABLED='false';const auth='Bearer '+signTestJwt(teacher);
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization',auth).send({title:'Normal teacher edit'})).status).toBe(200);
  expect((await Assignment.findById(assignment._id)).allowGuestSubmission).toBe(true);
  await Assignment.updateOne({_id:assignment._id},{$set:{allowGuestSubmission:false}});
  expect((await request(app).patch(`/api/assignments/${assignment.id}`).set('Authorization',auth).send({allowGuestSubmission:true})).status).toBe(403);
  expect((await Assignment.findById(assignment._id)).allowGuestSubmission).toBe(false);
});
