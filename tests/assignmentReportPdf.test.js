'use strict';
// GET /api/pdf/assignment-report/:id (Stage 3). The generator is mocked (no browser); the HTML it receives is checked instead.
// Covers the auth matrix, tz validation, the same numbers as the JSON report, headers (attachment filename, no-store), the busy pool
// (503 + Retry-After), one running PDF per teacher (503), the rate limit, and error bodies/logs without raw messages. Synthetic data.
process.env.JWT_SECRET = 'assignment-report-pdf-secret';
process.env.NODE_ENV = 'test';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
jest.mock('../src/services/email.service', () => ({}));
jest.mock('../src/modules/assignmentReportPdfGenerator', () => ({ generateAssignmentReportPdf: jest.fn() }));

const fs = require('fs');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const { ApiError } = require('../src/middlewares/error.middleware');
const { generateAssignmentReportPdf } = require('../src/modules/assignmentReportPdfGenerator');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');

jest.setTimeout(180000);
const id = () => new mongoose.Types.ObjectId();
const token = user => jwt.sign({ id: String(user._id) }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '1h' });
let ctx;
let lastHtml;

const fakePdf = async (html, outputPath) => { lastHtml = html; await fs.promises.writeFile(outputPath, '%PDF-1.4 synthetic'); return { path: outputPath, pageCount: 1 }; };

async function seed() {
  const teacher = { _id: id(), firebaseUid: `p-${id()}`, email: 'pdf.teacher@example.com', role: 'teacher', displayName: 'Ms Teacher' };
  const other = { _id: id(), firebaseUid: `p-${id()}`, email: 'pdf.other@example.com', role: 'teacher' };
  const kid = { _id: id(), firebaseUid: `p-${id()}`, email: 'pdf.kid@example.com', role: 'student', displayName: 'Ana Ray' };
  await User.collection.insertMany([teacher, other, kid]);
  const cls = { _id: id(), name: 'Writing 7B', teacher: teacher._id, isActive: true };
  await Class.collection.insertOne(cls);
  const assignment = { _id: id(), title: 'Persuasive essay', class: cls._id, teacher: teacher._id, isActive: true, resourceType: 'essay', deadline: new Date(Date.UTC(2026, 10, 20)) };
  await Assignment.collection.insertOne(assignment);
  const scores = [85, 55, 66];
  for (const [i, score] of scores.entries()) {
    const _id = id();
    await Submission.collection.insertOne({ _id, assignment: assignment._id, class: cls._id, ...(i === 0 ? { student: kid._id } : { submissionMode: 'guest', guest: { displayName: `Guest ${i}`, normalizedEmail: 'guest@example.com' } }),
      status: 'submitted', submittedAt: new Date(Date.UTC(2026, 10, 10 + i, 9)), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
      correctionSourceHash: 'h', correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationStatus: 'completed', evaluationVersion: EVALUATION_VERSION,
      assessmentStatus: 'complete', transcriptText: 'SECRET OCR TEXT', writingCorrections: [{ id: 'c1', symbol: 'SP', category: 'MECHANICS', message: 'SECRET CORRECTION' }],
      correctionStatistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 1, total: 1 } });
    await SubmissionFeedback.collection.insertOne({ submissionId: _id, classId: cls._id, teacherId: teacher._id, overallScore: score, grade: 'B', evaluationStatus: 'completed',
      evaluationSource: 'ai', evaluationSourceHash: 'h', assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION, teacherComments: 'SECRET TEACHER COMMENT',
      rubricScores: { CONTENT: { score: 16, maxScore: 20 }, GRAMMAR: { score: 15, maxScore: 25 } } });
  }
  return { teacher, other, kid, cls, assignment };
}

beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Submission.init(), SubmissionFeedback.init()]); });
afterAll(async () => { await disconnectInMemoryMongo(); });
beforeEach(async () => {
  await clearDatabase();
  jest.clearAllMocks();
  lastHtml = undefined;
  generateAssignmentReportPdf.mockImplementation(fakePdf);
  for (const level of ['warn', 'error', 'info']) jest.spyOn(logger, level);
  ctx = await seed();
});
afterEach(() => jest.restoreAllMocks());

const pdf = (user, assignmentId = ctx.assignment._id, query = '') => {
  const req = request(app).get(`/api/pdf/assignment-report/${assignmentId}${query}`);
  return user ? req.set('Authorization', `Bearer ${token(user)}`) : req;
};
const logged = () => ['warn', 'error', 'info'].flatMap(level => logger[level].mock.calls.map(([entry]) => entry));

describe('auth matrix', () => {
  test('owner 200; another teacher 404; student 403; no login 401; bad id 400', async () => {
    expect((await pdf(ctx.teacher)).status).toBe(200);
    expect((await pdf(ctx.other)).status).toBe(404);
    expect((await pdf(ctx.kid)).status).toBe(403);
    expect((await pdf(null)).status).toBe(401);
    expect((await pdf(ctx.teacher, 'not-an-id')).status).toBe(400);
    expect(generateAssignmentReportPdf).toHaveBeenCalledTimes(1);
  });

  test('archived assignment, archived class and deleted assignment 404; non-essay 409; the generator never runs for them', async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { isActive: false } });
    expect((await pdf(ctx.teacher)).status).toBe(404);
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { isActive: true } });
    await Class.collection.updateOne({ _id: ctx.cls._id }, { $set: { isActive: false } });
    expect((await pdf(ctx.teacher)).status).toBe(404);
    expect((await pdf(ctx.teacher, id())).status).toBe(404);
    await Class.collection.updateOne({ _id: ctx.cls._id }, { $set: { isActive: true } });
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { resourceType: 'flashcard' } });
    const res = await pdf(ctx.teacher);
    expect(res.status).toBe(409);
    expect(res.body.message).toBe('Reports are available for essay assignments only');
    expect(generateAssignmentReportPdf).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  test('attachment with a sanitized Rubrilo filename, PDF content type and no-store', async () => {
    await Assignment.collection.updateOne({ _id: ctx.assignment._id }, { $set: { title: '../Café "essay"; x' } });
    const res = await pdf(ctx.teacher, ctx.assignment._id, '?tz=UTC');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/pdf/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    const today = new Date().toISOString().slice(0, 10);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="Rubrilo-report-cafe-essay-x-${today}.pdf"`);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  test('the PDF shows exactly the numbers of the JSON report, and none of the email, comment, OCR or correction text', async () => {
    const json = (await request(app).get(`/api/assignments/${ctx.assignment._id}/report?tz=UTC`).set('Authorization', `Bearer ${token(ctx.teacher)}`)).body.data;
    expect((await pdf(ctx.teacher, ctx.assignment._id, '?tz=UTC')).status).toBe(200);
    const text = lastHtml.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    expect(json.scores.average).toBe(68.7);
    for (const kpi of [`Total submissions ${json.counts.total}`, `Scored ${json.counts.scored}`, `Average ${json.scores.average}%`, `Median ${json.scores.median}%`,
      `Highest ${json.scores.highest}%`, `Lowest ${json.scores.lowest}%`, `Needs revision ${json.scores.needsRevisionPct}%`]) expect(text).toContain(kpi);
    for (const insight of json.insights) expect(text).toContain(insight.text.replace(/&/g, '&amp;'));
    for (const s of json.students) expect(text).toContain(s.name);
    expect(lastHtml).not.toContain('@example.com');
    expect(lastHtml).not.toContain('SECRET');
    expect(lastHtml).not.toMatch(/rozna/i);
  });

  test('tz is validated exactly like the JSON report: a real zone is used, anything else falls back to UTC', async () => {
    await pdf(ctx.teacher, ctx.assignment._id, '?tz=Asia/Dhaka');
    expect(lastHtml).toContain('(Asia/Dhaka)');
    for (const bad of ['?tz=Not/AZone', '?tz=../../etc', '?tz[]=UTC', '?tz=%00', '']) {
      const res = await pdf(ctx.teacher, ctx.assignment._id, bad);
      expect(res.status).toBe(200);
      expect(lastHtml).toContain('(UTC)');
    }
  });
});

describe('busy and failure responses', () => {
  test('a busy browser pool answers 503 with a friendly message and Retry-After; never the internal message', async () => {
    generateAssignmentReportPdf.mockRejectedValueOnce(new ApiError(503, 'PDF generation queue timed out. INTERNAL DETAIL'));
    const res = await pdf(ctx.teacher);
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBe('30');
    expect(res.body).toEqual({ success: false, code: 'PDF_BUSY', message: 'The PDF service is busy. Please try again in a minute.' });
  });

  test('one running PDF per teacher: a second request while the first renders answers 503 with Retry-After; the first still completes', async () => {
    let release;
    generateAssignmentReportPdf.mockImplementationOnce((html, outputPath) => new Promise(resolve => { release = () => resolve(fakePdf(html, outputPath)); }));
    const first = pdf(ctx.teacher).then(r => r);
    for (let i = 0; i < 400 && !release; i += 1) await new Promise(r => setTimeout(r, 10));
    expect(release).toBeDefined();
    const second = await pdf(ctx.teacher);
    expect(second.status).toBe(503);
    expect(second.headers['retry-after']).toBeDefined();
    expect(second.body).toEqual({ success: false, code: 'PDF_ALREADY_RUNNING', message: 'Your PDF is still being prepared. Please wait for it to finish.' });
    release();
    expect((await first).status).toBe(200);
    expect((await pdf(ctx.teacher)).status).toBe(200);   // the slot is released afterwards
  });

  test.each([
    [new Error('ENOENT C:\\secret\\path SECRET STACK'), 500, 'PDF_FAILED', 'The PDF could not be created. Please try again.'],
    [new ApiError(504, 'PDF document rendering timed out. INTERNAL'), 504, 'PDF_TIMEOUT', 'Creating the PDF took too long. Please try again in a moment.'],
    [new ApiError(413, 'The report is too large to render safely. INTERNAL'), 413, 'PDF_TOO_LARGE', 'This report is too large to export as a PDF.']
  ])('failures answer a fixed message, never the raw one (%#)', async (error, status, code, message) => {
    generateAssignmentReportPdf.mockRejectedValueOnce(error);
    const res = await pdf(ctx.teacher);
    expect(res.status).toBe(status);
    expect(res.body).toEqual({ success: false, code, message });
    expect(JSON.stringify(res.body)).not.toMatch(/SECRET|INTERNAL|stack|ENOENT/);
    const entry = logged().find(e => e && e.event === 'assignment_report_pdf_failed');
    expect(entry).toEqual({ event: 'assignment_report_pdf_failed', code, assignmentId: String(ctx.assignment._id) });
  });

  test('the per-teacher rate limit answers 429 after 10 PDFs in the window', async () => {
    for (let i = 0; i < 10; i += 1) expect((await pdf(ctx.teacher)).status).toBe(200);
    const limited = await pdf(ctx.teacher);
    expect(limited.status).toBe(429);
    expect(JSON.stringify(limited.body)).not.toMatch(/stack|Error:/);
    expect((await pdf(ctx.other, ctx.assignment._id)).status).toBe(404);   // another teacher has their own budget
  });
});
