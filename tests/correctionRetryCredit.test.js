'use strict';
// C.3b (after Task 20): what a degraded result costs and shows, end to end through the HTTP API with mocked providers. Synthetic text only.
//  1. The teacher's full "Regenerate" after a degraded evaluation: is the credit checked and charged again, and when?
//  2. After a later correction-only retry: what the student and teacher see (counts, annotations) while the score stays as it was.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ASSESSMENT_AI_PRIMARY_PROVIDER = 'openrouter';
process.env.ASSESSMENT_AI_PRIMARY_MODEL = 'openai/gpt-4.1';
process.env.ASSESSMENT_AI_FALLBACK_1_PROVIDER = '';
process.env.ASSESSMENT_AI_FALLBACK_1_MODEL = '';
process.env.ASSESSMENT_AI_PRIMARY_RETRIES = '0';
process.env.ASSESSMENT_AI_FALLBACK_RETRIES = '0';
process.env.ASSESSMENT_AI_RETRY_DELAY_MS = '0';
process.env.OPENROUTER_API_KEY = 'test-openrouter-key';

let mockCorrectionFails = true;
jest.mock('../src/services/visionOcr.service', () => ({
  detectOrientationAnnotation: jest.fn(async () => require('./fixtures/orientationAnnotation').annotation()),
  extractOcrFromImageFile: jest.fn(async () => {
    const text = require('./fixtures/astraAssessmentSmallEssay.cjs').text;
    return { fullText: text, transcriptText: text, pages: [{ pageNumber: 1, words: text.split(/\s+/).map((word, index) => ({
      text: word, paragraphIndex: 0, bbox: { x: 6 + (index % 7) * 12, y: 6 + Math.floor(index / 7) * 4.5, w: 10, h: 3 } })) }] };
  })
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn(async () => ({ skipped: true })) }));

const request = require('supertest');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const CreditTransaction = require('../src/models/CreditTransaction');
const CreditWallet = require('../src/models/CreditWallet');
const app = require('../src/app');
const retry = require('../src/services/correctionStageRetry.service');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { reviewPayload } = require('./helpers/astraAssessmentFixtures.cjs');
const { pageImage } = require('./fixtures/imagePreflightPage');

jest.setTimeout(60000);
const prompts = options => { const body = JSON.parse(options.body); return (body.messages || []).map(m => m.content || '').join('\n'); };
const reply = (options, content) => ({ ok: true, status: 200, headers: { get: () => 'application/json' }, text: async () => JSON.stringify({
  model: JSON.parse(options.body).model, choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }) });
const FINDING = { category: 'GRAMMAR', symbol: 'AGR', correctionKind: 'localized', quotedText: 'clear idea', occurrence: 1,
  message: 'Check the agreement here.', suggestedText: 'clear ideas', confidence: 0.95, severity: 'medium', stylePreference: false };

function rubric(prompt) {
  const sourceHash = String(prompt.match(/^sourceHash=(.+)$/mu)?.[1] || '');
  const line = String(prompt).split('\n').find(item => item.startsWith('evidenceCatalog='));
  const evidence = JSON.parse(line.slice('evidenceCatalog='.length));
  return { sourceHash, categories: Object.fromEntries(['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map(category => [category, {
    score: 20, maxScore: 20, comment: 'Synthetic evidence supports this category.',
    strengthEvidence: [{ evidenceId: evidence[0].evidenceId, explanation: 'Explicit idea.' }], improvementEvidence: [] }])) };
}

let teacher, student, classDoc, teacherToken, studentToken, png, scheduled, debits;
beforeAll(async () => {
  png = await pageImage();
  await connectInMemoryMongo(); await seedTestPlans();
  global.fetch = jest.fn(async (url, options) => {
    const prompt = prompts(options);
    if (/transcriptHash=/.test(prompt) && !/correctionCatalog=/.test(prompt)) {
      if (mockCorrectionFails) return reply(options, '{"not":"the review contract"}');
      return reply(options, JSON.stringify(reviewPayload(String(prompt.match(/^transcriptHash=(.+)$/mu)?.[1] || ''), undefined, [FINDING])));
    }
    if (/correctionCatalog=/.test(prompt)) return reply(options, JSON.stringify(rubric(prompt)));
    return { ok: false, status: 503, headers: { get: () => null }, text: async () => '{}' };
  });
  teacher = await User.create({ firebaseUid: 'c3b-teacher', email: 'teacher.c3b@example.test', role: 'teacher' });
  student = await User.create({ firebaseUid: 'c3b-student', email: 'student.c3b@example.test', role: 'student' });
  classDoc = await Class.create({ name: 'C3b class', teacher: teacher._id, joinCode: 'C3BCLASS', qrCodeUrl: 'data:,' });
  await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
  teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
  studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
  scheduled = [];
  const real = retry.scheduleAutomatic;
  jest.spyOn(retry, 'scheduleAutomatic').mockImplementation((Model, id, error, o = {}) => real(Model, id, error, { ...o, timer: fn => { scheduled.push(fn); return { unref() {} }; } }));
  debits = () => CreditTransaction.countDocuments({ userId: teacher._id, type: 'ASSESSMENT_DEBIT', status: 'committed' });
});
afterAll(async () => { await disconnectInMemoryMongo(); });

const waitFor = async (id, predicate, ms = 20000) => {
  const start = Date.now();
  while (Date.now() - start < ms) { const d = await Submission.findById(id).lean(); if (d && predicate(d)) return d; await new Promise(r => setTimeout(r, 25)); }
  throw new Error('timed out');
};
const result = async (id, token) => (await request(app).get(`/api/feedback/${id}`).set('Authorization', `Bearer ${token}`)).body.data;
/** Committed debits, once the count has settled at the expected value (a debit commits just after the run is marked complete). */
const debitsSettle = async (expected, ms = 5000) => { const start = Date.now(); let n;
  while (Date.now() - start < ms) { n = await debits(); if (n === expected) { await new Promise(r => setTimeout(r, 300)); return debits(); } await new Promise(r => setTimeout(r, 25)); }
  return n; };
const corrections = async (id, token) => (await request(app).get(`/api/submissions/${id}/ocr-corrections`).set('Authorization', `Bearer ${token}`)).body.data;

test('degraded result, then a correction-only retry, then the teacher\'s full regenerate: what is charged and what is shown', async () => {
  const assignment = await Assignment.create({ title: 'C3b essay', description: 'Write a paragraph.', writingType: 'essay',
    deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'c3b-essay' });
  const uploaded = await request(app).post(`/api/submissions/${assignment._id}`).set('Authorization', `Bearer ${studentToken}`)
    .attach('files', png, { filename: 'page.png', contentType: 'image/png' });
  expect(uploaded.status).toBe(200);
  const id = String(uploaded.body.data._id);

  // A degraded result: the correction stage failed (both attempts), the rubric scored anyway.
  const degraded = await waitFor(id, d => d.evaluationStatus === 'completed' && d.assessmentStatus === 'complete');
  expect(degraded).toMatchObject({ semanticStatus: 'failed', correctionStatus: 'partial', writingCorrections: [] });
  const scoreBefore = (await result(id, studentToken)).score;
  expect(scoreBefore).toEqual(expect.any(Number));
  // FINDING 0: the degraded assessment is charged once.
  expect(await debitsSettle(1)).toBe(1);
  const studentDegraded = await result(id, studentToken);
  expect(studentDegraded).toMatchObject({ correctionRetryActive: true, processingActive: true });   // the automatic retry is scheduled

  // The automatic correction-only retry succeeds.
  mockCorrectionFails = false;
  expect(scheduled).toHaveLength(1);
  await scheduled[0]();
  const retried = await waitFor(id, d => d.correctionRetry?.status === 'completed');
  expect(retried).toMatchObject({ semanticStatus: 'completed', correctionStatus: 'completed' });
  // FINDING 2: corrections, counts and annotations appear; the score is the same rubric score; no new charge.
  const studentAfter = await result(id, studentToken), teacherAfter = await result(id, teacherToken);
  for (const view of [studentAfter, teacherAfter]) {
    expect(view.score).toBe(scoreBefore);
    expect(view).toMatchObject({ evaluationCurrent: true, correctionsAvailable: true, correctionRetryActive: false });
    expect(view.correctionStatistics.grammar).toBe(1);
    expect(view.correctionStatistics.total).toBe(1);
  }
  expect((await corrections(id, studentToken)).corrections.map(c => c.symbol)).toEqual(['AGR']);
  expect(await debitsSettle(1)).toBe(1);
  // Record what the score parts said about grammar when they were made (no corrections were known then).
  const feedback = await SubmissionFeedback.findOne({ submissionId: id }).lean();
  // eslint-disable-next-line no-console
  console.log('C3B_AFTER_RETRY', JSON.stringify({ score: studentAfter.score, statistics: studentAfter.correctionStatistics,
    grammarRubric: studentAfter.rubricScores?.GRAMMAR && { score: studentAfter.rubricScores.GRAMMAR.score, issueCount: studentAfter.rubricScores.GRAMMAR.issueCount },
    scoringAuditGrammar: feedback.scoringAudit?.categories?.find?.(c => c.category === 'GRAMMAR')?.issueCount ?? null,
    detailedFeedbackMentionsCount: JSON.stringify(studentAfter.detailedFeedback || {}).match(/"(issueCount|count)":\s*\d+/g) || [],
    scoreBeforeCorrections: studentAfter.scoreBeforeCorrections ?? null }));
  // The page may now look inconsistent (counts > 0, rubric category with no issue): both views carry the flag for the one neutral line.
  expect(studentAfter.scoreBeforeCorrections).toBe(true);
  expect(teacherAfter.scoreBeforeCorrections).toBe(true);

  // FINDING 1: the teacher's full "Regenerate" checks the credit, re-scores and charges again (new assessment run).
  const regenerated = await request(app).post(`/api/submissions/${id}/ocr-corrections/regenerate`).set('Authorization', `Bearer ${teacherToken}`);
  expect(regenerated.status).toBe(202);
  await waitFor(id, d => d.correctionStatus === 'completed' && d.evaluationStatus === 'completed' && d.assessmentStatus === 'complete'
    && d.assessmentRunId !== degraded.assessmentRunId);
  expect(await debitsSettle(2)).toBe(2);
  // A full assessment with the corrections: the score is consistent again, the line goes away.
  expect((await result(id, studentToken)).scoreBeforeCorrections).toBeUndefined();
  // With no credit left, the full regenerate is refused before any work: 403, nothing charged.
  for (const wallet of await CreditWallet.find({ userId: teacher._id })) {
    await CreditWallet.updateOne({ _id: wallet._id }, { $set: { monthlyCreditsUsed: wallet.monthlyCredits, purchasedCredits: 0, bonusCredits: 0 } });
  }
  const refused = await request(app).post(`/api/submissions/${id}/ocr-corrections/regenerate`).set('Authorization', `Bearer ${teacherToken}`);
  expect(refused.status).toBe(403);
  expect(refused.body.code).toBe('INSUFFICIENT_ASSESSMENT_CREDITS');
  expect(await debitsSettle(2)).toBe(2);
});
