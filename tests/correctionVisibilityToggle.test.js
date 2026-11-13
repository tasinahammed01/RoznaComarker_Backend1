'use strict';
// FIX 1 (show/hide toggle): the teacher's eye toggle is the existing hide/restore action. Through the real routes: hiding persists
// (a fresh teacher read shows it hidden and still listed), removes the correction from EVERY student and guest surface (JSON and
// PDF, registered and guest), and showing it again brings it back. Synthetic fixture only; no AI, OCR or email is called.
process.env.JWT_SECRET = 'visibility-toggle-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/visibility-toggle';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';   // real PDF rendering (headless browser) for the text check
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi } = require('./helpers/annotationApi');
const { surfaces, capture } = require('./helpers/studentSurfaces');

jest.setTimeout(600000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const MESSAGE = 'before a vowel sound';   // only in the ART correction on "a"
let fixture, teacher, studentJwt;

const binary = r => r.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });
async function pdfText(res) { expect(res.status).toBe(200); return (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' '); }
const pdfs = async () => ({
  registered: await pdfText(await binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`))),
  guest: await pdfText(await binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken))),
});
async function studentView() {
  const out = await capture(surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken }));
  for (const [name, { status }] of Object.entries(out)) expect({ name, status }).toEqual({ name, status: 200 });
  return Object.fromEntries(Object.entries(out).map(([name, { body }]) => [name, JSON.stringify(body)]));
}
const target = async mode => (await teacher.find(fixture.IDS[mode], 'a', 'ART'));

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await Promise.all(['Submission', 'AnnotationAudit'].map(m => require(`../src/models/${m}`).init()));
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  if (process.env.PDF_FEEDBACK_CACHE_DIR) fs.rmSync(process.env.PDF_FEEDBACK_CACHE_DIR, { recursive: true, force: true });
});

test('hide -> persisted and absent for the student and the guest (JSON and PDF) -> show -> back for both', async () => {
  // Positive control: visible, so the student surfaces and both PDFs carry it.
  const ids = { registered: (await target('registered')).id, guest: (await target('guest')).id };
  let view = await studentView(), pdf = await pdfs();
  expect(Object.values(view).some(text => text.includes(MESSAGE))).toBe(true);
  expect(pdf.registered).toContain(MESSAGE); expect(pdf.guest).toContain(MESSAGE);

  for (const mode of ['registered', 'guest']) {
    const res = await teacher.act(fixture.IDS[mode], { action: 'hide', id: ids[mode] });
    expect(res.status).toBe(200);
  }
  // Persisted: a fresh teacher read (what a page reload does) shows it hidden, and still listed for the teacher.
  for (const mode of ['registered', 'guest']) expect(await target(mode)).toEqual(expect.objectContaining({ id: ids[mode], moderationStatus: 'hidden' }));
  view = await studentView(); pdf = await pdfs();
  for (const [name, text] of Object.entries(view)) {
    expect({ name, leaked: text.includes(MESSAGE) }).toEqual({ name, leaked: false });
    expect({ name, leaked: text.includes(ids.registered) || text.includes(ids.guest) }).toEqual({ name, leaked: false });
  }
  expect(pdf.registered).not.toContain(MESSAGE); expect(pdf.guest).not.toContain(MESSAGE);

  // Show again (the eye toggle sends restore from hidden).
  for (const mode of ['registered', 'guest']) expect((await teacher.act(fixture.IDS[mode], { action: 'restore', id: ids[mode] })).status).toBe(200);
  for (const mode of ['registered', 'guest']) expect(await target(mode)).toEqual(expect.objectContaining({ moderationStatus: 'visible' }));
  view = await studentView(); pdf = await pdfs();
  expect(Object.values(view).some(text => text.includes(MESSAGE))).toBe(true);
  expect(pdf.registered).toContain(MESSAGE); expect(pdf.guest).toContain(MESSAGE);
});

test('a second hide of an already hidden correction is refused (no silent double toggle)', async () => {
  const id = (await target('registered')).id;
  expect((await teacher.act(fixture.IDS.registered, { action: 'hide', id })).status).toBe(200);
  const again = await teacher.act(fixture.IDS.registered, { action: 'hide', id });
  expect(again.status).toBe(409);
  expect(again.body.code).toBe('ANNOTATION_STATE_CONFLICT');
  expect((await teacher.act(fixture.IDS.registered, { action: 'restore', id })).status).toBe(200);
});
