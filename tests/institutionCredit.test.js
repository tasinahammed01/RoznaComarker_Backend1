'use strict';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const User = require('../src/models/user.model'); const Plan = require('../src/models/Plan');
const Institution = require('../src/models/Institution'); const Member = require('../src/models/InstitutionMember');
const Wallet = require('../src/models/InstitutionCreditWallet'); const Transaction = require('../src/models/InstitutionCreditTransaction');
const Class = require('../src/models/class.model'); const Assignment = require('../src/models/assignment.model');
const PersonalWallet = require('../src/models/CreditWallet'); const router = require('../src/services/assessmentCreditRouter.service');
const institutionCredits = require('../src/services/institutionCredit.service');

let teacher; let institution; let institutionClass; let assignment; let member;
beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo);
beforeEach(async () => {
  await clearDatabase();
  const plan = await Plan.create({ name: 'Free', slug: `free-${Date.now()}`, isActive: true, features: { essayAnalysesPerMonth: 5 } });
  teacher = await User.create({ firebaseUid: `institution-${Date.now()}`, email: `institution-${Date.now()}@example.com`, role: 'teacher', plan: plan._id });
  institution = await Institution.create({ name: 'Rozna School', ownerUserId: teacher._id, status: 'ACTIVE', activeSeatCount: 1,
    plan: { provider: 'MANUAL', status: 'ACTIVE', billingCycleStart: new Date('2026-09-01'), billingCycleEnd: new Date('2026-10-01') } });
  member = await Member.create({ institutionId: institution._id, userId: teacher._id, role: 'INSTITUTION_OWNER', status: 'ACTIVE', joinedAt: new Date() });
  await Wallet.create({ institutionId: institution._id, monthlyCredits: 3, cycleStart: new Date('2026-09-01'), cycleEnd: new Date('2026-10-01') });
  institutionClass = await Class.create({ name: 'Institution English', teacher: teacher._id, institutionId: institution._id, joinCode: `I${Date.now()}` });
  assignment = await Assignment.create({ title: 'Essay', teacher: teacher._id, class: institutionClass._id });
});
const debit = (n) => router.consumeAssessmentCredit({ teacherUserId: teacher._id, submissionId: new mongoose.Types.ObjectId(),
  assignmentId: assignment._id, assessmentId: `run-${n}`, reason: 'AI Assessment' });

test('institution work debits only the shared pool with complete audit context', async () => {
  await debit(1); const wallet = await Wallet.findOne({ institutionId: institution._id });
  expect(wallet.monthlyCreditsUsed).toBe(1); expect(await PersonalWallet.countDocuments()).toBe(0);
  expect(await Transaction.findOne()).toMatchObject({ institutionId: institution._id, teacherUserId: teacher._id,
    classId: institutionClass._id, assignmentId: assignment._id, amount: -1, status: 'committed' });
});
test('same assessment is idempotent under concurrency', async () => {
  const submissionId = new mongoose.Types.ObjectId(); const params = { teacherUserId: teacher._id, submissionId,
    assignmentId: assignment._id, assessmentId: 'same-run', reason: 'AI Assessment' };
  await Promise.all([router.consumeAssessmentCredit(params), router.consumeAssessmentCredit(params)]);
  expect((await Wallet.findOne({ institutionId: institution._id })).monthlyCreditsUsed).toBe(1);
  expect(await Transaction.countDocuments()).toBe(1);
});
test('per-teacher cap and zero pool block without personal fallback', async () => {
  await Member.updateOne({ _id: member._id }, { $set: { monthlyCreditLimit: 1 } }); await debit(1);
  await expect(debit(2)).rejects.toMatchObject({ code: 'INSTITUTION_TEACHER_CAP_REACHED' });
  await Member.updateOne({ _id: member._id }, { $unset: { monthlyCreditLimit: 1 }, $set: { cycleCreditsUsed: 0 } });
  await Wallet.updateOne({ institutionId: institution._id }, { $set: { monthlyCreditsUsed: 3 } });
  await expect(debit(3)).rejects.toMatchObject({ code: 'INSUFFICIENT_INSTITUTION_CREDITS' });
  expect(await PersonalWallet.countDocuments()).toBe(0);
});
test('personal class continues using personal wallet', async () => {
  const personalClass = await Class.create({ name: 'Personal', teacher: teacher._id, joinCode: `P${Date.now()}` });
  const personalAssignment = await Assignment.create({ title: 'Personal essay', teacher: teacher._id, class: personalClass._id });
  await router.consumeAssessmentCredit({ teacherUserId: teacher._id, submissionId: new mongoose.Types.ObjectId(), assignmentId: personalAssignment._id,
    assessmentId: 'personal-run', reason: 'AI Assessment' });
  expect((await PersonalWallet.findOne({ userId: teacher._id })).monthlyCreditsUsed).toBe(1);
  expect((await Wallet.findOne({ institutionId: institution._id })).monthlyCreditsUsed).toBe(0);
});
test('retries a durable member-applied crash stage without double debit', async () => {
  const submissionId = new mongoose.Types.ObjectId(); const idempotencyKey = `institution-assessment:${submissionId}:crash-run`;
  const wallet = await Wallet.findOne({ institutionId: institution._id }); const key = institutionCredits.cycleKey(wallet);
  await Transaction.create({ institutionId: institution._id, teacherUserId: teacher._id, classId: institutionClass._id,
    submissionId, assignmentId: assignment._id, assessmentId: 'crash-run', cycleKey: key, type: 'ASSESSMENT_DEBIT',
    status: 'applying', amount: -1, idempotencyKey, reason: 'AI Assessment' });
  await Member.updateOne({ _id: member._id }, { $set: { cycleKey: key, cycleCreditsUsed: 1 }, $addToSet: { appliedDebitKeys: idempotencyKey } });
  const params = { teacherUserId: teacher._id, submissionId, assignmentId: assignment._id, assessmentId: 'crash-run', reason: 'AI Assessment' };
  await Promise.all([router.consumeAssessmentCredit(params), router.consumeAssessmentCredit(params)]);
  expect((await Member.findById(member._id)).cycleCreditsUsed).toBe(1); expect((await Wallet.findById(wallet._id)).monthlyCreditsUsed).toBe(1);
  expect(await Transaction.countDocuments({ idempotencyKey, status: 'committed' })).toBe(1);
});
test('UTC-safe monthly addition clamps month ends and leap years', () => {
  expect(institutionCredits.addUtcMonthsClamped(new Date('2025-01-31T00:00:00Z')).toISOString()).toBe('2025-02-28T00:00:00.000Z');
  expect(institutionCredits.addUtcMonthsClamped(new Date('2024-01-31T00:00:00Z')).toISOString()).toBe('2024-02-29T00:00:00.000Z');
  expect(institutionCredits.addUtcMonthsClamped(new Date('2024-02-29T00:00:00Z'), 1, 31).toISOString()).toBe('2024-03-31T00:00:00.000Z');
});
