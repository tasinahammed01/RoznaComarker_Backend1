'use strict';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan'); const User = require('../src/models/user.model');
const Submission = require('../src/models/Submission'); const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const CreditTransaction = require('../src/models/CreditTransaction'); const AssessmentRun = require('../src/models/AssessmentRun');
const adaptive = require('../src/services/adaptivePractice.service'); const report = require('../src/services/submissionFeedbackReport.service');
const completion = require('../src/services/assessmentCompletion.service');

let teacher; let submission;
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); jest.restoreAllMocks();
  const plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, features: { essayAnalysesPerMonth: 5 } });
  teacher = await User.create({ firebaseUid: `complete-${Date.now()}`, email: `complete-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
  const student = await User.create({ firebaseUid: `student-${Date.now()}`, email: `student-${Date.now()}@example.com`, role: 'student', plan: plan._id });
  submission = await Submission.create({ student: student._id, assignment: new mongoose.Types.ObjectId(), class: new mongoose.Types.ObjectId(),
    status: 'submitted', submittedAt: new Date(), correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'completed',
    correctionSourceHash: 'source-1', evaluationSourceHash: 'source-1', transcriptText: 'A complete student response.' });
  await SubmissionFeedback.create({ submissionId: submission._id, classId: submission.class, studentId: student._id,
    teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'source-1', overallScore: 80,
    detailedFeedback: { status: 'completed', sourceHash: 'source-1', strengths: [], areasForImprovement: [], actionSteps: [] } });
  jest.spyOn(report, 'buildPersistedSubmissionFeedbackReport').mockResolvedValue({ viewModel: {} });
});

test('all required components transition run to complete before exactly one debit', async () => {
  jest.spyOn(adaptive, 'generateSession').mockResolvedValue({ state: 'ready' });
  await completion.start({ runId: 'run-complete', submission, teacherId: teacher._id, sourceHash: 'source-1' });
  await completion.complete({ runId: 'run-complete', submissionId: submission._id, teacherId: teacher._id, sourceHash: 'source-1' });
  const run = await AssessmentRun.findOne({ runId: 'run-complete' }).lean();
  expect(run).toMatchObject({ status: 'complete', components: { transcription: 'complete', issueDetection: 'complete',
    evaluation: 'complete', detailedFeedback: 'complete', report: 'complete', adaptiveLearning: 'complete' } });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT', status: 'committed' })).toBe(1);
});

test('Adaptive failure leaves the assessment failed and consumes no credit', async () => {
  jest.spyOn(adaptive, 'generateSession').mockRejectedValue(new Error('provider failed'));
  await expect(completion.complete({ runId: 'run-adaptive-failed', submissionId: submission._id,
    teacherId: teacher._id, sourceHash: 'source-1' })).rejects.toMatchObject({ code: 'ASSESSMENT_COMPLETION_FAILED' });
  expect(await AssessmentRun.findOne({ runId: 'run-adaptive-failed' })).toMatchObject({ status: 'failed' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(0);
});

test('report preparation failure leaves the assessment failed and consumes no credit', async () => {
  report.buildPersistedSubmissionFeedbackReport.mockRejectedValueOnce(new Error('report failed'));
  jest.spyOn(adaptive, 'generateSession').mockResolvedValue({ state: 'ready' });
  await expect(completion.complete({ runId: 'run-report-failed', submissionId: submission._id,
    teacherId: teacher._id, sourceHash: 'source-1' })).rejects.toMatchObject({ code: 'ASSESSMENT_COMPLETION_FAILED' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(0);
});
