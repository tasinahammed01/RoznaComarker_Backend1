'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'teacher-comments-test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Feedback = require('../src/models/Feedback');
const { resolveTeacherComments } = require('../src/services/teacherComments.service');
const { buildPersistedSubmissionFeedbackReport } = require('../src/services/submissionFeedbackReport.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('canonical teacher comments', () => {
  let teacher; let otherTeacher; let student; let classDoc; let assignment; let submission;
  let teacherToken; let otherTeacherToken; let studentToken;

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    teacher = await User.create({ firebaseUid: 'tc-teacher', email: 'tc-teacher@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'tc-other', email: 'tc-other@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'tc-student', email: 'tc-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Comment class', teacher: teacher._id, joinCode: 'tc-code', qrCodeUrl: 'data:,' });
    assignment = await Assignment.create({ title: 'Comment assignment', writingType: 'essay',
      deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'tc-token' });
    submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed',
      correctionStatus: 'partial', semanticStatus: 'failed', evaluationStatus: 'failed' });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
    otherTeacherToken = signTestJwt({ id: otherTeacher._id, firebaseUid: otherTeacher.firebaseUid, role: 'teacher' });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
  });

  const patch = (token, body, id = null) => request(app)
    .patch(`/api/feedback/${id || submission._id}/teacher-comments`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  test('creates, trims, preserves line breaks, updates, and clears without requiring analysis', async () => {
    const created = await patch(teacherToken, { teacherComments: '  First line\nSecond line  ' });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ submissionId: String(submission._id),
      teacherComments: 'First line\nSecond line', teacherCommentsUpdatedBy: String(teacher._id) });
    expect(created.body.data.teacherCommentsUpdatedAt).toBeTruthy();
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);

    expect((await patch(teacherToken, { teacherComments: 'Updated' })).body.data.teacherComments).toBe('Updated');
    expect((await patch(teacherToken, { teacherComments: '' })).body.data.teacherComments).toBe('');
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);
  });

  test('rejects invalid payloads, identities, and authorization', async () => {
    for (const body of [{}, { teacherComments: null }, { teacherComments: 1 }, { teacherComments: [] },
      { teacherComments: {} }, { teacherComments: true }, { teacherComments: 'ok', extra: true },
      { teacherComments: 'x'.repeat(5001) }]) {
      expect((await patch(teacherToken, body)).status).toBe(400);
    }
    expect((await request(app).patch(`/api/feedback/${submission._id}/teacher-comments`).send({ teacherComments: 'x' })).status).toBe(401);
    expect((await patch(studentToken, { teacherComments: 'x' })).status).toBe(403);
    expect((await patch(otherTeacherToken, { teacherComments: 'x' })).status).toBe(403);
    expect((await patch(teacherToken, { teacherComments: 'x' }, 'invalid')).status).toBe(400);
    expect((await patch(teacherToken, { teacherComments: 'x' }, new mongoose.Types.ObjectId())).status).toBe(404);
  });

  test('targeted update preserves all rubric, AI, evaluation, and override fields', async () => {
    const original = await SubmissionFeedback.create({
      submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      rubricScores: { CONTENT: { score: 17, maxScore: 20, comment: 'c' }, ORGANIZATION: { score: 16, maxScore: 20, comment: 'o' },
        GRAMMAR: { score: 21, maxScore: 25, comment: 'g' }, VOCABULARY: { score: 15, maxScore: 20, comment: 'v' },
        MECHANICS: { score: 8, maxScore: 10, comment: 'm' }, PRESENTATION: { score: 4, maxScore: 5, comment: 'p' } },
      overallScore: 81, grade: 'B', correctionStats: { content: 1, grammar: 2, organization: 3, vocabulary: 4, mechanics: 5, total: 15 },
      detailedFeedback: { status: 'completed', strengths: ['s'], areasForImprovement: ['a'], actionSteps: ['n'] },
      aiFeedback: { perCategory: [{ category: 'CONTENT', message: 'ai', score: 4, maxScore: 5 }], overallComments: 'AI content' },
      assessmentVersion: 'assessment-x', evaluationVersion: 'evaluation-x', evaluationSourceHash: 'source-x',
      evaluationRubricSourceHash: 'rubric-x', evaluationStatus: 'failed', evaluationSource: 'provisional',
      evaluationJobId: 'job-x', overriddenByTeacher: false
    });
    const before = original.toObject();
    expect((await patch(teacherToken, { teacherComments: 'Only comment' })).status).toBe(200);
    const after = (await SubmissionFeedback.findById(original._id)).toObject();
    for (const field of ['rubricScores', 'overallScore', 'grade', 'correctionStats', 'detailedFeedback', 'aiFeedback',
      'assessmentVersion', 'evaluationVersion', 'evaluationSourceHash', 'evaluationRubricSourceHash',
      'evaluationStatus', 'evaluationSource', 'evaluationJobId', 'overriddenByTeacher']) {
      expect(after[field]).toEqual(before[field]);
    }
  });

  test('read precedence honors canonical empty and legacy fields without writes', async () => {
    await Feedback.create({ teacher: teacher._id, student: student._id, class: classDoc._id, assignment: assignment._id,
      submission: submission._id, teacherComments: 'Legacy teacher', textFeedback: 'Legacy text' });
    const canonical = await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id,
      studentId: student._id, teacherId: teacher._id, teacherComments: '' });
    const read = await request(app).get(`/api/feedback/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.data.teacherComments).toBe('');
    expect((await SubmissionFeedback.findById(canonical._id)).teacherComments).toBe('');

    expect(resolveTeacherComments({ submissionFeedback: {}, legacyFeedback: { teacherComments: 'Teacher', textFeedback: 'Text' } })).toBe('Teacher');
    expect(resolveTeacherComments({ submissionFeedback: {}, legacyFeedback: { textFeedback: 'Text' } })).toBe('Text');
    expect(resolveTeacherComments({ submissionFeedback: { aiFeedback: { overallComments: 'Old form' } } })).toBe('Old form');
  });

  test('PDF view model uses the identical resolver and performs no persistence', async () => {
    const sf = { teacherComments: 'Canonical PDF comment', evaluationSourceHash: 'old' };
    const legacy = { teacherComments: 'Legacy PDF comment' };
    const source = { _id: submission._id, files: ['f1'], ocrStatus: 'completed', correctionStatus: 'completed',
      correctionSourceHash: 'hash', writingCorrections: [], ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'Text.', words: [] }] };
    const spy = jest.spyOn(SubmissionFeedback, 'findOneAndUpdate');
    const report = await buildPersistedSubmissionFeedbackReport({ submission: source, submissionFeedback: sf, feedback: legacy });
    expect(report.viewModel.teacherComments).toBe('Canonical PDF comment');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('concurrent accepted saves retain one unique feedback document', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => patch(teacherToken, { teacherComments: `comment-${index}` })));
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 429].includes(response.status))).toBe(true);
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);
  });

  test('teacher rubric saving preserves comments and unrelated canonical data', async () => {
    await SubmissionFeedback.create({
      submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      teacherComments: 'Keep this comment', correctionStats: { grammar: 2, total: 2 },
      evaluationSourceHash: 'source-hash', detailedFeedbackSourceHash: 'source-hash',
      rubricScores: { CONTENT: { score: 14, maxScore: 20 }, ORGANIZATION: { score: 11, maxScore: 20 },
        GRAMMAR: { score: 5, maxScore: 25 }, VOCABULARY: { score: 9, maxScore: 20 },
        MECHANICS: { score: 5.5, maxScore: 10 }, PRESENTATION: { score: 4.5, maxScore: 5 } },
      overallScore: 49, grade: 'F', overriddenByTeacher: false
    });
    const rubricScores = { CONTENT: { score: 14, maxScore: 20, comment: 'c' },
      ORGANIZATION: { score: 11, maxScore: 20, comment: 'o' },
      GRAMMAR: { score: 5, maxScore: 25, comment: 'g' },
      VOCABULARY: { score: 9, maxScore: 20, comment: 'v' },
      MECHANICS: { score: 5.5, maxScore: 10, comment: 'm' },
      PRESENTATION: { score: 3.5, maxScore: 5, comment: 'Teacher reviewed handwriting.' } };
    const response = await request(app).put(`/api/feedback/${submission._id}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ rubricScores, overallScore: 51, detailedFeedback: {}, aiFeedback: { perCategory: [], overallComments: '' },
        rubricDesigner: null });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ overallScore: 51, grade: 'F', overriddenByTeacher: true });
    expect(response.body.data).not.toHaveProperty('scoreStatus');
    expect(response.body.data).not.toHaveProperty('presentationReviewStatus');
    const saved = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    expect(saved.rubricScores.PRESENTATION).toMatchObject({ score: 3.5, maxScore: 5,
      comment: 'Teacher reviewed handwriting.' });
    expect(saved).toMatchObject({ overallScore: 51, grade: 'F', teacherComments: 'Keep this comment',
      evaluationSourceHash: 'source-hash', detailedFeedbackSourceHash: 'source-hash' });
    expect(saved.correctionStats).toMatchObject({ grammar: 2, total: 2 });
  });
});
