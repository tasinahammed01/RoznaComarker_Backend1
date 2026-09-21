'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'membership-progress-quota-test-secret';
process.env.FRONTEND_URL = 'http://localhost:4200';
jest.mock('../src/services/ocrPipeline.service', () => ({ runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn() }));
jest.mock('../src/services/autoRubricDesigner.service', () => ({ autoGenerateRubricDesignerForSubmission: jest.fn() }));

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const Assignment = require('../src/models/assignment.model');
const Class = require('../src/models/class.model');
const FlashcardSubmission = require('../src/models/FlashcardSubmission');
const Membership = require('../src/models/membership.model');
const Plan = require('../src/models/Plan');
const Submission = require('../src/models/Submission');
const User = require('../src/models/user.model');
const WorksheetSubmission = require('../src/models/WorksheetSubmission');
const { diagnoseTeacherStudentUsage, reconcileTeacherStudentUsage } = require('../src/services/studentQuota.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

async function actor(role, suffix, plan) {
  const user = await User.create({ firebaseUid: `${role}-${suffix}`, email: `${role}-${suffix}@test.local`, role,
    ...(plan ? { plan: plan._id } : {}) });
  return { user, token: signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role }) };
}

async function setup(limit = 2) {
  const plan = await Plan.create({ name: `Plan ${limit}`, slug: `plan_${limit}`, isActive: true,
    features: { maxClasses: 10, maxStudents: limit, essayAnalysesPerMonth: 100, storageMB: 100 } });
  await Plan.create({ name: 'Free', slug: 'free', isActive: true,
    features: { maxClasses: 10, maxStudents: limit, essayAnalysesPerMonth: 100, storageMB: 100 } });
  const teacher = await actor('teacher', `teacher-${limit}`, plan);
  const classDoc = await Class.create({ name: 'Current roster', teacher: teacher.user._id, joinCode: `JOIN${limit}` });
  return { plan, teacher, classDoc };
}

async function join(student, joinCode) {
  return request(app).post('/api/memberships/join')
    .set('Authorization', `Bearer ${student.token}`).send({ joinCode });
}

describe('current roster progress and student quota', () => {
  beforeAll(async () => { await connectInMemoryMongo(); await Promise.all([Membership.init(), Class.init()]); });
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); jest.restoreAllMocks(); });

  test('assignment counts use active roster for essay, flashcard, and worksheet while history remains stored', async () => {
    const { teacher, classDoc } = await setup(5);
    const active = await actor('student', 'active');
    const removed = await actor('student', 'removed');
    const removedTwo = await actor('student', 'removed-two');
    await Membership.create([{ class: classDoc._id, student: active.user._id, status: 'active' },
      { class: classDoc._id, student: removed.user._id, status: 'left' },
      { class: classDoc._id, student: removedTwo.user._id, status: 'left' }]);
    const flashcardId = new mongoose.Types.ObjectId();
    const worksheetId = new mongoose.Types.ObjectId();
    await mongoose.connection.db.collection('flashcardsets').insertOne({ _id: flashcardId, title: 'Cards' });
    await mongoose.connection.db.collection('worksheets').insertOne({ _id: worksheetId, title: 'Sheet', createdBy: teacher.user._id });
    const [essay, flashcard, worksheet] = await Assignment.create([
      { title: 'Essay', writingType: 'Essay', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher.user._id, resourceType: 'essay' },
      { title: 'Cards', writingType: 'flashcard', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher.user._id, resourceType: 'flashcard', resourceId: String(flashcardId) },
      { title: 'Sheet', writingType: 'worksheet', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher.user._id, resourceType: 'worksheet', resourceId: String(worksheetId) }
    ]);
    for (const student of [active.user, removed.user, removedTwo.user]) {
      await Submission.create({ student: student._id, assignment: essay._id, class: classDoc._id,
        status: 'submitted', submittedAt: new Date(), isLate: false });
      await FlashcardSubmission.create({ flashcardSetId: flashcardId, assignmentId: flashcard._id, userId: student._id });
      await WorksheetSubmission.create({ worksheetId, assignmentId: worksheet._id, studentId: student._id });
    }

    const response = await request(app).get(`/api/assignments/class/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.map(item => ({ type: item.resourceType, submitted: item.submitted, total: item.total })))
      .toEqual(expect.arrayContaining([
        { type: 'essay', submitted: 1, total: 1 },
        { type: 'flashcard', submitted: 1, total: 1 },
        { type: 'worksheet', submitted: 1, total: 1 }
      ]));
    expect(await Submission.countDocuments({ assignment: essay._id })).toBe(3);
    const history = await request(app).get(`/api/submissions/assignment/${essay._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(history.status).toBe(200);
    expect(history.body.data).toHaveLength(3);
  });

  test('zero active students plus historical work reports 0/0', async () => {
    const { teacher, classDoc } = await setup(5);
    const removed = await actor('student', 'only-removed');
    await Membership.create({ class: classDoc._id, student: removed.user._id, status: 'left' });
    const assignment = await Assignment.create({ title: 'Essay', writingType: 'Essay', deadline: new Date(Date.now() + 86400000),
      class: classDoc._id, teacher: teacher.user._id });
    await Submission.create({ student: removed.user._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false });
    const response = await request(app).get(`/api/assignments/class/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(response.body.data[0]).toMatchObject({ submitted: 0, total: 0 });
  });

  test('one active student without work reports 0/1 even when a removed student has history', async () => {
    const { teacher, classDoc } = await setup(5);
    const active = await actor('student', 'active-no-work');
    const removed = await actor('student', 'removed-with-work');
    await Membership.create([
      { class: classDoc._id, student: active.user._id, status: 'active' },
      { class: classDoc._id, student: removed.user._id, status: 'left' }
    ]);
    const assignment = await Assignment.create({ title: 'Essay', writingType: 'Essay', deadline: new Date(Date.now() + 86400000),
      class: classDoc._id, teacher: teacher.user._id });
    await Submission.create({ student: removed.user._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false });

    const response = await request(app).get(`/api/assignments/class/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(response.status).toBe(200);
    expect(response.body.data[0]).toMatchObject({ submitted: 0, total: 1 });
    expect(await Submission.countDocuments({ assignment: assignment._id })).toBe(1);
  });

  test('teacher removal changes submitted current progress from 1/1 to 0/0 without deleting history', async () => {
    const { teacher, classDoc } = await setup(5);
    const student = await actor('student', 'submit-then-remove');
    await join(student, classDoc.joinCode);
    const assignment = await Assignment.create({ title: 'Essay', writingType: 'Essay', deadline: new Date(Date.now() + 86400000),
      class: classDoc._id, teacher: teacher.user._id });
    await Submission.create({ student: student.user._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false });
    const before = await request(app).get(`/api/assignments/class/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(before.body.data[0]).toMatchObject({ submitted: 1, total: 1 });

    await request(app).delete(`/api/classes/${classDoc._id}/students/${student.user._id}`)
      .set('Authorization', `Bearer ${teacher.token}`).expect(200);
    const after = await request(app).get(`/api/assignments/class/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`);
    expect(after.body.data[0]).toMatchObject({ submitted: 0, total: 0 });
    expect(await Submission.countDocuments({ assignment: assignment._id, student: student.user._id })).toBe(1);
  });

  test('/assignments/my includes active memberships and excludes left memberships', async () => {
    const { teacher, classDoc } = await setup(5);
    const active = await actor('student', 'my-active');
    const left = await actor('student', 'my-left');
    await Membership.create([
      { class: classDoc._id, student: active.user._id, status: 'active' },
      { class: classDoc._id, student: left.user._id, status: 'left' }
    ]);
    const assignment = await Assignment.create({ title: 'Visible assignment', writingType: 'Essay',
      deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher.user._id });
    const activeResponse = await request(app).get('/api/assignments/my')
      .set('Authorization', `Bearer ${active.token}`);
    const leftResponse = await request(app).get('/api/assignments/my')
      .set('Authorization', `Bearer ${left.token}`);
    expect(activeResponse.status).toBe(200);
    expect(activeResponse.body.data.map(item => item._id)).toContain(String(assignment._id));
    expect(leftResponse.status).toBe(200);
    expect(leftResponse.body.data).toEqual([]);
  });

  test('configured dynamic limit is atomic and concurrent final-seat joins cannot oversubscribe', async () => {
    const { teacher, classDoc } = await setup(1);
    const first = await actor('student', 'concurrent-one');
    const second = await actor('student', 'concurrent-two');
    const responses = await Promise.all([join(first, classDoc.joinCode), join(second, classDoc.joinCode)]);
    expect(responses.filter(item => item.status === 200)).toHaveLength(1);
    expect(responses.find(item => item.status !== 200).body.code).toBe('STUDENT_LIMIT_REACHED');
    expect(await Membership.countDocuments({ class: classDoc._id, status: 'active' })).toBe(1);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
  });

  test('teacher removal and student self-leave each release exactly one seat', async () => {
    const { teacher, classDoc } = await setup(2);
    const one = await actor('student', 'remove-one');
    const two = await actor('student', 'leave-two');
    await join(one, classDoc.joinCode); await join(two, classDoc.joinCode);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(2);
    await request(app).delete(`/api/classes/${classDoc._id}/students/${one.user._id}`)
      .set('Authorization', `Bearer ${teacher.token}`).expect(200);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
    await request(app).patch(`/api/memberships/leave/${classDoc._id}`)
      .set('Authorization', `Bearer ${two.token}`).expect(200);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(0);
    const duplicateLeave = await request(app).patch(`/api/memberships/leave/${classDoc._id}`)
      .set('Authorization', `Bearer ${two.token}`);
    expect(duplicateLeave.status).toBe(409);
    expect(duplicateLeave.body.code).toBe('ALREADY_LEFT');
    expect((await User.findById(teacher.user._id)).usage.students).toBe(0);
  });

  test('rejoin consumes one seat and duplicate join consumes none', async () => {
    const { teacher, classDoc } = await setup(2);
    const student = await actor('student', 'rejoin');
    expect((await join(student, classDoc.joinCode)).status).toBe(200);
    const duplicate = await join(student, classDoc.joinCode);
    expect(duplicate.status).toBe(409); expect(duplicate.body.code).toBe('ALREADY_JOINED');
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
    await request(app).patch(`/api/memberships/leave/${classDoc._id}`)
      .set('Authorization', `Bearer ${student.token}`).expect(200);
    expect((await join(student, classDoc.joinCode)).status).toBe(200);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
  });

  test('failed membership creation rolls back its reserved seat', async () => {
    const { teacher, classDoc } = await setup(2);
    const student = await actor('student', 'failed-create');
    jest.spyOn(Membership, 'create').mockRejectedValueOnce(new Error('synthetic persistence failure'));
    expect((await join(student, classDoc.joinCode)).status).toBe(500);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(0);
    expect(await Membership.countDocuments()).toBe(0);
  });

  test('soft deletion releases active seats and archive preserves them', async () => {
    const { teacher, classDoc } = await setup(2);
    const student = await actor('student', 'delete-seat');
    await join(student, classDoc.joinCode);
    await request(app).patch(`/api/classes/${classDoc._id}/archive`)
      .set('Authorization', `Bearer ${teacher.token}`).expect(200);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
    await request(app).delete(`/api/classes/${classDoc._id}`)
      .set('Authorization', `Bearer ${teacher.token}`).expect(200);
    expect((await User.findById(teacher.user._id)).usage.students).toBe(0);
    expect((await Membership.findOne({ class: classDoc._id })).status).toBe('left');
  });

  test('legacy drift is diagnosed and explicitly reconciled', async () => {
    const { teacher, classDoc } = await setup(9);
    const student = await actor('student', 'legacy-drift');
    await Membership.create({ class: classDoc._id, student: student.user._id, status: 'active' });
    await User.updateOne({ _id: teacher.user._id }, { $set: { 'usage.students': 8 } });
    const diagnosis = await diagnoseTeacherStudentUsage(teacher.user._id, { classId: classDoc._id });
    expect(diagnosis).toMatchObject({ maxStudents: 9, storedUsageStudents: 8,
      activeMembershipsInActiveClasses: 1, distinctActiveStudentIds: 1,
      affectedClassId: String(classDoc._id), activeMembershipsInAffectedClass: 1, drift: 7 });
    await reconcileTeacherStudentUsage(teacher.user._id, { apply: false });
    expect((await User.findById(teacher.user._id)).usage.students).toBe(8);
    await reconcileTeacherStudentUsage(teacher.user._id, { apply: true });
    expect((await User.findById(teacher.user._id)).usage.students).toBe(1);
  });
});
