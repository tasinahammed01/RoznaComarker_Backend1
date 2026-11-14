'use strict';
// AI summary (Stage 4) over HTTP. aiGateway.generate is mocked: no real AI call is ever made. Synthetic data only.
process.env.JWT_SECRET = 'assignment-report-summary-secret';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.OPENROUTER_API_KEY = 'test-key-not-real';
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/modules/assignmentReportPdfGenerator', () => ({ generateAssignmentReportPdf: jest.fn() }));

const fs = require('fs');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const gateway = require('../src/services/aiGateway.service');
const summary = require('../src/services/assignmentReportSummary.service');
const { generateAssignmentReportPdf } = require('../src/modules/assignmentReportPdfGenerator');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');

jest.setTimeout(240000);
const id = () => new mongoose.Types.ObjectId();
const token = user => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
const SENTINEL = 'SECRET-SUMMARY-SENTINEL';
let ctx, generate, lastHtml;

/** The input the service sent to the model, parsed back out of the prompt. */
const inputOf = messages => JSON.parse(/BEGIN_REPORT_DATA\n([\s\S]*?)\nEND_REPORT_DATA/.exec(messages[messages.length - 1].content)[1]);
const outputFor = input => JSON.stringify({
  headline: `The class average is ${input.scores.average}% across ${input.counts.scored} scored submissions.`,
  findings: [`The highest score is ${input.scores.highest}%.`, `The lowest score is ${input.scores.lowest}%.`, `${input.scores.needsRevisionPct}% of scored submissions are below 80%.`],
  nextSteps: ['Review the most common error type with the class.', 'Pair stronger writers with students who need revision.'],
  caution: 'Counts come from the AI analysis and may include items the teacher removed.'
});
const aiSuccess = async (options) => ({ value: options.validate(outputFor(inputOf(options.messages))), model: options.config.chain[0].model,
  usage: { prompt_tokens: 910, completion_tokens: 240 }, metadata: { usage: { prompt_tokens: 910, completion_tokens: 240 } } });

async function addScored(score, extra = {}) {
  const _id = id();
  await Submission.collection.insertOne({ _id, assignment: ctx.assignment._id, class: ctx.cls._id, submissionMode: 'guest', guest: { displayName: `Guest ${score}`, normalizedEmail: 'guest@example.com' },
    status: 'submitted', submittedAt: new Date(Date.UTC(2026, 10, 10, 9)), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
    correctionSourceHash: 'h', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION,
    assessmentStatus: 'complete', writingCorrections: [{ id: 'c1', symbol: 'SP', category: 'MECHANICS' }],
    correctionStatistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 1, total: 1 }, ...extra });
  await SubmissionFeedback.collection.insertOne({ submissionId: _id, classId: ctx.cls._id, teacherId: ctx.teacher._id, overallScore: score, grade: 'B', evaluationStatus: 'completed',
    evaluationSource: 'ai', evaluationSourceHash: 'h', assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
    rubricScores: { CONTENT: { score: 16, maxScore: 20 }, GRAMMAR: { score: 15, maxScore: 25 } } });
}

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), SubmissionFeedback.init()]); });
afterAll(async () => { await disconnectInMemoryMongo(); });
beforeEach(async () => {
  await clearDatabase();
  jest.restoreAllMocks();
  process.env.ASSIGNMENT_REPORT_SUMMARY_ENABLED = 'true';
  delete process.env.ASSIGNMENT_REPORT_SUMMARY_AI_MODEL;
  generate = jest.spyOn(gateway, 'generate').mockImplementation(aiSuccess);
  generateAssignmentReportPdf.mockImplementation(async (html, outputPath) => { lastHtml = html; await fs.promises.writeFile(outputPath, '%PDF-1.4'); return { path: outputPath, pageCount: 1 }; });
  for (const level of ['warn', 'error', 'info', 'metric']) jest.spyOn(logger, level);
  const teacher = { _id: id(), firebaseUid: `s-${id()}`, email: 'sum.teacher@example.com', role: 'teacher', displayName: 'Ms Teacher' };
  const other = { _id: id(), firebaseUid: `s-${id()}`, email: 'sum.other@example.com', role: 'teacher' };
  const kid = { _id: id(), firebaseUid: `s-${id()}`, email: 'sum.kid@example.com', role: 'student', displayName: 'Kid Name' };
  await User.collection.insertMany([teacher, other, kid]);
  const cls = { _id: id(), name: 'Writing 7B', teacher: teacher._id, isActive: true, status: 'active', joinCode: `J${String(id()).slice(-8)}` };
  await Class.collection.insertOne(cls);
  await Membership.collection.insertOne({ student: kid._id, class: cls._id, status: 'active' });
  const assignment = { _id: id(), title: 'Persuasive essay', class: cls._id, teacher: teacher._id, isActive: true, resourceType: 'essay', qrToken: `qr-${id()}`,
    allowGuestSubmission: true, deadline: new Date(Date.now() + 7 * 86400000), createdAt: new Date(), updatedAt: new Date() };
  await Assignment.collection.insertOne(assignment);
  ctx = { teacher, other, kid, cls, assignment };
  for (const score of [85, 55, 66]) await addScored(score);
});
afterAll(() => { delete process.env.ASSIGNMENT_REPORT_SUMMARY_ENABLED; });

const as = (user, req) => (user ? req.set('Authorization', `Bearer ${token(user)}`) : req);
const post = (user, assignmentId = ctx.assignment._id) => as(user, request(app).post(`/api/assignments/${assignmentId}/report/summary`));
const report = async (user = ctx.teacher) => (await as(user, request(app).get(`/api/assignments/${ctx.assignment._id}/report?tz=UTC`))).body.data;
const stored = async () => (await Assignment.collection.findOne({ _id: ctx.assignment._id })).reportSummary;

describe('flag', () => {
  test('off by default: the report says disabled, the endpoint answers 404 and the model is never called', async () => {
    delete process.env.ASSIGNMENT_REPORT_SUMMARY_ENABLED;
    expect((await report()).summary).toEqual({ enabled: false, state: 'disabled' });
    const res = await post(ctx.teacher);
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ success: false, code: 'SUMMARY_DISABLED', message: 'Summaries are not available.' });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('access', () => {
  test('owner only: another teacher 404, student 403, no login 401, bad id 400, non-essay 409; the model is not called', async () => {
    expect((await post(ctx.other)).status).toBe(404);
    expect((await post(ctx.kid)).status).toBe(403);
    expect((await post(null)).status).toBe(401);
    expect((await post(ctx.teacher, 'nope')).status).toBe(400);
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { resourceType: 'worksheet' } });
    expect((await post(ctx.teacher)).status).toBe(409);
    expect(generate).not.toHaveBeenCalled();
  });

  test('fewer than 3 scored submissions: 422 with a fixed code, and the report says so', async () => {
    await SubmissionFeedback.collection.deleteMany({ overallScore: { $in: [55, 66] } });
    expect((await report()).summary).toMatchObject({ enabled: true, state: 'not_enough_data', minimumScored: 3 });
    const res = await post(ctx.teacher);
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ success: false, code: 'SUMMARY_NOT_ENOUGH_DATA', message: 'A summary needs at least 3 scored submissions.' });
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('generate, cache and staleness', () => {
  test('generates through the gateway with aggregates only, stores it, and returns it fresh', async () => {
    const res = await post(ctx.teacher);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'ai', cached: false, state: 'fresh', remainingToday: 4,
      current: { headline: 'The class average is 68.7% across 3 scored submissions.', label: 'AI-generated summary. Please review before sharing.' } });
    expect(generate).toHaveBeenCalledTimes(1);
    const options = generate.mock.calls[0][0];
    expect(options.feature).toBe('assignment_report_summary');
    expect(options.config.chain).toEqual([{ provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', fallbackIndex: 0 }]);
    const sent = JSON.stringify(options.messages);
    for (const secret of ['Guest 85', 'guest@example.com', 'Persuasive essay', 'Writing 7B', String(ctx.assignment._id)]) expect(sent).not.toContain(secret);
    const saved = await stored();
    expect(saved).toMatchObject({ source: 'ai', model: 'anthropic/claude-haiku-5.5', promptVersion: summary.PROMPT_VERSION,
      summary: { headline: 'The class average is 68.7% across 3 scored submissions.' } });
    expect(saved.inputFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(saved.generatedAt).toBeInstanceOf(Date);
    expect((await report()).summary).toMatchObject({ enabled: true, state: 'fresh', remainingToday: 4, current: { headline: expect.stringContaining('68.7%') } });
    const metric = logger.metric.mock.calls.map(([e]) => e).find(e => e?.event === 'assignment_report_summary_generated');
    expect(metric).toEqual({ event: 'assignment_report_summary_generated', assignmentId: String(ctx.assignment._id), model: 'anthropic/claude-haiku-5.5', inputTokens: 910, outputTokens: 240 });
  });

  test('unchanged data: the cached summary is returned without calling the model and without using the daily allowance', async () => {
    await post(ctx.teacher);
    const again = await post(ctx.teacher);
    expect(again.status).toBe(200);
    expect(again.body.data).toMatchObject({ source: 'ai', cached: true, state: 'fresh', remainingToday: 4 });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('changed data: the report marks it out of date, the PDF leaves it out, and Regenerate calls the model again', async () => {
    await post(ctx.teacher);
    await as(ctx.teacher, request(app).get(`/api/pdf/assignment-report/${ctx.assignment._id}`));
    expect(lastHtml).toContain('AI-generated summary. Please review before sharing.');
    expect(lastHtml).toContain('The class average is 68.7% across 3 scored submissions.');
    await addScored(91);
    const r = await report();
    expect(r.summary).toMatchObject({ state: 'stale', current: { headline: expect.stringContaining('68.7%') } });
    await as(ctx.teacher, request(app).get(`/api/pdf/assignment-report/${ctx.assignment._id}`));
    expect(lastHtml).not.toContain('AI-generated summary');
    expect(lastHtml).not.toContain('68.7% across 3');
    const regenerated = await post(ctx.teacher);
    expect(regenerated.body.data).toMatchObject({ source: 'ai', cached: false, state: 'fresh', remainingToday: 3 });
    expect(generate).toHaveBeenCalledTimes(2);
  });

  test('a disabled flag never serves a stored summary (report, PDF)', async () => {
    await post(ctx.teacher);
    delete process.env.ASSIGNMENT_REPORT_SUMMARY_ENABLED;
    expect((await report()).summary).toEqual({ enabled: false, state: 'disabled' });
    await as(ctx.teacher, request(app).get(`/api/pdf/assignment-report/${ctx.assignment._id}`));
    expect(lastHtml).not.toContain('AI-generated summary');
  });
});

describe('fallback', () => {
  test.each([
    ['a timeout', async () => { throw Object.assign(new Error('AI total budget was exhausted. INTERNAL'), { code: 'AI_TOTAL_BUDGET_EXHAUSTED' }); }, 'AI_UNAVAILABLE'],
    ['invalid output (an invented number)', async (options) => options.validate(JSON.stringify({ headline: 'The average is 99% for 77 students today.',
      findings: ['a finding here', 'another finding', 'a third finding'], nextSteps: ['a step here', 'another step'], caution: 'Please review.' })), 'AI_INVALID_OUTPUT']
  ])('%s: the deterministic insights come back as "fallback", nothing is stored, the attempt counts', async (_name, impl, reason) => {
    generate.mockImplementation(impl);
    const res = await post(ctx.teacher);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ source: 'fallback', reason, remainingToday: 4, state: 'none' });
    expect(res.body.data.insights.map(i => i.code)).toContain('AVERAGE');
    expect(JSON.stringify(res.body)).not.toMatch(/INTERNAL|99%|77 students/);
    const saved = await stored();
    expect(saved?.summary).toBeUndefined();
    expect(saved?.inputFingerprint).toBeUndefined();
    const entry = logger.warn.mock.calls.map(([e]) => e).find(e => e?.event === 'assignment_report_summary_fallback');
    expect(entry).toEqual({ event: 'assignment_report_summary_fallback', code: reason, assignmentId: String(ctx.assignment._id) });
  });

  test('a failed regeneration keeps the previous (now stale) summary and never replaces it with the failure', async () => {
    await post(ctx.teacher);
    await addScored(91);
    generate.mockImplementation(async () => { throw new Error('down'); });
    const res = await post(ctx.teacher);
    expect(res.body.data).toMatchObject({ source: 'fallback', state: 'stale' });
    expect((await stored()).summary.headline).toContain('68.7%');
  });
});

describe('limits', () => {
  test('5 attempts per assignment per day; the 6th answers 429 SUMMARY_DAILY_LIMIT; a new day resets it', async () => {
    generate.mockImplementation(async () => { throw new Error('down'); });
    for (let i = 0; i < 5; i += 1) expect((await post(ctx.teacher)).body.data.remainingToday).toBe(4 - i);
    const sixth = await post(ctx.teacher);
    expect(sixth.status).toBe(429);
    expect(sixth.body).toEqual({ success: false, code: 'SUMMARY_DAILY_LIMIT', message: 'The daily summary limit for this assignment has been reached. Please try again tomorrow.' });
    expect(generate).toHaveBeenCalledTimes(5);
    expect((await report()).summary).toMatchObject({ remainingToday: 0 });
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { 'reportSummary.usage.day': '2000-01-01' } });
    generate.mockImplementation(aiSuccess);
    // The per-teacher limit (6 per 15 minutes) is used up by now, so a fresh teacher account owns the assignment for this last call.
    const owner = { _id: id(), firebaseUid: `s-${id()}`, email: 'sum.owner2@example.com', role: 'teacher' };
    await User.collection.insertOne(owner);
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { teacher: owner._id } });
    await Class.collection.updateOne({ _id: ctx.cls._id }, { $set: { teacher: owner._id } });
    expect((await post(owner)).body.data).toMatchObject({ source: 'ai', remainingToday: 4 });
  });

  test('6 requests per 15 minutes per teacher: the 7th is rate limited', async () => {
    for (let i = 0; i < 6; i += 1) expect((await post(ctx.teacher)).status).toBe(200);   // cached after the first: no daily allowance used
    const seventh = await post(ctx.teacher);
    expect(seventh.status).toBe(429);
    expect(seventh.body.code).not.toBe('SUMMARY_DAILY_LIMIT');
    expect(generate).toHaveBeenCalledTimes(1);
  });

  test('one summary at a time per teacher', async () => {
    let release;
    generate.mockImplementationOnce(options => new Promise(resolve => { release = () => resolve(aiSuccess(options)); }));
    const first = post(ctx.teacher).then(r => r);
    for (let i = 0; i < 400 && !release; i += 1) await new Promise(r => setTimeout(r, 10));
    expect(release).toBeDefined();
    const second = await post(ctx.teacher);
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  });
});

describe('privacy of Assignment.reportSummary', () => {
  beforeEach(async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { reportSummary: { summary: { headline: SENTINEL, findings: [SENTINEL], nextSteps: [SENTINEL], caution: SENTINEL },
      source: 'ai', model: SENTINEL, promptVersion: SENTINEL, inputFingerprint: 'f'.repeat(64), generatedAt: new Date(), usage: { day: SENTINEL, count: 1 } } } });
  });

  test('never in student, guest or teacher assignment responses', async () => {
    const responses = [
      await as(ctx.kid, request(app).get(`/api/assignments/${ctx.assignment._id}`)),
      await as(ctx.kid, request(app).get('/api/assignments/my')),
      await as(ctx.kid, request(app).get(`/api/assignments/qr/${ctx.assignment.qrToken}`)),
      await request(app).get(`/api/guest/assignments/${ctx.assignment.qrToken}`),
      await as(ctx.teacher, request(app).get(`/api/assignments/class/${ctx.cls._id}`)),
      await as(ctx.teacher, request(app).get(`/api/assignments/teacher/${ctx.assignment._id}`))
    ];
    for (const res of responses) {
      expect(res.status).toBeLessThan(500);
      expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
      expect(JSON.stringify(res.body)).not.toContain('reportSummary');
    }
    expect(responses.filter(r => r.status === 200).length).toBeGreaterThanOrEqual(5);
  });

  test('the report response exposes the summary only through its own fields (no model, usage or fingerprint)', async () => {
    const body = JSON.stringify(await report());
    expect(body).not.toContain('inputFingerprint');
    expect(body).not.toContain('promptVersion');
    expect(body).not.toContain('"usage"');
  });

  test('Duplicate does not copy reportSummary', async () => {
    await require('./helpers/seedTestPlans').seedTestPlans();   // the duplicate route checks the teacher's plan limits
    const res = await as(ctx.teacher, request(app).post(`/api/assignments/${ctx.assignment._id}/duplicate`))
      .send({ targetClassId: String(ctx.cls._id), title: 'Copy', deadline: new Date(Date.now() + 86400000).toISOString() });
    expect(res.status).toBeLessThan(300);
    const copies = await Assignment.collection.find({ title: 'Copy' }).toArray();
    expect(copies).toHaveLength(1);
    expect(copies[0].reportSummary).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain(SENTINEL);
  });

  test('only the report and summary modules read the field', () => {
    const root = require('path').join(__dirname, '..', 'src');
    const readers = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = require('path').join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|ts)$/.test(entry.name) && fs.readFileSync(full, 'utf8').includes('reportSummary')) readers.push(require('path').relative(root, full).replace(/\\/g, '/'));
    } };
    walk(root);
    expect(readers.sort()).toEqual(['models/assignment.model.js', 'services/assignmentReport.service.js', 'services/assignmentReportSummary.service.js']);
  });
});
