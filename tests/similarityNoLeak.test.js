'use strict';
// Similarity Reporting never reaches a student or a guest: with a full report (web, repository and internal sources, a provider audit,
// the notice) stored for both fixture submissions and the feature ON, no student or guest surface (API and feedback PDF) contains any
// part of it. Also: the notice text names no provider, is stored only when the page showed this exact version, and the upload paths use it.
process.env.JWT_SECRET = 'similarity-noleak-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/similarity-noleak';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'similarity-noleak-pdf-'));
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SimilarityReport = require('../src/models/SimilarityReport');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces } = require('./helpers/studentSurfaces');
const { NOTICE_VERSION } = require('../src/services/similarity/policy');
const notice = require('../src/config/essaySimilarityNotice');

jest.setTimeout(600000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const SENTINELS = ['SIMILARITY_SENTINEL_TITLE', 'sentinel.example.test', 'view.sentinel.example.test', 'Internet source',
  'Published or institutional source', 'Another submission in Rubrilo', 'Same student, another assignment', NOTICE_VERSION, 'similarityNotice',
  'overallPercent', 'providerAudit', 'externalRef', 'rbsentinel'];
const PROVIDERS = /copyscape|copyleaks/i;
let fixture, studentJwt;

const report = (submission, f) => ({ submissionId: submission, assignmentId: f.assignment._id, classId: f.assignment.class, teacherId: f.IDS.teacher,
  status: 'completed', revision: 3, external: { state: 'completed' }, text: { sha256: 'a'.repeat(64), chars: 10, words: 2, origin: 'ocr' },
  sources: [
    { sourceId: 's1', kind: 'web', label: 'Internet source', title: 'SIMILARITY_SENTINEL_TITLE', url: 'https://sentinel.example.test/page',
      viewUrl: 'https://view.sentinel.example.test/x', spans: [{ start: 0, end: 4, wordStart: 0, wordEnd: 1 }] },
    { sourceId: 's2', kind: 'repository', label: 'Published or institutional source', compared: false, approxWords: 9 },
    { sourceId: 's3', kind: 'internal', label: 'Another submission in Rubrilo', refSubmissionId: f.IDS.guest, refTeacherId: f.IDS.otherTeacher,
      sameStudent: true, spans: [{ start: 0, end: 4, wordStart: 0, wordEnd: 1 }], excluded: true }],
  checks: [{ at: new Date(), by: f.IDS.teacher, requestId: 'r1', day: '2026-11-27', permitted: true }],
  providerAudit: { provider: 'copyleaks', externalRef: 'rbsentinel000000000000000000', units: 1, costUsd: 0.05, resultCount: 3 },
  job: { externalRef: `rbsentinel${String(submission).slice(-18)}` } });

async function pdfText(res) { return (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' '); }
const binary = req => req.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

beforeAll(async () => {
  await connectInMemoryMongo();
  await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  process.env.SIMILARITY_ENABLED = 'true';
  process.env.SIMILARITY_PROVIDER = 'stub';
  await SimilarityReport.create([report(fixture.IDS.registered, fixture), report(fixture.IDS.guest, fixture)]);
  await Submission.updateMany({ _id: { $in: [fixture.IDS.registered, fixture.IDS.guest] } },
    { $set: { similarityNotice: { version: NOTICE_VERSION, acceptedAt: new Date() } } });
});
afterAll(async () => {
  delete process.env.SIMILARITY_ENABLED; delete process.env.SIMILARITY_PROVIDER;
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
});

test('no student or guest API surface carries any part of a similarity report, a provider name or the notice', async () => {
  const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
  for (const [name, call] of Object.entries(list)) {
    const res = await call();
    const body = JSON.stringify(res.body);
    for (const sentinel of SENTINELS) expect({ name, sentinel, found: body.includes(sentinel) }).toEqual({ name, sentinel, found: false });
    expect({ name, provider: PROVIDERS.test(body) }).toEqual({ name, provider: false });
  }
});

test('the student and guest feedback PDFs carry none of it', async () => {
  const registered = await pdfText(await binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)));
  const guest = await pdfText(await binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken)));
  for (const text of [registered, guest]) {
    expect(text.length).toBeGreaterThan(50);
    for (const sentinel of SENTINELS) expect(text).not.toContain(sentinel);
    expect(text).not.toMatch(PROVIDERS);
  }
});

test('the essay\'s own student and its guest get 404 from every similarity route', async () => {
  const id = fixture.IDS.registered;
  expect((await request(app).get(`/api/similarity/submissions/${id}`).set('Authorization', `Bearer ${studentJwt}`)).status).toBe(404);
  expect((await request(app).get(`/api/similarity/submissions/${fixture.IDS.guest}`).set('X-Guest-Token', fixture.guestToken)).status).toBe(401);
  expect((await request(app).post(`/api/similarity/submissions/${id}/checks`).set('Authorization', `Bearer ${studentJwt}`).set('Idempotency-Key', 'k')).status).toBe(404);
});

describe('the notice', () => {
  test('GET /api/similarity/notice: the text and version while on, 404 while off; the text names no provider', async () => {
    const res = await request(app).get('/api/similarity/notice');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ version: NOTICE_VERSION, text: notice.ESSAY_SIMILARITY_NOTICE_TEXT });
    expect(res.body.data.text).toMatch(/external similarity-checking service/);
    expect(res.body.data.text).not.toMatch(PROVIDERS);
    process.env.SIMILARITY_ENABLED = 'false';
    try { expect((await request(app).get('/api/similarity/notice')).status).toBe(404); } finally { process.env.SIMILARITY_ENABLED = 'true'; }
  });
  test('stored only when the page showed this exact version and the feature is on', () => {
    const now = new Date('2026-11-27T10:00:00Z');
    expect(notice.noticeFields({ similarityNoticeVersion: NOTICE_VERSION }, { enabled: true, now })).toEqual({ similarityNotice: { version: NOTICE_VERSION, acceptedAt: now } });
    expect(notice.noticeFields({ similarityNoticeVersion: NOTICE_VERSION }, { enabled: false, now })).toEqual({});
    expect(notice.noticeFields({ similarityNoticeVersion: 'essay-similarity-2025-01' }, { enabled: true, now })).toEqual({});
    expect(notice.noticeFields({}, { enabled: true, now })).toEqual({});
    expect(notice.noticeFields(undefined, { enabled: true, now })).toEqual({});
  });
  test('the registered create, the resubmission/revision save and the guest create all store it (source check: the upload HTTP path is not exercised here)', () => {
    const sub = fs.readFileSync(path.join(__dirname, '../src/controllers/submission.controller.js'), 'utf8');
    const guest = fs.readFileSync(path.join(__dirname, '../src/controllers/guestSubmission.controller.js'), 'utf8');
    expect(sub).toMatch(/Object\.assign\(existing, similarityNoticeFields\(req\.body\)\);\s+let saved;\s+try \{ saved = await existing\.save\(\)/);
    expect(sub).toMatch(/const created = await Submission\.create\(\{\s+\.\.\.similarityNoticeFields\(req\.body\),/);
    expect(guest).toMatch(/created = await Submission\.create\(\{ \.\.\.similarityNoticeFields\(req\.body\), _id: id, submissionMode: 'guest'/);
  });
  test('the notice is never in a submission\'s JSON, even when selected', async () => {
    const doc = await Submission.findById(fixture.IDS.registered).select('+similarityNotice');
    expect(doc.similarityNotice.version).toBe(NOTICE_VERSION);
    expect(JSON.stringify(doc.toJSON())).not.toContain('similarityNotice');
  });
});
