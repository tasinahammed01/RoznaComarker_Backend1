'use strict';
// Phase B2: teacher edits of the evaluation scores and comments. Owner only (404 for everyone else), validation, history, idempotency,
// optimistic revision, no credit charge, AI writes never touch the teacher's record, a new draft starts from the AI values, students and
// guests (API, guest results, PDF view model) get the final values and none of the record. Synthetic data only.
process.env.JWT_SECRET = 'teacher-evaluation-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-evaluation';
process.env.TEACHER_EVALUATION_EDIT_ENABLED = 'true';
process.env.TEACHER_EVALUATION_RATE_LIMIT_MAX = '100000';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '100000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const policy = require('../src/services/teacherEvaluation.service');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture;
beforeAll(async () => { await connectInMemoryMongo(); });
beforeEach(async () => {
  process.env.TEACHER_EVALUATION_EDIT_ENABLED = 'true';
  await mongoose.connection.dropDatabase(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

const jwt = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
const url = id => `/api/submissions/${id}/teacher-evaluation`;
const getAs = (user, id) => request(app).get(url(id)).set('Authorization', `Bearer ${jwt(user)}`);
const postAs = (user, id, body) => request(app).post(url(id)).set('Authorization', `Bearer ${jwt(user)}`).send(body);
async function save(id, body, user = fixture.teacher) {
  const snap = (await getAs(fixture.teacher, id)).body.data;
  return postAs(user, id, { revision: snap.revision, requestId: crypto.randomUUID(), ...body });
}
const studentFeedback = id => request(app).get(`/api/feedback/${id}`).set('Authorization', `Bearer ${jwt(fixture.student)}`);
const guestFeedback = () => request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/feedback`).set('X-Guest-Token', fixture.guestToken);
const guestResults = () => request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/`).set('X-Guest-Token', fixture.guestToken);
const record = async id => (await SubmissionFeedback.findOne({ submissionId: id }).select('+teacherEvaluation').lean()).teacherEvaluation;
const EDIT = { criteria: { GRAMMAR: { score: 20, comment: 'Better now.' } }, reason: 'Re-read the second paragraph' };
const LEAK_TERMS = ['teacherEvaluation', 'Re-read the second paragraph', 'actorName', 'updatedByName', 'history', 'AI suggested'];

describe('who may use it', () => {
  test('other teacher, student and admin: 404 on GET and POST, for registered and guest submissions; nothing is written', async () => {
    const admin = await require('../src/models/user.model').create({ firebaseUid: 'fixture-admin', email: 'admin@example.com', role: 'admin', displayName: 'Admin' });
    for (const user of [fixture.otherTeacher, fixture.student, admin]) {
      for (const id of [fixture.IDS.registered, fixture.IDS.guest]) {
        expect((await getAs(user, id)).status).toBe(404);
        const res = await postAs(user, id, { revision: 0, requestId: crypto.randomUUID(), ...EDIT });
        expect({ status: res.status, code: res.body.code }).toEqual({ status: 404, code: 'TEACHER_EVALUATION_NOT_FOUND' });
      }
    }
    expect(await record(fixture.IDS.registered)).toBeUndefined();
  });
  test('a guest token (no account) is refused before the controller (401)', async () => {
    const res = await request(app).post(url(fixture.IDS.guest)).set('X-Guest-Token', fixture.guestToken).send({ revision: 0, requestId: crypto.randomUUID(), ...EDIT });
    expect(res.status).toBe(401);
    expect(await record(fixture.IDS.guest)).toBeUndefined();
  });
  test('flag off: 404 for the owner too, and a stored record changes nothing anywhere', async () => {
    expect((await save(fixture.IDS.registered, EDIT)).status).toBe(200);
    process.env.TEACHER_EVALUATION_EDIT_ENABLED = 'false';
    expect((await getAs(fixture.teacher, fixture.IDS.registered)).status).toBe(404);
    expect((await postAs(fixture.teacher, fixture.IDS.registered, { revision: 1, requestId: crypto.randomUUID(), ...EDIT })).status).toBe(404);
    const shown = (await studentFeedback(fixture.IDS.registered)).body.data;
    expect(shown.overallScore).toBe(82);
    expect(shown.rubricScores.GRAMMAR.score).toBe(18);
    expect(JSON.stringify(shown)).not.toContain('teacherEvaluation');
  });
  test('closed class: read-only', async () => {
    await require('../src/models/class.model').updateOne({ _id: fixture.IDS.class }, { $set: { status: 'archived' } });
    const snap = (await getAs(fixture.teacher, fixture.IDS.registered)).body.data;
    expect({ editable: snap.editable, blockedReason: snap.blockedReason }).toEqual({ editable: false, blockedReason: 'CLASS_CLOSED' });
    expect((await save(fixture.IDS.registered, EDIT)).body.code).toBe('TEACHER_EVALUATION_CLASS_CLOSED');
  });
});

describe('saving', () => {
  test('the snapshot keeps the AI values as suggested; a save stores teacher values, final overall and grade, and one history row', async () => {
    const before = (await getAs(fixture.teacher, fixture.IDS.registered)).body.data;
    expect(before).toEqual(jasmineLike({ enabled: true, editable: true, revision: 0, edited: false }));
    const grammar = before.criteria.find(c => c.key === 'GRAMMAR');
    expect(grammar).toEqual({ key: 'GRAMMAR', maxScore: 25, ai: { score: 18, comment: '' }, teacher: { score: null, comment: null }, final: { score: 18, comment: '' } });
    const res = await save(fixture.IDS.registered, EDIT);
    expect(res.status).toBe(200);
    const snap = res.body.data.snapshot;
    expect(snap.revision).toBe(1);
    expect(snap.criteria.find(c => c.key === 'GRAMMAR')).toEqual({ key: 'GRAMMAR', maxScore: 25, ai: { score: 18, comment: '' },
      teacher: { score: 20, comment: 'Better now.' }, final: { score: 20, comment: 'Better now.' } });
    expect(snap.overall).toEqual({ ai: 82, final: 84, max: 100 });
    expect(snap.grade).toEqual({ ai: 'F', final: 'B' });
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0]).toEqual(jasmineLike({ actorName: 'Teacher', reason: 'Re-read the second paragraph', previousRevision: 0, newRevision: 1,
      before: { criteria: { GRAMMAR: { score: 18, comment: '' } }, overallScore: 82, grade: 'F' },
      after: { criteria: { GRAMMAR: { score: 20, comment: 'Better now.' } }, overallScore: 84, grade: 'B' } }));
    // The AI fields are untouched.
    const stored = await SubmissionFeedback.findOne({ submissionId: fixture.IDS.registered }).lean();
    expect({ overall: stored.overallScore, grammar: stored.rubricScores.GRAMMAR.score, flag: stored.overriddenByTeacher }).toEqual({ overall: 82, grammar: 18, flag: true });
  });
  test('a comment-only edit keeps the AI overall and grade; score null goes back to the AI value; reset clears everything', async () => {
    await save(fixture.IDS.registered, { criteria: { MECHANICS: { comment: 'Spelling is better.' } } });
    let snap = (await getAs(fixture.teacher, fixture.IDS.registered)).body.data;
    expect({ overall: snap.overall.final, grade: snap.grade.final }).toEqual({ overall: 82, grade: 'F' });
    await save(fixture.IDS.registered, EDIT);
    await save(fixture.IDS.registered, { criteria: { GRAMMAR: { score: null } } });
    snap = (await getAs(fixture.teacher, fixture.IDS.registered)).body.data;
    expect(snap.criteria.find(c => c.key === 'GRAMMAR').final).toEqual({ score: 18, comment: 'Better now.' });
    expect(snap.overall.final).toBe(82);
    const reset = await save(fixture.IDS.registered, { reset: true, reason: 'Back to AI' });
    expect(reset.body.data.snapshot.edited).toBe(false);
    expect(reset.body.data.snapshot.history).toHaveLength(4);
    expect(reset.body.data.snapshot.history[0].reset).toBe(true);
  });
  test('validation: range against the rubric max, one decimal, types, closed keys, text rules, payload size', async () => {
    const codes = [];
    for (const body of [
      { criteria: { GRAMMAR: { score: 25.5 } } }, { criteria: { GRAMMAR: { score: -1 } } }, { criteria: { GRAMMAR: { score: 12.25 } } },
      { criteria: { GRAMMAR: { score: '20' } } }, { criteria: { GRAMMAR: { score: true } } }]) codes.push((await save(fixture.IDS.registered, body)).body.code);
    expect(new Set(codes)).toEqual(new Set(['TEACHER_EVALUATION_INVALID_SCORE']));
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { score: 24.5 } } })).status).toBe(200);
    expect((await save(fixture.IDS.registered, { criteria: { SPELLING: { score: 1 } } })).body.code).toBe('TEACHER_EVALUATION_UNKNOWN_CRITERION');
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { score: 1, weight: 2 } } })).body.code).toBe('TEACHER_EVALUATION_INVALID_FIELDS');
    expect((await save(fixture.IDS.registered, { ...EDIT, overallScore: 99 })).body.code).toBe('TEACHER_EVALUATION_INVALID_FIELDS');
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { comment: 'Nice <b>work</b>' } } })).body.code).toBe('TEACHER_EVALUATION_INVALID_COMMENT');
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { comment: 'bell\u0007' } } })).body.code).toBe('TEACHER_EVALUATION_INVALID_COMMENT');
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { comment: 'x'.repeat(1001) } } })).body.code).toBe('TEACHER_EVALUATION_INVALID_COMMENT');
    expect((await save(fixture.IDS.registered, { ...EDIT, reason: 'r'.repeat(301) })).body.code).toBe('TEACHER_EVALUATION_INVALID_REASON');
    expect((await save(fixture.IDS.registered, { reset: true, criteria: EDIT.criteria })).body.code).toBe('TEACHER_EVALUATION_INVALID_REQUEST');
    const big = await save(fixture.IDS.registered, { criteria: Object.fromEntries(policy.CRITERIA.map(k => [k, { comment: 'y'.repeat(1000) }])), reason: 'z'.repeat(300), extra: 'w'.repeat(3000) });
    expect(big.status).toBe(413);
    expect((await save(fixture.IDS.registered, { criteria: { GRAMMAR: { score: 24.5 } } })).body.code).toBe('TEACHER_EVALUATION_NO_CHANGE');
    expect((await record(fixture.IDS.registered)).history).toHaveLength(1);
  });
  test('idempotent: the same request id replays; a reused id with another body is a conflict; a stale revision is 409', async () => {
    const body = { revision: 0, requestId: crypto.randomUUID(), ...EDIT };
    const first = await postAs(fixture.teacher, fixture.IDS.registered, body);
    const again = await postAs(fixture.teacher, fixture.IDS.registered, body);
    expect(again.status).toBe(200);
    expect({ replay: again.body.data.replay, revision: again.body.data.revision }).toEqual({ replay: true, revision: first.body.data.revision });
    expect((await record(fixture.IDS.registered)).history).toHaveLength(1);
    expect((await postAs(fixture.teacher, fixture.IDS.registered, { ...body, reason: 'other' })).body.code).toBe('TEACHER_EVALUATION_IDEMPOTENCY_CONFLICT');
    const stale = await postAs(fixture.teacher, fixture.IDS.registered, { revision: 0, requestId: crypto.randomUUID(), criteria: { MECHANICS: { score: 9 } } });
    expect({ status: stale.status, code: stale.body.code }).toEqual({ status: 409, code: 'TEACHER_EVALUATION_REVISION_CONFLICT' });
  });
  test('no credit is charged and no AI provider or credit service is called', async () => {
    const credit = require('../src/services/credit.service'), router = require('../src/services/assessmentCreditRouter.service');
    const spies = [...Object.keys(credit).filter(k => typeof credit[k] === 'function').map(k => jest.spyOn(credit, k)),
      ...Object.keys(router).filter(k => typeof router[k] === 'function').map(k => jest.spyOn(router, k))];
    const wallets = async () => JSON.stringify(await require('../src/models/CreditWallet').find({}).lean()) + await require('../src/models/CreditTransaction').countDocuments();
    const user = async () => JSON.stringify((await require('../src/models/user.model').findById(fixture.teacher._id).lean()).usage || null);
    const [w0, u0] = [await wallets(), await user()];
    expect((await save(fixture.IDS.registered, EDIT)).status).toBe(200);
    expect([await wallets(), await user()]).toEqual([w0, u0]);
    for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
  });
});

describe('what students, guests and the PDF see', () => {
  test('student API: the final values, none of the record', async () => {
    await save(fixture.IDS.registered, EDIT);
    const res = await studentFeedback(fixture.IDS.registered);
    expect(res.status).toBe(200);
    expect({ overall: res.body.data.overallScore, grade: res.body.data.grade, grammar: res.body.data.rubricScores.GRAMMAR.score, comment: res.body.data.rubricScores.GRAMMAR.comment })
      .toEqual({ overall: 84, grade: 'B', grammar: 20, comment: 'Better now.' });
    const json = JSON.stringify(res.body);
    for (const term of LEAK_TERMS) expect(json).not.toContain(term);
  });
  test('guest feedback and guest results: the final values, none of the record', async () => {
    await save(fixture.IDS.guest, EDIT);
    const feedback = await guestFeedback(), results = await guestResults();
    expect(feedback.body.data.overallScore).toBe(84);
    expect(feedback.body.data.rubricScores.GRAMMAR.score).toBe(20);
    expect(results.status).toBe(200);
    expect(results.body.data.feedback.overallScore).toBe(84);
    expect(results.body.data.feedback.rubricScores.GRAMMAR.score).toBe(20);
    for (const term of LEAK_TERMS) { expect(JSON.stringify(feedback.body)).not.toContain(term); expect(JSON.stringify(results.body)).not.toContain(term); }
  });
  test('PDF view model: built from the final values', async () => {
    await save(fixture.IDS.registered, EDIT);
    const submission = await Submission.findById(fixture.IDS.registered).lean();
    const sf = policy.finalFeedback(await SubmissionFeedback.findOne({ submissionId: submission._id }).select('+teacherEvaluation').lean(), submission);
    const { buildPersistedSubmissionFeedbackReport } = require('../src/services/submissionFeedbackReport.service');
    const { viewModel } = await buildPersistedSubmissionFeedbackReport({ submission, submissionFeedback: sf, feedback: null });
    expect(viewModel.result.overallScore).toBe(84);
    expect(viewModel.result.grade).toBe('B');
    expect(JSON.stringify(viewModel.aiEvaluationFeedback)).toContain('Better now.');
    expect(JSON.stringify(viewModel)).not.toContain('Re-read the second paragraph');
  });
});

describe('AI writes and new drafts', () => {
  test('an AI rewrite of its own fields never touches the teacher record; the final values follow the new AI values', async () => {
    await save(fixture.IDS.registered, EDIT);
    const kept = await record(fixture.IDS.registered);
    // What a re-evaluation does: $set on the AI fields (canonicalEvaluation / canonicalCorrectionsPipeline). Simulated: no provider is called.
    await SubmissionFeedback.updateOne({ submissionId: fixture.IDS.registered }, { $set: { overallScore: 70, 'rubricScores.GRAMMAR.score': 15, grade: 'C' } });
    expect(await record(fixture.IDS.registered)).toEqual(kept);
    const shown = (await studentFeedback(fixture.IDS.registered)).body.data;
    expect({ overall: shown.overallScore, grammar: shown.rubricScores.GRAMMAR.score }).toEqual({ overall: 75, grammar: 20 });
  });
  test('a new draft starts from the AI values; the next save starts a new history for that draft', async () => {
    await save(fixture.IDS.registered, EDIT);
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { draftNumber: 2 } });
    const shown = (await studentFeedback(fixture.IDS.registered)).body.data;
    expect({ overall: shown.overallScore, grammar: shown.rubricScores.GRAMMAR.score }).toEqual({ overall: 82, grammar: 18 });
    const snap = (await getAs(fixture.teacher, fixture.IDS.registered)).body.data;
    expect({ edited: snap.edited, history: snap.history.length, revision: snap.revision, draft: snap.draftNumber }).toEqual({ edited: false, history: 0, revision: 1, draft: 2 });
    const next = await save(fixture.IDS.registered, { criteria: { MECHANICS: { score: 9 } } });
    expect(next.body.data.snapshot.history).toHaveLength(1);
    expect((await record(fixture.IDS.registered)).draftNumber).toBe(2);
  });
});

/** A partial match that reads like jasmine.objectContaining in jest. */
function jasmineLike(expected) { return expect.objectContaining(expected); }
