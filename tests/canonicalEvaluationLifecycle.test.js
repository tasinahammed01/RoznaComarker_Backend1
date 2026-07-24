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
    await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(record.exists).toHaveBeenCalledWith(expect.objectContaining({ correctionSourceHash: 'hash', evaluationJobId: expect.any(String) }));
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(mockFindOneAndUpdate.mock.calls[0][1].$set).not.toHaveProperty('detailedFeedback');
  });

  test('a current job writes feedback only through its reserved job id', async () => {
    const record = submission(true);
    await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(mockFindOneAndUpdate.mock.calls[1][0]).toMatchObject({ submissionId: 'submission-1', evaluationJobId: expect.any(String) });
    expect(mockFindOneAndUpdate.mock.calls[1][1].$set).toMatchObject({ detailedFeedbackSourceHash: 'hash', detailedFeedbackVersion: 'canonical-detailed-feedback-2' });
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

  test('missing rubric categories fail before any score or detailed feedback is persisted', async () => {
    mockAssess.mockRejectedValueOnce(Object.assign(new Error('bad semantic result'), { code: 'SEMANTIC_RUBRIC_SCHEMA_INVALID' }));
    const record = submission(true);
    await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(2);
    expect(record.updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ evaluationJobId: expect.any(String) }),
      expect.objectContaining({ $set: expect.objectContaining({ evaluationStatus: 'failed' }) }));
  });
});
