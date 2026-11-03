'use strict';
// Tasks 7B and 7C: the grade check after annotation changes. Status lifecycle, the "keep" endpoint, races, audit, rollback. After every
// operation the stored feedback must be byte-identical, and no AI or credit service may be called. Synthetic text only.
process.env.JWT_SECRET = 'annotation-review-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-review';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ANNOTATION_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AnnotationAudit = require('../src/models/AnnotationAudit');
const Class = require('../src/models/class.model');
const review = require('../src/services/scoreReview.service');
const policy = require('../src/services/teacherAnnotation.service');
const canonicalEvaluation = require('../src/services/canonicalEvaluation.service');
const semanticRubric = require('../src/services/semanticRubricAssessment.service');
const credits = require('../src/services/assessmentCreditRouter.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, normalizeVolatile } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
let fixture, teacher, other, seeded = {};
const MODES = ['registered', 'guest'];
const spies = [];

const raw = (collection, filter = {}) => collection.collection.find(filter).sort({ _id: 1 }).toArray();
const feedbackBytes = async () => JSON.stringify(await raw(SubmissionFeedback));
const load = id => Submission.findById(id).select('+teacherAnnotations').lean();
const snap = async id => (await teacher.snapshot(id)).body.data;
const status = async id => (await snap(id)).scoreReview.status;
const correction = async (id, quoted) => (await snap(id)).corrections.find(c => c.quotedText === quoted);
const act = async (id, body) => { const res = await teacher.act(id, body); if (res.status !== 200) throw new Error(`${body.action}: ${res.status} ${res.body.code}`); return res; };
const hide = async (id, quoted = 'a') => act(id, { action: 'hide', id: (await correction(id, quoted)).id });
const keepBody = async (id, extra = {}) => { const s = await snap(id);
  return { requestId: crypto.randomUUID(), revision: s.revision, sourceHash: s.sourceHash, scoreFingerprint: s.scoreReview.fingerprint, outcome: 'kept', ...extra }; };
const keep = async (id, extra) => teacher.scoreReview(id, await keepBody(id, extra));
const notCurrent = id => SubmissionFeedback.collection.updateOne({ submissionId: id }, { $set: { overriddenByTeacher: false, evaluationSourceHash: 'another-source' } });

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  await AnnotationAudit.init();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher); other = annotationApi(app, fixture.otherTeacher);
  seeded = { submissions: await raw(Submission), feedback: await raw(SubmissionFeedback) };
});
beforeEach(async () => {
  await Submission.collection.deleteMany({}); await Submission.collection.insertMany(seeded.submissions);
  await SubmissionFeedback.collection.deleteMany({}); await SubmissionFeedback.collection.insertMany(seeded.feedback);
  await AnnotationAudit.deleteMany({});
  await Class.updateOne({ _id: fixture.IDS.class }, { $unset: { status: 1 } });
  spies.length = 0;
  spies.push(jest.spyOn(canonicalEvaluation, 'generate'), jest.spyOn(semanticRubric, 'assess'), jest.spyOn(credits, 'canRunAssessment'));
});
afterEach(() => {
  for (const spy of spies) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); }
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

describe('snapshot', () => {
  test('the old score policy sentence is gone (it pointed at grading controls that do not exist), the review is there', async () => {
    const data = await snap(fixture.IDS.registered);
    expect(data).not.toHaveProperty('scorePolicy');
    expect(data.scoreReview).toEqual(expect.objectContaining({ status: 'not_needed' }));
  });
});

describe('score fingerprint', () => {
  const base = { overallScore: 80, grade: 'B', evaluationSourceHash: 'h', overriddenByTeacher: false, evaluationVersion: 'v',
    rubricScores: { GRAMMAR: { score: 20, maxScore: 25, comment: 'one' }, MECHANICS: { score: 8, maxScore: 10, comment: 'x' } } };
  const fp = (feedback, submission = { evaluationStatus: 'completed' }) => review.scoreFingerprint(feedback, submission);
  test('is a stable sha256, whatever the key order', () => {
    expect(fp(base)).toMatch(/^[a-f0-9]{64}$/);
    expect(fp(base)).toBe(fp({ ...base }));
    expect(fp({ ...base, rubricScores: { MECHANICS: base.rubricScores.MECHANICS, GRAMMAR: base.rubricScores.GRAMMAR } })).toBe(fp(base));
  });
  test('changes with every score, the source and the override; not with comments', () => {
    expect(fp({ ...base, rubricScores: { ...base.rubricScores, GRAMMAR: { score: 20, maxScore: 25, comment: 'reworded' } } })).toBe(fp(base));
    for (const changed of [{ overallScore: 81 }, { grade: 'A' }, { evaluationSourceHash: 'other' }, { overriddenByTeacher: true }, { evaluationVersion: 'w' },
      { rubricScores: { ...base.rubricScores, GRAMMAR: { score: 19, maxScore: 25 } } }, { customRubricScores: { criteria: [{ criterionId: 'c', weightedPoints: 3, selectedLevel: 'L' }] } }])
      expect(fp({ ...base, ...changed })).not.toBe(fp(base));
    expect(fp(base, { evaluationStatus: 'partial' })).not.toBe(fp(base));
  });
  test('corrections do not move it: a hide leaves it as it was', async () => {
    const id = fixture.IDS.registered;
    const before = (await snap(id)).scoreReview.fingerprint;
    await hide(id);
    expect((await snap(id)).scoreReview.fingerprint).toBe(before);
  });
});

describe.each(MODES)('status lifecycle (%s)', (mode) => {
  const id = () => fixture.IDS[mode];
  const seededDoc = () => (mode === 'guest' ? fixture.guest : fixture.registered);

  test('starts not_needed, with the scores and both sets of counts', async () => {
    const { scoreReview } = await snap(id());
    expect(scoreReview).toEqual({ status: 'not_needed', fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/), decision: null,
      scores: { overallScore: 82, grade: 'F', categories: expect.objectContaining({ GRAMMAR: { score: 18, maxScore: 25 } }), customRubricOverallScore: null },
      countsScored: { content: 0, organization: 0, grammar: 3, vocabulary: 0, mechanics: 2, total: 5 },
      countsVisible: { content: 0, organization: 0, grammar: 3, vocabulary: 0, mechanics: 2, total: 5 } });
  });

  test.each([
    ['add', async () => ({ action: 'add', value: manualValue(seededDoc(), 'park', { symbol: 'ART', category: 'GRAMMAR' }) })],
    ['hide', async () => ({ action: 'hide', id: (await correction(id(), 'a')).id })],
    ['archive', async () => ({ action: 'archive', id: (await correction(id(), 'a')).id })],
    ['substantive edit', async () => ({ action: 'edit', id: (await correction(id(), 'dont')).id,
      value: manualValue(seededDoc(), 'dont', { symbol: 'CAP', category: 'MECHANICS', message: 'Teacher wording.', suggestedText: "Don't" }) })],
  ])('%s: needed, tied to this draft', async (_name, body) => {
    const before = await feedbackBytes();
    await act(id(), await body());
    expect(await status(id())).toBe('needed');
    expect(policy.normalizeState((await load(id())).teacherAnnotations)).toEqual(expect.objectContaining({ scoringReviewRequired: true, scoringReview: { decision: null, requiredDraftNumber: 1 } }));
    expect(await feedbackBytes()).toBe(before);
  });

  test('rewording only (message, suggested text) asks for nothing', async () => {
    const target = await correction(id(), 'dont');
    await act(id(), { action: 'edit', id: target.id, value: manualValue(seededDoc(), 'dont', { symbol: target.symbol, category: target.category, message: 'Reworded.', suggestedText: "don't!" }) });
    expect(await status(id())).toBe('not_needed');
  });

  test('needed -> keep -> checked; the flag is cleared and the decision kept', async () => {
    await hide(id());
    const before = await feedbackBytes();
    const res = await keep(id(), { reason: 'Hidden correction was an OCR slip.' });
    expect(res.status).toBe(200);
    expect(res.body.data.scoreReview).toEqual(expect.objectContaining({ status: 'checked', decision: expect.objectContaining({ outcome: 'kept', reason: 'Hidden correction was an OCR slip.',
      by: String(fixture.teacher._id), draftNumber: 1, annotationRevision: res.body.data.revision, fingerprint: res.body.data.scoreReview.fingerprint }) }));
    expect(res.body.data.scoreReview.countsVisible.grammar).toBe(2);
    expect(res.body.data.scoreReview.countsScored.grammar).toBe(3);
    expect(await status(id())).toBe('checked');
    expect((await load(id())).teacherAnnotations.scoringReviewRequired).toBe(false);
    expect(await feedbackBytes()).toBe(before);
  });

  test('checked -> restore from hidden -> needed: the visible set moved again', async () => {
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    await act(id(), { action: 'restore', id: (await correction(id(), 'a')).entryId });
    expect(await status(id())).toBe('needed');
    expect((await snap(id())).scoreReview.decision).toEqual(expect.objectContaining({ outcome: 'kept' }));   // the earlier decision stays on record
  });

  test('restore from archived is a trigger too', async () => {
    await act(id(), { action: 'archive', id: (await correction(id(), 'a')).id });
    expect((await keep(id())).status).toBe(200);
    await act(id(), { action: 'restore', id: (await correction(id(), 'a')).entryId });
    expect(await status(id())).toBe('needed');
  });

  test('checked -> an AI run changes the score -> needed, and keep works again with the new fingerprint', async () => {
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    await SubmissionFeedback.collection.updateOne({ submissionId: id() }, { $set: { overallScore: 70 } });
    expect(await status(id())).toBe('needed');
    expect((await keep(id())).status).toBe(200);
    expect(await status(id())).toBe('checked');
  });

  test('a new draft starts not_needed, until a trigger on that draft', async () => {
    await hide(id());
    await Submission.updateOne({ _id: id() }, { $set: { draftNumber: 2 } });
    expect(await status(id())).toBe('not_needed');
    await hide(id(), 'dont');
    expect(await status(id())).toBe('needed');
    expect(policy.normalizeState((await load(id())).teacherAnnotations).scoringReview.requiredDraftNumber).toBe(2);
  });

  test('a decision on an earlier draft says nothing about this one', async () => {
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    await Submission.updateOne({ _id: id() }, { $set: { draftNumber: 2 } });
    expect(await status(id())).toBe('not_needed');
  });

  test('assessment running, or evaluation not current: unavailable', async () => {
    await hide(id());
    await Submission.collection.updateOne({ _id: id() }, { $set: { evaluationStatus: 'processing' } });
    expect(await status(id())).toBe('unavailable');
    await Submission.collection.updateOne({ _id: id() }, { $set: { evaluationStatus: 'completed' } });
    expect(await status(id())).toBe('needed');
    await notCurrent(id());
    expect(await status(id())).toBe('unavailable');
  });
});

describe('flags stored before this task', () => {
  const id = () => fixture.IDS.registered;
  test('a version 2 overlay with the flag on and no review block reads as needed, on any draft, and keep clears it', async () => {
    await Submission.collection.updateOne({ _id: id() }, { $set: { teacherAnnotations: { version: 2, revision: 4, scoringReviewRequired: true, entries: [], recent: [] } } });
    expect(await status(id())).toBe('needed');
    await Submission.updateOne({ _id: id() }, { $set: { draftNumber: 3 } });
    expect(await status(id())).toBe('needed');
    expect((await keep(id())).status).toBe(200);
    expect(await status(id())).toBe('checked');
  });
  test('a version 1 overlay reads as needed; keep upgrades it and keeps its history', async () => {
    const doc = await load(id());
    const { sourceHash } = policy.source(doc);
    const target = doc.writingCorrections.find(c => c.quotedText === 'a');
    const oldRequest = crypto.randomUUID();
    await Submission.collection.updateOne({ _id: id() }, { $set: { teacherAnnotations: { revision: 1, scoringReviewRequired: true,
      entries: [{ id: target.id, sourceHash, status: 'hidden', value: target, original: target }],
      audit: [{ requestId: oldRequest, requestHash: 'h', action: 'hide', actor: String(fixture.teacher._id), correctionId: target.id, timestamp: '2026-09-01T00:00:00.000Z', previousRevision: 0, newRevision: 1, before: null, after: null, changedFields: [] }] } } });
    expect(await status(id())).toBe('needed');
    expect((await keep(id())).status).toBe(200);
    const stored = (await load(id())).teacherAnnotations;
    expect(stored).toEqual(expect.objectContaining({ version: 2, scoringReviewRequired: false }));
    expect(stored.audit).toBeUndefined();
    expect(stored.entries[0]).toEqual(expect.objectContaining({ status: 'hidden', targetId: target.id }));
    expect((await AnnotationAudit.find({ submissionId: id() }).lean()).map(r => r.action).sort()).toEqual(['hide', 'score_review']);
  });
  test('normalizeState carries the review block through version 1 and version 2', () => {
    const scoringReview = { requiredDraftNumber: 2, decision: { outcome: 'kept' } };
    expect(policy.normalizeState({ version: 2, revision: 1, scoringReview, entries: [], recent: [] }).scoringReview).toEqual(scoringReview);
    expect(policy.normalizeState({ revision: 1, scoringReview, entries: [] }).scoringReview).toEqual(scoringReview);
    expect(policy.normalizeState(null).scoringReview).toBeNull();
  });
  test('the version 1 migration keeps the review block', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'migrateTeacherAnnotations.js'), 'utf8');
    expect(script).toContain('state.scoringReview ? { scoringReview: state.scoringReview }');
  });
});

describe('every annotation write preserves the review block', () => {
  const id = () => fixture.IDS.registered;
  test.each(['add', 'edit (text only)', 'edit (substantive)', 'hide', 'archive', 'restore'])('%s', async (name) => {
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    const decision = policy.normalizeState((await load(id())).teacherAnnotations).scoringReview.decision;
    const dont = await correction(id(), 'dont');
    const bodies = {
      add: { action: 'add', value: manualValue(fixture.registered, 'park', { symbol: 'ART', category: 'GRAMMAR' }) },
      'edit (text only)': { action: 'edit', id: dont.id, value: manualValue(fixture.registered, 'dont', { symbol: dont.symbol, category: dont.category, message: 'Reworded.', suggestedText: "don't!" }) },
      'edit (substantive)': { action: 'edit', id: dont.id, value: manualValue(fixture.registered, 'dont', { symbol: 'CAP', category: 'MECHANICS', message: 'Other.', suggestedText: "Don't" }) },
      hide: { action: 'hide', id: dont.id }, archive: { action: 'archive', id: dont.id },
      restore: { action: 'restore', id: (await correction(id(), 'a')).entryId },
    };
    await act(id(), bodies[name]);
    const state = policy.normalizeState((await load(id())).teacherAnnotations);
    expect(state.scoringReview.decision).toEqual(decision);
    expect(state.scoringReview.requiredDraftNumber).toBe(name === 'edit (text only)' ? null : 1);
    expect(state.scoringReviewRequired).toBe(name !== 'edit (text only)');
  });
});

describe('POST score-review', () => {
  const id = () => fixture.IDS.registered;
  const code = res => [res.status, res.body.code];
  const ready = async () => { await hide(id()); return keepBody(id()); };

  test('writes one audit row with who, when, before and after, reason and source', async () => {
    await hide(id());
    const body = await keepBody(id(), { reason: '<b>Kept</b> & fine' });
    const res = await teacher.scoreReview(id(), body);
    expect(res.status).toBe(200);
    const rows = await AnnotationAudit.find({ submissionId: id(), action: 'score_review' }).lean();
    expect(rows).toHaveLength(1);
    const scores = expect.objectContaining({ overallScore: 82, grade: 'F', categories: expect.objectContaining({ GRAMMAR: { score: 18, maxScore: 25 } }) });
    expect(rows[0]).toEqual(expect.objectContaining({ requestId: body.requestId, actor: String(fixture.teacher._id), source: 'teacher_action', reason: '<b>Kept</b> & fine',
      previousRevision: body.revision, newRevision: body.revision + 1, draftNumber: 1, createdAt: expect.any(Date), scoringReviewRequired: false,
      before: { scores, fingerprint: body.scoreFingerprint, status: 'needed' }, after: { scores, fingerprint: body.scoreFingerprint, outcome: 'kept', status: 'checked' } }));
    const history = (await teacher.history(id())).body.data.items;
    expect(history[0]).toEqual(expect.objectContaining({ action: 'score_review', reason: '<b>Kept</b> & fine' }));   // stored raw; the page escapes it
    expect(history[0].requestHash).toBeUndefined();
  });

  test('guest submission', async () => {
    const guest = fixture.IDS.guest;
    await hide(guest);
    expect((await keep(guest)).status).toBe(200);
    expect(await status(guest)).toBe('checked');
  });

  test('allowed on a teacher-overridden result, which stays overridden', async () => {
    expect((await SubmissionFeedback.findOne({ submissionId: id() }).lean()).overriddenByTeacher).toBe(true);
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    expect((await SubmissionFeedback.findOne({ submissionId: id() }).lean()).overriddenByTeacher).toBe(true);
  });

  test('a current result that was not overridden stays not overridden', async () => {
    const doc = await load(id());
    await SubmissionFeedback.collection.updateOne({ submissionId: id() }, { $set: { overriddenByTeacher: false, evaluationSourceHash: doc.correctionSourceHash } });
    await hide(id());
    const { scoreReview } = await snap(id());
    expect(scoreReview.status).toBe('needed');
    expect((await keep(id())).status).toBe(200);
    expect((await SubmissionFeedback.findOne({ submissionId: id() }).lean()).overriddenByTeacher).toBe(false);
  });

  describe('access: 404 for everyone but the owner', () => {
    test('another teacher, a student, a malformed id, an unknown id', async () => {
      const body = await ready();
      expect(code(await other.scoreReview(id(), body))).toEqual([404, 'ANNOTATION_NOT_FOUND']);
      expect(code(await annotationApi(app, fixture.student).scoreReview(id(), body))).toEqual([404, 'ANNOTATION_NOT_FOUND']);
      expect(code(await teacher.scoreReview('not-an-id', body))).toEqual([404, 'ANNOTATION_NOT_FOUND']);
      expect(code(await teacher.scoreReview(new mongoose.Types.ObjectId(), body))).toEqual([404, 'ANNOTATION_NOT_FOUND']);
      expect(await status(id())).toBe('needed');
    });
    test('no token, and a guest token, are refused', async () => {
      const body = await ready();
      expect((await request(app).post(`/api/submissions/${id()}/teacher-annotations/score-review`).send(body)).status).toBe(401);
      expect((await request(app).post(`/api/submissions/${fixture.IDS.guest}/teacher-annotations/score-review`).set('X-Guest-Token', fixture.guestToken).send(body)).status).toBe(401);
      expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(0);
    });
    test('deleted class', async () => {
      const body = await ready();
      await Class.updateOne({ _id: fixture.IDS.class }, { $set: { isActive: false } });
      try { expect(code(await teacher.scoreReview(id(), body))).toEqual([404, 'ANNOTATION_NOT_FOUND']); }
      finally { await Class.updateOne({ _id: fixture.IDS.class }, { $set: { isActive: true } }); }
    });
  });

  describe('400 ANNOTATION_INVALID_FIELDS', () => {
    test.each([
      ['an unknown field', { overallScore: 100 }],
      ['another outcome', { outcome: 'edited' }],
      ['no outcome', { outcome: undefined }],
      ['a malformed request id', { requestId: 'x' }],
      ['a fractional revision', { revision: 1.5 }],
      ['an empty source hash', { sourceHash: '' }],
      ['a malformed fingerprint', { scoreFingerprint: 'abc' }],
      ['a reason over 500 characters', { reason: 'x'.repeat(501) }],
      ['a reason with a control character', { reason: 'a\u0007b' }],
      ['a reason with a line break', { reason: 'a\nb' }],
      ['a reason with a C1 control', { reason: 'a\u0085b' }],
      ['a blank reason', { reason: '   ' }],
      ['a reason that is not text', { reason: 5 }],
    ])('%s', async (_name, extra) => {
      const res = await teacher.scoreReview(id(), { ...await ready(), ...extra });
      expect(code(res)).toEqual([400, 'ANNOTATION_INVALID_FIELDS']);
      expect(await status(id())).toBe('needed');
    });
    test('an array body', async () => {
      expect(code(await teacher.scoreReview(id(), []))).toEqual([400, 'ANNOTATION_INVALID_FIELDS']);
    });
    test('a reason of exactly 500 characters is accepted', async () => {
      expect((await teacher.scoreReview(id(), { ...await ready(), reason: 'x'.repeat(500) })).status).toBe(200);
    });
  });

  test('409 ANNOTATION_CLASS_CLOSED, while reads still work', async () => {
    const body = await ready();
    await Class.updateOne({ _id: fixture.IDS.class }, { $set: { status: 'archived' } });
    expect(code(await teacher.scoreReview(id(), body))).toEqual([409, 'ANNOTATION_CLASS_CLOSED']);
    expect(await status(id())).toBe('needed');
  });
  test('409 ANNOTATION_ASSESSMENT_BUSY', async () => {
    const body = await ready();
    await Submission.collection.updateOne({ _id: id() }, { $set: { evaluationStatus: 'processing' } });
    expect(code(await teacher.scoreReview(id(), body))).toEqual([409, 'ANNOTATION_ASSESSMENT_BUSY']);
  });
  test('409 ANNOTATION_REVISION_CONFLICT: stale revision, other source', async () => {
    const body = await ready();
    expect(code(await teacher.scoreReview(id(), { ...body, revision: body.revision - 1 }))).toEqual([409, 'ANNOTATION_REVISION_CONFLICT']);
    expect(code(await teacher.scoreReview(id(), { ...body, sourceHash: 'other' }))).toEqual([409, 'ANNOTATION_REVISION_CONFLICT']);
  });
  test('409 ANNOTATION_SCORE_CHANGED: scores moved between load and keep', async () => {
    const body = await ready();
    await SubmissionFeedback.collection.updateOne({ submissionId: id() }, { $set: { overallScore: 60 } });
    expect(code(await teacher.scoreReview(id(), body))).toEqual([409, 'ANNOTATION_SCORE_CHANGED']);
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(0);
  });
  test('409 ANNOTATION_EVALUATION_NOT_CURRENT', async () => {
    const body = await ready();
    await notCurrent(id());
    expect(code(await teacher.scoreReview(id(), { ...body, scoreFingerprint: (await snap(id())).scoreReview.fingerprint }))).toEqual([409, 'ANNOTATION_EVALUATION_NOT_CURRENT']);
  });
  test('409 ANNOTATION_REVIEW_NOT_NEEDED: nothing changed, or already checked', async () => {
    expect(code(await keep(id()))).toEqual([409, 'ANNOTATION_REVIEW_NOT_NEEDED']);
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    expect(code(await keep(id()))).toEqual([409, 'ANNOTATION_REVIEW_NOT_NEEDED']);
  });
  test('409 ANNOTATION_IDEMPOTENCY_CONFLICT: a different body under the same request id, here and across endpoints', async () => {
    const body = await ready();
    expect((await teacher.scoreReview(id(), body)).status).toBe(200);
    expect(code(await teacher.scoreReview(id(), { ...body, reason: 'Different.' }))).toEqual([409, 'ANNOTATION_IDEMPOTENCY_CONFLICT']);
    const s = await snap(id());
    expect(code(await teacher.post(id(), { action: 'hide', id: (await correction(id(), 'dont')).id, revision: s.revision, sourceHash: s.sourceHash, requestId: body.requestId }))).toEqual([409, 'ANNOTATION_IDEMPOTENCY_CONFLICT']);
  });
  test('a retried request is replayed: same answer, no second row, no second revision', async () => {
    const body = await ready();
    const first = await teacher.scoreReview(id(), body);
    const again = await teacher.scoreReview(id(), body);
    expect(again.status).toBe(200);
    expect(again.body.data).toEqual(expect.objectContaining({ replay: true, revision: first.body.data.revision }));
    expect(again.body.data.scoreReview.status).toBe('checked');
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(1);
    expect((await load(id())).teacherAnnotations.revision).toBe(first.body.data.revision);
  });
  test('a failed audit insert is repaired from the overlay on the next history read', async () => {
    const body = await ready();
    const spy = jest.spyOn(AnnotationAudit, 'bulkWrite').mockRejectedValueOnce(Object.assign(new Error('down'), { name: 'MongoNetworkError' }));
    expect((await teacher.scoreReview(id(), body)).status).toBe(200);
    spy.mockRestore();
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(0);
    expect((await teacher.history(id())).body.data.items.map(r => r.action)).toContain('score_review');
  });
});

describe('races', () => {
  const id = () => fixture.IDS.registered;
  test('two parallel keeps: one wins, one conflict, one row, one revision', async () => {
    await hide(id());
    const [a, b] = [await keepBody(id()), await keepBody(id())];
    const start = (await load(id())).teacherAnnotations.revision;
    const results = await Promise.all([teacher.scoreReview(id(), a), teacher.scoreReview(id(), b)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(results.find(r => r.status === 409).body.code).toMatch(/ANNOTATION_(REVISION_CONFLICT|REVIEW_NOT_NEEDED)/);
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(1);
    expect((await load(id())).teacherAnnotations.revision).toBe(start + 1);
  });
  test('the same request sent twice in parallel never makes two rows', async () => {
    await hide(id());
    const body = await keepBody(id());
    const results = await Promise.all([teacher.scoreReview(id(), body), teacher.scoreReview(id(), body)]);
    expect(results.some(r => r.status === 200)).toBe(true);
    expect((await teacher.scoreReview(id(), body)).status).toBe(200);   // a retry after any conflict succeeds as a replay
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(1);
  });
  test('parallel with an annotation write: exactly one lands, neither is lost', async () => {
    await hide(id());
    const s = await snap(id());
    const start = s.revision;
    const [kept, hidden] = await Promise.all([
      teacher.scoreReview(id(), { requestId: crypto.randomUUID(), revision: start, sourceHash: s.sourceHash, scoreFingerprint: s.scoreReview.fingerprint, outcome: 'kept' }),
      teacher.post(id(), { action: 'hide', id: s.corrections.find(c => c.quotedText === 'dont').id, revision: start, sourceHash: s.sourceHash, requestId: crypto.randomUUID() })]);
    expect([kept.status, hidden.status].sort()).toEqual([200, 409]);
    const state = (await load(id())).teacherAnnotations;
    expect(state.revision).toBe(start + 1);
    expect(state.scoringReviewRequired).toBe(kept.status !== 200);
    expect(await AnnotationAudit.countDocuments({ submissionId: id(), newRevision: start + 1 })).toBe(1);
  });
  const during = (work) => { const original = SubmissionFeedback.findOne.bind(SubmissionFeedback); let done = false;
    return jest.spyOn(SubmissionFeedback, 'findOne').mockImplementation((...args) => { const query = original(...args);
      if (!done) { done = true; const lean = query.lean.bind(query); query.lean = () => ({ then: (res, rej) => work().then(() => lean().then(res, rej)) }); }
      return query; }); };
  test('an annotation write landing between the read and the write: keep gets a conflict, the change stands', async () => {
    await hide(id());
    const body = await keepBody(id());
    const spy = during(async () => { await hide(id(), 'dont'); });
    const res = await teacher.scoreReview(id(), body);
    spy.mockRestore();
    expect([res.status, res.body.code]).toEqual([409, 'ANNOTATION_REVISION_CONFLICT']);
    expect((await load(id())).teacherAnnotations.scoringReviewRequired).toBe(true);
    expect(await status(id())).toBe('needed');
  });
  test('an evaluation job starting between the read and the write: keep gets a conflict', async () => {
    await hide(id());
    const body = await keepBody(id());
    const spy = during(async () => { await Submission.collection.updateOne({ _id: id() }, { $set: { evaluationStatus: 'processing', evaluationJobId: 'job' } }); });
    const res = await teacher.scoreReview(id(), body);
    spy.mockRestore();
    expect([res.status, res.body.code]).toEqual([409, 'ANNOTATION_REVISION_CONFLICT']);
  });
  test('scores changing right after keep are caught on the next read', async () => {
    await hide(id());
    expect((await keep(id())).status).toBe(200);
    await SubmissionFeedback.collection.updateOne({ submissionId: id() }, { $set: { 'rubricScores.GRAMMAR.score': 10 } });
    expect(await status(id())).toBe('needed');
  });
});

describe('a real teacher edit through PUT /api/feedback makes a decision stale', () => {
  test('checked -> PUT -> needed', async () => {
    const id = fixture.IDS.registered;
    await hide(id);
    expect((await keep(id)).status).toBe(200);
    const jwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
    const rubricScores = Object.fromEntries(['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS', 'PRESENTATION'].map(k => [k, { score: 3, comment: '' }]));
    expect((await request(app).put(`/api/feedback/${id}`).set('Authorization', `Bearer ${jwt}`).send({ rubricScores, overallScore: 18, aiFeedback: { perCategory: [] } })).status).toBe(200);
    expect(await status(id)).toBe('needed');
  });
});

describe('students never see any of it', () => {
  test('every student surface is identical before and after keep, except what the hide itself changed', async () => {
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const all = () => capture(surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken }));
    for (const mode of MODES) await hide(fixture.IDS[mode]);
    const before = normalizeVolatile(await all());
    for (const mode of MODES) expect((await keep(fixture.IDS[mode])).status).toBe(200);
    expect(normalizeVolatile(await all())).toEqual(before);
    expect(JSON.stringify(before)).not.toMatch(/scoreReview|scoringReview|score_review/);
  });
  test('the teacher preview shows the student payload: no review data in it', async () => {
    const id = fixture.IDS.registered;
    await hide(id);
    expect((await keep(id, { reason: 'Private reason.' })).status).toBe(200);
    const text = JSON.stringify((await teacher.preview(id)).body);
    expect(text).not.toMatch(/scoreReview|scoringReview|score_review|Private reason/);
  });
});

describe('no score change, no AI, no credit: by construction', () => {
  test('the service and the handler never write feedback or reach for an assessment', () => {
    const service = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'scoreReview.service.js'), 'utf8');
    const controller = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'teacherAnnotation.controller.js'), 'utf8');
    const code = text => text.replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');   // what the comments say does not count
    expect(code(service)).not.toMatch(/SubmissionFeedback|updateOne|findOneAndUpdate|canonicalEvaluation|[Cc]redit|aiGateway|\.save\(/);
    expect(code(controller).match(/SubmissionFeedback\.\w+/g)).toEqual(['SubmissionFeedback.findOne']);
    expect(code(controller)).not.toMatch(/canonicalEvaluation|[Cc]redit|aiGateway|overriddenByTeacher/);
  });
  test('all the operations together leave the feedback documents byte-identical', async () => {
    const before = await feedbackBytes();
    for (const mode of MODES) {
      const id = fixture.IDS[mode];
      await snap(id); await hide(id); await keep(id); await keep(id);
      await act(id, { action: 'restore', id: (await correction(id, 'a')).entryId });
      await keep(id, { reason: 'Second look.' });
      await teacher.history(id); await teacher.preview(id);
      await teacher.scoreReview(id, { nonsense: true });
    }
    expect(await feedbackBytes()).toBe(before);
    expect(await AnnotationAudit.countDocuments({ action: 'score_review' })).toBe(4);
  });
});

describe('rollback: the previous code meeting a score_review row', () => {
  // The 6A.1 model and its syncAudit bulkWrite, against the same collection.
  const oldSchema = new mongoose.Schema({ submissionId: { type: mongoose.Schema.Types.ObjectId, required: true }, classId: mongoose.Schema.Types.ObjectId,
    requestId: { type: String, required: true }, requestHash: { type: String, required: true },
    action: { type: String, enum: ['add', 'edit', 'hide', 'restore', 'archive', 'reject'], required: true },
    actor: { type: String, required: true }, entryId: String, correctionId: String, previousRevision: Number, newRevision: Number, draftNumber: Number,
    before: mongoose.Schema.Types.Mixed, after: mongoose.Schema.Types.Mixed, changedFields: [String], visibilityChanged: Boolean, scoringReviewRequired: Boolean, legacy: Boolean,
    createdAt: { type: Date, required: true } }, { versionKey: false });
  const OldAudit = mongoose.models.OldAnnotationAudit || mongoose.model('OldAnnotationAudit', oldSchema, AnnotationAudit.collection.collectionName);
  const oldSync = (doc, list) => OldAudit.bulkWrite(list.map(row => ({ updateOne: { filter: { submissionId: doc._id, requestId: row.requestId },
    update: { $setOnInsert: { ...row, submissionId: doc._id, classId: doc.class || null, createdAt: new Date(row.createdAt) } }, upsert: true } })), { ordered: false });

  test('the re-sync neither fails nor duplicates; a row it inserts itself loses only reason and source', async () => {
    const id = fixture.IDS.registered;
    await hide(id);
    const spy = jest.spyOn(AnnotationAudit, 'bulkWrite').mockRejectedValueOnce(new Error('down'));
    expect((await keep(id, { reason: 'Kept.' })).status).toBe(200);
    spy.mockRestore();
    const doc = await load(id);
    const recent = policy.normalizeState(doc.teacherAnnotations).recent;
    await expect(oldSync(doc, recent)).resolves.toBeDefined();
    const row = await AnnotationAudit.collection.findOne({ submissionId: id, action: 'score_review' });
    expect(row).toEqual(expect.objectContaining({ action: 'score_review', actor: String(fixture.teacher._id) }));
    expect(row.after.outcome).toBe('kept');
    expect(row.reason).toBeUndefined();
    await expect(oldSync(doc, recent)).resolves.toBeDefined();
    expect(await AnnotationAudit.countDocuments({ submissionId: id, action: 'score_review' })).toBe(1);
    expect((await OldAudit.find({ submissionId: id }).sort({ newRevision: -1 }).lean())[0].action).toBe('score_review');   // the old history read
  });

  test('a row already written keeps reason and source through the old re-sync', async () => {
    const id = fixture.IDS.registered;
    await hide(id);
    expect((await keep(id, { reason: 'Kept.' })).status).toBe(200);
    const doc = await load(id);
    await oldSync(doc, policy.normalizeState(doc.teacherAnnotations).recent);
    expect(await AnnotationAudit.collection.findOne({ submissionId: id, action: 'score_review' })).toEqual(expect.objectContaining({ reason: 'Kept.', source: 'teacher_action' }));
  });
});

describe('read-only count script', () => {
  const { countScoreReviewState } = require('../scripts/countScoreReviewState');
  test('counts match, and nothing is written', async () => {
    const id = fixture.IDS.registered;
    await hide(id);
    await SubmissionFeedback.collection.updateOne({ submissionId: fixture.IDS.guest }, { $set: { overriddenByTeacher: false, customRubricScores: { criteria: [{ criterionId: 'c' }] } } });
    await Submission.collection.updateOne({ _id: fixture.IDS.guest }, { $set: { teacherAnnotations: { version: 2, revision: 1, scoringReviewRequired: true, entries: [], recent: [] } } });
    const before = JSON.stringify([await raw(Submission), await raw(SubmissionFeedback), await raw(AnnotationAudit)]);
    const first = await countScoreReviewState();
    expect(first).toEqual({ submissionsWithFlagOn: 2, submissionsWithFlagOnAndNoDraftNumber: 1, feedbackOverriddenByTeacher: 1, feedbackUsingCustomRubric: 1 });
    expect(await countScoreReviewState()).toEqual(first);
    expect(JSON.stringify([await raw(Submission), await raw(SubmissionFeedback), await raw(AnnotationAudit)])).toBe(before);
    expect(Object.values(first).every(Number.isInteger)).toBe(true);   // numbers only: no ids, no names
  });
  test('the script has no write call and an npm alias', () => {
    const script = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'countScoreReviewState.js'), 'utf8');
    expect(script).not.toMatch(/update|insert|delete|\.save\(|createIndex|dropIndex|bulkWrite/i);
    expect(require('../package.json').scripts['report:score-review']).toBe('node scripts/countScoreReviewState.js');
  });
});
