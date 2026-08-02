jest.mock('../src/models/Submission', () => ({ findById: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/assignment.model', () => ({ findById: jest.fn() }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({ generate: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn() }));
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/upload.service', () => ({ assertTeacherOwnsClassOrThrow: jest.fn() }));

const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const evaluation = require('../src/services/canonicalEvaluation.service');
const corrections = require('../src/services/canonicalCorrectionsPipeline.service');
const ocr = require('../src/services/ocrPipeline.service');
const upload = require('../src/services/upload.service');
const controller = require('../src/controllers/submission.controller');
const fs = require('fs');
const path = require('path');

const response = () => {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.json = jest.fn((body) => { res.body = body; return res; });
  return res;
};

const submission = (overrides = {}) => ({
  _id: 'submission-1', student: 'student-1', class: 'class-1', assignment: 'assignment-1',
  correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'failed',
  correctionSourceHash: 'correction-hash',
  correctionVersion: 'canonical-6-category-structured', correctionTranscriptLayoutVersion: 'ocr-layout-v5-native-text',
  writingCorrections: [{ id: 'c1', category: 'GRAMMAR', symbol: 'AGR' }],
  correctionStatistics: { content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0, total: 1 },
  ...overrides
});

describe('evaluation-only retry controller', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Submission.updateOne.mockResolvedValue({ modifiedCount: 1 });
    Assignment.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ title: 'Essay' }) });
    evaluation.generate.mockResolvedValue({ status: 'completed', provider: 'openrouter', model: 'openai/gpt-oss-20b' });
  });

  test('student owner receives 202 and only canonical evaluation starts', async () => {
    const original = submission();
    const correctionsBefore = JSON.stringify(original.writingCorrections);
    const statisticsBefore = JSON.stringify(original.correctionStatistics);
    const sourceHashBefore = original.correctionSourceHash;
    Submission.findById.mockResolvedValue(original);
    const res = response();
    await controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' },
      user: { _id: 'student-1', role: 'student' } }, res);
    expect(res.statusCode).toBe(202);
    await new Promise((resolve) => setImmediate(resolve));
    expect(evaluation.generate).toHaveBeenCalledTimes(1);
    expect(corrections.generateAndPersist).not.toHaveBeenCalled();
    expect(ocr.runOcrAndPersist).not.toHaveBeenCalled();
    expect(ocr.runOcrAndPersistForFiles).not.toHaveBeenCalled();
    expect(original.writingCorrections).toEqual([{ id: 'c1', category: 'GRAMMAR', symbol: 'AGR' }]);
    expect(JSON.stringify(original.writingCorrections)).toBe(correctionsBefore);
    expect(JSON.stringify(original.correctionStatistics)).toBe(statisticsBefore);
    expect(original.correctionSourceHash).toBe(sourceHashBefore);
    expect(Submission.updateOne.mock.calls[0][1].$set).not.toHaveProperty('correctionStatus');
    expect(Submission.updateOne.mock.calls[0][1].$set).not.toHaveProperty('correctionStatistics');
    expect(Submission.updateOne.mock.calls[0][1].$set).not.toHaveProperty('correctionSourceHash');
  });

  test('other student is forbidden', async () => {
    Submission.findById.mockResolvedValue(submission());
    const res = response();
    await controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' },
      user: { _id: 'student-2', role: 'student' } }, res);
    expect(res.statusCode).toBe(403);
    expect(Submission.updateOne).not.toHaveBeenCalled();
  });

  test('owning teacher can retry evaluation without correction regeneration', async () => {
    Submission.findById.mockResolvedValue(submission());
    upload.assertTeacherOwnsClassOrThrow.mockResolvedValue();
    const res = response();
    await controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' },
      user: { _id: 'teacher-1', role: 'teacher' } }, res);
    expect(res.statusCode).toBe(202);
    expect(upload.assertTeacherOwnsClassOrThrow).toHaveBeenCalledWith('teacher-1', 'class-1');
    await new Promise((resolve) => setImmediate(resolve));
    expect(evaluation.generate).toHaveBeenCalledTimes(1);
    expect(corrections.generateAndPersist).not.toHaveBeenCalled();
  });

  test('active evaluation is rejected without starting another operation', async () => {
    Submission.findById.mockResolvedValue(submission({ evaluationStatus: 'processing' }));
    const res = response();
    await controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' },
      user: { _id: 'student-1', role: 'student' } }, res);
    expect(res.statusCode).toBe(409);
    expect(evaluation.generate).not.toHaveBeenCalled();
  });

  test('concurrent evaluation retries acquire one single-flight job', async () => {
    Submission.findById.mockResolvedValue(submission());
    Submission.updateOne.mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValueOnce({ modifiedCount: 0 });
    const first = response(); const second = response();
    await Promise.all([
      controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' }, user: { _id: 'student-1', role: 'student' } }, first),
      controller.retryCanonicalEvaluation({ params: { submissionId: 'submission-1' }, user: { _id: 'student-1', role: 'student' } }, second)
    ]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(evaluation.generate).toHaveBeenCalledTimes(1);
  });

  test('pipeline uses truthful evaluation outcome stage names', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/canonicalCorrectionsPipeline.service.js'), 'utf8');
    expect(source).not.toContain("stage: 'evaluationCompleted'");
    expect(source).toContain("'evaluationSucceeded'");
    expect(source).toContain("'evaluationFailed'");
    expect(source).toContain("'evaluationReused'");
    expect(source).toContain("'evaluationSuperseded'");
  });
});
