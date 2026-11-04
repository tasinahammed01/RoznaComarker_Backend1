'use strict';
// Guard: a field added to a schema cannot reach a student by accident. Every string, Mixed, array and number path of Submission, SubmissionRevision,
// SubmissionFeedback and Feedback is filled with a sentinel, read from the schemas, and the real student surfaces are called as each kind of caller.
// A sentinel that arrives must be in ALLOWED below, each with its reason. Add a path there only after a student page is shown to read it, or with the
// open item it belongs to. Synthetic data only.
process.env.JWT_SECRET = 'student-schema-noleak-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/student-schema-noleak';
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
jest.mock('../src/services/ocrCorrections.service', () => ({ ...jest.requireActual('../src/services/ocrCorrections.service'), buildOcrCorrections: jest.fn(async () => ({ corrections: [] })) }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const LegacyFeedback = require('../src/models/Feedback');
const access = require('../src/services/guestAccess.service');
const emailService = require('../src/services/email.service');
const { captureCurrentRevision } = require('../src/services/submissionRevision.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi, manualValue } = require('./helpers/annotationApi');
const { sentinelFiller, sentinelsIn } = require('./helpers/schemaSentinels');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);

const ALLOWED = {
  // A student page reads these.
  'Submission.ocrPages[].ocrExifOrientation': 'only as sourceGeometry.orientation on ocr-corrections, which annotation-image-geometry.ts reads to place the highlights; the field itself is removed',
  'Submission.ocrPages[].pageImageUrl': 'transcript-page-views.util.ts: the page image (a raw stored value on the registered routes)',
  'Submission.combinedOcrText': 'my-submission-page.ts: the transcript fallback',
  'Submission.ocrText': 'my-submission-page.ts, handwritten-ocr-page.ts: the transcript fallback',
  'Submission.ocrData': 'my-submission-page.ts',
  'Submission.ocrError': 'my-submission-page.ts, handwritten-ocr-page.ts: the error shown',
  'Submission.evaluationSourceHash': 'adaptive-writing-studio.ts: practice source identity',
  'Submission.evaluationRubricSourceHash': 'adaptive-writing-studio.ts, canonical-result-state.util.ts',
  'Submission.evaluationPolicyHash': 'adaptive-writing-studio.ts, canonical-result-state.util.ts',
  'Submission.evaluationErrorCode': 'canonical-result-state.util.ts:162',
  'SubmissionFeedback.evaluationErrorCode': 'canonical-result-state.util.ts:162',
  'SubmissionFeedback.customRubricScores': 'my-submission-page.ts, evaluation-feedback-comments.util.ts',
  'SubmissionFeedback.detailedFeedback.extra': 'detailedFeedback is free-form and read by the feedback pages; only its marks and references are restated',
  'SubmissionFeedback.aiFeedback.perCategory[].category': 'the feedback pages',
  'SubmissionFeedback.aiFeedback.perCategory[].message': 'the feedback pages',
  'SubmissionFeedback.aiFeedback.perCategory[].score': 'the feedback pages; removed when marks are hidden',
  'SubmissionFeedback.aiFeedback.perCategory[].scoreOutOf5': 'the feedback pages; removed when marks are hidden',
  'SubmissionFeedback.aiFeedback.perCategory[].maxScore': 'the feedback pages; removed when marks are hidden',
  'SubmissionFeedback.rubricDesigner.title': 'my-submission-page.ts',
  'SubmissionFeedback.rubricDesigner.totalPoints': 'my-submission-page.ts',
  'SubmissionFeedback.rubricDesigner.criteria[].title': 'my-submission-page.ts',
  'SubmissionFeedback.rubricDesigner.criteria[].weight': 'my-submission-page.ts',
  'SubmissionFeedback.rubricDesigner.levels[].title': 'my-submission-page.ts',
  'SubmissionFeedback.rubricDesigner.levels[].maxPoints': 'my-submission-page.ts',
  // The caller's own: nothing of anyone else.
  'Submission.guest.displayName': 'a guest\'s own name',
  // Status counters of the response state (no provider or model in them).
  'Submission.semanticAttempt': 'status counter of the student\'s own analysis',
  'Submission.semanticMaxAttempts': 'status counter of the student\'s own analysis',
  'Submission.semanticErrorCode': 'safe failure code of the student\'s own analysis',
  'Submission.ocrErrorCode': 'safe failure code of the student\'s own analysis',
  // OPEN (Task 9 audit): no student page reads these, and they were not in this change's removal list. The student's own text or its source state, on the registered routes.
  'Submission.rawTranscriptText': 'open: unused, the student\'s own text',
  'Submission.rawOcrText': 'open: unused, the student\'s own text',
  'Submission.rawCombinedOcrText': 'open: unused, the student\'s own text',
  'Submission.sourceTranscriptExact': 'open: unused, the student\'s own text',
  'Submission.sourceTranscriptSha256': 'open: unused hash of the student\'s own text',
  'Submission.sourceFidelityInputIdentity': 'open: unused',
  'Submission.sourceFidelityMode': 'open: unused source state',
  'Submission.sourceFidelityStatus': 'open: unused source state',
  'Submission.sourceFidelityVersion': 'open: unused source state',
  // OPEN: the legacy feedback document (redacted when marks are hidden).
  'Feedback.aiFeedback': 'open: legacy feedback',
  'Feedback.textFeedback': 'open: legacy feedback',
  'Feedback.fileUrl': 'open: legacy feedback',
  'Feedback.annotations[].comment': 'open: legacy feedback',
  'Feedback.annotations[].page': 'open: legacy feedback',
  'Feedback.annotations[].x': 'open: legacy feedback',
  'Feedback.annotations[].y': 'open: legacy feedback',
  'Feedback.score': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.maxScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.contentScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.grammarScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.overallScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.structureScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.taskAchievementScore': 'open: legacy feedback; removed when marks are hidden',
  'Feedback.overriddenScores.vocabularyScore': 'open: legacy feedback; removed when marks are hidden',
};

// The fields a pipeline or a provider could add to a stored correction. None is in the schema (a correction is Mixed), so the filler cannot see them.
const CORRECTION_PROBES = { provider: 'LEAK_correction.provider', model: 'LEAK_correction.model', promptVersion: 'LEAK_correction.promptVersion',
  rawResponse: 'LEAK_correction.rawResponse', costUsd: 'LEAK_correction.costUsd', tokens: 'LEAK_correction.tokens' };
const NEW_PATH = 'guardProbeFieldAddedLater';

let f, studentJwt, teacherJwt, resendToken, portalSession, teacher, filler, responses;

/** Teacher decisions on the current draft; the hidden and archived corrections then carry text that only they hold. */
async function decide(id, seeded, tag) {
  const snapshot = (await teacher.snapshot(id)).body.data.corrections;
  const goes = snapshot.filter(c => c.quotedText === 'goes' && c.moderationStatus === 'visible').sort((a, b) => a.startChar - b.startChar);
  const ok = res => expect(res.status).toBe(200);
  ok(await teacher.act(id, { action: 'hide', id: snapshot.find(c => c.quotedText === 'a').id }));
  ok(await teacher.act(id, { action: 'archive', id: goes.at(-1).id }));
  ok(await teacher.act(id, { action: 'edit', id: snapshot.find(c => c.quotedText === 'realy').id, value: manualValue(seeded, 'realy', { symbol: 'SP', category: 'MECHANICS', message: `LEAK_TEACHER_ONLY_EDIT_${tag}`, suggestedText: 'really' }) }));
  ok(await teacher.act(id, { action: 'hide', id: snapshot.find(c => c.quotedText === 'realy').id }));
  const hidden = (await teacher.snapshot(id)).body.data.corrections.filter(c => c.moderationStatus !== 'visible').map(c => c.id);
  const doc = await Submission.collection.findOne({ _id: id });
  doc.writingCorrections = doc.writingCorrections.map(c => ({ ...c, ...CORRECTION_PROBES,
    ...(hidden.includes(String(c.id)) ? { message: `LEAK_TEACHER_ONLY_MESSAGE_${tag}`, suggestedText: `LEAK_TEACHER_ONLY_SUGGESTION_${tag}` } : {}) }));
  doc.teacherAnnotations.recent = [...(doc.teacherAnnotations.recent || []), { actor: `LEAK_TEACHER_ONLY_AUDIT_${tag}` }];
  await Submission.collection.replaceOne({ _id: id }, doc);
}

async function openPortal() {
  expect((await request(app).post('/api/recovery/request').send({ email: 'guest.student@example.com' })).status).toBe(202);
  for (let i = 0; i < 500 && !emailService.sendRecoveryPortalEmail.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const link = new URL(emailService.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link);
  const exchanged = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(exchanged.status).toBe(200);
  return exchanged.body.data.session;
}

function surfaces() {
  const r = String(f.IDS.registered), g = String(f.IDS.guest), a = String(f.IDS.assignment);
  const asStudent = url => () => request(app).get(url).set('Authorization', `Bearer ${studentJwt}`);
  const registered = { 'my submission': `/api/submissions/assignment/${a}/my`, 'my submissions': '/api/submissions/my', 'ocr-corrections': `/api/submissions/${r}/ocr-corrections`,
    feedback: `/api/feedback/${r}`, 'legacy feedback': `/api/feedback/submission/${r}`, 'draft comparison': `/api/submissions/${r}/draft-comparison` };
  const guest = { results: '', presentation: 'presentation', 'ocr-corrections': 'ocr-corrections', feedback: 'feedback', drafts: 'drafts' };
  const guestCallers = { 'guest link': ['X-Guest-Token', () => f.guestToken], 'resend link': ['X-Guest-Token', () => resendToken], 'portal session': ['X-Recovery-Session', () => portalSession] };
  const calls = Object.fromEntries(Object.entries(registered).map(([name, url]) => [`registered student: ${name}`, asStudent(url)]));
  for (const [caller, [header, value]] of Object.entries(guestCallers)) for (const [name, suffix] of Object.entries(guest)) {
    calls[`${caller}: ${name}`] = () => request(app).get(`/api/guest/submissions/${g}/${suffix}`).set(header, value());
  }
  return calls;
}

beforeAll(async () => {
  Submission.schema.add({ [NEW_PATH]: String });
  await connectInMemoryMongo(); await seedTestPlans();
  await Promise.all(['Submission', 'RecoveryToken', 'RecoverySession', 'RecoveryEmailWindow'].map(m => require(`../src/models/${m}`).init()));
  f = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, f.teacher);
  studentJwt = signTestJwt({ id: f.student._id, role: 'student', firebaseUid: f.student.firebaseUid });
  teacherJwt = signTestJwt({ id: f.teacher._id, role: 'teacher', firebaseUid: f.teacher.firebaseUid });
  await LegacyFeedback.collection.insertOne({ submission: f.IDS.registered, student: f.IDS.student, teacher: f.IDS.teacher, class: f.IDS.class, assignment: f.IDS.assignment, teacherComments: 'Legacy note.', createdAt: new Date(), updatedAt: new Date() });
  for (const [mode, seeded] of [['registered', f.registered], ['guest', f.guest]]) {
    await decide(f.IDS[mode], seeded, 'draft1');
    await captureCurrentRevision(await Submission.findById(f.IDS[mode]));
    await Submission.collection.updateOne({ _id: f.IDS[mode] }, { $set: { draftNumber: 2, fileContentIdentity: `schema-noleak-${mode}` } });
    await decide(f.IDS[mode], seeded, 'draft2');
  }
  const resend = access.issueToken();
  resendToken = resend.token;
  await Submission.updateOne({ _id: f.IDS.guest }, { $push: { 'guest.recoveryAccess': { hash: resend.accessHash, expiresAt: resend.expiresAt, createdAt: new Date() } } });
  portalSession = await openPortal();
  filler = sentinelFiller();
  for (const model of [SubmissionFeedback, LegacyFeedback, SubmissionRevision, Submission]) await filler.fillModel(model);
  responses = {};
  for (const [name, call] of Object.entries(surfaces())) responses[name] = await call();
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const arrived = () => {
  const out = new Map();
  for (const [name, res] of Object.entries(responses)) for (const sentinel of sentinelsIn(res.body, filler.numbers)) out.set(sentinel, [...(out.get(sentinel) || []), name]);
  return out;
};

/** What arrived and is not allowed. `ignore`: the path the test adds to the schema on purpose, checked in its own test below. */
const notAllowed = (seen, ignore = []) => Object.fromEntries([...seen.entries()].filter(([sentinel]) => !(sentinel in ALLOWED) && !ignore.includes(sentinel))
  .map(([sentinel, names]) => [sentinel, [...new Set(names)].sort()]));

describe('controls: the surfaces really answered, and the sentinels really are in the data', () => {
  test('every surface answered 200', () => {
    expect(Object.entries(responses).filter(([, res]) => res.status !== 200).map(([name, res]) => `${name}: ${res.status}`)).toEqual([]);
  });
  test('the teacher sees the hidden correction and the sentinels of the stored data', async () => {
    const text = JSON.stringify((await teacher.snapshot(f.IDS.registered)).body.data);
    expect(text).toContain('LEAK_TEACHER_ONLY_MESSAGE');
    const raw = await Submission.collection.findOne({ _id: f.IDS.registered });
    expect(raw.ocrPages[0].sourcePrimaryModel).toContain('LEAK_');
  });
  test('the student sees only the visible corrections, with their highlight data', () => {
    for (const name of ['registered student: ocr-corrections', 'guest link: ocr-corrections', 'resend link: ocr-corrections', 'portal session: ocr-corrections']) {
      const { corrections, ocr } = responses[name].body.data;
      expect({ name, count: corrections.length }).toEqual({ name, count: 2 });
      for (const correction of corrections) expect(correction).toEqual(expect.objectContaining({ id: expect.any(String), wordIds: expect.any(Array), renderTarget: expect.any(Object), message: expect.any(String) }));
      expect(ocr[0].words.length).toBeGreaterThan(0);
    }
  });
  test('the page data a student page reads is still there', () => {
    const page = responses['registered student: my submission'].body.data.ocrPages[0];
    expect(page).toEqual(expect.objectContaining({ fileId: expect.anything(), pageNumber: 1, text: expect.any(String), words: expect.any(Array) }));
    const file = responses['registered student: my submission'].body.data.files[0];
    expect(file).toEqual(expect.objectContaining({ _id: expect.anything(), url: expect.any(String), filename: expect.any(String) }));
  });
});

describe('what reaches a student', () => {
  test('no text only the teacher holds, on any surface', () => {
    const found = [...arrived().entries()].filter(([sentinel]) => sentinel.startsWith('TEACHER_ONLY'));
    expect(found).toEqual([]);
  });
  test('no sentinel outside ALLOWED, on any surface and for any caller', () => {
    expect(notAllowed(arrived(), [`Submission.${NEW_PATH}`])).toEqual({});
  });
  test('a provider field stored on a correction never reaches a student', () => {
    const found = [...arrived().keys()].filter(sentinel => sentinel.startsWith('correction.'));
    expect(found).toEqual([]);
  });
  test('ALLOWED does not rot: every entry still arrives, and has a reason', () => {
    const present = arrived();
    expect(Object.keys(ALLOWED).filter(sentinel => !present.has(sentinel))).toEqual([]);
    expect(Object.entries(ALLOWED).filter(([, reason]) => !reason)).toEqual([]);
  });
});

describe('the guard itself', () => {
  test('a path added to a schema later is filled and, not being allowed, is reported', async () => {
    expect((await Submission.collection.findOne({ _id: f.IDS.registered }))[NEW_PATH]).toContain(`LEAK_Submission.${NEW_PATH}`);
    // It arrives because a whole submission is returned minus a denylist; a real new field would therefore fail the check above until it is allowed or removed.
    expect(notAllowed(arrived())[`Submission.${NEW_PATH}`]).toEqual(expect.arrayContaining(['registered student: my submission']));
  });
});
