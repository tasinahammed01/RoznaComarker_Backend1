'use strict';
// Whole-assignment report (Phase 2, Stage 1): GET /api/assignments/:id/report. Teacher-only aggregation over light rows.
// Covers ownership (another teacher, student, archived or deleted assignment), an empty assignment, small data, a class + guest +
// teacher-upload mix, messy records (bad ids, null names, deleted students, missing feedback, NaN scores), the dashboard score rule
// (teacher-adjusted, completed evaluations only; unscored never counts as 0), no email anywhere, the time zone fallback, and a large
// heavy assignment on a server where a blocking sort cannot spill to disk (MongoServerError 292). Synthetic data only.
process.env.JWT_SECRET = 'assignment-report-secret';
process.env.NODE_ENV = 'test';
process.env.TEACHER_EVALUATION_EDIT_ENABLED = 'true';
jest.mock('../src/services/email.service', () => ({}));

const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const report = require('../src/services/assignmentReport.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');
const { averageOfDashboard } = require('./helpers/dashboardScore');

jest.setTimeout(180000);
const id = () => new mongoose.Types.ObjectId();
const token = user => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const EMAILS = ['teacher.one@example.com', 'teacher.two@example.com', 'kid.a@example.com', 'kid.b@example.com', 'guest.g@example.com', 'upload.u@example.com'];
let ctx;

async function setServer(params) {
  for (const [name, value] of Object.entries(params)) await mongoose.connection.db.admin().command({ setParameter: 1, [name]: value });
}

/** A submission whose canonical result state is "completed and current" (what the dashboard counts). */
const scoredSubmission = (extra = {}) => ({
  status: 'submitted', submittedAt: new Date(Date.UTC(2026, 10, 10, 9)), isLate: false, draftNumber: 1,
  ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed', correctionSourceHash: 'h',
  correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION,
  assessmentStatus: 'complete', writingCorrections: [], correctionStatistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0, total: 0 },
  ...extra
});
const rubric = (scale = 1) => ({
  CONTENT: { score: 16 * scale, maxScore: 20, comment: 'SECRET RUBRIC COMMENT' }, ORGANIZATION: { score: 14 * scale, maxScore: 20 },
  GRAMMAR: { score: 15 * scale, maxScore: 25 }, VOCABULARY: { score: 16 * scale, maxScore: 20 }, MECHANICS: { score: 6 * scale, maxScore: 10 },
  PRESENTATION: { score: 4 * scale, maxScore: 5 }
});
const currentFeedback = (submission, overallScore, extra = {}) => ({
  submissionId: submission._id, classId: submission.class, teacherId: ctx.teacher._id, studentId: submission.student,
  submissionMode: submission.submissionMode || 'registered', overallScore, grade: 'B', evaluationStatus: 'completed', evaluationSource: 'ai',
  evaluationSourceHash: 'h', assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION, rubricScores: rubric(),
  detailedFeedback: { areasForImprovement: [], strengths: [], actionSteps: [] }, teacherComments: 'SECRET TEACHER COMMENT', ...extra
});
const corrections = list => list.map(([symbol, category], i) => ({ id: `c${i}`, symbol, category, source: 'AI',
  message: 'SECRET CORRECTION TEXT', quotedText: 'SECRET QUOTE', suggestedText: 'SECRET SUGGESTION' }));
const stats = c => { const out = { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0 };
  for (const x of c) out[x.category.toLowerCase()] += 1; return { ...out, total: c.length }; };

async function insertSubmission(doc, feedback) {
  const _id = doc._id || id();
  const row = { _id, assignment: ctx.assignment._id, class: ctx.cls._id, ...doc };
  await Submission.collection.insertOne(row);
  if (feedback) await SubmissionFeedback.collection.insertOne(feedback(row));
  return row;
}

beforeAll(async () => {
  await connectInMemoryMongo();
  await Promise.all([Submission.init(), SubmissionFeedback.init()]);
});
afterAll(async () => { await disconnectInMemoryMongo(); });
beforeEach(async () => {
  await clearDatabase();
  jest.spyOn(logger, 'warn');
  jest.spyOn(logger, 'info');
  const teacher = { _id: id(), firebaseUid: 'rt1', email: EMAILS[0], role: 'teacher', displayName: 'Ms Teacher' };
  const other = { _id: id(), firebaseUid: 'rt2', email: EMAILS[1], role: 'teacher', displayName: 'Mr Other' };
  const kidA = { _id: id(), firebaseUid: 'ra', email: EMAILS[2], role: 'student', displayName: 'Ana Ray' };
  const kidB = { _id: id(), firebaseUid: 'rb', email: EMAILS[3], role: 'student', displayName: '' };
  await User.collection.insertMany([teacher, other, kidA, kidB]);
  const cls = { _id: id(), name: 'Writing 7B', teacher: teacher._id, isActive: true };
  await Class.collection.insertOne(cls);
  const assignment = { _id: id(), title: 'Persuasive essay', class: cls._id, teacher: teacher._id, isActive: true, resourceType: 'essay',
    deadline: new Date(Date.UTC(2026, 10, 20)), writingType: 'Persuasive' };
  await Assignment.collection.insertOne(assignment);
  ctx = { teacher, other, kidA, kidB, cls, assignment };
});
afterEach(() => jest.restoreAllMocks());

const get = (user, assignmentId = ctx.assignment._id, query = '') =>
  request(app).get(`/api/assignments/${assignmentId}/report${query}`).set('Authorization', `Bearer ${token(user)}`);
const logged = () => [...logger.warn.mock.calls, ...logger.info.mock.calls].map(([entry]) => (typeof entry === 'string' ? entry : JSON.stringify(entry))).join('\n');

describe('ownership and access', () => {
  test('another teacher gets 404; a student gets 403; no token gets 401; an invalid id gets 400', async () => {
    await insertSubmission(scoredSubmission({ student: ctx.kidA._id }), s => currentFeedback(s, 80));
    expect((await get(ctx.other)).status).toBe(404);
    expect((await get({ ...ctx.kidA })).status).toBe(403);
    expect((await request(app).get(`/api/assignments/${ctx.assignment._id}/report`)).status).toBe(401);
    expect((await get(ctx.teacher, 'not-an-id')).status).toBe(400);
  });

  test('an archived assignment, an archived class and a deleted assignment answer 404 to the owner too', async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { isActive: false } });
    expect((await get(ctx.teacher)).status).toBe(404);
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { isActive: true } });
    await Class.collection.updateOne({ _id: ctx.cls._id }, { $set: { isActive: false } });
    expect((await get(ctx.teacher)).status).toBe(404);
    expect((await get(ctx.teacher, id())).status).toBe(404);
  });

  test('a worksheet or flashcard assignment has no essay report (409)', async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { resourceType: 'worksheet' } });
    const res = await get(ctx.teacher);
    expect(res.status).toBe(409);
  });
});

describe('empty and small data', () => {
  test('0 submissions: zero counts, null scores, charts hidden, a "no submissions" insight', async () => {
    const res = await get(ctx.teacher);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.assignment).toMatchObject({ id: String(ctx.assignment._id), title: 'Persuasive essay', className: 'Writing 7B' });
    expect(data.counts).toMatchObject({ total: 0, scored: 0, reviewed: 0, bySource: { class: 0, guest: 0, teacherUpload: 0 }, skippedRows: 0, capped: false });
    expect(data.scores).toMatchObject({ average: null, median: null, highest: null, lowest: null, needsRevisionPct: null, reviewedPct: null });
    expect(data.scores.bands.map(b => b.count)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(data.smallData).toEqual({ distributionHidden: true, timelineHidden: true });
    expect(data.students).toEqual([]);
    expect(data.insights.map(i => i.code)).toEqual(['NO_SUBMISSIONS']);
  });

  test('1 and 2 submissions: numbers are shown but the distribution and the trend stay hidden', async () => {
    await insertSubmission(scoredSubmission({ student: ctx.kidA._id }), s => currentFeedback(s, 72));
    let data = (await get(ctx.teacher)).body.data;
    expect(data.scores).toMatchObject({ average: 72, median: 72, highest: 72, lowest: 72 });
    expect(data.smallData).toEqual({ distributionHidden: true, timelineHidden: true });
    await insertSubmission(scoredSubmission({ student: ctx.kidB._id }), s => currentFeedback(s, 91));
    data = (await get(ctx.teacher)).body.data;
    expect(data.counts.total).toBe(2);
    expect(data.smallData).toEqual({ distributionHidden: true, timelineHidden: true });
  });
});

describe('class, guest and teacher-upload mix', () => {
  beforeEach(async () => {
    const c1 = corrections([['SP', 'MECHANICS'], ['SP', 'MECHANICS'], ['AGR', 'GRAMMAR'], ['T', 'GRAMMAR']]);
    const c2 = corrections([['AGR', 'GRAMMAR'], ['AGR', 'GRAMMAR'], ['WC', 'VOCABULARY']]);
    ctx.a = await insertSubmission(scoredSubmission({ student: ctx.kidA._id, writingCorrections: c1, correctionStatistics: stats(c1),
      submittedAt: new Date(Date.UTC(2026, 10, 10, 23, 30)) }), s => currentFeedback(s, 85, { teacherReviewedAt: new Date() }));
    ctx.g = await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Gus Guest', normalizedEmail: EMAILS[4] },
      writingCorrections: c2, correctionStatistics: stats(c2), submittedAt: new Date(Date.UTC(2026, 10, 12, 8)) }), s => currentFeedback(s, 55));
    ctx.u = await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { normalizedEmail: EMAILS[5] },
      teacherUpload: { uploadedBy: ctx.teacher._id, batchId: 'b1', typedName: 'Uma Upload', uploadedAt: new Date(), email: { status: 'none' } },
      submittedAt: new Date(Date.UTC(2026, 10, 12, 9)), isLate: true }), s => currentFeedback(s, 66));
    ctx.p = await insertSubmission(scoredSubmission({ student: ctx.kidB._id, evaluationStatus: 'pending', submittedAt: new Date(Date.UTC(2026, 10, 13, 9)) }), null);
  });

  test('counts by source, scores of scored rows only, bands, rubric, errors and labelled student rows', async () => {
    const res = await get(ctx.teacher);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.counts).toMatchObject({ total: 4, bySource: { class: 2, guest: 1, teacherUpload: 1 }, scored: 3, inProgress: 1, notScored: 0, reviewed: 1, late: 1 });
    // The pending submission never counts as 0: (85 + 55 + 66) / 3 = 68.7
    expect(data.scores).toMatchObject({ average: 68.7, median: 66, highest: 85, lowest: 55, onTrack: 1, needsRevision: 1, needsAttention: 1,
      needsRevisionPct: 67, needsAttentionPct: 33, reviewedPct: 25 });
    expect(data.scores.bands).toEqual([
      { key: '0-49', label: '0-49', min: 0, max: 49, count: 0 }, { key: '50-59', label: '50-59', min: 50, max: 59, count: 1 },
      { key: '60-69', label: '60-69', min: 60, max: 69, count: 1 }, { key: '70-79', label: '70-79', min: 70, max: 79, count: 0 },
      { key: '80-89', label: '80-89', min: 80, max: 89, count: 1 }, { key: '90-100', label: '90-100', min: 90, max: 100, count: 0 }]);
    expect(data.smallData).toEqual({ distributionHidden: false, timelineHidden: false });
    expect(data.rubric.kind).toBe('builtin');
    expect(data.rubric.criteria.map(c => [c.key, c.averagePct])).toEqual([['CONTENT', 80], ['ORGANIZATION', 70], ['GRAMMAR', 60],
      ['VOCABULARY', 80], ['MECHANICS', 60], ['PRESENTATION', 80]]);
    expect(data.rubric.strongestKey).toBe('CONTENT');
    expect(data.rubric.weakestKey).toBe('GRAMMAR');
    expect(data.errors).toMatchObject({ basis: 'ai_analysis', total: 7 });
    expect(data.errors.categories.find(c => c.key === 'GRAMMAR')).toMatchObject({ count: 4, pct: 57 });
    expect(data.errors.symbols[0]).toMatchObject({ symbol: 'AGR', count: 3, pct: 43, category: 'GRAMMAR' });
    expect(data.errors.symbols[0].label).toEqual(expect.any(String));
    const byName = Object.fromEntries(data.students.map(s => [s.name, s]));
    expect(byName['Ana Ray']).toMatchObject({ source: 'class', score: 85, band: 'on_track', assessment: 'scored', reviewed: true, needsAttention: false });
    expect(byName['Ana Ray'].topIssue).toMatchObject({ symbol: 'SP', count: 2 });
    expect(byName['Gus Guest']).toMatchObject({ source: 'guest', score: 55, band: 'needs_attention', needsAttention: true, attentionReasons: ['LOW_SCORE'] });
    expect(byName['Uma Upload']).toMatchObject({ source: 'teacher_upload', score: 66, band: 'needs_revision', isLate: true });
    expect(byName['Student']).toMatchObject({ source: 'class', score: null, band: null, assessment: 'in_progress' });
    expect(data.students.every(s => /^[a-f0-9]{24}$/.test(s.submissionId))).toBe(true);
  });

  test('the timeline buckets days in the teacher\'s time zone and fills gaps; an invalid zone falls back to UTC', async () => {
    const utc = (await get(ctx.teacher, ctx.assignment._id, '?tz=Not/AZone')).body.data;
    expect(utc.timeZone).toBe('UTC');
    expect(utc.timeline).toEqual({ granularity: 'day', points: [{ date: '2026-11-10', count: 1 }, { date: '2026-11-11', count: 0 },
      { date: '2026-11-12', count: 2 }, { date: '2026-11-13', count: 1 }] });
    // 23:30 UTC on the 10th is the 11th in Dhaka (UTC+6).
    const dhaka = (await get(ctx.teacher, ctx.assignment._id, '?tz=Asia/Dhaka')).body.data;
    expect(dhaka.timeZone).toBe('Asia/Dhaka');
    expect(dhaka.timeline.points[0]).toEqual({ date: '2026-11-11', count: 1 });
    for (const bad of ['', '?tz=', '?tz=../../etc', '?tz[]=UTC', '?tz=' + 'A'.repeat(80), '?tz=%00']) {
      const res = await get(ctx.teacher, ctx.assignment._id, bad);
      expect(res.status).toBe(200);
      expect(res.body.data.timeZone).toBe('UTC');
    }
  });

  test('deterministic insights are built from the numbers', async () => {
    const data = (await get(ctx.teacher)).body.data;
    const byCode = Object.fromEntries(data.insights.map(i => [i.code, i.text]));
    expect(byCode.AVERAGE).toBe('The average score is 68.7% across 3 scored submissions.');
    expect(byCode.TOP_ERROR_CATEGORY).toMatch(/^Grammar errors are the most common issue \(57% of 7 corrections\)\.$/);
    expect(byCode.LOW_SCORES).toBe('1 student scored below 60%.');
    expect(byCode.RUBRIC_RANGE).toBe('Strongest area: Content (80%). Weakest area: Grammar (60%).');
    expect(byCode.IN_PROGRESS).toBe('1 submission is still being assessed.');
    expect(byCode.AWAITING_REVIEW).toBe('2 scored submissions are waiting for your review.');
    expect(data.insights.length).toBeLessThanOrEqual(7);
  });

  // Narrowed for "Common mistakes" (which shows short, anonymous example corrections on purpose): correction text may appear ONLY inside
  // commonMistakes.types[].examples, as original / corrected / explanation. Everywhere else in the payload, and in every log line, it still
  // must not; the email, "@", comment, OCR and internal-key checks are unchanged; and the section itself carries no name or id.
  test('no email address, comment or correction text reaches the payload or the logs', async () => {
    const res = await get(ctx.teacher);
    const { commonMistakes, ...data } = res.body.data;
    const body = JSON.stringify({ ...res.body, data });
    for (const email of EMAILS) expect(body).not.toContain(email);
    expect(body).not.toContain('@');
    expect(body).not.toContain('SECRET');
    expect(body).not.toMatch(/normalizedEmail|teacherId|uploadedBy|evaluationSourceHash|ocrPages|writingCorrections/);
    // The section: correction text only in the three example fields; nothing else from a correction, a submission or a student.
    expect(commonMistakes.types.some(t => t.examples.length)).toBe(true);   // the planted text does reach the examples (Ana and Gus share AGR)
    for (const type of commonMistakes.types) {
      expect(Object.keys(type).sort()).toEqual(['category', 'examples', 'isCommon', 'label', 'occurrenceCount', 'studentCount', 'totalStudents', 'typeCode']);
      for (const example of type.examples) expect(Object.keys(example).sort()).toEqual(['corrected', 'explanation', 'original']);
    }
    expect(JSON.stringify({ ...commonMistakes, types: commonMistakes.types.map(({ examples: _examples, ...type }) => type) })).not.toContain('SECRET');
    const section = JSON.stringify(commonMistakes);
    for (const email of EMAILS) expect(section).not.toContain(email);
    expect(section).not.toContain('@');
    expect(section).not.toMatch(/normalizedEmail|teacherId|uploadedBy|evaluationSourceHash|ocrPages|writingCorrections|submissionId|"name"/);
    for (const name of ['Ana Ray', 'Gus Guest', 'Uma Upload', '"Student"']) expect(section).not.toContain(name);
    for (const doc of [ctx.a, ctx.g, ctx.u, ctx.p, ctx.kidA, ctx.kidB, ctx.teacher]) expect(section).not.toContain(String(doc._id));
    const logs = logged();
    for (const email of EMAILS) expect(logs).not.toContain(email);
    expect(logs).not.toContain('SECRET');
  });
});

describe('the dashboard score rule', () => {
  test('teacher-adjusted, completed and current evaluations only; the report average equals the dashboard average', async () => {
    // Scored (AI 70, teacher raises GRAMMAR by 5: 75), scored 90, stale (old evaluation version), failed, blocked, partial, missing feedback.
    await insertSubmission(scoredSubmission({ student: ctx.kidA._id }), s => currentFeedback(s, 70, {
      teacherEvaluation: { draftNumber: 1, criteria: { GRAMMAR: { score: 20 } } } }));
    await insertSubmission(scoredSubmission({ student: ctx.kidB._id }), s => currentFeedback(s, 90));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Stale' } }), s => currentFeedback(s, 10, { evaluationVersion: 'old' }));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Failed' }, evaluationStatus: 'failed' }), s => currentFeedback(s, 0, { evaluationStatus: 'failed' }));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Blocked' }, semanticStatus: 'failed', correctionStatus: 'partial', evaluationStatus: 'blocked' }), s => currentFeedback(s, 0, { evaluationStatus: 'blocked' }));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Partial' }, evaluationStatus: 'partial' }), s => currentFeedback(s, 20, { evaluationStatus: 'partial' }));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'No feedback' } }), null);
    // Exact-source rows: the dashboard verifies real page text; the report reads statuses and hashes only. Both must agree.
    const { sha } = require('../src/utils/sourceFidelity');
    const exact = (status, pageStatus) => { const fileId = id(), text = 'SECRET EXACT PAGE TEXT';
      return { files: [fileId], sourceFidelityMode: 'astra_verified', sourceFidelityStatus: status, sourceFidelityVersion: 'astra-fable-exact-v1',
        sourceTranscriptExact: text, sourceTranscriptSha256: sha(text),
        ocrPages: [{ fileId, fileOrder: 0, pageIndex: 0, pageNumber: 1, sourceFidelityMode: 'astra_verified', sourceFidelityStatus: pageStatus,
          sourceFidelityVersion: 'astra-fable-exact-v1', sourceTextExact: text, sourceTextSha256: sha(text) }] }; };
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Exact ok' }, ...exact('MODEL_AGREED', 'MODEL_AGREED') }), s => currentFeedback(s, 60));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: 'Exact review' }, ...exact('HUMAN_REVIEW_REQUIRED', 'OCR_UNCERTAIN') }), s => currentFeedback(s, 5));

    const data = (await get(ctx.teacher)).body.data;
    const ids = data.students.map(s => s.submissionId);
    const dashboard = await averageOfDashboard(app, token(ctx.teacher), ids);
    expect(dashboard).toBe(75);   // (75 + 90 + 60) / 3
    expect(data.students.find(s => s.name === 'Exact ok').score).toBe(60);
    expect(data.students.find(s => s.name === 'Exact review')).toMatchObject({ score: null, assessment: 'not_scored', attentionReasons: ['NOT_SCORED'] });
    expect(JSON.stringify(data)).not.toContain('SECRET');
    expect(data.scores.average).toBe(dashboard);
    expect(data.counts.scored).toBe(3);
    const scores = Object.fromEntries(data.students.map(s => [s.name, s.score]));
    expect(scores).toMatchObject({ 'Ana Ray': 75, Student: 90, Stale: null, Failed: null, Blocked: null, Partial: null, 'No feedback': null });
    const groups = Object.fromEntries(data.students.map(s => [s.name, s.assessment]));
    expect(groups).toMatchObject({ Failed: 'not_scored', Blocked: 'not_scored' });
    expect(data.counts.notScored).toBeGreaterThanOrEqual(2);
    for (const name of ['Failed', 'Blocked']) expect(data.students.find(s => s.name === name)).toMatchObject({ needsAttention: true, attentionReasons: ['NOT_SCORED'] });
    expect(data.insights.find(i => i.code === 'NOT_SCORED').text).toMatch(/could not be scored/);
  });
});

describe('messy records', () => {
  test('null names, a deleted student, a NaN score, a non-ObjectId student and a bad date are handled; one bad row is skipped and counted', async () => {
    await insertSubmission(scoredSubmission({ student: id() /* deleted account */ }), s => currentFeedback(s, 64));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: null } }), s => currentFeedback(s, Number.NaN));
    await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: '   ' }, submittedAt: 'not a date', createdAt: null }), s => currentFeedback(s, 77));
    await insertSubmission(scoredSubmission({ student: 'legacy-string-id' }), s => currentFeedback(s, 81));
    await insertSubmission(scoredSubmission({ student: ctx.kidB._id, writingCorrections: [null, 7, { symbol: '' }, { symbol: 'SP', category: 'MECHANICS' }] }), s => currentFeedback(s, 50));
    await Submission.collection.insertOne({ _id: 'string-id-row', assignment: ctx.assignment._id, class: ctx.cls._id, submittedAt: new Date() });

    const res = await get(ctx.teacher);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.counts.total).toBe(5);
    expect(data.counts.skippedRows).toBe(1);
    expect(data.students.every(s => s.name === 'Student')).toBe(true);
    expect(data.scores.average).toBe(68);   // 64, 77, 81, 50; NaN is not a score
    expect(data.counts.scored).toBe(4);
    expect(data.timeline.points.reduce((n, p) => n + p.count, 0)).toBe(4);   // the undated row is left out of the trend only
    const warn = logger.warn.mock.calls.map(([e]) => e).find(e => e?.event === 'assignment_report_rows_skipped');
    expect(warn).toMatchObject({ code: 'ASSIGNMENT_REPORT_ROWS_SKIPPED', assignmentId: String(ctx.assignment._id), skipped: 1, reasons: { INVALID_ID: 1 } });
  });

  test('a custom rubric averages its criteria by level percentage', async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { rubrics: { totalPoints: 100, criteria: [
      { id: 'thesis', name: 'Thesis', weight: 50, levels: [{ title: 'Strong', score: 100, description: 'Clear' }, { title: 'Weak', score: 40, description: 'Vague' }] },
      { id: 'evidence', name: 'Evidence', weight: 50, levels: [{ title: 'Strong', score: 100, description: 'Rich' }, { title: 'Weak', score: 40, description: 'Thin' }] }] } } });
    const custom = (thesis, evidence) => ({ overallScore: (thesis + evidence) / 2, criteria: [
      { criterionId: 'thesis', title: 'Thesis', configuredLevelPercentage: thesis, comment: 'SECRET' },
      { criterionId: 'evidence', title: 'Evidence', configuredLevelPercentage: evidence }] });
    await insertSubmission(scoredSubmission({ student: ctx.kidA._id }), s => currentFeedback(s, 70, { customRubricScores: custom(100, 40) }));
    await insertSubmission(scoredSubmission({ student: ctx.kidB._id }), s => currentFeedback(s, 70, { customRubricScores: custom(100, 40) }));
    const settings = await require('../src/services/evaluationSettingsContext.service').currentEvaluationSettings(await Assignment.findById(ctx.assignment._id).lean());
    await SubmissionFeedback.collection.updateMany({}, { $set: { evaluationRubricSourceHash: settings.rubricHash } });
    const data = (await get(ctx.teacher)).body.data;
    expect(data.rubric.kind).toBe('custom');
    expect(data.rubric.criteria).toEqual([{ key: 'thesis', label: 'Thesis', averagePct: 100, count: 2 }, { key: 'evidence', label: 'Evidence', averagePct: 40, count: 2 }]);
    expect(data.rubric).toMatchObject({ strongestKey: 'thesis', weakestKey: 'evidence' });
    expect(JSON.stringify(data)).not.toContain('SECRET');
  });
});

describe('a large heavy assignment on a server where a blocking sort cannot spill to disk', () => {
  const heavyPage = n => ({ fileId: id(), fileOrder: 0, pageIndex: n, pageNumber: 1, text: 'SECRET OCR '.repeat(200), sourceTextExact: 'SECRET PAGE TEXT',
    words: Array.from({ length: 1500 }, (_, i) => ({ id: `w${i}`, text: 'SECRETWORD', bbox: { x: 0.1, y: 0.2, w: 0.03, h: 0.02 }, confidence: 0.98 })) });
  beforeAll(async () => setServer({ allowDiskUseByDefault: false, internalQueryMaxBlockingSortMemoryUsageBytes: 2 * 1024 * 1024 }));
  afterAll(async () => setServer({ allowDiskUseByDefault: true, internalQueryMaxBlockingSortMemoryUsageBytes: 100 * 1024 * 1024 }));

  test('heavy rows still report; no query sorts in the database; projections are inclusion-only and light', async () => {
    for (let i = 0; i < 30; i++) {
      await insertSubmission(scoredSubmission({ submissionMode: 'guest', guest: { displayName: `G${i}` }, submittedAt: new Date(Date.UTC(2026, 10, 1 + (i % 9))),
        ocrPages: [heavyPage(0)], transcriptPages: [heavyPage(1)], transcriptText: 'SECRET TRANSCRIPT', combinedOcrText: 'SECRET OCR TEXT',
        teacherAnnotations: { blob: 'SECRET ANNOTATION '.repeat(300) },
        writingCorrections: corrections(Array.from({ length: 30 }, () => ['SP', 'MECHANICS'])) }), s => currentFeedback(s, 50 + i));
    }
    const real = Submission.find.bind(Submission), queries = [];
    jest.spyOn(Submission, 'find').mockImplementation((...args) => { const q = real(...args); queries.push(q); return q; });
    const res = await get(ctx.teacher);
    Submission.find.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.data.counts.total).toBe(30);
    // Narrowed for "Common mistakes": correction text may appear ONLY in commonMistakes.types[].examples (original / corrected /
    // explanation). Nothing heavy (page text, word data, transcripts, the overlay) appears anywhere.
    const { commonMistakes, ...data } = res.body.data;
    expect(JSON.stringify({ ...res.body, data })).not.toContain('SECRET');
    expect(JSON.stringify({ ...commonMistakes, types: commonMistakes.types.map(({ examples: _examples, ...type }) => type) })).not.toContain('SECRET');
    for (const heavy of ['SECRET OCR', 'SECRETWORD', 'SECRET PAGE TEXT', 'SECRET TRANSCRIPT', 'SECRET ANNOTATION', '"words"'])
      expect(JSON.stringify(res.body)).not.toContain(heavy);
    // Reads: the main read below is unchanged (still asserted). "Common mistakes" adds exactly one more read here: the correction text of
    // the submissions with current corrections (one per 500). None of these essays was edited by the teacher, so no transcript read.
    expect(queries).toHaveLength(2);
    const extra = queries[1];
    expect(extra.getOptions().sort).toBeUndefined();
    expect(Object.values(extra.projection()).every(v => v === 1)).toBe(true);
    expect(Object.keys(extra.projection()).sort()).toEqual(['_id', 'draftNumber', 'guest.normalizedEmail', 'teacherAnnotations', 'writingCorrections.category',
      'writingCorrections.id', 'writingCorrections.message', 'writingCorrections.quotedText', 'writingCorrections.source', 'writingCorrections.suggestedText',
      'writingCorrections.symbol']);
    for (const heavy of ['ocrPages', 'ocrPages.words', 'ocrPages.text', 'ocrData', 'transcriptPages', 'transcriptText', 'combinedOcrText', 'sourceTranscriptExact', 'writingCorrections'])
      expect(Object.prototype.hasOwnProperty.call(extra.projection(), heavy)).toBe(false);
    const q = queries[0];
    expect(q.getOptions().sort).toBeUndefined();
    const projection = q.projection();
    expect(Object.values(projection).every(v => v === 1)).toBe(true);
    for (const heavy of ['ocrPages', 'ocrPages.words', 'ocrPages.text', 'ocrPages.sourceTextExact', 'transcriptPages', 'transcriptText', 'combinedOcrText',
      'teacherAnnotations', 'sourceTranscriptExact', 'writingCorrections', 'writingCorrections.message', 'writingCorrections.quotedText', 'guest.normalizedEmail'])
      expect(Object.prototype.hasOwnProperty.call(projection, heavy)).toBe(false);
    const fetched = JSON.stringify(await Submission.find(q.getFilter()).select(projection).limit(5).lean());
    expect(fetched).not.toContain('SECRET');
    expect(fetched).not.toContain('"words"');
  });

  test('more rows than the scan cap: the report answers, flags capped, and logs the cap with ids and a code only', async () => {
    const rows = Array.from({ length: report.SCAN_CAP + 5 }, () => ({ _id: id(), assignment: ctx.assignment._id, class: ctx.cls._id, submissionMode: 'guest',
      guest: { displayName: 'Many', normalizedEmail: EMAILS[4] }, status: 'submitted', submittedAt: new Date(Date.UTC(2026, 10, 2)) }));
    await Submission.collection.insertMany(rows);
    const res = await get(ctx.teacher);
    expect(res.status).toBe(200);
    expect(res.body.data.counts).toMatchObject({ total: report.SCAN_CAP, capped: true });
    const cap = logger.warn.mock.calls.map(([e]) => e).find(e => e?.event === 'assignment_report_cap_reached');
    expect(cap).toEqual({ event: 'assignment_report_cap_reached', code: 'ASSIGNMENT_REPORT_CAP_REACHED', assignmentId: String(ctx.assignment._id), cap: report.SCAN_CAP });
    expect(logged()).not.toContain(EMAILS[4]);
  });
});

describe('pure helpers', () => {
  test('safeTimeZone never throws and only accepts real IANA zones', () => {
    expect(report.safeTimeZone('Europe/London')).toBe('Europe/London');
    expect(report.safeTimeZone('UTC')).toBe('UTC');
    for (const bad of [undefined, null, '', 'Mars/Base', '../x', ['UTC'], { a: 1 }, 'A'.repeat(100), 42]) expect(report.safeTimeZone(bad)).toBe('UTC');
  });

  test('a long gap switches the trend to weekly buckets', () => {
    const points = report.timelineOf([new Date(Date.UTC(2026, 0, 1)), new Date(Date.UTC(2026, 5, 1))], 'UTC');
    expect(points.granularity).toBe('week');
    expect(points.points.reduce((n, p) => n + p.count, 0)).toBe(2);
    expect(points.points[0].date).toBe('2025-12-29');   // the Monday of that week
  });

  test('exact-source rows are judged by their verification statuses without page text', () => {
    const base = { sourceFidelityMode: 'astra_verified', sourceFidelityStatus: 'MODEL_AGREED', sourceTranscriptSha256: 'a'.repeat(64), files: ['f1'],
      ocrPages: [{ fileId: 'f1', fileOrder: 0, pageIndex: 0, sourceFidelityStatus: 'MODEL_AGREED', sourceFidelityVersion: 'astra-fable-exact-v1', sourceTextSha256: 'b'.repeat(64) }] };
    expect(report.sourceStatusEligible(base)).toBe(true);
    expect(report.sourceStatusEligible({ ...base, sourceFidelityStatus: 'HUMAN_REVIEW_REQUIRED' })).toBe(false);
    expect(report.sourceStatusEligible({ ...base, ocrPages: [{ ...base.ocrPages[0], sourceTextSha256: undefined }] })).toBe(false);
    expect(report.sourceStatusEligible({ ...base, sourceHumanReviewSummary: { required: true } })).toBe(false);
  });
});
