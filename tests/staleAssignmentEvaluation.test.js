jest.mock('../src/models/Submission', () => ({ find: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/SubmissionFeedback', () => ({ find: jest.fn(), exists: jest.fn() }));
jest.mock('../src/models/user.model', () => ({ findById: jest.fn() }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({
  hashRubric: jest.fn(() => 'current-rubric'),
  generate: jest.fn().mockResolvedValue({ status: 'completed' })
}));
jest.mock('../src/services/assignmentRubric.service', () => ({
  normalizeAssignmentRubric: jest.fn(() => ({ status: 'none' })),
  hashNormalizedRubric: jest.fn()
}));
jest.mock('../src/services/teacherEvaluationPolicy.service', () => ({
  normalizeTeacherEvaluationPolicy: jest.fn(() => ({ strictness: 'balanced', checks: {} })),
  evaluationPolicyHash: jest.fn(() => 'current-policy')
}));
jest.mock('../src/services/correctionCanonical.service', () => ({
  VERSION: 'canonical-version',
  computeCanonicalCorrectionStatistics: jest.fn(() => ({
    content: 0, organization: 0, grammar: 1, vocabulary: 0, mechanics: 0, total: 1
  }))
}));

const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const User = require('../src/models/user.model');
const canonicalEvaluation = require('../src/services/canonicalEvaluation.service');
const service = require('../src/services/staleAssignmentEvaluation.service');
const fs = require('fs');
const path = require('path');

const assignment = { _id: 'assignment-1', teacher: 'teacher-1', title: 'Essay' };
const readySubmission = (id, overrides = {}) => ({
  _id: id,
  assignment: 'assignment-1',
  correctionStatus: 'completed',
  semanticStatus: 'completed',
  evaluationStatus: 'stale',
  correctionSourceHash: 'source',
  correctionVersion: 'canonical-version',
  correctionTranscriptLayoutVersion: 'ocr-layout-v5-native-text',
  writingCorrections: [{ id: 'correction-1' }],
  correctionStatistics: {
    content: 0, organization: 0, grammar: 1, vocabulary: 0, mechanics: 0, total: 1
  },
  evaluationRubricSourceHash: 'old-rubric',
  evaluationPolicyHash: 'old-policy',
  ...overrides
});

describe('assignment stale evaluation service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    SubmissionFeedback.exists.mockResolvedValue(false);
    User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ aiConfig: {} }) }) });
  });

  test('classifies only hash-stale assignment submissions and reports every skip reason', async () => {
    Submission.find.mockResolvedValue([
      readySubmission('eligible'),
      readySubmission('override'),
      readySubmission('processing', { evaluationStatus: 'processing' }),
      readySubmission('not-ready', { semanticStatus: 'failed' }),
      readySubmission('current', {
        evaluationRubricSourceHash: 'current-rubric',
        evaluationPolicyHash: 'current-policy'
      })
    ]);
    SubmissionFeedback.find.mockReturnValue({ lean: async () => ([
      { submissionId: 'eligible', evaluationSourceHash: 'source' },
      { submissionId: 'override', evaluationSourceHash: 'source', overriddenByTeacher: true },
      { submissionId: 'processing', evaluationSourceHash: 'source' },
      { submissionId: 'not-ready', evaluationSourceHash: 'source' },
      { submissionId: 'current', evaluationSourceHash: 'source' }
    ]) });

    const summary = await service.summarize(assignment);

    expect(Submission.find).toHaveBeenCalledTimes(1);
    expect(Submission.find).toHaveBeenCalledWith({ assignment: 'assignment-1' });
    expect(summary).toEqual({
      assignmentId: 'assignment-1',
      eligibleCount: 1,
      skippedOverrideCount: 1,
      skippedProcessingCount: 1,
      skippedNotReadyCount: 1
    });
  });

  test('locks eligible submissions, returns immediately, and queues current assignment settings', async () => {
    const eligible = readySubmission('eligible');
    Submission.find.mockResolvedValue([eligible]);
    SubmissionFeedback.find.mockReturnValue({ lean: async () => ([
      { submissionId: 'eligible', evaluationSourceHash: 'source' }
    ]) });
    Submission.updateOne.mockResolvedValue({ modifiedCount: 1 });

    const result = await service.start(assignment, { concurrency: 2 });

    expect(result.startedCount).toBe(1);
    expect(result.submissionIds).toEqual(['eligible']);
    expect(Submission.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'eligible', evaluationStatus: { $ne: 'processing' } }),
      expect.objectContaining({ $set: expect.objectContaining({ evaluationStatus: 'processing' }) })
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(canonicalEvaluation.generate).toHaveBeenCalledWith(expect.objectContaining({
      submission: eligible,
      assignment
    }));
  });

  test('a repeated request cannot duplicate a job that lost the single-flight lock', async () => {
    Submission.find.mockResolvedValue([readySubmission('eligible')]);
    SubmissionFeedback.find.mockReturnValue({ lean: async () => ([
      { submissionId: 'eligible', evaluationSourceHash: 'source' }
    ]) });
    Submission.updateOne.mockResolvedValue({ modifiedCount: 0 });

    const result = await service.start(assignment);

    expect(result.startedCount).toBe(0);
    expect(result.skippedProcessingCount).toBe(1);
    expect(canonicalEvaluation.generate).not.toHaveBeenCalled();
  });

  test('bounded runner never exceeds the requested concurrency', async () => {
    let active = 0;
    let maximum = 0;
    await service.runBounded([1, 2, 3, 4, 5], 2, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
    });
    expect(maximum).toBe(2);
  });

  test('bulk and individual mutation routes are teacher-only', () => {
    const assignmentRoutes = fs.readFileSync(
      path.join(__dirname, '../src/routes/assignment.routes.js'), 'utf8'
    );
    const submissionRoutes = fs.readFileSync(
      path.join(__dirname, '../src/routes/submission.routes.js'), 'utf8'
    );
    expect(assignmentRoutes).toMatch(/evaluations\/retry-stale[\s\S]*requireRole\('teacher'\)/u);
    expect(submissionRoutes).toMatch(/evaluation\/retry'[\s\S]*requireRole\('teacher'\)/u);
    expect(submissionRoutes).toMatch(/ocr-corrections\/regenerate'[\s\S]*requireRole\('teacher'\)/u);
  });
});
