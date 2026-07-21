process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');

const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');

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
      writingType: 'essay',
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
      writingType: 'essay',
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
      .get(`/api/feedback/by-id/${feedbackId}`)
      .set('Authorization', `Bearer ${teacherToken}`);

    expect(teacherRead.status).toBe(200);
    expect(teacherRead.body).toHaveProperty('success', true);
    expect(teacherRead.body.data).toHaveProperty('_id', feedbackId);
  });

  test('GET /api/feedback/:submissionId normalizes legacy feedback with old maxScore values', async () => {
    const teacher = await User.create({ firebaseUid: 't3', email: 't3@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 's3', email: 's3@example.com', role: 'student' });

    const classDoc = await Class.create({
      name: 'Class 3',
      teacher: teacher._id,
      joinCode: 'join-code-3',
      qrCodeUrl: 'data:,'
    });

    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });

    const assignment = await Assignment.create({
      title: 'A3',
      writingType: 'essay',
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: 'qr-token-3'
    });

    const teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    const submit = await request(app)
      .post(`/api/submissions/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'test.pdf', contentType: 'application/pdf' });

    const submissionId = submit.body.data._id;

    // Create legacy feedback with old maxScore values (all 5)
    const legacyFeedback = await SubmissionFeedback.create({
      submissionId: submissionId,
      classId: classDoc._id,
      studentId: student._id,
      teacherId: teacher._id,
      rubricScores: {
        CONTENT: { score: 0, maxScore: 5, comment: '' },
        ORGANIZATION: { score: 0, maxScore: 5, comment: '' },
        GRAMMAR: { score: 0, maxScore: 5, comment: '' },
        VOCABULARY: { score: 0, maxScore: 5, comment: '' },
        MECHANICS: { score: 0, maxScore: 5, comment: '' },
        PRESENTATION: { score: 0, maxScore: 5, comment: '' }
      },
      assessmentVersion: 'writing-rubric-100-v1',
      maxOverallScore: 100,
      overallScore: 77,
      grade: 'F',
      correctionStats: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0 },
      detailedFeedback: { strengths: [], areasForImprovement: [], actionSteps: [] },
      aiFeedback: { perCategory: [], overallComments: '' },
      overriddenByTeacher: false
    });

    await Submission.updateOne({ _id: submissionId }, { $set: { ocrStatus: 'completed', correctionStatus: 'processing' } });

    // Pending canonical evaluation must suppress the legacy record.
    const res = await request(app)
      .get(`/api/feedback/${submissionId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    
    const feedback = res.body.data;
    expect(feedback.score).toBeNull();
    expect(feedback.rubricScores).toBeNull();
    expect(feedback.evaluationStatus).toBe('pending');
    expect(feedback.detailedFeedbackStatus).toBe('pending');
    expect(JSON.stringify(feedback)).not.toContain('77');
  });

  test('GET /api/feedback/:submissionId handles missing PRESENTATION category', async () => {
    const teacher = await User.create({ firebaseUid: 't4', email: 't4@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 's4', email: 's4@example.com', role: 'student' });

    const classDoc = await Class.create({
      name: 'Class 4',
      teacher: teacher._id,
      joinCode: 'join-code-4',
      qrCodeUrl: 'data:,'
    });

    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });

    const assignment = await Assignment.create({
      title: 'A4',
      writingType: 'essay',
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: 'qr-token-4'
    });

    const teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    const submit = await request(app)
      .post(`/api/submissions/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'test.pdf', contentType: 'application/pdf' });

    const submissionId = submit.body.data._id;

    // Create feedback missing PRESENTATION category
    const feedbackWithoutPresentation = await SubmissionFeedback.create({
      submissionId: submissionId,
      classId: classDoc._id,
      studentId: student._id,
      teacherId: teacher._id,
      rubricScores: {
        CONTENT: { score: 0, maxScore: 5, comment: '' },
        ORGANIZATION: { score: 0, maxScore: 5, comment: '' },
        GRAMMAR: { score: 0, maxScore: 5, comment: '' },
        VOCABULARY: { score: 0, maxScore: 5, comment: '' },
        MECHANICS: { score: 0, maxScore: 5, comment: '' }
      },
      assessmentVersion: 'writing-rubric-100-v1',
      maxOverallScore: 100,
      overallScore: 0,
      grade: 'F',
      correctionStats: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0 },
      detailedFeedback: { strengths: [], areasForImprovement: [], actionSteps: [] },
      aiFeedback: { perCategory: [], overallComments: '' },
      overriddenByTeacher: false
    });

    await Submission.updateOne({ _id: submissionId }, { $set: { ocrStatus: 'completed', correctionStatus: 'processing' } });

    // GET feedback must not synthesize a default rubric while evaluation is pending.
    const res = await request(app)
      .get(`/api/feedback/${submissionId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    
    const feedback = res.body.data;
    expect(feedback.score).toBeNull();
    expect(feedback.rubricScores).toBeNull();
    expect(feedback.evaluationStatus).toBe('pending');
    expect(feedback.detailedFeedbackStatus).toBe('pending');
    expect(JSON.stringify(feedback)).not.toContain('77');
  });

  test('GET /api/feedback/:submissionId returns canonical SubmissionFeedback with correct structure', async () => {
    const teacher = await User.create({ firebaseUid: 't5', email: 't5@example.com', role: 'teacher' });
    const student = await User.create({ firebaseUid: 's5', email: 's5@example.com', role: 'student' });

    const classDoc = await Class.create({
      name: 'Class 5',
      teacher: teacher._id,
      joinCode: 'join-code-5',
      qrCodeUrl: 'data:,'
    });

    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });

    const assignment = await Assignment.create({
      title: 'A5',
      writingType: 'essay',
      deadline: new Date(Date.now() + 24 * 60 * 60 * 1000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: 'qr-token-5'
    });

    const teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });

    const submit = await request(app)
      .post(`/api/submissions/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\n%test\n'), { filename: 'test.pdf', contentType: 'application/pdf' });

    const submissionId = submit.body.data._id;

    await Submission.updateOne({ _id: submissionId }, { $set: { ocrStatus: 'completed', correctionStatus: 'processing' } });

    // GET feedback should return the canonical pending structure.
    const res = await request(app)
      .get(`/api/feedback/${submissionId}`)
      .set('Authorization', `Bearer ${studentToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    
    const feedback = res.body.data;
    expect(feedback.score).toBeNull();
    expect(feedback.rubricScores).toBeNull();
    expect(feedback.evaluationStatus).toBe('pending');
    expect(feedback.detailedFeedbackStatus).toBe('pending');
    expect(JSON.stringify(feedback)).not.toContain('77');
  });
});
