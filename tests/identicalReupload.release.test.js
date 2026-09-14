process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret';
jest.setTimeout(30000);
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn().mockResolvedValue(),
  runOcrAndPersistForFiles: jest.fn().mockResolvedValue() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn().mockResolvedValue() }));
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const Revision = require('../src/models/SubmissionRevision');
const Transaction = require('../src/models/CreditTransaction');
const ocr = require('../src/services/ocrPipeline.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const evaluation = require('../src/services/canonicalEvaluation.service');
const canonical = require('../src/services/correctionCanonical.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { resolveLegend } = require('../src/services/correctionLegendResolver.service');
const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');

describe('persisted assessment reuse through the upload API (mocked AI)', () => {
  let teacher, student, classDoc, assignment, token, submission, before, feedbackBefore, evaluate;
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  afterEach(() => evaluate?.mockRestore());
  const upload = (bytes = png) => request(app).post('/api/submissions/qr/release-test')
    .set('Authorization', `Bearer ${token}`).attach('file', bytes, { filename: 'essay.png', contentType: 'image/png' });
  beforeEach(async () => {
    await clearDatabase(); await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'release-teacher', email: 'release-t@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'release-student', email: 'release-s@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Release test', teacher: teacher._id, joinCode: 'release-test' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    assignment = await Assignment.create({ title: 'Essay', writingType: 'Opinion', class: classDoc._id,
      teacher: teacher._id, qrToken: 'release-test', deadline: new Date(Date.now() + 86400000),
      allowResubmission: true, requireAdaptiveBeforeResubmission: false });
    token = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
    const first = await upload();
    expect(first.status).toBe(200);
    await new Promise(setImmediate);
    submission = await Submission.findById(first.body.data._id);
    const fileId = String(submission.files[0]);
    const wordId = `word_${fileId}_1_1`;
    submission.ocrPages = [{ fileId, fileOrder: 0, pageNumber: 1, pageIndex: 0,
      text: 'I goes home.', rawText: 'I goes home.', words: [{ id: wordId, text: 'I', page: 1,
        bbox: { x0: 0, y0: 0, x1: 10, y1: 10 } }] }];
    const transcript = buildCanonicalSubmissionTranscript(submission);
    const sourceHash = pipeline.buildCorrectionSourceHash({ transcript: transcript.text, pages: transcript.pages,
      assignment, fileContentIdentity: submission.fileContentIdentity, legend: await resolveLegend() });
    Object.assign(submission, { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
      correctionVersion: canonical.VERSION, correctionSourceHash: sourceHash,
      writingCorrections: [{ id: 'stable-correction', fileId, wordIds: [wordId], page: 1,
        startChar: 2, endChar: 6, quotedText: 'goes', suggestedText: 'go', category: 'GRAMMAR', symbol: 'AGR' }],
      correctionStatistics: { grammar: 1, total: 1 }, evaluationStatus: 'completed', assessmentStatus: 'complete' });
    await submission.save();
    const rubricHash = evaluation.hashRubric(assignment), policyHash = evaluationPolicyHash(teacher.aiConfig);
    await Feedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      overallScore: 85, evaluationStatus: 'completed', evaluationSourceHash: sourceHash,
      evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
      analysisInputHash: evaluation.analysisInputHash({ sourceHash, rubricHash, policyHash, contextHash: evaluation.hashBuiltInContext(assignment) }),
      detailedFeedback: { status: 'completed', sourceHash, summary: 'Preserved feedback' } });
    before = await Submission.findById(submission._id).lean();
    feedbackBefore = await Feedback.findOne({ submissionId: submission._id }).lean();
    ocr.runOcrAndPersistForFiles.mockClear();
    evaluate = jest.spyOn(evaluation, 'generate').mockResolvedValue({ status: 'completed' });
  });
  test('same exact bytes/new File ID preserve corrections, statistics, score and feedback without AI', async () => {
    const count = await Transaction.countDocuments();
    expect((await upload()).status).toBe(200);
    await new Promise(setImmediate);
    const after = await Submission.findById(submission._id).lean();
    const feedbackAfter = await Feedback.findOne({ submissionId: submission._id }).lean();
    expect(after.reusedAssessment).toBe(true);
    expect(String(after.files[0])).not.toBe(String(before.files[0]));
    expect(after.correctionSourceHash).toBe(before.correctionSourceHash);
    expect(after.correctionStatistics).toEqual(before.correctionStatistics);
    expect(after.writingCorrections).toEqual(before.writingCorrections.map(item => ({ ...item,
      fileId: String(after.files[0]), wordIds: [`word_${after.files[0]}_1_1`] })));
    expect(String(after.ocrPages[0].fileId)).toBe(String(after.files[0]));
    expect(after.ocrPages[0].words[0].id).toBe(`word_${after.files[0]}_1_1`);
    expect(feedbackAfter.overallScore).toBe(feedbackBefore.overallScore);
    expect(feedbackAfter.detailedFeedback).toEqual(feedbackBefore.detailedFeedback);
    expect(ocr.runOcrAndPersistForFiles).not.toHaveBeenCalled();
    expect(evaluate).not.toHaveBeenCalled();
    expect(await Transaction.countDocuments()).toBe(count);
    expect(await Revision.countDocuments({ sourceSubmissionId: submission._id })).toBe(1);
  });
  test.each(['rubric', 'policy', 'evaluation-version'])('%s change reruns evaluation only', async change => {
    if (change === 'policy') await User.updateOne({ _id: teacher._id }, { $set: { 'aiConfig.strictness': 'strict' } });
    else if (change === 'rubric') await Assignment.updateOne({ _id: assignment._id }, { $set: {
      rubrics: { totalPoints: 100, criteria: [{ name: 'Ideas', weight: 100,
        levels: [{ title: 'Excellent', score: 100, description: 'Clear ideas' },
          { title: 'Developing', score: 50, description: 'Needs detail' }] }] }
    } });
    else await Feedback.updateOne({ submissionId: submission._id }, { $set: { analysisInputHash: 'old-algorithm' } });
    expect((await upload()).status).toBe(200);
    await new Promise(setImmediate);
    const after = await Submission.findById(submission._id).lean();
    expect(after.reusedAssessment).toBe(false);
    expect(after.correctionSourceHash).toBe(before.correctionSourceHash);
    expect(after.correctionStatistics).toEqual(before.correctionStatistics);
    expect(after.evaluationStatus).toBe('stale');
    expect(ocr.runOcrAndPersistForFiles).not.toHaveBeenCalled();
    expect(evaluate).toHaveBeenCalledTimes(1);
  });
  test.each(['content', 'correction-version'])('%s change starts a new analysis', async change => {
    if (change === 'correction-version') await Submission.updateOne({ _id: submission._id }, { $set: { correctionVersion: 'obsolete' } });
    const bytes = change === 'content' ? Buffer.concat([png, Buffer.from('different-bytes')]) : png;
    expect((await upload(bytes)).status).toBe(200);
    await new Promise(setImmediate);
    const after = await Submission.findById(submission._id).lean();
    expect(after.reusedAssessment).toBe(false);
    expect(after.writingCorrections).toEqual([]);
    expect(ocr.runOcrAndPersistForFiles).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();
  });
});
