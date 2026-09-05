'use strict';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const Plan = require('../src/models/Plan'); const User = require('../src/models/user.model');
const Submission = require('../src/models/Submission'); const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Class = require('../src/models/class.model'); const Assignment = require('../src/models/assignment.model');
const CreditTransaction = require('../src/models/CreditTransaction'); const AssessmentRun = require('../src/models/AssessmentRun');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const adaptive = require('../src/services/adaptivePractice.service'); const report = require('../src/services/submissionFeedbackReport.service');
const completion = require('../src/services/assessmentCompletion.service');
const referralService = require('../src/services/referral.service');

let teacher; let submission;
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); jest.restoreAllMocks();
  const plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, features: { essayAnalysesPerMonth: 5 } });
  teacher = await User.create({ firebaseUid: `complete-${Date.now()}`, email: `complete-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
  const student = await User.create({ firebaseUid: `student-${Date.now()}`, email: `student-${Date.now()}@example.com`, role: 'student', plan: plan._id });
  const classDoc = await Class.create({ name: 'Completion class', teacher: teacher._id, joinCode: `C${Date.now()}` });
  const assignment = await Assignment.create({ title: 'Completion assignment', teacher: teacher._id, class: classDoc._id });
  submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
    status: 'submitted', submittedAt: new Date(), correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'completed',
    correctionSourceHash: 'source-1', evaluationSourceHash: 'source-1', transcriptText: 'A complete student response.' });
  await SubmissionFeedback.create({ submissionId: submission._id, classId: submission.class, studentId: student._id,
    teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'source-1', overallScore: 80,
    detailedFeedback: { status: 'completed', sourceHash: 'source-1', strengths: [], areasForImprovement: [], actionSteps: [] } });
  jest.spyOn(report, 'buildPersistedSubmissionFeedbackReport').mockResolvedValue({ viewModel: {} });
});

test('all required components transition run to complete before exactly one debit', async () => {
  const generate = jest.spyOn(adaptive, 'generateSession');
  await completion.start({ runId: 'run-complete', submission, teacherId: teacher._id, sourceHash: 'source-1' });
  await completion.complete({ runId: 'run-complete', submissionId: submission._id, teacherId: teacher._id, sourceHash: 'source-1' });
  await completion.complete({ runId: 'run-complete', submissionId: submission._id, teacherId: teacher._id, sourceHash: 'source-1' });
  const run = await AssessmentRun.findOne({ runId: 'run-complete' }).lean();
  expect(run).toMatchObject({ status: 'complete', components: { transcription: 'complete', issueDetection: 'complete',
    evaluation: 'complete', detailedFeedback: 'complete', report: 'complete', adaptiveLearning: 'not_required' },
  adaptiveState: 'not_generated' });
  expect(generate).not.toHaveBeenCalled();
  expect(await AdaptivePracticeSession.countDocuments()).toBe(0);
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT', status: 'committed' })).toBe(1);
});

test('assessment completion does not invoke Adaptive Practice even if its generator would fail', async () => {
  const generate = jest.spyOn(adaptive, 'generateSession').mockRejectedValue(new Error('provider failed'));
  await completion.complete({ runId: 'run-adaptive-independent', submissionId: submission._id,
    teacherId: teacher._id, sourceHash: 'source-1' });
  expect(await AssessmentRun.findOne({ runId: 'run-adaptive-independent' })).toMatchObject({
    status: 'complete', adaptiveState: 'not_generated', components: { adaptiveLearning: 'not_required' }
  });
  expect(generate).not.toHaveBeenCalled();
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT', status: 'committed' })).toBe(1);
});

test('a referral reward failure cannot fail an otherwise successful assessment', async () => {
  jest.spyOn(referralService, 'qualifyReferral').mockRejectedValue(new Error('temporary referral failure'));
  await expect(completion.complete({ runId: 'run-referral-independent', submissionId: submission._id,
    teacherId: teacher._id, sourceHash: 'source-1' })).resolves.toMatchObject({ run: { status: 'complete' } });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT', status: 'committed' })).toBe(1);
});

test('report preparation failure leaves the assessment failed and consumes no credit', async () => {
  report.buildPersistedSubmissionFeedbackReport.mockRejectedValueOnce(new Error('report failed'));
  const generate = jest.spyOn(adaptive, 'generateSession');
  await expect(completion.complete({ runId: 'run-report-failed', submissionId: submission._id,
    teacherId: teacher._id, sourceHash: 'source-1' })).rejects.toMatchObject({ code: 'ASSESSMENT_COMPLETION_FAILED' });
  expect(await CreditTransaction.countDocuments({ type: 'ASSESSMENT_DEBIT' })).toBe(0);
  expect(generate).not.toHaveBeenCalled();
});
