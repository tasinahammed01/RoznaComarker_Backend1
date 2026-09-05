process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
jest.setTimeout(30000);

jest.mock('../src/services/ocrPipeline.service', () => ({
  runOcrAndPersist: jest.fn(), runOcrAndPersistForFiles: jest.fn()
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({
  autoGenerateRubricDesignerForSubmission: jest.fn()
}));

const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const CreditTransaction = require('../src/models/CreditTransaction');
const Plan = require('../src/models/Plan');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('teacher activity summary', () => {
  let teacher; let otherTeacher; let student; let classDoc; let assignment; let token;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await Plan.create({ name: 'Free', slug: 'free', isActive: true, price: 0 });
    teacher = await User.create({ firebaseUid: 'activity-teacher', email: 'activity-teacher@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'activity-other', email: 'activity-other@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'activity-student', email: 'activity-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Active class', teacher: teacher._id, joinCode: 'ACTV01' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    assignment = await Assignment.create({ title: 'Essay', writingType: 'essay', class: classDoc._id,
      teacher: teacher._id, deadline: new Date(Date.now() + 86400000) });
    token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
  });

  async function get() {
    return request(app).get('/api/teacher/activity-summary').set(auth());
  }
  async function acknowledge(ackToken) {
    return request(app).post('/api/teacher/activity-summary/acknowledge').set(auth()).send({ ackToken });
  }
  async function submission(overrides = {}) {
    return Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ...overrides });
  }

  test('first visit reports no history and establishes its baseline only after acknowledgement', async () => {
    await submission();
    const first = await get();
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({ isFirstVisit: true, since: null,
      sinceLastVisit: { newSubmissions: 0, revisedDrafts: 0, adaptiveCompletions: 0 },
      current: { waitingForReview: 1 } });
    expect((await User.findById(teacher._id)).teacherActivityLastViewedAt).toBeUndefined();
    expect((await acknowledge(first.body.data.ackToken)).status).toBe(200);
    expect((await User.findById(teacher._id)).teacherActivityLastViewedAt.toISOString()).toBe(first.body.data.viewedAt);
  });

  test('counts authoritative events and current review state without double-counting revision snapshots or answers', async () => {
    const since = new Date(Date.now() - 60_000);
    await User.updateOne({ _id: teacher._id }, { $set: { teacherActivityLastViewedAt: since } });
    const initial = await submission({ draftNumber: 1 });
    await Submission.collection.updateOne({ _id: initial._id }, { $set: { createdAt: new Date(since.getTime() - 60_000) } });
    const revised = await submission({ student: (await User.create({ firebaseUid: 'second-student', email: 'second@example.com', role: 'student' }))._id,
      draftNumber: 3 });
    await Membership.create({ student: revised.student, class: classDoc._id, status: 'active' });
    await SubmissionRevision.create({ sourceSubmissionId: revised._id, student: revised.student, assignment: assignment._id,
      class: classDoc._id, draftNumber: 2, submittedAt: new Date() });
    await SubmissionRevision.create({ sourceSubmissionId: revised._id, student: revised.student, assignment: assignment._id,
      class: classDoc._id, draftNumber: 1, submittedAt: new Date() });
    await SubmissionFeedback.create({ submissionId: initial._id, classId: classDoc._id, studentId: student._id,
      teacherId: teacher._id, teacherReviewedAt: new Date(), teacherReviewedBy: teacher._id });
    await AdaptivePracticeSession.create({ submissionId: revised._id, studentId: revised.student,
      assignmentId: assignment._id, status: 'ready', sourceFingerprint: 'completed-source', completedAt: new Date(),
      sourceSnapshot: { transcriptFingerprint: 't', feedbackId: new (require('mongoose').Types.ObjectId)(),
        feedbackUpdatedAt: new Date(), skills: [] }, activities: [] });
    const beforeCredits = await CreditTransaction.countDocuments();
    const response = await get();
    expect(response.body.data.since).toBe(since.toISOString());
    expect(response.body.data.sinceLastVisit).toEqual({ newSubmissions: 1, revisedDrafts: 2, adaptiveCompletions: 1 });
    expect(response.body.data.current.waitingForReview).toBe(1);
    expect(await CreditTransaction.countDocuments()).toBe(beforeCredits);
  });

  test('excludes foreign, archived, inactive-assignment, and removed-student data', async () => {
    await User.updateOne({ _id: teacher._id }, { $set: { teacherActivityLastViewedAt: new Date(Date.now() - 60_000) } });
    await Membership.updateOne({ student: student._id, class: classDoc._id }, { $set: { status: 'left' } });
    await submission();
    const archived = await Class.create({ name: 'Archived', teacher: teacher._id, joinCode: 'ARCH01', status: 'archived' });
    const archivedAssignment = await Assignment.create({ title: 'Old', writingType: 'essay', class: archived._id,
      teacher: teacher._id, deadline: new Date(Date.now() + 86400000) });
    await Membership.create({ student: student._id, class: archived._id, status: 'active' });
    await submission({ class: archived._id, assignment: archivedAssignment._id });
    const foreignClass = await Class.create({ name: 'Foreign', teacher: otherTeacher._id, joinCode: 'OTHR01' });
    const foreignAssignment = await Assignment.create({ title: 'Foreign', writingType: 'essay', class: foreignClass._id,
      teacher: otherTeacher._id, deadline: new Date(Date.now() + 86400000) });
    await Membership.create({ student: student._id, class: foreignClass._id, status: 'active' });
    await submission({ class: foreignClass._id, assignment: foreignAssignment._id });
    const response = await get();
    expect(response.body.data.sinceLastVisit).toEqual({ newSubmissions: 0, revisedDrafts: 0, adaptiveCompletions: 0 });
    expect(response.body.data.current.waitingForReview).toBe(0);
  });

  test('duplicate concurrent reads retain the same window and acknowledgements never move the baseline backwards', async () => {
    const since = new Date(Date.now() - 60_000);
    await User.updateOne({ _id: teacher._id }, { $set: { teacherActivityLastViewedAt: since } });
    await submission();
    const [one, two] = await Promise.all([get(), get()]);
    expect(one.body.data.since).toBe(since.toISOString());
    expect(two.body.data.since).toBe(since.toISOString());
    expect(one.body.data.sinceLastVisit.newSubmissions).toBe(1);
    expect(two.body.data.sinceLastVisit.newSubmissions).toBe(1);
    await Promise.all([acknowledge(one.body.data.ackToken), acknowledge(two.body.data.ackToken)]);
    const saved = (await User.findById(teacher._id)).teacherActivityLastViewedAt.getTime();
    expect(saved).toBe(Math.max(new Date(one.body.data.viewedAt).getTime(), new Date(two.body.data.viewedAt).getTime()));
  });
});
