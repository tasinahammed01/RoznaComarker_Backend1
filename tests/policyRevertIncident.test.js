'use strict';
// Starting the isolated Mongo process can exceed Jest's 5s default on Windows CI.
jest.setTimeout(60000);
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const { updateMe } = require('../src/controllers/user.controller');
const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');
const { buildCanonicalResultState } = require('../src/services/canonicalResultState.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');
const policyA = { strictness: 'balanced', checks: { grammarSpelling: true, coherenceLogic: true, factChecking: false } };
const policyB = { ...policyA, strictness: 'strict' };
async function seed() {
  const teacher = await User.create({ firebaseUid: 'policy-incident', email: 'teacher@example.test', role: 'teacher', aiConfig: policyA });
  const cls = await Class.create({ teacher: teacher._id, name: 'Fixture class', joinCode: 'POLICYTEST' });
  const assignment = await Assignment.create({ teacher: teacher._id, class: cls._id, title: 'Fixture assignment' });
  const submission = await Submission.create({ student: new (require('mongoose').Types.ObjectId)(), class: cls._id, assignment: assignment._id,
    submittedAt: new Date(), status: 'submitted', ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
    assessmentStatus: 'complete', evaluationStatus: 'completed', correctionSourceHash: 'fixture-source',
    correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION, evaluationVersion: EVALUATION_VERSION,
    evaluationPolicyHash: evaluationPolicyHash(policyA), evaluationSourceHash: 'fixture-source' });
  await Feedback.create({ submissionId: submission._id, studentId: submission.student, classId: cls._id, teacherId: teacher._id,
    evaluationStatus: 'completed', evaluationSourceHash: 'fixture-source', evaluationPolicyHash: evaluationPolicyHash(policyA),
    assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION, overallScore: 82,
    detailedFeedbackSourceHash: 'fixture-source', detailedFeedback: { status: 'completed', strengths: [], areasForImprovement: [], actionSteps: [] } });
  return { teacher, submission };
}
async function savePolicy(teacherId, aiConfig) {
  const user = await User.findById(teacherId); let body;
  const res = { status: jest.fn().mockReturnThis(), json: value => { body = value; return res; } };
  await updateMe({ user, body: { aiConfig } }, res);
  expect(body.success).toBe(true); return body.data;
}
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo); beforeEach(clearDatabase);
test('policy A -> B -> A restores the existing completed evaluation without re-assessment', async () => {
  const { teacher, submission } = await seed();
  await savePolicy(teacher._id, policyB);
  expect((await Submission.findById(submission._id)).evaluationStatus).toBe('stale');
  await savePolicy(teacher._id, policyA);
  const current = await Submission.findById(submission._id).lean();
  const feedback = await Feedback.findOne({ submissionId: submission._id }).lean();
  expect(buildCanonicalResultState({ submission: current, feedback }).evaluationCurrent).toBe(true);
  expect(current.evaluationStatus).toBe('completed');
});
test.each(['partial', 'rubric', 'override', 'running'])('policy revert preserves %s lifecycle protections', async condition => {
  const { teacher, submission } = await seed();
  if (condition === 'partial') {
    await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'partial' } });
    await Feedback.updateOne({ submissionId: submission._id }, { $set: { evaluationStatus: 'partial' } });
  }
  if (condition === 'rubric') {
    await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'stale' } });
    await Feedback.updateOne({ submissionId: submission._id }, { $set: { evaluationStatus: 'stale', evaluationStaleReason: 'rubric' } });
  }
  if (condition === 'override') await Feedback.updateOne({ submissionId: submission._id }, { $set: { overriddenByTeacher: true } });
  await savePolicy(teacher._id, policyB);
  if (condition === 'running') await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'processing', assessmentStatus: 'processing' } });
  const response = await savePolicy(teacher._id, policyA);
  const result = await Submission.findById(submission._id).lean();
  expect(result.evaluationStatus).toBe(({ partial: 'partial', rubric: 'stale', override: 'completed', running: 'processing' })[condition]);
  if (condition === 'partial') expect(response.evaluationPropagation.restoredCount).toBe(1);
  expect(await require('../src/models/CreditTransaction').countDocuments()).toBe(0);
});
