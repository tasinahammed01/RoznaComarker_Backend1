'use strict';
// Student-facing responses never carry a teacher's email or id, only a display name. The scan reads every GET route from the route files, so a
// new route is covered without being listed here. Teacher-facing endpoints are unchanged. Synthetic data only.
process.env.JWT_SECRET = 'student-identity-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/student-identity';
process.env.SENSITIVE_RATE_LIMIT_MAX = '100000';
// The scan makes thousands of calls as one student: no limiter may answer for the route.
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX']) process.env[name] = '1000000';
// The legacy route asks LanguageTool for its own academic evaluation; no network in tests.
jest.mock('../src/services/ocrCorrections.service', () => ({ ...jest.requireActual('../src/services/ocrCorrections.service'), buildOcrCorrections: jest.fn(async () => ({ corrections: [] })) }));
jest.mock('../src/services/notificationRealtime.service', () => { const actual = jest.requireActual('../src/services/notificationRealtime.service'); return { ...actual, publishToUser: jest.fn(actual.publishToUser) }; });
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const LegacyFeedback = require('../src/models/Feedback');
const identity = require('../src/services/studentTeacherIdentity.service');
const { seedStudentResources } = require('./helpers/studentResources');
const { scan, keysOf, routeInventory } = require('./helpers/studentRouteScan');
const notifications = require('../src/services/notification.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const src = path.join(__dirname, '..', 'src');
const TEACHER_EMAIL = 'teacher@example.com';
let f, r, studentJwt, teacherJwt, scanned;
const asStudent = url => request(app).get(url).set('Authorization', `Bearer ${studentJwt}`);

/** Paths in a JSON value whose string value contains the teacher's id or email. */
function hits(value, at = '$', out = []) {
  if (typeof value === 'string') { if (value.includes(String(f.IDS.teacher)) || value.includes(TEACHER_EMAIL)) out.push(at); }
  else if (Array.isArray(value)) value.forEach((v, i) => hits(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) hits(v, `${at}.${k}`, out);
  return out;
}

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  f = await seedAnnotationFixture({ uploadRoot });
  r = await seedStudentResources(f);
  studentJwt = signTestJwt({ id: f.student._id, role: 'student', firebaseUid: f.student.firebaseUid });
  teacherJwt = signTestJwt({ id: f.teacher._id, role: 'teacher', firebaseUid: f.teacher.firebaseUid });
  await LegacyFeedback.collection.insertOne({ submission: f.IDS.registered, student: f.IDS.student, teacher: f.IDS.teacher, class: f.IDS.class,
    assignment: f.IDS.assignment, teacherComments: 'Legacy note.', overriddenBy: f.IDS.teacher, createdAt: new Date(), updatedAt: new Date() });
  await notifications.createNotification({ recipientId: f.student._id, actorId: f.teacher._id, type: 'assignment_uploaded', title: 'New assignment', description: 'Fixture' });
  const emailService = require('../src/services/email.service');
  expect((await request(app).post('/api/recovery/request').send({ email: 'guest.student@example.com' })).status).toBe(202);
  for (let i = 0; i < 300 && !emailService.sendRecoveryPortalEmail.mock.calls.length; i++) await new Promise(resolve => setTimeout(resolve, 10));
  const link = new URL(emailService.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link);
  const exchanged = await request(app).post('/api/recovery/exchange').send({ token: link.hash.slice(1) });
  expect(exchanged.status).toBe(200);
  scanned = await scan({ app, f, r, studentJwt, portalSession: exchanged.body.data.session });
  // SCAN_REPORT=<file> writes what the scan saw (routes, and for each internal-looking key the routes that carry it), for the report of a change.
  if (process.env.SCAN_REPORT) {
    const keys = {};
    for (const { who, route, body } of scanned.responses) for (const { key } of keysOf(body)) if (INTERNAL.test(key)) (keys[key] ||= new Set()).add(`${who} ${route}`);
    // The top-level keys of each response, to review what a student receives from each route (not only the keys that look internal).
    const shapes = {};
    for (const { who, route, body } of scanned.responses) {
      const data = body.data && !Array.isArray(body.data) ? body.data : Array.isArray(body.data) ? body.data[0] : body;
      if (data && typeof data === 'object') shapes[`${who} ${route}`] = Object.keys(data).sort();
    }
    fs.writeFileSync(process.env.SCAN_REPORT, JSON.stringify({ inventory: scanned.inventory, shapes, keys: Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, [...v].sort()])) }, null, 1));
  }
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

describe('every GET route a student or guest can reach, against realistic fixtures', () => {
  test('no teacher id or email in any response (worksheets, flashcards and practice included)', () => {
    const found = [];
    for (const { who, route, body } of scanned.responses) for (const at of hits(body)) found.push(`${who} GET ${route} ${at.replace(/\[\d+\]/g, '[]')}`);
    expect([...new Set(found)]).toEqual([]);
  });

  test('positive control: the routes that carry owner ids did answer', () => {
    const answered = new Set(scanned.responses.map(item => `${item.who} ${item.route}`));
    for (const route of ['/api/classes/:classId/summary', '/api/memberships/mine', '/api/assignments/my', '/api/assignments/:id', '/api/assignments/qr/:qrToken',
      '/api/submissions/my', '/api/submissions/assignment/:assignmentId/my', '/api/feedback/submission/:submissionId', '/api/notifications',
      '/api/worksheets/:id', '/api/worksheets/:id/my-submission', '/api/worksheets/:id/draft', '/api/flashcards/:id', '/api/flashcards/:setId/progress',
      '/api/adaptive-practice/submissions/:submissionId']) expect(answered).toContain(`student ${route}`);
    expect(answered).toContain('public /api/shared/flashcards/:shareToken');
    // The fixtures really do hold the teacher's id where the schema does.
    expect(String(r.worksheet.createdBy)).toBe(String(f.IDS.teacher));
    expect(String(r.flashcards.ownerId)).toBe(String(f.IDS.teacher));
  });

  test('every reachable route is called with a 200 at least once, or says why it is not', () => {
    const missing = scanned.inventory.filter(item => item.access !== 'teacher/admin' && !item.exempt && !item.covered && !NOT_COVERED[item.route]).map(item => `${item.access} ${item.route}`);
    expect(missing).toEqual([]);
    for (const [route, reason] of Object.entries(NOT_COVERED)) {
      expect({ route, listed: scanned.inventory.some(item => item.route === route), reason: Boolean(reason) }).toEqual({ route, listed: true, reason: true });
      expect({ route, nowCovered: scanned.inventory.find(item => item.route === route).covered }).toEqual({ route, nowCovered: false });
    }
  });

  test('no provider, model, prompt, policy, hash, token, cost, credit or config key in a student response, except those a student page reads', () => {
    const found = {};
    for (const { who, route, body } of scanned.responses) if (!(route in PUBLIC_ROUTES)) for (const { key } of keysOf(body)) {
      if (INTERNAL.test(key) && !(key in STUDENT_READS)) (found[key] ||= new Set()).add(`${who} ${route}`);
    }
    expect(Object.fromEntries(Object.entries(found).map(([key, routes]) => [key, [...routes].sort()]))).toEqual({});
  });

  test('the allowed internal-looking keys are all still read by a student page (the list does not rot)', () => {
    const present = new Set(scanned.responses.filter(({ route }) => !(route in PUBLIC_ROUTES)).flatMap(({ body }) => keysOf(body).map(item => item.key)));
    const unused = Object.keys(STUDENT_READS).filter(key => !present.has(key));
    expect(unused).toEqual([]);
  });

  test('no secret of the teacher (source content, model answers, answer key) in a worksheet response', () => {
    const text = JSON.stringify(scanned.responses.filter(item => item.route.startsWith('/api/worksheets')).map(item => item.body));
    for (const secret of ['TEACHER-SOURCE-CONTENT', 'MODEL-ANSWER-KEY']) expect({ secret, leaked: text.includes(secret) }).toEqual({ secret, leaked: false });
  });

  test('every owner or creator id is replaced, not only the teacher: a flashcard or worksheet response has no createdBy, ownerId or teacher', () => {
    const offenders = scanned.responses.filter(item => /^\/api\/(worksheets|flashcards|shared)/.test(item.route))
      .flatMap(({ route, body }) => keysOf(body).filter(({ key }) => /^(createdBy|ownerId|teacher|teacherId|owner)$/.test(key)).map(({ at }) => `${route} ${at}`));
    expect([...new Set(offenders)]).toEqual([]);
  });
});

// Reachable routes the scan cannot call with a 200, with the reason. A route that starts answering must be removed from this list.
const NOT_COVERED = {
  '/api/demo/student': 'mounted only when NODE_ENV is development (src/app.js)',
  '/api/demo/shared': 'mounted only when NODE_ENV is development (src/app.js)',
  '/api/submissions/:submissionId/teacher-annotations': 'teacher only: the controller answers 404 to everyone else (annotationApi.test.js)',
  '/api/submissions/:submissionId/teacher-annotations/history': 'teacher only: the controller answers 404 to everyone else (annotationApi.test.js)',
  '/api/submissions/:submissionId/teacher-annotations/preview': 'teacher only: the controller answers 404 to everyone else (annotationApi.test.js)',
  '/api/submissions/:submissionId/teacher-evaluation': 'teacher only (Phase B2): the controller answers 404 to everyone else (teacherEvaluation.test.js)',
  '/api/assignments/:id/writing-model': 'teacher only (Improved Writing Model): the controller answers 404 to everyone else (writingModel.test.js)',
  '/api/submissions/:submissionId/writing-model': 'behind IMPROVED_WRITING_MODEL_ENABLED (off here: 404); returns only { available, text } (writingModel.test.js)',
  '/api/guest/submissions/:submissionId/writing-model': 'behind IMPROVED_WRITING_MODEL_ENABLED (off here: 404); returns only { available, text } (writingModel.test.js)',
  '/api/subscription/me': 'answers 500 for the fixture user, who has no subscription record (pre-existing; a teacher billing route)',
};
// Keys that look internal but that a student page reads. Each has a reason; a key is added here only after its reader is named.
const STUDENT_READS = {
  // Freshness of the result. A page compares them to decide whether a result is current, or is a stale one to be replaced.
  correctionSourceHash: 'canonical-result-state.util.ts, adaptive-writing-studio.ts: is the evaluation current for these corrections',
  evaluationSourceHash: 'adaptive-writing-studio.ts: the practice source must match the evaluation',
  detailedFeedbackSourceHash: 'canonical-result-state.util.ts: is the detailed feedback current',
  evaluationRubricSourceHash: 'adaptive-writing-studio.ts: practice source identity',
  evaluationPolicyHash: 'adaptive-writing-studio.ts: practice source identity',
  sourceHash: 'DetailedFeedback.sourceHash, read by canonical-result-state.util.ts',
  policyFresh: 'canonical-result-state.util.ts: copied into the result state (no template shows it)',
  currentRubricSourceHash: 'canonical-result-state.util.ts: copied into the result state (no template shows it)',
  currentPolicyHash: 'canonical-result-state.util.ts: copied into the result state (no template shows it)',
  ocrJobId: 'my-submission-page.ts: the cache token of the page images',
  // What a student needs to open the assignment: the link and QR code they were given carry it.
  qrToken: 'assignment-qr-redirect.ts, guest-submission.ts, guest-student-access.service.ts: the join link',
  // The user's own record.
  aiConfig: 'GET /users/me returns the signed-in user\'s own settings (the teacher\'s, for a teacher; a student has defaults)',
  // The public share link echoes the token the caller already used in the URL.
  shareToken: 'GET /shared/flashcards/:shareToken answers with the token it was asked for',
  // Practice: the model answer is revealed only after an attempt (sanitizeAdaptiveSession), and the page shows it then.
  modelAnswer: 'adaptive-writing-studio.ts: shown after the student has tried the question',
};
// Public catalogues and operational endpoints: not student data. Their internal-looking keys are reported for a decision, not scanned.
const PUBLIC_ROUTES = {
  '/api/health': 'public operational endpoint; `runtime` carries prompt and model versions and is read by scripts/verify-runtime-contract.js (reported in the follow-up notes)',
  '/api/plans': 'public price list: paymentProvider and assessmentCreditNudges describe plans, not a student or a teacher',
  '/api/writing-corrections/legend': 'public correction legend: contentHash is the version of the legend text',
};
const INTERNAL = /provider|model|prompt|policy|hash|token|cost|credit|internal|config|secret|apikey|lease|job|runid|fingerprint|diagnostic|metric|worker/i;

describe('the display name replaces it', () => {
  test.each([
    ['submission', async () => (await asStudent(`/api/submissions/assignment/${f.IDS.assignment}/my`)).body.data, d => [d.assignment, d.class]],
    ['submission list', async () => (await asStudent('/api/submissions/my')).body.data, d => [d[0].assignment, d[0].class]],
    ['assignment', async () => (await asStudent(`/api/assignments/${f.IDS.assignment}`)).body.data, d => [d, d.class]],
    ['assignment list', async () => (await asStudent('/api/assignments/my')).body.data, d => [d[0], d[0].class]],
    ['assignment by QR', async () => (await asStudent('/api/assignments/qr/fixture-qr')).body.data, d => [d, d.class]],
    ['membership', async () => (await asStudent('/api/memberships/mine')).body.data, d => [d[0].class]],
    ['class summary', async () => (await asStudent(`/api/classes/${f.IDS.class}/summary`)).body.data, d => [d]],
    ['legacy feedback', async () => (await asStudent(`/api/feedback/submission/${f.IDS.registered}`)).body.data, d => [d, d.assignment, d.class]],
  ])('%s', async (_name, load, objects) => {
    for (const object of objects(await load())) {
      expect(object.teacherDisplayName).toBe('Teacher');
      expect(object).not.toHaveProperty('teacher');
    }
  });
  test('legacy feedback: no one who overrode it, either', async () => {
    const { data } = (await asStudent(`/api/feedback/submission/${f.IDS.registered}`)).body;
    expect(data).not.toHaveProperty('overriddenBy');
    expect(data.teacherComments).toBe('Legacy note.');
  });
  test('falls back when the display name is empty or is an email', async () => {
    for (const displayName of ['', 'teacher@example.com', '   ']) {
      await User.collection.updateOne({ _id: f.teacher._id }, { $set: { displayName } });
      const { data } = (await asStudent(`/api/submissions/assignment/${f.IDS.assignment}/my`)).body;
      expect({ displayName, name: data.assignment.teacherDisplayName, cls: data.class.teacherDisplayName }).toEqual({ displayName, name: 'Your teacher', cls: 'Your teacher' });
    }
    await User.collection.updateOne({ _id: f.teacher._id }, { $set: { displayName: 'Teacher' } });
  });
  test('joining a class: no identity in the response', async () => {
    await Membership.deleteMany({ student: f.student._id });
    const res = await request(app).post('/api/memberships/join').set('Authorization', `Bearer ${studentJwt}`).send({ joinCode: 'FIXTURE-1' });
    expect(res.status).toBe(200);
    expect(hits(res.body)).toEqual([]);
    expect(res.body.data.class.teacherDisplayName).toBe('Teacher');
  });
  test('notifications: the sender is a name only, for students', async () => {
    const { data } = (await asStudent('/api/notifications')).body;
    expect(data[0].actor).toEqual({ displayName: 'Teacher' });
    const read = await request(app).patch(`/api/notifications/${data[0]._id}/read`).set('Authorization', `Bearer ${studentJwt}`);
    expect(read.status).toBe(200);
    expect(read.body.data.actor).toEqual({ displayName: 'Teacher' });
  });
  test('the live notification push is reduced as well', async () => {
    const { publishToUser } = require('../src/services/notificationRealtime.service');
    publishToUser.mockClear();
    await notifications.createNotification({ recipientId: f.student._id, actorId: f.teacher._id, type: 'assignment_uploaded', title: 'Another', description: 'Fixture' });
    expect(publishToUser).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(JSON.stringify(publishToUser.mock.calls[0][0].payload));
    expect(payload.title).toBe('Another');
    expect(hits(payload)).toEqual([]);
  });
});

describe('what a student does not get, and what stays', () => {
  const strip = identity.withoutInternal;
  test('removes the named keys at any depth and nothing else', () => {
    const out = strip({ title: 'T', createdBy: 'id', nested: { ownerId: 'id', keep: 1, list: [{ shareToken: 'x', keep: 2 }] }, correctionSourceHash: 'h', modelAnswer: 'a' });
    expect(out).toEqual({ title: 'T', nested: { keep: 1, list: [{ keep: 2 }] }, correctionSourceHash: 'h', modelAnswer: 'a' });
  });
  test('the provenance blocks keep their outcome and lose who ran them', () => {
    const when = new Date('2026-01-01T00:00:00.000Z');
    expect(strip({ generation: { provider: 'p', model: 'm', promptVersion: 'v', metrics: { totalTokens: 9 }, startedAt: when, errorMessage: 'It failed.' },
      attempts: [{ checking: { provider: 'p', model: 'm', errorCode: 'X', errorMessage: 'Again.' }, responseFingerprint: 'f', response: 'B' }] }))
      .toEqual({ generation: { startedAt: when, errorMessage: 'It failed.' }, attempts: [{ checking: { errorCode: 'X', errorMessage: 'Again.' }, response: 'B' }] });
  });
  test('dates, ids and buffers are left as they are, and the input is not changed', () => {
    const id = new (require('mongoose').Types.ObjectId)(), when = new Date(), input = { _id: id, at: when, bytes: Buffer.from('a'), ownerId: id };
    const out = strip(input);
    expect(out._id).toBe(id); expect(out.at).toBe(when); expect(out.bytes).toBe(input.bytes);
    expect(input.ownerId).toBe(id);
  });
  test('a worksheet and a flashcard set lose their creator, source text, share link and folder; the content stays', () => {
    expect(identity.worksheetForStudent({ _id: 'w', title: 'W', createdBy: 't', sourceContent: 's', shareToken: 'x', isPublic: true, activities: [{ title: 'A' }] })).toEqual({ _id: 'w', title: 'W', activities: [{ title: 'A' }] });
    expect(identity.flashcardSetForStudent({ _id: 'f', title: 'F', ownerId: 't', shareToken: 'x', folderId: 'd', cards: [{ front: 'a', back: 'b' }] })).toEqual({ _id: 'f', title: 'F', cards: [{ front: 'a', back: 'b' }] });
  });
  test('every hidden key is a specific name, not a pattern, and the freshness keys a page reads are not among them', () => {
    for (const key of ['correctionSourceHash', 'evaluationSourceHash', 'detailedFeedbackSourceHash', 'evaluationRubricSourceHash', 'evaluationPolicyHash', 'ocrJobId', 'qrToken', 'sourceHash', 'modelAnswer', 'teacherDisplayName'])
      expect({ key, hidden: identity.STUDENT_HIDDEN_KEYS.has(key) }).toEqual({ key, hidden: false });
  });
});

describe('helper', () => {
  test('a bare id, null and a plain value pass through', () => {
    expect(identity.assignmentForStudent('abc')).toBe('abc');
    expect(identity.assignmentForStudent(null)).toBeNull();
    expect(identity.teacherDisplayName(undefined)).toBe('Your teacher');
    expect(identity.teacherDisplayName({ displayName: ' Ms Rahman ' })).toBe('Ms Rahman');
    expect(identity.teacherDisplayName({ displayName: 'a@b.c' })).toBe('Your teacher');
  });
  test('removes the internal fields from a submission', () => {
    const out = identity.submissionForStudent({ _id: '1', evaluationProvider: 'p', evaluationModel: 'm', evaluationAttempts: [], analysisInputHash: 'h', evaluationPolicy: {}, evaluationStatus: 'completed' });
    expect(out).toEqual({ _id: '1', evaluationStatus: 'completed' });
  });
});

describe('teachers are unchanged', () => {
  const asTeacher = url => request(app).get(url).set('Authorization', `Bearer ${teacherJwt}`);
  test('worksheet, flashcard set and corrections keep their owner and pipeline fields for the teacher', async () => {
    const worksheet = (await asTeacher(`/api/worksheets/${r.worksheet._id}`)).body.data;
    expect(worksheet).toEqual(expect.objectContaining({ createdBy: String(f.IDS.teacher), sourceContent: 'TEACHER-SOURCE-CONTENT', shareToken: 'worksheet-share-0001', isPublished: true }));
    const set = (await asTeacher(`/api/flashcards/${r.flashcards._id}`)).body.data;
    expect(set).toEqual(expect.objectContaining({ ownerId: String(f.IDS.teacher), shareToken: expect.any(String), isPublic: true }));
    const corrections = (await asTeacher(`/api/submissions/${f.IDS.registered}/ocr-corrections`)).body.data;
    expect(corrections).toEqual(expect.objectContaining({ assessmentRunId: 'run-fixture' }));
    expect(corrections.corrections.some(item => 'ocrEvidenceHash' in item || 'correctionFingerprint' in item)).toBe(true);
    const student = (await asStudent(`/api/submissions/${f.IDS.registered}/ocr-corrections`)).body.data;
    expect('assessmentRunId' in student).toBe(false);
    expect(student.corrections.some(item => 'ocrEvidenceHash' in item || 'correctionFingerprint' in item || 'ocrRunId' in item)).toBe(false);
  });
  test('class summary, assignment and submission list keep the teacher object', async () => {
    const summary = (await asTeacher(`/api/classes/${f.IDS.class}/summary`)).body.data;
    expect(summary.teacher).toEqual(expect.objectContaining({ id: String(f.IDS.teacher), email: TEACHER_EMAIL }));
    expect(summary).not.toHaveProperty('teacherDisplayName');
    const assignment = (await asTeacher(`/api/assignments/teacher/${f.IDS.assignment}`));
    expect(assignment.status).toBe(200);
    expect(assignment.body.data.teacher).toEqual(expect.objectContaining({ email: TEACHER_EMAIL }));
    const list = (await asTeacher(`/api/submissions/assignment/${f.IDS.assignment}`)).body.data;
    expect(list[0].assignment.teacher).toEqual(expect.objectContaining({ email: TEACHER_EMAIL }));
  });
  test('the feedback endpoint keeps the internal fields for the teacher, and not for the student', async () => {
    await require('../src/models/SubmissionFeedback').collection.updateOne({ submissionId: f.IDS.registered }, { $set: { evaluationProvider: 'prov', evaluationModel: 'mod', evaluationAttempts: [{ code: 'x' }], evaluationPolicy: { strictness: 'balanced' } } });
    const teacher = (await asTeacher(`/api/feedback/${f.IDS.registered}`)).body.data;
    expect(teacher).toEqual(expect.objectContaining({ evaluationProvider: 'prov', evaluationModel: 'mod', evaluationPolicy: { strictness: 'balanced' }, analysisInputHash: expect.any(String) }));
    const student = (await asStudent(`/api/feedback/${f.IDS.registered}`)).body.data;
    for (const key of identity.INTERNAL_FIELDS) expect({ key, present: key in student }).toEqual({ key, present: false });
  });
});
