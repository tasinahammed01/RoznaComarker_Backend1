'use strict';
// Task 7A: after a teacher hides a correction, no student surface may expose the raw counts behind it, or anything that tells the student
// a teacher acted. Every access path: registered, guest own link, guest resend link, recovery-portal session; plus PDF, practice input and
// the legacy feedback route. The stored feedback is seeded as the canonical evaluation persists it. Synthetic text only.
process.env.JWT_SECRET = 'annotation-hygiene-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-hygiene';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
// The legacy route asks LanguageTool for its own academic evaluation; no network in tests.
jest.mock('../src/services/ocrCorrections.service', () => ({ ...jest.requireActual('../src/services/ocrCorrections.service'), buildOcrCorrections: jest.fn(async () => ({ corrections: [] })) }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-hygiene-pdf-'));
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const LegacyFeedback = require('../src/models/Feedback');
const Assignment = require('../src/models/assignment.model');
const emailService = require('../src/services/email.service');
const scoring = require('../src/services/rubricLanguageScoring.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { surfaces } = require('./helpers/studentSurfaces');
const { annotationApi } = require('./helpers/annotationApi');

jest.setTimeout(600000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture, teacher, studentJwt, resendToken, portal;
const RAW = { grammar: 3, mechanics: 2 }, VISIBLE = { grammar: 2, mechanics: 2 };
const binary = r => r.buffer(true).parse((res, cb) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); });

/** Feedback fields exactly as canonicalEvaluation.generate stores them when coverage is authoritative, with the raw counts inside. */
async function persistRealisticEvaluation(mode) {
  const submissionId = fixture.IDS[mode];
  const stored = await Submission.findById(submissionId).lean();
  const comment = (label, count, score, max) => `${count} ${label} issue${count === 1 ? '' : 's'} detected. Accuracy is generally controlled, but the recorded patterns should be revised.`;
  const rubricScores = {
    CONTENT: { score: 15, maxScore: 20, comment: 'Ideas are relevant.', issueCount: 0 },
    ORGANIZATION: { score: 15, maxScore: 20, comment: 'This category was assessed using 0 validated canonical organization corrections.', issueCount: 0 },
    GRAMMAR: { score: 20, maxScore: 25, comment: comment('grammar', RAW.grammar, 20, 25), issueCount: RAW.grammar },
    VOCABULARY: { score: 15, maxScore: 20, comment: 'Word choice is adequate.', issueCount: 0 },
    MECHANICS: { score: 8, maxScore: 10, comment: comment('mechanics', RAW.mechanics, 8, 10), issueCount: RAW.mechanics },
    PRESENTATION: { score: 4.5, maxScore: 5, comment: 'Automated score (1/1 pages readable).', issueCount: 0 },
  };
  const categoryAudit = category => scoring.scoringAudit({ corrections: stored.writingCorrections, category, maxScore: category === 'GRAMMAR' ? 25 : 10, wordCount: 24 });
  await SubmissionFeedback.collection.updateOne({ submissionId }, { $set: { rubricScores, overallScore: 77.5, grade: 'C',
    scoringAudit: { version: 'canonical-scoring-audit-v1', overallMethod: 'fixed_six_category_sum', correctionCountsAuthoritativeForScoring: true,
      categories: [categoryAudit('GRAMMAR'), categoryAudit('MECHANICS')] },
    evaluationDiagnostics: { assessmentModel: 'fixture', commentNormalizations: [{ category: 'GRAMMAR', commentNormalized: true, canonicalCount: RAW.grammar }] },
    aiFeedback: { perCategory: [{ category: 'GRAMMAR', message: `We found ${RAW.grammar} grammar errors to fix.`, score: 20, maxScore: 25 }], overallComments: '' },
    customRubricScores: { overallScore: null, criteria: [] } } });
  await Submission.collection.updateOne({ _id: submissionId }, { $set: {
    semanticMetrics: { rawCorrectionCount: RAW.grammar + RAW.mechanics, acceptedCorrectionCount: RAW.grammar + RAW.mechanics, duplicateCount: 0,
      mergeDiagnostics: { duplicateCount: 0, conflictCount: 0 }, validationDiagnostics: { rawCorrectionCount: 5 },
      coverage: { complete: true, coverageComplete: true, coveredCharacters: 100, totalCharacters: 100, totalChunks: 1, successfulChunks: 1, failedChunks: 0,
        categoryCoverageComplete: { CONTENT: true, ORGANIZATION: true, GRAMMAR: true, VOCABULARY: true, MECHANICS: true } } },
    evaluationDiagnostics: { commentNormalizations: [{ category: 'GRAMMAR', canonicalCount: RAW.grammar }] } } });
}

async function hideOneGrammar(mode) {
  const id = fixture.IDS[mode];
  const snap = (await teacher.snapshot(id)).body.data.corrections;
  const res = await teacher.act(id, { action: 'hide', id: snap.find(c => c.quotedText === 'a').id });
  if (res.status !== 200) throw new Error(`${mode}: ${res.status} ${res.body.code}`);
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

function allCalls() {
  const pick = (list, prefix, label) => Object.fromEntries(Object.entries(list).filter(([k]) => k.startsWith(prefix)).map(([k, v]) => [`${label} ${k}`, v]));
  const own = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
  const resend = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: resendToken });
  const guestId = String(fixture.IDS.guest);
  return { ...pick(own, 'registered', ''), ...pick(own, 'guest', 'own link'), ...pick(resend, 'guest', 'resend'),
    ...Object.fromEntries(['', 'presentation', 'ocr-corrections', 'feedback', 'drafts'].map(s => [`portal: ${s || 'results'}`,
      () => request(app).get(`/api/guest/submissions/${guestId}/${s}`).set('X-Recovery-Session', portal)])) };
}

/** Every path in a JSON value whose key is one of `keys`. */
function findKeys(value, keys, at = '$', out = []) {
  if (Array.isArray(value)) value.forEach((v, i) => findKeys(v, keys, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (keys.includes(k)) out.push(`${at}.${k}`);
    findKeys(v, keys, `${at}.${k}`, out);
  }
  return out;
}
/** Objects anywhere in a JSON value stored under a key named `name`. */
function under(value, name, out = []) {
  if (Array.isArray(value)) value.forEach(v => under(v, name, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) {
    if (k === name && v && typeof v === 'object') out.push(v);
    under(v, name, out);
  }
  return out;
}

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await Promise.all(['Submission', 'RecoveryToken', 'RecoverySession', 'RecoveryEmailWindow', 'AnnotationAudit'].map(m => require(`../src/models/${m}`).init()));
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  for (const mode of ['registered', 'guest']) { await persistRealisticEvaluation(mode); await hideOneGrammar(mode); }
  const access = require('../src/services/guestAccess.service');
  const resend = access.issueToken();
  resendToken = resend.token;
  await Submission.updateOne({ _id: fixture.IDS.guest }, { $push: { 'guest.recoveryAccess': { hash: resend.accessHash, expiresAt: resend.expiresAt, createdAt: new Date() } } });
  portal = await portalSession();
});
afterAll(async () => {
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true });
  fs.rmSync(process.env.PDF_FEEDBACK_CACHE_DIR, { recursive: true, force: true });
});

describe('raw counts never reach a student after a hide', () => {
  test('rubric issue counts follow the visible set, scores stay', async () => {
    let checked = 0;
    for (const [label, call] of Object.entries(allCalls())) {
      const res = await call();
      expect({ label, status: res.status }).toEqual({ label, status: 200 });
      for (const rubric of [...under(res.body, 'rubricScores'), ...under(res.body, 'categoryScores')]) {
        if (!rubric.GRAMMAR) continue;
        checked += 1;
        expect({ label, issueCount: rubric.GRAMMAR.issueCount, mechanics: rubric.MECHANICS.issueCount, score: rubric.GRAMMAR.score })
          .toEqual({ label, issueCount: VISIBLE.grammar, mechanics: VISIBLE.mechanics, score: 20 });
      }
    }
    expect(checked).toBeGreaterThanOrEqual(11);
  });

  test('text embedding a count is restated: no "3 grammar" anywhere, the visible count instead', async () => {
    let restated = 0;
    for (const [label, call] of Object.entries(allCalls())) {
      const text = JSON.stringify((await call()).body);
      expect({ label, raw: /\b3 grammar (issues?|errors?)\b/.test(text) }).toEqual({ label, raw: false });
      if (text.includes('2 grammar issues detected')) restated += 1;
    }
    expect(restated).toBeGreaterThanOrEqual(11);
  });

  test('audit and diagnostic counts are gone; the fields the page reads remain', async () => {
    const leaking = ['totalIssueCount', 'countedIssueCount', 'ignoredIssueCount', 'ignoredCorrectionIds', 'canonicalCount', 'rawCorrectionCount',
      'acceptedCorrectionCount', 'evaluationDiagnostics', 'mergeDiagnostics', 'validationDiagnostics'];
    let audits = 0;
    for (const [label, call] of Object.entries(allCalls())) {
      const { body } = await call();
      expect({ label, found: findKeys(body, leaking) }).toEqual({ label, found: [] });
      for (const audit of under(body, 'scoringAudit')) { audits += 1; expect({ label, method: audit.overallMethod }).toEqual({ label, method: 'fixed_six_category_sum' }); }
    }
    expect(audits).toBeGreaterThanOrEqual(4);
  });

  test('the ocr-corrections evaluation block restates its areas too', async () => {
    const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
    for (const name of ['registered: ocr-corrections', 'guest: ocr-corrections']) {
      const evaluation = (await list[name]()).body.data.evaluation;
      const grammar = evaluation.areasForImprovement.find(a => a.category === 'GRAMMAR');
      expect({ name, count: grammar.issueCount, text: grammar.explanation.startsWith('2 distinct issues') }).toEqual({ name, count: 2, text: true });
    }
  });

  test('hidden marks: no scores, and still no raw count', async () => {
    await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $set: { showMarksToStudent: false } });
    try {
      const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
      for (const name of ['registered: feedback', 'registered: ocr-corrections', 'guest: feedback', 'guest: ocr-corrections', 'guest: results']) {
        const { body } = await list[name]();
        const text = JSON.stringify(body);
        expect({ name, raw: /\b3 grammar (issues?|errors?)\b/.test(text), audit: findKeys(body, ['totalIssueCount', 'canonicalCount']) }).toEqual({ name, raw: false, audit: [] });
        for (const rubric of under(body, 'rubricScores')) if (rubric.GRAMMAR) expect({ name, issueCount: rubric.GRAMMAR.issueCount, score: rubric.GRAMMAR.score }).toEqual({ name, issueCount: 2, score: undefined });
      }
    } finally { await Assignment.updateOne({ _id: fixture.IDS.assignment }, { $unset: { showMarksToStudent: 1 } }); }
  });

  test('PDF: rows and comments show the visible count', async () => {
    const text = async res => { expect(res.status).toBe(200); return (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' '); };
    const registered = await text(await binary(request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)));
    const guest = await text(await binary(request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/pdf`).set('X-Guest-Token', fixture.guestToken)));
    for (const [label, pdf] of [['registered', registered], ['guest', guest]]) {
      expect({ label, raw: /\b3 grammar (issues?|errors?)\b/i.test(pdf) }).toEqual({ label, raw: false });
    }
  });

  test('practice generation input does not carry the raw count', async () => {
    const practice = require('../src/services/adaptivePractice.service');
    await SubmissionFeedback.updateOne({ submissionId: fixture.IDS.guest }, { $set: { 'rubricScores.GRAMMAR.score': 5 } });
    try {
      const doc = await Submission.findById(fixture.IDS.guest).lean();
      const source = await practice.loadOwnedSource(fixture.IDS.guest, require('../src/services/submissionAccessContext.service').guestContext(doc));
      expect(source.weakSkills.map(s => s.id)).toContain('GRAMMAR');   // positive control: grammar goes into the prompt
      const messages = JSON.stringify(practice.buildMessages(source, []));
      expect(/\b3 grammar (issues?|errors?)\b/.test(messages)).toBe(false);
    } finally { await SubmissionFeedback.updateOne({ submissionId: fixture.IDS.guest }, { $set: { 'rubricScores.GRAMMAR.score': 20 } }); }
  });

  test('the legacy feedback route shows the visible corrections only', async () => {
    await LegacyFeedback.collection.insertOne({ submission: fixture.IDS.registered, student: fixture.IDS.student, teacher: fixture.IDS.teacher, class: fixture.IDS.class,
      assignment: fixture.IDS.assignment, teacherComments: 'Legacy note.', createdAt: new Date(), updatedAt: new Date() });
    const res = await request(app).get(`/api/feedback/submission/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`);
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text.includes('before a vowel sound')).toBe(false);   // the hidden correction's message
    expect(res.body.data.submission.correctionStatistics.grammar).toBe(VISIBLE.grammar);
  });
});

describe('fields that are not for students', () => {
  const TEACHER_ONLY = ['annotationGradeReviewRequired', 'annotationRevision', 'teacherReviewedAt', 'teacherReviewedBy', 'teacherId', 'teacherCommentsUpdatedBy', 'teacherAnnotations'];

  test('removed from every student surface, with and without annotations', async () => {
    await request(app).patch(`/api/feedback/${fixture.IDS.registered}/reviewed`).set('Authorization', `Bearer ${signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid })}`);
    for (const [label, call] of Object.entries(allCalls())) {
      const { body } = await call();
      expect({ label, found: findKeys(body, TEACHER_ONLY) }).toEqual({ label, found: [] });
    }
  });

  test('the teacher id is not in the feedback or correction responses', async () => {
    const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
    for (const name of ['registered: feedback', 'registered: ocr-corrections', 'guest: feedback', 'guest: ocr-corrections', 'guest: results', 'guest: presentation', 'guest: drafts', 'registered: draft comparison']) {
      const text = JSON.stringify((await list[name]()).body);
      expect({ name, leaked: text.includes(String(fixture.IDS.teacher)) }).toEqual({ name, leaked: false });
    }
  });

  test('the teacher keeps what the teacher pages read', async () => {
    const teacherJwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
    const res = await request(app).get(`/api/feedback/${fixture.IDS.registered}`).set('Authorization', `Bearer ${teacherJwt}`);
    expect(res.status).toBe(200);
    expect(res.body.data.teacherReviewedAt).toBeTruthy();
    expect(res.body.data.teacherReviewedBy).toBe(String(fixture.IDS.teacher));
  });

  test('the teacher preview still equals the student payload', async () => {
    const list = surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken });
    for (const mode of ['registered', 'guest']) {
      const preview = (await teacher.preview(fixture.IDS[mode])).body.data;
      expect(preview.ocrCorrections).toEqual((await list[`${mode}: ocr-corrections`]()).body.data);
      expect(preview.feedback).toEqual((await list[`${mode}: feedback`]()).body.data);
    }
  });
});

describe('restating stored text', () => {
  const { studentPayload } = require('../src/services/studentCorrectionView.service');
  const view = counts => ({ changed: true, corrections: [], statistics: counts, editedById: new Map() });
  const rubric = (comment, count) => studentPayload({ rubricScores: { GRAMMAR: { score: 20, maxScore: 25, comment } } }, view({ grammar: count })).rubricScores.GRAMMAR;

  test('the language comment is rebuilt for the visible count, singular and zero included', () => {
    const stored = '3 grammar issues detected. Accuracy is generally controlled, but the recorded patterns should be revised.';
    expect(rubric(stored, 1)).toEqual({ score: 20, maxScore: 25, issueCount: 1, comment: scoring.languageComment('grammar', 1, 20, 25) });
    expect(rubric(stored, 1).comment.startsWith('1 grammar issue detected.')).toBe(true);
    expect(rubric(stored, 0).comment.startsWith('0 grammar issues detected.')).toBe(true);
  });
  test('a count inside free text is replaced; text without one is left exactly as stored', () => {
    expect(rubric('This category was assessed using 3 validated canonical grammar corrections.', 1).comment).toBe('This category was assessed using 1 validated canonical grammar correction.');
    expect(rubric('We found 3 grammar errors.', 2).comment).toBe('We found 2 grammar errors.');
    expect(rubric('Verb forms are mostly under control.', 2).comment).toBe('Verb forms are mostly under control.');
    expect(rubric('Covers 3 main ideas.', 2).comment).toBe('Covers 3 main ideas.');
  });
  test('a custom rubric comment has no category to count: the number goes, the claim stays', () => {
    const out = studentPayload({ customRubricScores: { overallScore: 80, criteria: [{ criterionId: 'c1', comment: 'Has 4 grammar errors.', weightedPoints: 8 }] } }, view({ grammar: 1 }));
    expect(out.customRubricScores).toEqual({ overallScore: 80, criteria: [{ criterionId: 'c1', comment: 'Has grammar errors.', weightedPoints: 8 }] });
  });
  test('nothing changed: the payload is returned as it is', () => {
    const payload = { rubricScores: { GRAMMAR: { comment: '3 grammar issues detected.', issueCount: 3 } }, scoringAudit: { categories: [] }, evaluationDiagnostics: {} };
    expect(studentPayload(payload, { changed: false })).toBe(payload);
  });
});

describe('scores never change', () => {
  test('reading every surface leaves the stored feedback untouched', async () => {
    const before = await SubmissionFeedback.collection.find({}).sort({ _id: 1 }).toArray();
    for (const call of Object.values(allCalls())) await call();
    expect(JSON.stringify(await SubmissionFeedback.collection.find({}).sort({ _id: 1 }).toArray())).toBe(JSON.stringify(before));
  });
});
