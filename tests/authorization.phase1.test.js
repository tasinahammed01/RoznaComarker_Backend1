process.env.JWT_SECRET = process.env.JWT_SECRET || 'phase1-security-test-secret';
process.env.NODE_ENV = 'test';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const textGenerate = jest.fn();
const fileGenerate = jest.fn();
jest.mock('../src/services/worksheetTextService', () => ({
  generateWorksheetFromText: (...args) => textGenerate(...args)
}));
jest.mock('../src/services/worksheetFileService', () => ({
  generateWorksheetFromFile: (...args) => fileGenerate(...args)
}));

const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const Feedback = require('../src/models/Feedback');
const File = require('../src/models/File');
const { WorksheetDocumentModel } = require('../src/models/WorksheetDocument');

const privateFilename = '11111111-1111-4111-8111-111111111111.png';
const privatePath = path.resolve(__dirname, '../uploads/submissions', privateFilename);
const feedbackFilename = '66666666-6666-4666-8666-666666666666.pdf';
const feedbackPath = path.resolve(__dirname, '../uploads/feedback', feedbackFilename);

function token(user) {
  return signTestJwt({ id: user._id, firebaseUid: user.firebaseUid, role: user.role });
}

function worksheet(createdBy, id = '22222222-2222-4222-8222-222222222222') {
  return {
    _id: id,
    version: '1.0',
    createdAt: new Date().toISOString(),
    createdBy: String(createdBy),
    source: 'text_prompt',
    meta: { title: 'Secure worksheet', subject: 'English', difficulty: 'medium' },
    design: {}, sections: [], answerKey: []
  };
}

describe('Phase 1 authorization boundaries', () => {
  let teacher;
  let otherTeacher;
  let student;
  let otherStudent;
  let classDoc;
  let submissionFile;

  beforeAll(async () => {
    await connectInMemoryMongo();
  });

  afterAll(async () => {
    if (fs.existsSync(privatePath)) fs.unlinkSync(privatePath);
    if (fs.existsSync(feedbackPath)) fs.unlinkSync(feedbackPath);
    await disconnectInMemoryMongo();
  });

  beforeEach(async () => {
    await clearDatabase();
    textGenerate.mockReset();
    fileGenerate.mockReset();

    const plan = await Plan.create({
      name: 'Free', slug: 'free', isActive: true,
      features: { aiWorksheets: true, aiWorksheetsLimit: 25, maxClasses: 10, maxStudents: 50, essayAnalysesPerMonth: 100, storageMB: 1000 }
    });
    [teacher, otherTeacher, student, otherStudent] = await User.create([
      { firebaseUid: 'teacher-1', email: 'teacher1@example.test', role: 'teacher', plan: plan._id, stripeCustomerId: 'cus_private_1' },
      { firebaseUid: 'teacher-2', email: 'teacher2@example.test', role: 'teacher', plan: plan._id },
      { firebaseUid: 'student-1', email: 'student1@example.test', role: 'student', plan: plan._id },
      { firebaseUid: 'student-2', email: 'student2@example.test', role: 'student', plan: plan._id }
    ]);
    classDoc = await Class.create({ name: 'Owned class', teacher: teacher._id, joinCode: 'AUTH01' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    const assignment = await Assignment.create({
      title: 'Private essay', deadline: new Date(Date.now() + 86400000),
      class: classDoc._id, teacher: teacher._id
    });
    submissionFile = await File.create({
      originalName: 'essay.png', filename: privateFilename,
      path: `uploads/submissions/${privateFilename}`,
      url: `/files/submissions/${privateFilename}`,
      uploadedBy: student._id, role: 'student', type: 'submissions'
    });
    const submission = await Submission.create({
      student: student._id, assignment: assignment._id, class: classDoc._id,
      file: submissionFile._id, files: [submissionFile._id],
      fileUrl: submissionFile.url, fileUrls: [submissionFile.url],
      status: 'submitted', submittedAt: new Date(), isLate: false
    });
    const feedbackFile = await File.create({
      originalName: 'feedback.pdf', filename: feedbackFilename,
      path: `uploads/feedback/${feedbackFilename}`,
      url: `/files/feedback/${feedbackFilename}`,
      uploadedBy: teacher._id, role: 'teacher', type: 'feedback'
    });
    await Feedback.create({
      teacher: teacher._id, student: student._id, class: classDoc._id,
      assignment: assignment._id, submission: submission._id,
      file: feedbackFile._id, fileUrl: feedbackFile.url
    });
    fs.mkdirSync(path.dirname(privatePath), { recursive: true });
    fs.writeFileSync(privatePath, Buffer.from('private-test-file'));
    fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
    fs.writeFileSync(feedbackPath, Buffer.from('private-feedback-file'));
  });

  test('private feedback files are limited to the feedback participants', async () => {
    expect((await request(app).get(`/files/feedback/${feedbackFilename}`)).status).toBe(401);
    expect((await request(app).get(`/files/feedback/${feedbackFilename}`).set('Authorization', `Bearer ${token(otherStudent)}`)).status).toBe(403);
    expect((await request(app).get(`/files/feedback/${feedbackFilename}`).set('Authorization', `Bearer ${token(otherTeacher)}`)).status).toBe(403);
    expect((await request(app).get(`/files/feedback/${feedbackFilename}`).set('Authorization', `Bearer ${token(student)}`)).status).toBe(200);
    expect((await request(app).get(`/files/feedback/${feedbackFilename}`).set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(200);
  });

  test('private submission files require auth and enforce owner/class relationships', async () => {
    expect((await request(app).get(`/files/submissions/${privateFilename}`)).status).toBe(401);
    expect((await request(app).get(`/files/submissions/${privateFilename}`).set('Authorization', `Bearer ${token(otherStudent)}`)).status).toBe(403);
    expect((await request(app).get(`/files/submissions/${privateFilename}`).set('Authorization', `Bearer ${token(otherTeacher)}`)).status).toBe(403);
    expect((await request(app).get(`/files/submissions/${privateFilename}`).set('Authorization', `Bearer ${token(student)}`)).status).toBe(200);
    expect((await request(app).get(`/files/submissions/${privateFilename}`).set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(200);
    expect((await request(app).get(`/uploads/submissions/${privateFilename}`)).status).toBe(401);
  });

  test('worksheet document CRUD is teacher-only, owner-scoped, and ignores browser identity', async () => {
    const own = await WorksheetDocumentModel.create(worksheet(teacher._id));
    const foreignId = '33333333-3333-4333-8333-333333333333';
    await WorksheetDocumentModel.create(worksheet(otherTeacher._id, foreignId));

    expect((await request(app).get(`/api/worksheet-documents/${own._id}`)).status).toBe(401);
    expect((await request(app).put(`/api/worksheet-documents/${own._id}`).send({ meta: { title: 'anonymous' } })).status).toBe(401);
    expect((await request(app).delete(`/api/worksheet-documents/${own._id}`)).status).toBe(401);
    expect((await request(app).get(`/api/worksheet-documents/${own._id}`).set('Authorization', `Bearer ${token(student)}`)).status).toBe(403);
    expect((await request(app).get(`/api/worksheet-documents/${foreignId}`).set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(404);
    expect((await request(app).put(`/api/worksheet-documents/${foreignId}`).set('Authorization', `Bearer ${token(teacher)}`).send({ meta: { title: 'stolen' } })).status).toBe(404);
    expect((await request(app).delete(`/api/worksheet-documents/${foreignId}`).set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(404);
    expect((await request(app).post(`/api/worksheet-documents/${foreignId}/duplicate`).set('Authorization', `Bearer ${token(teacher)}`).send({})).status).toBe(404);

    const list = await request(app).get(`/api/worksheet-documents?teacherId=${otherTeacher._id}`).set('Authorization', `Bearer ${token(teacher)}`);
    expect(list.status).toBe(200);
    expect(list.body.worksheets).toHaveLength(1);
    expect(list.body.worksheets[0]._id).toBe(String(own._id));

    const update = await request(app).put(`/api/worksheet-documents/${own._id}`)
      .set('Authorization', `Bearer ${token(teacher)}`)
      .send({ createdBy: String(otherTeacher._id), _id: foreignId, meta: { title: 'Updated', difficulty: 'easy' } });
    expect(update.status).toBe(200);
    expect(update.body.createdBy).toBe(String(teacher._id));
    expect(update.body._id).toBe(String(own._id));
  });

  test('AI generation requires teacher entitlement and derives identity from JWT', async () => {
    const generated = worksheet(teacher._id, '44444444-4444-4444-8444-444444444444');
    textGenerate.mockResolvedValue(generated);
    fileGenerate.mockResolvedValue({ ...generated, _id: '55555555-5555-4555-8555-555555555555', source: 'file_upload' });
    const body = { topic: 'Fractions', subject: 'Math', gradeCategory: 'primary', gradeLevel: '3', teacherId: String(otherTeacher._id) };

    expect((await request(app).post('/api/worksheets/generate/text').send(body)).status).toBe(401);
    expect((await request(app).post('/api/worksheets/generate/file')
      .field('gradeLevel', '3')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'input.png', contentType: 'image/png' })).status).toBe(401);
    expect((await request(app).post('/api/worksheets/generate/text').set('Authorization', `Bearer ${token(student)}`).send(body)).status).toBe(403);
    const textResponse = await request(app).post('/api/worksheets/generate/text').set('Authorization', `Bearer ${token(teacher)}`).send(body);
    expect(textResponse.status).toBe(201);
    expect(textGenerate).toHaveBeenCalledWith(expect.objectContaining({ teacherId: String(teacher._id) }));

    const fileResponse = await request(app).post('/api/worksheets/generate/file')
      .set('Authorization', `Bearer ${token(teacher)}`)
      .field('teacherId', String(otherTeacher._id)).field('gradeLevel', '3')
      .attach('file', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { filename: 'input.png', contentType: 'image/png' });
    expect(fileResponse.status).toBe(201);
    expect(fileGenerate).toHaveBeenCalledWith(expect.objectContaining({ teacherId: String(teacher._id) }));
  });

  test('AI generation rejects a plan without the worksheet feature or exhausted quota', async () => {
    const blockedPlan = await Plan.create({ name: 'Blocked Plan', slug: 'blocked', isActive: true, features: { aiWorksheets: false } });
    teacher.plan = blockedPlan._id;
    await teacher.save();
    const body = { topic: 'Topic', subject: 'Math', gradeCategory: 'primary', gradeLevel: '3' };
    expect((await request(app).post('/api/worksheets/generate/text').set('Authorization', `Bearer ${token(teacher)}`).send(body)).status).toBe(403);

    blockedPlan.features.aiWorksheets = true;
    blockedPlan.features.aiWorksheetsLimit = 1;
    await blockedPlan.save();
    teacher.usage.aiWorksheets = 1;
    await teacher.save();
    expect((await request(app).post('/api/worksheets/generate/text').set('Authorization', `Bearer ${token(teacher)}`).send(body)).status).toBe(403);
  });

  test('user lookups require auth, restrict teachers to enrolled students, and return an allowlist', async () => {
    expect((await request(app).get(`/api/users/${student._id}`)).status).toBe(401);
    expect((await request(app).get(`/api/users/${otherStudent._id}`).set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(403);
    const allowed = await request(app).get(`/api/users/${student._id}`).set('Authorization', `Bearer ${token(teacher)}`);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.email).toBe(student.email);
    expect(allowed.body.data).not.toHaveProperty('stripeCustomerId');
    expect(allowed.body.data).not.toHaveProperty('usage');

    const self = await request(app).get(`/api/users/firebase/${teacher.firebaseUid}`).set('Authorization', `Bearer ${token(teacher)}`);
    expect(self.status).toBe(200);
    expect(self.body.data).not.toHaveProperty('stripeCustomerId');
    expect((await request(app).get('/api/users/not-a-mongo-id').set('Authorization', `Bearer ${token(teacher)}`)).status).toBe(400);
  });
});
