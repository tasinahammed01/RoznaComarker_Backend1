'use strict';
jest.mock('../src/models/Submission', () => ({ exists: jest.fn(), updateOne: jest.fn() }));
jest.mock('../src/models/SubmissionFeedback', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../src/models/class.model', () => ({ findById: () => ({ select: () => ({ lean: async () => null }) }) }));
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const evaluation = require('../src/services/canonicalEvaluation.service');
const policy = require('../src/services/teacherEvaluationPolicy.service');
const semantic = require('../src/services/semanticRubricAssessment.service');
const assignment = { title: 'Essay' };
// The corrections pipeline deliberately serializes a Mongoose document before this call.
const submission = JSON.parse(JSON.stringify({ _id: 'guest-submission', class: 'class', submissionMode: 'guest',
  transcriptText: 'A clear essay.', ocrStatus: 'completed', correctionSourceHash: 'source', evaluationJobId: 'job' }));
function prepared() {
  return { sourceHash: 'source', policyHash: policy.evaluationPolicyHash(policy.normalizeTeacherEvaluationPolicy(null)),
    rubricHash: evaluation.hashRubric(assignment), customRubricStatus: 'absent',
    promptVersion: semantic.PROMPT_VERSION, schemaVersion: semantic.SCHEMA_VERSION,
    semantic: { sourceHash: 'source', provider: 'test', model: 'test', categories: Object.fromEntries(
      ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'].map(key => [key, { score: 16, maxScore: 20, comment: 'Evidence.' }])) } };
}
beforeEach(() => {
  jest.clearAllMocks(); Submission.exists.mockResolvedValue({ _id: submission._id });
  Submission.updateOne.mockResolvedValue({ modifiedCount: 1 }); Feedback.findOneAndUpdate.mockResolvedValue({});
});
const persist = () => evaluation.persistProvisionalScore({ submission, assignment, sourceHash: 'source', jobId: 'job', preparedRubricAssessment: prepared() });
test('serialized guest input persists provisional score using the actual model with full ownership guards', async () => {
  expect(submission.constructor.exists).toBeUndefined();
  await expect(persist()).resolves.toMatchObject({ status: 'partial', overallScore: expect.any(Number) });
  const ownership = { _id: submission._id, correctionSourceHash: 'source', correctionJobId: 'job', evaluationJobId: 'job' };
  expect(Submission.exists).toHaveBeenCalledWith(ownership);
  expect(Submission.updateOne).toHaveBeenCalledWith(ownership, expect.any(Object));
  expect(Feedback.findOneAndUpdate).toHaveBeenCalledTimes(1);
  expect(Feedback.findOneAndUpdate.mock.calls[0][1].$set).toMatchObject({ submissionMode: 'guest', evaluationStatus: 'partial' });
});
test('a superseded guest job cannot write feedback', async () => {
  Submission.exists.mockResolvedValue(null);
  await expect(persist()).rejects.toMatchObject({ code: 'ANALYSIS_JOB_SUPERSEDED' });
  expect(Feedback.findOneAndUpdate).not.toHaveBeenCalled(); expect(Submission.updateOne).not.toHaveBeenCalled();
});
test('a job superseded during feedback persistence is still refused at the guarded submission write', async () => {
  Submission.updateOne.mockResolvedValue({ modifiedCount: 0 });
  await expect(persist()).rejects.toMatchObject({ code: 'ANALYSIS_JOB_SUPERSEDED' });
});
