process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';

jest.mock('../src/services/ocrPipeline.service', () => ({
  runOcrAndPersist: jest.fn().mockResolvedValue(undefined),
  runOcrAndPersistForFiles: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({
  autoGenerateRubricDesignerForSubmission: jest.fn().mockResolvedValue(undefined)
}));

const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const FlashcardSet = require('../src/models/FlashcardSet');
const Worksheet = require('../src/models/Worksheet');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

describe('duplicate assignment', () => {
  let teacher;
  let otherTeacher;
  let sourceClass;
  let targetClass;
  let otherClass;
  let token;

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'duplicate-teacher', email: 'duplicate@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'other-duplicate-teacher', email: 'other-duplicate@example.com', role: 'teacher' });
    sourceClass = await Class.create({ name: 'Source Class', teacher: teacher._id, joinCode: 'DUPSOURCE' });
    targetClass = await Class.create({ name: 'Target Class', teacher: teacher._id, joinCode: 'DUPTARGET' });
    otherClass = await Class.create({ name: 'Other Class', teacher: otherTeacher._id, joinCode: 'DUPOTHER' });
    token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
  });

  function makeSource(overrides = {}) {
    return Assignment.create({
      title: 'Argumentative Essay', writingType: 'Argumentative', resourceType: 'essay',
      instructions: 'Write a supported argument with clear evidence.', rubric: '{"legacy":true}',
      rubrics: { totalPoints: 100, criteria: [{ name: 'Evidence', weight: 100,
        levels: [{ title: 'Strong', score: 4, description: 'Specific evidence' }] }] },
      deadline: new Date(Date.now() + 86400000), class: sourceClass._id, teacher: teacher._id,
      qrToken: `source-${Math.random()}`, allowLateResubmission: true, showMarksToStudent: false,
      allowResubmission: true, requireAdaptiveBeforeResubmission: true, ...overrides
    });
  }

  test('rubric save/reload preserves weighting, stales evaluation only, and protects manual grades', async () => {
    const source = await makeSource();
    const student = await User.create({ firebaseUid: 'rubric-student', email: 'rubric-student@example.com', role: 'student' });
    const submission = await Submission.create({ student: student._id, assignment: source._id, class: sourceClass._id,
      status: 'submitted', submittedAt: new Date(), ocrStatus: 'completed', ocrText: 'Preserved essay', correctionStatus: 'completed',
      correctionSourceHash: 'source-hash', semanticStatus: 'completed', evaluationStatus: 'completed', evaluationRubricSourceHash: 'old-rubric' });
    await SubmissionFeedback.create({ submissionId: submission._id, studentId: student._id, teacherId: teacher._id,
      classId: sourceClass._id, overallScore: 76, evaluationStatus: 'completed', evaluationSourceHash: 'source-hash',
      evaluationRubricSourceHash: 'old-rubric', overriddenByTeacher: false });
    const designer = { title: 'Essay', totalPoints: 100,
      levels: [{ title: 'Strong', maxPoints: 4 }, { title: 'Developing', maxPoints: 0 }],
      criteria: [{ title: 'Ideas', weight: 70, cells: ['Strong ideas', 'Develop ideas'] },
        { title: 'Structure', weight: 30, cells: ['Clear structure', 'Improve structure'] }] };
    const save = () => request(app).patch(`/api/assignments/${source._id}/rubrics`)
      .set('Authorization', `Bearer ${token}`).send({ rubricDesigner: designer });
    const response = await save();
    expect(response.status).toBe(200);
    const reloaded = await Assignment.findById(source._id).lean();
    expect(reloaded.rubrics.totalPoints).toBe(100);
    expect(reloaded.rubrics.criteria.map(row => row.weight)).toEqual([70, 30]);
    expect(reloaded.rubrics.criteria[0].levels[1].score).toBe(0);
    const feedback = await SubmissionFeedback.findOne({ submissionId: submission._id });
    expect(feedback).toMatchObject({ evaluationStatus: 'stale', overriddenByTeacher: false,
      previousEvaluation: { overallScore: 76 } });
    expect(await Submission.findById(submission._id)).toMatchObject({ ocrStatus: 'completed', ocrText: 'Preserved essay',
      correctionStatus: 'completed', correctionSourceHash: 'source-hash', evaluationStatus: 'stale' });
    await SubmissionFeedback.updateOne({ _id: feedback._id }, { $set: { overriddenByTeacher: true, overallScore: 88, evaluationStatus: 'completed' } });
    await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'completed' } });
    designer.criteria[0].weight = 60;
    designer.criteria[1].weight = 40;
    expect((await save()).status).toBe(200);
    expect(await SubmissionFeedback.findById(feedback._id)).toMatchObject({ overriddenByTeacher: true, overallScore: 88, evaluationStatus: 'completed' });
  });

  test('invalid rubric is rejected before changing the stored assignment', async () => {
    const source = await makeSource();
    const original = (await Assignment.findById(source._id).lean()).rubrics;
    const response = await request(app).patch(`/api/assignments/${source._id}/rubrics`)
      .set('Authorization', `Bearer ${token}`).send({ rubrics: { totalPoints: 100, criteria: [
        { name: 'Ideas', weight: -10, levels: [{ title: 'Strong', score: 4, description: 'Good' }] }
      ] } });
    expect(response.status).toBe(400);
    expect((await Assignment.findById(source._id).lean()).rubrics).toEqual(original);
  });

  test('essay list counts actual assignment references without per-assignment countDocuments calls', async () => {
    const source = await makeSource();
    await makeSource({ title: 'Second assignment' });
    await Submission.create({ student: otherTeacher._id, assignment: source._id, class: sourceClass._id, status: 'submitted', submittedAt: new Date() });
    const count = jest.spyOn(Submission, 'countDocuments');
    const response = await request(app).get(`/api/assignments/class/${sourceClass._id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    expect(response.body.data.find(item => item._id === String(source._id)).submitted).toBe(1);
    expect(count).not.toHaveBeenCalled();
    count.mockRestore();
  });

  test('copies only configuration into a clean cross-class assignment with fresh identity', async () => {
    const source = await makeSource();
    await Submission.create({
      student: otherTeacher._id, assignment: source._id, class: sourceClass._id, status: 'submitted',
      submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
      semanticStatus: 'completed', evaluationStatus: 'completed', writingCorrections: []
    });
    const sourceBefore = (await Assignment.findById(source._id).lean());
    const deadline = new Date(Date.now() + 172800000).toISOString();

    const response = await request(app).post(`/api/assignments/${source._id}/duplicate`)
      .set('Authorization', `Bearer ${token}`)
      .send({ targetClassId: String(targetClass._id), title: 'Argumentative Essay - Copy', deadline });

    expect(response.status).toBe(200);
    expect(response.body.data._id).not.toBe(String(source._id));
    expect(response.body.data.qrToken).toBeTruthy();
    expect(response.body.data.qrToken).not.toBe(source.qrToken);
    expect(response.body.data).toMatchObject({
      title: 'Argumentative Essay - Copy', writingType: 'Argumentative', resourceType: 'essay',
      instructions: source.instructions, rubric: source.rubric, allowLateResubmission: true,
      showMarksToStudent: false, allowResubmission: true, requireAdaptiveBeforeResubmission: true
    });
    expect(String(response.body.data.class._id || response.body.data.class)).toBe(String(targetClass._id));
    expect(new Date(response.body.data.deadline).toISOString()).toBe(deadline);
    expect(response.body.data.rubrics).toEqual(expect.objectContaining({ totalPoints: 100 }));
    expect(response.body.data.rubrics.criteria[0].levels[0].description).toBe('Specific evidence');
    expect(response.body.data.submitted).toBeUndefined();
    expect(await Submission.countDocuments({ assignment: response.body.data._id })).toBe(0);
    expect(await Assignment.findById(source._id).lean()).toMatchObject(sourceBefore);
  });

  test('supports same-class duplication and normalizes dependent adaptive settings', async () => {
    const source = await makeSource({ allowResubmission: false, requireAdaptiveBeforeResubmission: true });
    const response = await request(app).post(`/api/assignments/${source._id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ targetClassId: String(sourceClass._id),
        title: 'Same Class Copy', deadline: new Date(Date.now() + 172800000).toISOString() });
    expect(response.status).toBe(200);
    expect(String(response.body.data.class._id || response.body.data.class)).toBe(String(sourceClass._id));
    expect(response.body.data.allowResubmission).toBe(false);
    expect(response.body.data.requireAdaptiveBeforeResubmission).toBe(false);
  });

  test('preserves valid flashcard and worksheet resource configuration without cloning resources', async () => {
    const flashcards = await FlashcardSet.create({
      title: 'Vocabulary', ownerId: teacher._id,
      cards: [{ front: 'Term', back: 'Definition' }], assignedClasses: [sourceClass._id]
    });
    const worksheet = await Worksheet.create({
      title: 'Practice Worksheet', assignmentDeadline: new Date(Date.now() + 86400000),
      createdBy: teacher._id
    });

    for (const [resourceType, resource] of [['flashcard', flashcards], ['worksheet', worksheet]]) {
      const source = await makeSource({
        title: `${resourceType} source`, resourceType, resourceId: String(resource._id),
        writingType: resourceType
      });
      const response = await request(app).post(`/api/assignments/${source._id}/duplicate`)
        .set('Authorization', `Bearer ${token}`).send({
          targetClassId: String(targetClass._id), title: `${resourceType} copy`,
          deadline: new Date(Date.now() + 172800000).toISOString()
        });

      expect(response.status).toBe(200);
      expect(response.body.data.resourceType).toBe(resourceType);
      expect(response.body.data.resourceId).toBe(String(resource._id));
      expect(response.body.data._id).not.toBe(String(source._id));
      expect(response.body.data.qrToken).not.toBe(source.qrToken);
      expect(response.body.data.allowResubmission).toBe(false);
      expect(response.body.data.requireAdaptiveBeforeResubmission).toBe(false);
    }

    const refreshedFlashcards = await FlashcardSet.findById(flashcards._id).lean();
    expect(refreshedFlashcards.assignedClasses.map(String)).toContain(String(targetClass._id));
    expect(await FlashcardSet.countDocuments()).toBe(1);
    expect(await Worksheet.countDocuments()).toBe(1);
  });

  test('does not reveal or duplicate another teacher assignment', async () => {
    const source = await makeSource({ teacher: otherTeacher._id, class: otherClass._id });
    const response = await request(app).post(`/api/assignments/${source._id}/duplicate`)
      .set('Authorization', `Bearer ${token}`).send({ targetClassId: String(targetClass._id),
        title: 'Forbidden Copy', deadline: new Date(Date.now() + 172800000).toISOString() });
    expect(response.status).toBe(404);
    expect(await Assignment.countDocuments({ title: 'Forbidden Copy' })).toBe(0);
  });

  test('rejects another teacher target, archived targets, invalid targets, and expired deadlines', async () => {
    const source = await makeSource();
    const base = { title: 'Rejected Copy', deadline: new Date(Date.now() + 172800000).toISOString() };
    expect((await request(app).post(`/api/assignments/${source._id}/duplicate`).set('Authorization', `Bearer ${token}`)
      .send({ ...base, targetClassId: String(otherClass._id) })).status).toBe(404);
    targetClass.status = 'archived'; await targetClass.save();
    expect((await request(app).post(`/api/assignments/${source._id}/duplicate`).set('Authorization', `Bearer ${token}`)
      .send({ ...base, targetClassId: String(targetClass._id) })).status).toBe(404);
    expect((await request(app).post(`/api/assignments/${source._id}/duplicate`).set('Authorization', `Bearer ${token}`)
      .send({ ...base, targetClassId: 'invalid' })).status).toBe(400);
    expect((await request(app).post(`/api/assignments/${source._id}/duplicate`).set('Authorization', `Bearer ${token}`)
      .send({ ...base, targetClassId: String(sourceClass._id), deadline: new Date(Date.now() - 1000).toISOString() })).status).toBe(400);
    expect(await Assignment.countDocuments({ title: 'Rejected Copy' })).toBe(0);
  });
});
