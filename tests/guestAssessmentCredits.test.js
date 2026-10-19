'use strict';
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/SubmissionFeedback');
const Institution = require('../src/models/Institution');
const Member = require('../src/models/InstitutionMember');
const Wallet = require('../src/models/InstitutionCreditWallet');
const Transaction = require('../src/models/InstitutionCreditTransaction');
const PersonalWallet = require('../src/models/CreditWallet');
const accounting = require('../src/services/assessmentCreditRouter.service');
const completion = require('../src/services/assessmentCompletion.service');
let teacher, assignment, submission, institution;
jest.setTimeout(60000);
beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  teacher = await User.create({ firebaseUid: 'guest-institution-teacher', email: 'teacher@example.com', role: 'teacher' });
  institution = await Institution.create({ name: 'Guest school', ownerUserId: teacher._id, status: 'ACTIVE', plan: { status: 'ACTIVE' } });
  await Member.create({ institutionId: institution._id, userId: teacher._id, role: 'INSTITUTION_OWNER', status: 'ACTIVE' });
  await Wallet.create({ institutionId: institution._id, monthlyCredits: 3,
    cycleStart: new Date(Date.now() - 86400000), cycleEnd: new Date(Date.now() + 28 * 86400000) });
  const classDoc = await Class.create({ name: 'Guest class', teacher: teacher._id, institutionId: institution._id, joinCode: 'GUEST-INSTITUTION' });
  assignment = await Assignment.create({ title: 'Guest essay', teacher: teacher._id, class: classDoc._id, allowGuestSubmission: true });
  submission = await Submission.create({ submissionMode: 'guest', guest: { displayName: 'Student', normalizedEmail: 'student@example.com' },
    assignment: assignment._id, class: classDoc._id, status: 'submitted', submittedAt: new Date(),
    ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed', evaluationStatus: 'completed',
    correctionSourceHash: 'guest-source', evaluationSourceHash: 'guest-source', transcriptText: 'A guest essay.' });
  await Feedback.create({ submissionMode: 'guest', submissionId: submission._id, classId: classDoc._id, teacherId: teacher._id,
    evaluationStatus: 'completed', evaluationSourceHash: 'guest-source', overallScore: 80,
    detailedFeedback: { status: 'completed', sourceHash: 'guest-source', strengths: [], areasForImprovement: [], actionSteps: [] } });
});
test('concurrent guest completion charges only the institution once and never creates a personal/guest wallet', async () => {
  expect((await accounting.canRunAssessment({ teacherUserId: teacher._id, assignmentId: assignment._id })).allowed).toBe(true);
  const args = { runId: 'guest-institution-run', submissionId: submission._id, teacherId: teacher._id, sourceHash: 'guest-source' };
  await completion.start({ ...args, submission });
  await Promise.all([completion.complete(args), completion.complete(args), completion.complete(args)]);
  expect((await Wallet.findOne()).monthlyCreditsUsed).toBe(1);
  expect(await Transaction.countDocuments({ status: 'committed', submissionId: submission._id })).toBe(1);
  expect(await PersonalWallet.countDocuments()).toBe(0);
  expect(await User.countDocuments()).toBe(1);
  expect((await Submission.findById(submission._id)).student).toBeUndefined();
});
test('exhausted institution credits block a guest assessment without falling back to a personal wallet', async () => {
  await Wallet.updateOne({ institutionId: institution._id }, { $set: { monthlyCreditsUsed: 3 } });
  expect((await accounting.canRunAssessment({ teacherUserId: teacher._id, assignmentId: assignment._id })).allowed).toBe(false);
  expect(await PersonalWallet.countDocuments()).toBe(0);
  expect(await Transaction.countDocuments()).toBe(0);
});
