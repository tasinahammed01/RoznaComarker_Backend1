process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');

const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');

const app = require('../src/app');

const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('Submissions & Feedback APIs', () => {
  beforeAll(async () => {
    await connectInMemoryMongo();
    await Plan.seedDefaults();
  });

  afterAll(async () => {
    await disconnectInMemoryMongo();
  });

  beforeEach(async () => {
    await clearDatabase();
    await Plan.seedDefaults();
  });

  test('RBAC: student cannot access teacher submissions list', async () => {
    const teacher = await User.create({ firebaseUid: 't1', email: 't1@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 's1', email: 's1@example.com', role: 'student' });

    const classDoc = await Class.create({
      name: 'Class',
      teacher: teacher._id,
      joinCode: 'join-code-1',
      qrCodeUrl: 'data:,'
    });

    const assignment = await Assignment.create({
      title: 'A1',
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: 'qr-token-1'
    });

    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    const res = await request(app)
      .get(`/api/submissions/assignment/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(403);
    expect(res.body).toHaveProperty('success', false);
  });

  test('Student can submit, teacher can list, teacher can create feedback, student can read feedback', async () => {
    const teacher = await User.create({ firebaseUid: 't2', email: 't2@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 's2', email: 's2@example.com', role: 'student' });

    const classDoc = await Class.create({
      name: 'Class 2',
      teacher: teacher._id,
      joinCode: 'join-code-2',
      qrCodeUrl: 'data:,'
    });

    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });

    const assignment = await Assignment.create({
      title: 'A2',
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: 'qr-token-2'
    });

    const teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    const submit = await request(app)
      .post(`/api/submissions/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'test.pdf', contentType: 'application/pdf' });

    expect(submit.status).toBe(200);
    expect(submit.body).toHaveProperty('success', true);
    expect(submit.body.data).toHaveProperty('_id');

    const submissionId = submit.body.data._id;

    const list = await request(app)
      .get(`/api/submissions/assignment/${assignment._id}`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(list.status).toBe(200);
    expect(list.body).toHaveProperty('success', true);
    expect(Array.isArray(list.body.data)).toBe(true);
    expect(list.body.data.length).toBe(1);

    const createFeedback = await request(app)
      .post(`/api/feedback/${submissionId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .field('textFeedback', 'Good job')
      .field('score', '8')
      .field('maxScore', '10');

    expect(createFeedback.status).toBe(200);
    expect(createFeedback.body).toHaveProperty('success', true);
    expect(createFeedback.body.data).toHaveProperty('_id');

    const feedbackId = createFeedback.body.data._id;

    const duplicate = await request(app)
      .post(`/api/feedback/${submissionId}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .field('textFeedback', 'Duplicate');

    expect(duplicate.status).toBe(409);

    const studentRead = await request(app)
      .get(`/api/feedback/submission/${submissionId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(studentRead.status).toBe(200);
    expect(studentRead.body).toHaveProperty('success', true);
    expect(studentRead.body.data).toHaveProperty('_id', feedbackId);

    const teacherRead = await request(app)
      .get(`/api/feedback/${feedbackId}`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(teacherRead.status).toBe(200);
    expect(teacherRead.body).toHaveProperty('success', true);
    expect(teacherRead.body.data).toHaveProperty('_id', feedbackId);
  });
});
