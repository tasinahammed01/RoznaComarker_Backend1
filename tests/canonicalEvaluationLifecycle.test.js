const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockClassLean = jest.fn().mockResolvedValue({ teacher: 'teacher-1' });
const mockAssess = jest.fn().mockResolvedValue({ sourceHash: 'hash', status: 'completed', provider: 'test', model: 'rubric',
  categories: {
    CONTENT: { score: 18, maxScore: 20, comment: 'Supported ideas.', issueCount: 0, strengthEvidence: [{ quotedText: 'Essay text.', explanation: 'Clear idea.' }], improvementEvidence: [] },
    ORGANIZATION: { score: 18, maxScore: 20, comment: 'Logical structure.', issueCount: 0, strengthEvidence: [{ quotedText: 'Essay text.', explanation: 'Clear structure.' }], improvementEvidence: [] },
    VOCABULARY: { score: 18, maxScore: 20, comment: 'Precise vocabulary.', issueCount: 0, strengthEvidence: [{ quotedText: 'Essay text.', explanation: 'Clear wording.' }], improvementEvidence: [] }
  }, metrics: {} });

jest.mock('../src/models/SubmissionFeedback', () => ({ findOneAndUpdate: mockFindOneAndUpdate, findOne: mockFindOne }));
jest.mock('../src/models/class.model', () => ({ findById: jest.fn(() => ({ select: () => ({ lean: mockClassLean }) })) }));
jest.mock('../src/models/user.model', () => ({ findById: jest.fn(() => ({ select: () => ({ lean: jest.fn().mockResolvedValue(null) }) })) }));
jest.mock('../src/services/semanticRubricAssessment.service', () => ({ assess: mockAssess }));

const { generate } = require('../src/services/canonicalEvaluation.service');

function submission(jobStillCurrent) {
  const updateOne = jest.fn().mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValue({ modifiedCount: 1 });
  const exists = jest.fn().mockResolvedValue(jobStillCurrent ? { _id: 'submission-1' } : null);
  return {
    value: { _id: 'submission-1', class: 'class-1', student: 'student-1', correctionStatus: 'completed',
      correctionSourceHash: 'hash', evaluationStatus: 'pending', writingCorrections: [],
      ocrPages: [{ text: 'Essay text.' }],
      correctionStatistics: { content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0 },
      constructor: { updateOne, exists } },
    updateOne, exists
  };
}

describe('canonical evaluation write guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOneAndUpdate.mockResolvedValue({});
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
  });

  test('a superseded job cannot persist detailed feedback', async () => {
    const record = submission(false);
    const result = await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(result.status).toBe('superseded');
    expect(record.exists).toHaveBeenCalledWith(expect.objectContaining({ correctionSourceHash: 'hash', evaluationJobId: expect.any(String) }));
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty('detailedFeedback');
  });

  test('a current job writes feedback only through its reserved job id', async () => {
    const record = submission(true);
    mockAssess.mockResolvedValueOnce({ ...await mockAssess(), provider: 'openrouter', model: 'openai/gpt-oss-20b',
      metrics: { attempts: [{ attempt: 1, provider: 'google', model: 'gemini-3.6-flash', status: 'provider_refusal', code: 'HTTP_402' },
        { attempt: 2, provider: 'openrouter', model: 'openai/gpt-oss-20b', status: 'completed' }] } });
    const result = await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(result).toMatchObject({ status: 'completed', provider: 'openrouter', model: 'openai/gpt-oss-20b', errorCode: null });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate.mock.calls[1][0]).toMatchObject({ submissionId: 'submission-1', evaluationJobId: expect.any(String) });
    expect(mockFindOneAndUpdate.mock.calls[1][1].$set).toMatchObject({ detailedFeedbackSourceHash: 'hash',
      detailedFeedbackVersion: 'canonical-detailed-feedback-2', evaluationProvider: 'openrouter', evaluationModel: 'openai/gpt-oss-20b' });
    expect(mockFindOneAndUpdate.mock.calls[1][1].$set.scoringAudit).toMatchObject({
      version: 'canonical-scoring-audit-v1',
      overallMethod: 'fixed_six_category_sum',
      categories: [
        expect.objectContaining({ category: 'GRAMMAR', finalScore: 0 }),
        expect.objectContaining({ category: 'MECHANICS', finalScore: 0 })
      ]
    });
  });

  test('custom-rubric scoring audit reproduces the deterministic selected-level overall score', async () => {
    const record = submission(true);
    const levels = [
      { title: 'Excellent', score: 100, description: 'Excellent work.' },
      { title: 'Good', score: 80, description: 'Good work.' },
      { title: 'Satisfactory', score: 60, description: 'Satisfactory work.' },
      { title: 'Needs Improvement', score: 40, description: 'Needs improvement.' }
    ];
    const assignment = { title: 'Custom rubric', rubrics: { totalPoints: 100, criteria: [
      { name: 'Content', weight: 30, levels },
      { name: 'Organization', weight: 20, levels },
      { name: 'Language', weight: 15, levels },
      { name: 'Analysis', weight: 20, levels },
      { name: 'Mechanics', weight: 15, levels }
    ] } };
    const baseSemantic = await mockAssess();
    mockAssess.mockResolvedValueOnce({
      ...baseSemantic,
      customCriteria: [
        { criterionId: 'criterion-1', percentage: 60, levelTitle: 'Satisfactory', evidence: [] },
        { criterionId: 'criterion-2', percentage: 60, levelTitle: 'Satisfactory', evidence: [] },
        { criterionId: 'criterion-3', percentage: 40, levelTitle: 'Needs Improvement', evidence: [] },
        { criterionId: 'criterion-4', percentage: 60, levelTitle: 'Satisfactory', evidence: [] },
        { criterionId: 'criterion-5', percentage: 80, levelTitle: 'Good', evidence: [] }
      ]
    });

    const result = await generate({ submission: record.value, assignment });
    const persisted = mockFindOneAndUpdate.mock.calls[1][1].$set;

    expect(result.overallScore).toBe(60);
    expect(persisted.customRubricScores.criteria.map((criterion) => criterion.weightedPoints))
      .toEqual([18, 12, 6, 12, 12]);
    expect(persisted.scoringAudit).toMatchObject({
      overallMethod: 'custom_rubric_weighted_total',
      customRubric: { overallScore: 60 }
    });
    expect(persisted.scoringAudit.customRubric.criteria
      .reduce((sum, criterion) => sum + criterion.weightedPoints, 0)).toBe(persisted.overallScore);
  });

  test('old evaluation versions are recomputed even when correction hash is unchanged', async () => {
    const record = submission(true);
    record.value.evaluationStatus = 'completed';
    record.value.evaluationSourceHash = 'hash';
    record.value.evaluationRubricSourceHash = require('../src/services/canonicalEvaluation.service').hashRubric({ title: 'Essay' });
    record.value.evaluationVersion = 'canonical-evaluation-1';
    await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(mockAssess).toHaveBeenCalled();
    expect(record.updateOne).toHaveBeenCalledWith(expect.objectContaining({ evaluationStatus: { $ne: 'processing' } }), expect.any(Object));
  });

  test('evaluation failure preserves any previously completed score and feedback fields', async () => {
    mockAssess.mockRejectedValueOnce(Object.assign(new Error('bad semantic result'), {
      code: 'HTTP_402', status: 402, attempts: [{ attempt: 1, provider: 'google', model: 'gemini-3.6-flash',
        status: 'provider_refusal', code: 'HTTP_402' }]
    }));
    const record = submission(true);
    const result = await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(result).toMatchObject({ status: 'failed', provider: 'google', model: 'gemini-3.6-flash',
      overallScore: null, errorCode: 'HTTP_402' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate.mock.calls[1][1].$unset).toBeUndefined();
    expect(record.updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ evaluationJobId: expect.any(String) }),
      expect.objectContaining({ $set: expect.objectContaining({ evaluationStatus: 'failed' }) }));
  });
});
