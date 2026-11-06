'use strict';
// Task 6A NO-LEAK MATRIX. One hidden, one archived, one orphaned and one edited correction (after an OCR re-run that moves every offset),
// checked on every student surface - registered, guest own link, guest resend link, recovery-portal session - in bodies, headers and
// logs, plus counts, PDF text (warm cache included), draft comparison, practice input, and the teacher preview. Synthetic text only.
process.env.JWT_SECRET = 'annotation-noleak-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-noleak';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';   // real PDF rendering (headless browser) for the text check
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-noleak-pdf-'));
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const logger = require('../src/utils/logger');
const emailService = require('../src/services/email.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, rerunOcr, AI_SPECS, WORDS } = require('./helpers/annotationFixture');
const { seedInternalFields } = require('./helpers/studentResources');
const { surfaces } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(600000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
// Text that exists only in suppressed corrections (hidden, archived, orphaned edit) or in AI text a teacher edit replaced.
const SECRETS = ['before a vowel sound', 'Check the verb', 'Teacher note on realy', 'Missing apostrophe'];
const EDITED = 'Teacher wording: add the apostrophe.';
let fixture, teacher, hiddenIds = [], pdfBefore = {};
const logs = [];

async function decorate(mode) {
  const id = fixture.IDS[mode], seeded = mode === 'guest' ? fixture.guest : fixture.registered;
  const snap = (await teacher.snapshot(id)).body.data.corrections;
  const goes = snap.filter(c => c.quotedText === 'goes').sort((a, b) => a.startChar - b.startChar);
  const ok = res => { if (res.status !== 200) throw new Error(`${mode}: ${res.status} ${res.body.code}`); };
  ok(await teacher.act(id, { action: 'hide', id: snap.find(c => c.quotedText === 'a').id }));                       // hidden
  ok(await teacher.act(id, { action: 'archive', id: goes[1].id }));                                                  // archived
  ok(await teacher.act(id, { action: 'edit', id: snap.find(c => c.quotedText === 'dont').id,                          // edited
    value: manualValue(seeded, 'dont', { symbol: 'SP', category: 'MECHANICS', message: EDITED, suggestedText: "don't" }) }));
  ok(await teacher.act(id, { action: 'edit', id: snap.find(c => c.quotedText === 'realy').id,                        // will be orphaned
    value: manualValue(seeded, 'realy', { symbol: 'SP', category: 'MECHANICS', message: 'Teacher note on realy.', suggestedText: 'really' }) }));
  hiddenIds.push(snap.find(c => c.quotedText === 'a').id, goes[1].id);
  // OCR re-run: one word added in front (every offset moves); "realy" is now read as "really" (the edited text is gone).
  await rerunOcr({ submissionId: id, words: ['Today', ...WORDS.map(w => w === 'realy' ? 'really' : w)],
    specs: AI_SPECS.filter(s => s[0] !== 22).map(([w, ...rest]) => [w + 1, ...rest]) });
  const after = (await teacher.snapshot(id)).body.data;
  hiddenIds.push(...after.corrections.filter(c => c.moderationStatus !== 'visible').map(c => c.id));
  return after;
}

async function portalSession() {
  const before = emailService.sendRecoveryPortalEmail.mock.calls.length;
  expect((await request(app).post('/api/recovery/request').send({ email: 'guest.student@example.com' })).status).toBe(202);
  for (let i = 0; i < 300 && emailService.sendRecoveryPortalEmail.mock.calls.length === before; i++) await new Promise(r => setTimeout(r, 10));
  const link = new URL(emailService.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link);
  const res = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(res.status).toBe(200);
  return res.body.data.session;
}

async function pdfText(res) {
  expect(res.status).toBe(200);
  return (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' ');
}
const binary = r => r.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await Promise.all(['Submission', 'RecoveryToken', 'RecoverySession', 'RecoveryEmailWindow', 'AnnotationAudit'].map(m => require(`../src/models/${m}`).init()));
  fixture = await seedAnnotationFixture({ uploadRoot });
  // What a real pipeline run leaves on a submission: providers, models, prompts, leases, job ids. Without it the checks below would pass on nothing.
  await seedInternalFields(fixture);
  teacher = annotationApi(app, fixture.teacher);
  // Warm the PDF cache with the unannotated reports: the annotated reports must not be served from it.
  const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  pdfBefore.registered = await pdfText(await binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)));
  pdfBefore.guest = await pdfText(await binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken)));
  await decorate('registered'); await decorate('guest');
  for (const level of ['debug', 'info', 'warn', 'error', 'metric']) if (typeof logger[level] === 'function') {
    const original = logger[level];
    jest.spyOn(logger, level).mockImplementation((...args) => { logs.push(JSON.stringify(args)); return original.apply(logger, args); });
  }
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.rmSync(process.env.PDF_FEEDBACK_CACHE_DIR, { recursive: true, force: true });
});

const NOT_FOR_STUDENTS = ['annotationGradeReviewRequired', 'annotationRevision', 'teacherReviewedAt', 'teacherReviewedBy', 'teacherId', 'teacherCommentsUpdatedBy', 'teacherAnnotations',
  'teacher', 'evaluationProvider', 'evaluationModel', 'evaluationAttempts', 'evaluationPolicy', 'analysisInputHash',
  'semanticProvider', 'semanticModel', 'semanticPromptVersion', 'correctionGenerationConfig', 'analysisLeaseOwner', 'evaluationJobId', 'assessmentRunId', 'ocrEvidenceHash', 'ocrRunId',
  'correctionFingerprint', 'rasterHash', 'createdBy', 'ownerId',
  'scoringReviewRequired', 'scoringReview', 'scoreReview', 'totalIssueCount', 'countedIssueCount', 'ignoredCorrectionIds', 'canonicalCount', 'rawCorrectionCount', 'acceptedCorrectionCount', 'evaluationDiagnostics'];
function keysIn(value, keys, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => keysIn(v, keys, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) { if (keys.includes(k)) out.push(`${at}.${k}`); keysIn(v, keys, `${at}.${k}`, out); }
  return out;
}
function assertClean(label, text) {
  for (const identity of [String(fixture.IDS.teacher), 'teacher@example.com']) expect({ label, identity, leaked: text.includes(identity) }).toEqual({ label, identity, leaked: false });
  for (const secret of SECRETS) expect({ label, secret, leaked: text.includes(secret) }).toEqual({ label, secret, leaked: false });
  for (const id of hiddenIds) expect({ label, id, leaked: text.includes(id) }).toEqual({ label, id, leaked: false });
}

describe('no-leak matrix', () => {
  test('positive control: the pipeline internals are in the stored data and in a teacher\'s response, so their absence below means something', async () => {
    const stored = await Submission.findById(fixture.IDS.registered).lean();
    expect(stored).toEqual(expect.objectContaining({ semanticProvider: 'fixture-provider', analysisLeaseOwner: 'worker-fixture', assessmentRunId: 'run-fixture' }));
    const teacherJwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
    const res = await request(app).get(`/api/submissions/${fixture.IDS.registered}/ocr-corrections`).set('Authorization', `Bearer ${teacherJwt}`);
    expect(res.body.data.assessmentRunId).toBe('run-fixture');
  });

  test('the unannotated PDFs (positive control) did contain the texts now suppressed', () => {
    expect(pdfBefore.registered).toContain('before a vowel sound');
    expect(pdfBefore.guest).toContain('Check the verb');
  });

  test('every JSON surface for every access path: bodies, headers, counts', async () => {
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const access = require('../src/services/guestAccess.service');
    const resend = access.issueToken();
    await Submission.updateOne({ _id: fixture.IDS.guest }, { $push: { 'guest.recoveryAccess': { hash: resend.accessHash, expiresAt: resend.expiresAt, createdAt: new Date() } } });
    const session = await portalSession();
    const paths = {
      registered: surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken }),
      'guest own link': surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken }),
      'guest resend link': surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: resend.token }),
    };
    const guestId = String(fixture.IDS.guest);
    const portal = Object.fromEntries(['', 'presentation', 'ocr-corrections', 'feedback', 'drafts']
      .map(s => [`portal: ${s || 'results'}`, () => request(app).get(`/api/guest/submissions/${guestId}/${s}`).set('X-Recovery-Session', session)]));
    const calls = { ...Object.fromEntries(Object.entries(paths.registered).filter(([k]) => k.startsWith('registered'))),
      ...Object.fromEntries(Object.entries(paths['guest own link']).filter(([k]) => k.startsWith('guest')).map(([k, v]) => [`own link ${k}`, v])),
      ...Object.fromEntries(Object.entries(paths['guest resend link']).filter(([k]) => k.startsWith('guest')).map(([k, v]) => [`resend ${k}`, v])),
      ...portal };
    let counted = 0;
    for (const [label, call] of Object.entries(calls)) {
      const res = await call();
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      assertClean(`${label} body`, JSON.stringify(res.body));
      assertClean(`${label} headers`, JSON.stringify(res.headers));
      // Task 7A: nothing a teacher did, and no count of the raw list, in any student body.
      expect({ label, found: keysIn(res.body, NOT_FOR_STUDENTS) }).toEqual({ label, found: [] });
      const data = res.body.data || {};
      for (const stats of [data.statistics, data.correctionStatistics, data.correctionStats, data.submission?.correctionStatistics, data[0]?.correctionStatistics]) {
        if (!stats) continue;
        counted += 1;
        expect({ label, grammar: stats.grammar, mechanics: stats.mechanics, total: stats.total }).toEqual({ label, grammar: 1, mechanics: 1, total: 2 });
      }
      const list = data.corrections || data.writingCorrections || data[0]?.writingCorrections;
      if (list) {
        expect({ label, texts: list.map(c => c.quotedText).sort() }).toEqual({ label, texts: ['dont', 'goes'] });
        expect({ label, edited: list.find(c => c.quotedText === 'dont').message }).toEqual({ label, edited: EDITED });
      }
    }
    expect(counted).toBeGreaterThanOrEqual(20);
    assertClean('logs', logs.join('\n'));
  });

  test('PDF text (registered and guest), after a warm cache', async () => {
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const registered = await pdfText(await binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)));
    const guest = await pdfText(await binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken)));
    for (const [label, text] of [['registered pdf', registered], ['guest pdf', guest]]) {
      assertClean(label, text);
      expect({ label, editedShown: text.includes('Teacher wording') }).toEqual({ label, editedShown: true });
    }
  });

  test('draft comparison and progress count only what the student sees', async () => {
    const doc = await Submission.findById(fixture.IDS.registered);
    await require('../src/services/submissionRevision.service').captureCurrentRevision(doc);
    await Submission.updateOne({ _id: doc._id }, { $set: { draftNumber: 2, fileContentIdentity: 'noleak-draft-2' } });
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const comparison = await request(app).get(`/api/submissions/${fixture.IDS.registered}/draft-comparison`).set('Authorization', `Bearer ${studentJwt}`);
    expect(comparison.body.data.issues.previousCount).toBe(2);
    assertClean('draft comparison', JSON.stringify(comparison.body));
    const progress = await request(app).get(`/api/classes/${fixture.IDS.class}/students/${fixture.student._id}/progress`).set('Authorization', `Bearer ${studentJwt}`);
    assertClean('progress', JSON.stringify(progress.body));
    await Submission.updateOne({ _id: doc._id }, { $set: { draftNumber: 1, fileContentIdentity: 'fixture-registered' } });
  });

  test('practice generation input carries no correction content', async () => {
    const practice = require('../src/services/adaptivePractice.service');
    const doc = await Submission.findById(fixture.IDS.guest).lean();
    // The re-evaluation that follows an OCR re-run (otherwise practice is refused as STALE_EVALUATION).
    await require('../src/models/SubmissionFeedback').updateOne({ submissionId: doc._id }, { $set: { evaluationSourceHash: doc.correctionSourceHash } });
    const source = await practice.loadOwnedSource(fixture.IDS.guest, require('../src/services/submissionAccessContext.service').guestContext(doc));
    const messages = JSON.stringify(practice.buildMessages(source, []));
    expect(messages).toContain('Today I goes');   // positive control: the transcript is in the input
    assertClean('practice messages', messages);
  });

  test('the teacher preview equals the student payload and leaks nothing', async () => {
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    for (const mode of ['registered', 'guest']) {
      const preview = (await teacher.preview(fixture.IDS[mode])).body.data;
      const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
      expect(preview.ocrCorrections).toEqual((await list[`${mode}: ocr-corrections`]()).body.data);
      expect(preview.feedback).toEqual((await list[`${mode}: feedback`]()).body.data);
      assertClean(`${mode} preview`, JSON.stringify(preview));
    }
  });

  test('the teacher still sees everything: hidden, archived and the orphan', async () => {
    const snap = (await teacher.snapshot(fixture.IDS.registered)).body.data;
    expect(snap.corrections.map(c => c.moderationStatus).sort()).toEqual(['archived', 'hidden', 'visible', 'visible']);
    expect(snap.orphans.map(o => [o.reason, o.value.message])).toEqual([['TEXT_NOT_FOUND', 'Teacher note on realy.']]);
  });
});
