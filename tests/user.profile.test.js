process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const request = require('supertest');
const mongoose = require('mongoose');

const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { evaluationPolicyHash } = require('../src/services/teacherEvaluationPolicy.service');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('User profile updates', () => {
  beforeAll(async () => {
    await connectInMemoryMongo();
    await seedTestPlans();
  });

  afterAll(async () => {
    await disconnectInMemoryMongo();
  });

  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
  });

  test('updates AI settings for a teacher without classes', async () => {
    const teacher = await User.create({
      firebaseUid: 'teacher-basic-ai-config',
      email: 'teacher-basic-ai-config@example.com',
      role: 'teacher'
    });
    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });

    const response = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aiConfig: {
          strictness: 'friendly',
          checks: { grammarSpelling: true, coherenceLogic: false, factChecking: true }
        }
      });

    expect(response.status).toBe(200);
    expect((await User.findById(teacher._id).lean()).aiConfig).toMatchObject({
      strictness: 'friendly',
      checks: { grammarSpelling: true, coherenceLogic: false, factChecking: true }
    });
  });

  test('updates AI settings on a legacy record with unrelated invalid data', async () => {
    const teacherId = new mongoose.Types.ObjectId();
    await User.collection.insertOne({
      _id: teacherId,
      firebaseUid: 'teacher-legacy-ai-config',
      role: 'teacher',
      usage: { submissions: -1 },
      aiConfig: { strictness: 'balanced' }
    });
    const token = signTestJwt({ id: teacherId, firebaseUid: 'teacher-legacy-ai-config', role: 'teacher' });

    const response = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aiConfig: {
          strictness: 'strict',
          checks: { grammarSpelling: true, coherenceLogic: true, factChecking: false }
        }
      });

    expect(response.status).toBe(200);
    expect((await User.findById(teacherId).lean()).aiConfig.strictness).toBe('strict');
  });

  test('rejects invalid AI settings', async () => {
    const teacher = await User.create({
      firebaseUid: 'teacher-invalid-ai-config',
      email: 'teacher-invalid-ai-config@example.com',
      role: 'teacher'
    });
    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });

    const response = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aiConfig: {
          strictness: 'extreme',
          checks: { grammarSpelling: 'yes' }
        }
      });

    expect(response.status).toBe(400);
  });

  test('updates teacher AI settings and preserves stale evaluation invalidation', async () => {
    const teacher = await User.create({
      firebaseUid: 'teacher-ai-config',
      email: 'teacher-ai-config@example.com',
      role: 'teacher',
      aiConfig: {
        strictness: 'balanced',
        checks: {
          grammarSpelling: true,
          coherenceLogic: true,
          factChecking: false
        }
      }
    });
    const student = await User.create({
      firebaseUid: 'student-ai-config',
      email: 'student-ai-config@example.com',
      role: 'student'
    });
    const classDoc = await Class.create({
      name: 'Profile Update Class',
      teacher: teacher._id,
      joinCode: `J${new mongoose.Types.ObjectId().toString().slice(-7)}`,
      qrCodeUrl: 'data:,'
    });
    const assignment = await Assignment.create({
      title: 'Essay',
      deadline: new Date(Date.now() + 86400000),
      class: classDoc._id,
      teacher: teacher._id,
      qrToken: `qr-${new mongoose.Types.ObjectId().toString().slice(-8)}`
    });
    const oldPolicyHash = evaluationPolicyHash(teacher.aiConfig);
    const submission = await Submission.create({
      student: student._id,
      assignment: assignment._id,
      class: classDoc._id,
      status: 'submitted',
      submittedAt: new Date(),
      evaluationStatus: 'completed',
      evaluationPolicyHash: oldPolicyHash
    });
    await SubmissionFeedback.create({
      submissionId: submission._id,
      classId: classDoc._id,
      studentId: student._id,
      teacherId: teacher._id,
      overallScore: 78,
      evaluationStatus: 'completed',
      evaluationPolicyHash: oldPolicyHash,
      evaluationSourceHash: oldPolicyHash,
      overriddenByTeacher: false
    });

    const token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    const response = await request(app)
      .patch('/api/users/me')
      .set('Authorization', `Bearer ${token}`)
      .send({
        aiConfig: {
          strictness: 'strict',
          checks: {
            grammarSpelling: false,
            coherenceLogic: true,
            factChecking: true
          }
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.aiConfig).toMatchObject({
      strictness: 'strict',
      checks: {
        grammarSpelling: false,
        coherenceLogic: true,
        factChecking: true
      }
    });

    const savedTeacher = await User.findById(teacher._id).lean();
    expect(savedTeacher.aiConfig).toMatchObject({
      strictness: 'strict',
      checks: {
        grammarSpelling: false,
        coherenceLogic: true,
        factChecking: true
      }
    });

    const updatedSubmission = await Submission.findById(submission._id).lean();
    const updatedFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    expect(updatedSubmission.evaluationStatus).toBe('stale');
    expect(updatedFeedback.evaluationStatus).toBe('pending');
  });
});
