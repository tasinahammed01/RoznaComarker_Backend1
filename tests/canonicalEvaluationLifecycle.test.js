const mockFindOneAndUpdate = jest.fn();
const mockFindOne = jest.fn();
const mockClassLean = jest.fn().mockResolvedValue({ teacher: 'teacher-1' });
const mockBuildWritingAssessment = jest.fn().mockResolvedValue({
  assessmentVersion: 'assessment-v1', grade: 'A', rubricScores: {
    CONTENT: { score: 18, maxScore: 20, comment: 'Supported ideas.' },
    ORGANIZATION: { score: 18, maxScore: 20, comment: 'Logical structure.' },
    GRAMMAR: { score: 24, maxScore: 25, comment: 'Controlled grammar.' },
    VOCABULARY: { score: 18, maxScore: 20, comment: 'Precise vocabulary.' },
    MECHANICS: { score: 9, maxScore: 10, comment: 'Controlled mechanics.' },
    PRESENTATION: { score: 5, maxScore: 5, comment: 'Readable.' }
  }
});

jest.mock('../src/models/SubmissionFeedback', () => ({ findOneAndUpdate: mockFindOneAndUpdate, findOne: mockFindOne }));
jest.mock('../src/models/class.model', () => ({ findById: jest.fn(() => ({ select: () => ({ lean: mockClassLean }) })) }));
jest.mock('../src/services/writingAssessment.service', () => ({ buildWritingAssessment: mockBuildWritingAssessment }));

const { generate } = require('../src/services/canonicalEvaluation.service');

function submission(jobStillCurrent) {
  const updateOne = jest.fn().mockResolvedValueOnce({ modifiedCount: 1 }).mockResolvedValue({ modifiedCount: 1 });
  const exists = jest.fn().mockResolvedValue(jobStillCurrent ? { _id: 'submission-1' } : null);
  return {
    value: { _id: 'submission-1', class: 'class-1', student: 'student-1', correctionStatus: 'completed',
      correctionSourceHash: 'hash', evaluationStatus: 'pending', writingCorrections: [],
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

  test('missing rubric categories fail before any score or detailed feedback is persisted', async () => {
    mockBuildWritingAssessment.mockResolvedValueOnce({ assessmentVersion: 'assessment-v1', grade: 'F', rubricScores: {
      CONTENT: { score: 10, maxScore: 20, comment: 'Incomplete result.' }
    } });
    const record = submission(true);
    await generate({ submission: record.value, assignment: { title: 'Essay' } });
    expect(mockFindOneAndUpdate).toHaveBeenCalledTimes(1);
    expect(record.updateOne).toHaveBeenLastCalledWith(expect.objectContaining({ evaluationJobId: expect.any(String) }),
      expect.objectContaining({ $set: expect.objectContaining({ evaluationStatus: 'failed' }) }));
  });
});
