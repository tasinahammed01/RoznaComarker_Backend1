const mockPersist = jest.fn().mockResolvedValue({});
const mockAssess = jest.fn();
jest.mock('../src/models/SubmissionFeedback', () => ({ findOneAndUpdate: mockPersist,
  findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));
jest.mock('../src/models/class.model', () => ({ findById: jest.fn(() => ({ select: () => ({
  lean: jest.fn().mockResolvedValue({ teacher: 'teacher-1' }) }) })) }));
jest.mock('../src/models/user.model', () => ({ findById: jest.fn(() => ({ select: () => ({
  lean: jest.fn().mockResolvedValue(null) }) })) }));
jest.mock('../src/services/semanticRubricAssessment.service', () => ({
  ...jest.requireActual('../src/services/semanticRubricAssessment.service'), assess: mockAssess
}));

const semantic = jest.requireActual('../src/services/semanticRubricAssessment.service');
const { getSemanticAIConfig } = require('../src/services/semanticAIClient.service');
const { generate } = require('../src/services/canonicalEvaluation.service');
const env = {
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter', ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_PRIMARY_RETRIES: '0', ASSESSMENT_AI_FALLBACK_RETRIES: '0',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '30000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '90000',
  ASSESSMENT_AI_RETRY_DELAY_MS: '0', SEMANTIC_AI_MAX_OUTPUT_TOKENS: '6000',
  OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: 'https://router.test/v1'
};

function fixture() {
  // Synthetic, approximately 600 words; no private student text or network calls.
  const paragraph = 'University students use social media to share course materials and maintain friendships. '
    + 'A class group helped Mina obtain lecture notes when illness prevented her attendance. '
    + 'Messages also interrupt concentration during study and encourage comparison with carefully edited lives. '
    + 'Students can protect their time by silencing notifications during lectures and reserving quiet hours for reading. '
    + 'Checking privacy settings protects personal photographs from strangers while careful sharing helps classmates stay connected.';
  const pages = [Array(4).fill(paragraph).join('\n\n'), Array(4).fill(paragraph).join('\n\n')
    + '\n\nStudents should protect privacy and balance online communication with face to face relationships.'];
  const criteria = [
    ['Content Understanding and Relevance', 30, 'Discusses effects with insightful examples.'],
    ['Organization and Structure', 20, 'Well-organized with smooth transitions.'],
    ['Use of Examples', 15, 'Multiple relevant and specific examples.'],
    ['Clarity and Language Use', 20, 'Clear and free of grammatical errors.'],
    ['Responsibility and Opinion Expression', 15, 'Thoughtful opinion on responsible use.']
  ].map(([title, weight, description], index) => ({ id: `criterion-${index + 1}`, title, weight,
    levels: [{ title: 'Excellent', percentage: 100, description },
      { title: 'Good', percentage: 80, description: index === 3 ? 'Mostly clear with few minor errors.' : 'Mostly developed.' },
      { title: 'Satisfactory', percentage: 60, description: 'Partially developed with noticeable limitations.' },
      { title: 'Needs Improvement', percentage: 40, description: 'Limited development with frequent weaknesses.' }] }));
  const corrections = [['CONTENT', 'REL', 10], ['ORGANIZATION', 'COH', 7], ['VOCABULARY', 'WC', 4],
    ['GRAMMAR', 'T', 51], ['MECHANICS', 'SP', 5]].flatMap(([category, symbol, count]) =>
    Array.from({ length: count }, (_, index) => ({ id: `${category}-${index}`, category, symbol, source: 'AI',
      quotedText: 'University students', suggestedText: 'Students', message: 'Revise this wording.',
      correctionKind: 'localized', severity: 'medium', confidence: 0.99, startChar: 0, endChar: 19, page: 1 })));
  return { assignment: { title: 'The Impact of Social Media on University Students', rubrics: { criteria } },
    submission: { _id: 'regression-submission', class: 'class-1', student: 'student-1',
      ocrStatus: 'completed', ocrPages: pages.map((text, index) => ({ text, pageNumber: index + 1, fileId: `file-${index + 1}` })),
      correctionStatus: 'completed', correctionSourceHash: 'regression-source', semanticStatus: 'completed',
      semanticMetrics: { coverage: { coverageComplete: true, totalChunks: 2, successfulChunks: 2,
        failedChunks: 0, structuralPassStatus: 'completed' } },
      evaluationStatus: 'pending', writingCorrections: corrections,
      constructor: { updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        exists: jest.fn().mockResolvedValue({ _id: 'regression-submission' }) } } };
}

function providerPayload(input) {
  const evidenceId = semantic.transcriptEvidenceCatalog(input.transcript)[0].evidenceId;
  return { sourceHash: input.sourceHash,
    categories: Object.fromEntries(['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map(category => [category, {
      score: 12, maxScore: 20, comment: 'The passage communicates an idea but needs revision.',
      strengthEvidence: [{ evidenceId, explanation: 'The passage explains how students communicate.' }],
      improvementEvidence: [{ evidenceType: 'correction', evidenceId: null,
        correctionId: input.corrections.find(item => item.category === category).id,
        explanation: 'Revise the identified wording.', suggestion: 'Apply the suggested correction.' }]
    }])), customCriteria: input.customRubric.criteria.map(criterion => ({ criterionId: criterion.id,
      percentage: 60, levelTitle: 'Satisfactory', comment: 'Some development is present; weaknesses prevent the next level.',
      evidenceIds: [evidenceId] })) };
}

describe('two-page custom rubric relevance regression through gateway and canonical persistence', () => {
  beforeEach(() => jest.clearAllMocks());

  test.each(['valid', 'invalid-then-valid', 'invalid-all'])('%s response has bounded requests and truthful final state', async mode => {
    const { submission, assignment } = fixture();
    const originalCorrections = structuredClone(submission.writingCorrections);
    const fetchImpl = jest.fn();
    mockAssess.mockImplementation(input => {
      fetchImpl.mockImplementation(async () => {
        const payload = providerPayload(input);
        if (mode === 'invalid-all' || (mode === 'invalid-then-valid' && fetchImpl.mock.calls.length === 1))
          payload.customCriteria[0].evidenceIds = ['invented-evidence'];
        return { ok: true, status: 200, headers: { get: () => 'application/json' },
          text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload) } }] }) };
      });
      return semantic.assess(input, { config: getSemanticAIConfig(env), env, fetchImpl });
    });
    const result = await generate({ submission, assignment, preparedRubricRequired: true,
      preparedRubricAssessment: { error: Object.assign(new Error('Prepared validation rejected'), {
        code: 'AI_CHAIN_EXHAUSTED', attempts: [
          { code: 'AI_OUTPUT_VALIDATION_FAILED', validationCode: 'CUSTOM_RUBRIC_EVIDENCE_IRRELEVANT' },
          { code: 'AI_OUTPUT_VALIDATION_FAILED', validationCode: 'CUSTOM_RUBRIC_EVIDENCE_IRRELEVANT' }
        ] }) } });
    expect(mockAssess).toHaveBeenCalledTimes(1);
    expect(mockAssess.mock.calls[0][0].corrections).toHaveLength(77);
    expect(mockAssess.mock.calls[0][0].pageManifest).toHaveLength(2);
    expect(mockAssess.mock.calls[0][0].statistics).toMatchObject({ grammar: 51, mechanics: 5, total: 77 });
    expect(fetchImpl).toHaveBeenCalledTimes(mode === 'valid' ? 1 : 2);
    expect(submission.writingCorrections).toEqual(originalCorrections);
    expect(submission.ocrStatus).toBe('completed');
    expect(submission.correctionStatus).toBe('completed');
    if (mode === 'invalid-all') {
      expect(result.status).toBe('failed');
      expect(result.overallScore == null).toBe(true);
    } else {
      expect(result).toMatchObject({ status: 'completed', overallScore: 60 });
      expect(mockPersist.mock.calls.at(-1)[1].$set).toMatchObject({ overallScore: 60,
        detailedFeedback: expect.any(Object), customRubricScores: expect.anything() });
    }
  });
});
