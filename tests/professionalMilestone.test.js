'use strict';
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'milestone-test-secret';
const mongoose = require('mongoose'); const Plan = require('../src/models/Plan'); const User = require('../src/models/user.model');
const Class = require('../src/models/class.model'); const Assignment = require('../src/models/assignment.model');
const AssessmentRun = require('../src/models/AssessmentRun'); const ProfessionalMilestone = require('../src/models/ProfessionalMilestone');
const CreditTransaction = require('../src/models/CreditTransaction'); const service = require('../src/services/professionalMilestone.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

describe('professional milestones', () => {
  beforeAll(connectInMemoryMongo); afterAll(disconnectInMemoryMongo); let teacher; let plan;
  beforeEach(async () => {
    await clearDatabase(); jest.restoreAllMocks();
    for (const key of ['FIRST_CLASS', 'FIRST_ASSIGNMENT', 'ASSESSMENTS_10', 'ASSESSMENTS_50', 'ASSESSMENTS_100'])
      delete process.env[`PROFESSIONAL_MILESTONE_${key}_ENABLED`];
    delete process.env.BONUS_REWARD_PROFESSIONAL_MILESTONE_ENABLED; delete process.env.BONUS_REWARD_PROFESSIONAL_MILESTONE_AMOUNT;
    plan = await Plan.create({ name: 'Free', slug: 'free', isActive: true, features: { essayAnalysesPerMonth: 10 } });
    teacher = await User.create({ firebaseUid: 'milestone-teacher', email: 'milestone@example.test', role: 'teacher', plan: plan._id });
  });
  const enable = (...keys) => keys.forEach((key) => { process.env[`PROFESSIONAL_MILESTONE_${key}_ENABLED`] = 'true'; });
  async function makeClass() { return Class.create({ name: 'Class', teacher: teacher._id, joinCode: `M${Date.now()}${Math.random()}` }); }
  async function runs(count, status = 'complete') { const classDoc = await makeClass(); const assignment = await Assignment.create({ title: 'A', writingType: 'essay', deadline: new Date(Date.now() + 100000), class: classDoc._id, teacher: teacher._id });
    for (let i = 0; i < count; i += 1) await AssessmentRun.create({ runId: `run-${status}-${i}`, submissionId: new mongoose.Types.ObjectId(), assignmentId: assignment._id,
      teacherId: teacher._id, sourceHash: `hash-${i}`, status, ...(status === 'complete' ? { completedAt: new Date() } : {}) }); }

  test('disabled milestone does not unlock', async () => { await makeClass(); await service.evaluateProfessionalMilestonesForUser(teacher._id);
    expect(await ProfessionalMilestone.countDocuments()).toBe(0); });
  test('first class unlocks exactly once under concurrency', async () => { enable('FIRST_CLASS'); await makeClass();
    await Promise.all([1, 2, 3].map(() => service.evaluateProfessionalMilestonesForUser(teacher._id, ['CLASSES_CREATED'])));
    expect(await ProfessionalMilestone.countDocuments({ milestoneKey: 'FIRST_CLASS' })).toBe(1); });
  test('failed or absent class creation cannot unlock', async () => { enable('FIRST_CLASS'); await service.evaluateProfessionalMilestonesForUser(teacher._id, ['CLASSES_CREATED']);
    expect(await ProfessionalMilestone.countDocuments()).toBe(0); });
  test('first assignment unlocks once from an owned persisted assignment', async () => { enable('FIRST_ASSIGNMENT'); const classDoc = await makeClass();
    await Assignment.create({ title: 'A', writingType: 'essay', deadline: new Date(Date.now() + 100000), class: classDoc._id, teacher: teacher._id });
    await service.evaluateProfessionalMilestonesForUser(teacher._id, ['ASSIGNMENTS_CREATED']); await service.evaluateProfessionalMilestonesForUser(teacher._id, ['ASSIGNMENTS_CREATED']);
    expect(await ProfessionalMilestone.countDocuments({ milestoneKey: 'FIRST_ASSIGNMENT' })).toBe(1); });
  test('9 to 10 completed assessments unlocks ten while failed runs do not count', async () => { enable('ASSESSMENTS_10'); await runs(9); await runs(1, 'failed');
    await service.evaluateProfessionalMilestonesForUser(teacher._id, ['SUCCESSFUL_ASSESSMENTS']); expect(await ProfessionalMilestone.countDocuments()).toBe(0);
    const classDoc = await makeClass(); const assignment = await Assignment.create({ title: 'B', writingType: 'essay', deadline: new Date(Date.now() + 100000), class: classDoc._id, teacher: teacher._id });
    await AssessmentRun.create({ runId: 'run-complete-10', submissionId: new mongoose.Types.ObjectId(), assignmentId: assignment._id, teacherId: teacher._id, sourceHash: 'h10', status: 'complete' });
    await service.evaluateProfessionalMilestonesForUser(teacher._id, ['SUCCESSFUL_ASSESSMENTS']); expect(await ProfessionalMilestone.countDocuments({ milestoneKey: 'ASSESSMENTS_10' })).toBe(1); });
  test('historical 65 assessments backfill ten and fifty but not one hundred without duplicates', async () => { enable('ASSESSMENTS_10', 'ASSESSMENTS_50', 'ASSESSMENTS_100'); await runs(65);
    await service.milestoneSummary(teacher._id); await service.milestoneSummary(teacher._id);
    expect((await ProfessionalMilestone.find().distinct('milestoneKey')).sort()).toEqual(['ASSESSMENTS_10', 'ASSESSMENTS_50']); });
  test('disabled milestone bonus still allows recognition without credit charges', async () => { enable('FIRST_CLASS'); await makeClass();
    await service.evaluateProfessionalMilestonesForUser(teacher._id, ['CLASSES_CREATED']); expect(await ProfessionalMilestone.countDocuments()).toBe(1);
    expect(await CreditTransaction.countDocuments()).toBe(0); });
  test('configured milestone bonus uses the shared reward pipeline once', async () => { enable('FIRST_CLASS'); process.env.BONUS_REWARD_PROFESSIONAL_MILESTONE_ENABLED = 'true'; process.env.BONUS_REWARD_PROFESSIONAL_MILESTONE_AMOUNT = '3'; await makeClass();
    await Promise.all([service.evaluateProfessionalMilestonesForUser(teacher._id, ['CLASSES_CREATED']), service.evaluateProfessionalMilestonesForUser(teacher._id, ['CLASSES_CREATED'])]);
    expect(await CreditTransaction.countDocuments({ type: 'BONUS_REWARD' })).toBe(1); });
  test('summary exposes deterministic progress without private data', async () => { enable('ASSESSMENTS_10'); await runs(4); const summary = await service.milestoneSummary(teacher._id);
    expect(summary.nextMilestone).toMatchObject({ current: 4, target: 10, percent: 40 }); expect(JSON.stringify(summary)).not.toContain('@'); });
});
