'use strict';

jest.mock('../src/models/Submission', () => ({
  findOne: jest.fn(), findById: jest.fn(), exists: jest.fn()
}));
jest.mock('../src/models/assignment.model', () => ({ findById: jest.fn() }));
jest.mock('../src/models/SubmissionFeedback', () => ({ findOne: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../src/services/rubricCompletion.service', () => ({ completeRubric: jest.fn() }));
jest.mock('../src/utils/ocrTranscriptNormalizer', () => ({
  getNormalizedSubmissionTranscript: jest.fn(() => 'Current normalized essay text.')
}));

const Submission = require('../src/models/Submission');
const Assignment = require('../src/models/assignment.model');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { completeRubric } = require('../src/services/rubricCompletion.service');
const { autoGenerateRubricDesignerForSubmission } = require('../src/services/autoRubricDesigner.service');

const submissionId = '64b7f0a1a1a1a1a1a1a1a1a1';
const rubric = { title: 'Rubric', totalPoints: 100,
  levels: [{ title: 'Strong', maxPoints: 100 }, { title: 'Developing', maxPoints: 60 },
    { title: 'Beginning', maxPoints: 20 }],
  criteria: [{ title: 'Ideas', weight: 34, cells: ['a', 'b', 'c'] },
    { title: 'Evidence', weight: 33, cells: ['a', 'b', 'c'] },
    { title: 'Clarity', weight: 33, cells: ['a', 'b', 'c'] }] };

describe('automatic rubric designer OCR-job lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Assignment.findById.mockResolvedValue({ _id: 'assignment-1', teacher: 'teacher-1', title: 'Essay' });
    SubmissionFeedback.findOne.mockResolvedValue(null);
    completeRubric.mockResolvedValue(rubric);
  });

  test('does not start a Draft-1 rubric request after its OCR job is superseded', async () => {
    Submission.findOne.mockResolvedValue(null);
    const result = await autoGenerateRubricDesignerForSubmission({ submissionId, expectedOcrJobId: 'old-job' });
    expect(result).toMatchObject({ skipped: true, reason: 'ocr_job_superseded' });
    expect(completeRubric).not.toHaveBeenCalled();
  });

  test('does not persist a rubric if the OCR job changes while AI is running', async () => {
    Submission.findOne.mockResolvedValue({ _id: submissionId, assignment: 'assignment-1', class: 'class-1',
      student: 'student-1', ocrJobId: 'current-job', correctionSourceHash: 'current-source' });
    Submission.exists.mockResolvedValue(false);
    const result = await autoGenerateRubricDesignerForSubmission({ submissionId, expectedOcrJobId: 'current-job' });
    expect(completeRubric).toHaveBeenCalledWith(expect.objectContaining({
      submissionId, assignmentId: 'assignment-1', jobId: 'current-job', ocrJobId: 'current-job',
      sourceHash: 'current-source', caller: 'autoRubricDesignerForSubmission',
      purpose: 'independent_submission_rubric_designer'
    }));
    expect(result).toMatchObject({ skipped: true, reason: 'ocr_job_superseded' });
    expect(SubmissionFeedback.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
