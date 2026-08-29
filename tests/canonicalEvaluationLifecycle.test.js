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
jest.mock('../src/services/semanticRubricAssessment.service', () => ({
  PROMPT_VERSION: 'semantic-rubric-assessment-v7-fixed-skill-isolation',
  SCHEMA_VERSION: 'semantic-rubric-assessment-json-v5',
  assess: mockAssess
}));

const { generate, prepareRubricAssessment } = require('../src/services/canonicalEvaluation.service');

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

  test('reuses one prepared rubric provider result during final score and feedback persistence', async () => {
    const record = submission(true);
    const assignment = { title: 'Essay' };
    const categoryPlan = [
      ['CONTENT', 'REL', 5], ['ORGANIZATION', 'COH', 4], ['VOCABULARY', 'WC', 4],
      ['GRAMMAR', 'T', 29], ['MECHANICS', 'SP', 4]
    ];
    record.value.writingCorrections = categoryPlan.flatMap(([category, symbol, count]) =>
      Array.from({ length: count }, (_, index) => ({ id: `${category}-${index}`, source: 'AI', category, symbol,
        quotedText: 'Essay', suggestedText: 'Revision', message: 'Concise correction.', correctionKind: 'localized',
        severity: 'medium', confidence: 0.99, startChar: 0, endChar: 5, page: 1 })));
    const prepared = await prepareRubricAssessment({ submission: record.value, assignment, sourceHash: 'hash' });
    const result = await generate({ submission: record.value, assignment,
      preparedRubricAssessment: prepared, preparedRubricRequired: true });

    expect(result).toMatchObject({ status: 'completed', overallScore: expect.any(Number) });
    expect(mockAssess).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate.mock.calls.at(-1)[1].$set).toMatchObject({
      overallScore: expect.any(Number), detailedFeedback: expect.any(Object),
      evaluationProvider: 'test', evaluationModel: 'rubric',
      correctionStats: expect.objectContaining({ total: 46, grammar: 29, mechanics: 4 })
    });
  });

  test('classifies a prepared rubric hash mismatch without a second provider request', async () => {
    const record = submission(true);
    const assignment = { title: 'Essay' };
    const prepared = await prepareRubricAssessment({ submission: record.value, assignment, sourceHash: 'hash' });
    const result = await generate({ submission: record.value, assignment,
      preparedRubricAssessment: { ...prepared, sourceHash: 'stale-hash' }, preparedRubricRequired: true });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'PREPARED_RUBRIC_HASH_MISMATCH' });
    expect(mockAssess).toHaveBeenCalledTimes(1);
  });

  test('classifies a missing required prepared rubric without making a provider request', async () => {
    const record = submission(true);
    const result = await generate({ submission: record.value, assignment: { title: 'Essay' },
      preparedRubricAssessment: null, preparedRubricRequired: true });

    expect(result).toMatchObject({ status: 'failed', errorCode: 'PREPARED_RUBRIC_MISSING' });
    expect(mockAssess).not.toHaveBeenCalled();
  });

  test('semantic correction failure still produces transcript-grounded rubric scores without false zero-correction success', async () => {
    const record = submission(true);
    record.value.correctionStatus = 'partial';
    record.value.semanticStatus = 'failed';
    record.value.semanticErrorCode = 'AI_ATTEMPT_TIMEOUT';
    mockAssess.mockResolvedValueOnce({ ...await mockAssess(), categories: {
      ...(await mockAssess()).categories,
      GRAMMAR: { score: 12, maxScore: 20, comment: 'Transcript evidence shows recurring grammar weaknesses.',
        issueCount: 0, strengthEvidence: [], improvementEvidence: [{ quotedText: 'Essay text.', explanation: 'Grammar weakness.', suggestion: 'Revise grammar.' }] },
      MECHANICS: { score: 14, maxScore: 20, comment: 'Transcript evidence shows mechanics weaknesses.',
        issueCount: 0, strengthEvidence: [], improvementEvidence: [{ quotedText: 'Essay text.', explanation: 'Mechanics weakness.', suggestion: 'Revise mechanics.' }] }
    } });

    const result = await generate({ submission: record.value, assignment: { title: 'Essay' }, allowDegradedCorrections: true });
    const persisted = mockFindOneAndUpdate.mock.calls[1][1].$set;

    expect(result.status).toBe('completed');
    expect(mockAssess).toHaveBeenCalledWith(expect.objectContaining({ includeLanguageCategories: true }));
    expect(persisted.rubricScores.GRAMMAR).toMatchObject({ score: 15, maxScore: 25 });
    expect(persisted.rubricScores.MECHANICS).toMatchObject({ score: 7, maxScore: 10 });
    expect(persisted.scoringAudit).toMatchObject({ correctionsAvailable: false,
      languageScoringMode: 'transcript_semantic_fallback' });
    expect(record.value.writingCorrections).toEqual([]);
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

  test('a custom-rubric-only reevaluation preserves the canonical built-in skill snapshot', async () => {
    const record = submission(true);
    const assignment = { title: 'Essay', instructions: 'Write a supported response.', rubrics: {
      totalPoints: 100, criteria: [{ name: 'Teacher criterion', weight: 100, levels: [
        { title: 'Strong', score: 100, description: 'Strong response.' },
        { title: 'Developing', score: 60, description: 'Developing response.' }
      ] }]
    } };
    const canonical = require('../src/services/canonicalEvaluation.service');
    const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');
    const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');
    const priorScores = {
      CONTENT: { score: 13.5, maxScore: 20, comment: 'Prior content.' },
      ORGANIZATION: { score: 15, maxScore: 20, comment: 'Prior organization.' },
      VOCABULARY: { score: 13.5, maxScore: 20, comment: 'Prior vocabulary.' },
      GRAMMAR: { score: 24.5, maxScore: 25, comment: 'Prior grammar.' },
      MECHANICS: { score: 9.5, maxScore: 10, comment: 'Prior mechanics.' },
      PRESENTATION: { score: 5, maxScore: 5, comment: 'Prior presentation.' }
    };
    const priorFeedback = {
      evaluationSourceHash: 'hash', evaluationPolicyHash: evaluationPolicyHash(null),
      evaluationBuiltInContextHash: canonical.hashBuiltInContext(assignment),
      assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
      overriddenByTeacher: false, rubricScores: priorScores
    };
    mockFindOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(priorFeedback) });
    const changedSemantic = await mockAssess();
    mockAssess.mockResolvedValueOnce({ ...changedSemantic, categories: {
      ...changedSemantic.categories,
      CONTENT: { ...changedSemantic.categories.CONTENT, score: 17 },
      ORGANIZATION: { ...changedSemantic.categories.ORGANIZATION, score: 17 },
      VOCABULARY: { ...changedSemantic.categories.VOCABULARY, score: 15 }
    }, customCriteria: [{ criterionId: 'criterion-1', percentage: 60,
      levelTitle: 'Developing', comment: 'Developing against the teacher criterion.', evidence: [] }] });

    await generate({ submission: record.value, assignment });
    const persisted = mockFindOneAndUpdate.mock.calls.at(-1)[1].$set;
    expect(Object.fromEntries(Object.entries(persisted.rubricScores)
      .map(([key, value]) => [key, value.score]))).toEqual({
      CONTENT: 13.5, ORGANIZATION: 15, VOCABULARY: 13.5,
      GRAMMAR: 24.5, MECHANICS: 9.5, PRESENTATION: 5
    });
    expect(persisted.overallScore).toBe(60);
    expect(persisted.scoringAudit).toMatchObject({ builtInScoresReused: true,
      builtInContextHash: canonical.hashBuiltInContext(assignment) });
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
