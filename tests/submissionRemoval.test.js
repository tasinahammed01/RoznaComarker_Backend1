process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = 'test';
jest.setTimeout(30000);

jest.mock('../src/services/ocrPipeline.service', () => ({
  runOcrAndPersist: jest.fn().mockResolvedValue(undefined),
  runOcrAndPersistForFiles: jest.fn().mockResolvedValue(undefined)
}));
jest.mock('../src/services/autoRubricDesigner.service', () => ({
  autoGenerateRubricDesignerForSubmission: jest.fn().mockResolvedValue(undefined)
}));

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Feedback = require('../src/models/Feedback');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../src/models/AdaptivePracticeAttempt');
const Upload = require('../src/models/Upload');
const File = require('../src/models/File');
const Notification = require('../src/models/notification.model');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('teacher submission removal', () => {
  let teacher; let otherTeacher; let student; let classDoc; let assignment;
  let teacherToken; let otherTeacherToken; let studentToken;
  const diskPath = path.resolve(__dirname, '..', 'uploads', 'submissions', 'phase4-removal-test.pdf');

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await fs.promises.mkdir(path.dirname(diskPath), { recursive: true });
    await fs.promises.unlink(diskPath).catch(() => {});
    teacher = await User.create({ firebaseUid: 'remove-teacher', email: 'remove-teacher@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'remove-other', email: 'remove-other@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'remove-student', email: 'remove-student@example.com', role: 'student',
      usage: { submissions: 1, storageMB: 1 } });
    classDoc = await Class.create({ name: 'Removal Class', teacher: teacher._id, joinCode: 'REMOVE1' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    assignment = await Assignment.create({ title: 'Removal essay', writingType: 'essay', class: classDoc._id,
      teacher: teacher._id, deadline: new Date(Date.now() + 86400000), qrToken: 'remove-assignment',
      allowResubmission: false });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    otherTeacherToken = signTestJwt({ id: otherTeacher._id, firebaseUid: otherTeacher.firebaseUid, role: otherTeacher.role });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });
  });
  afterEach(() => fs.promises.unlink(diskPath).catch(() => {}));

  async function seedSubmission() {
    await fs.promises.writeFile(diskPath, Buffer.from('%PDF-1.4\nphase4'));
    const file = await File.create({ originalName: 'essay.pdf', filename: path.basename(diskPath),
      path: 'uploads/submissions/phase4-removal-test.pdf', url: '/uploads/submissions/phase4-removal-test.pdf',
      uploadedBy: student._id, role: 'student', type: 'submissions' });
    const submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      file: file._id, files: [file._id], fileUrls: [file.url], status: 'submitted', submittedAt: new Date(),
      isLate: false, transcriptText: 'Current transcript', evaluationStatus: 'completed' });
    const feedback = await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id,
      studentId: student._id, teacherId: teacher._id, overallScore: 82, evaluationStatus: 'completed' });
    await Feedback.create({ teacher: teacher._id, student: student._id, class: classDoc._id,
      assignment: assignment._id, submission: submission._id, score: 8, teacherComments: 'Current comment' });
    const session = await AdaptivePracticeSession.create({ submissionId: submission._id, studentId: student._id,
      assignmentId: assignment._id, status: 'failed', sourceFingerprint: 'phase4-source', sourceSnapshot: {
        transcriptFingerprint: 'transcript', feedbackId: feedback._id, feedbackUpdatedAt: feedback.updatedAt,
        skills: [{ id: 'GRAMMAR', category: 'Grammar', earnedPoints: 5, maximumPoints: 25,
          percentage: 20, status: 'priority' }]
      }, targetSkills: ['GRAMMAR'] });
    await AdaptivePracticeAttempt.create({ sessionId: session._id, submissionId: submission._id,
      studentId: student._id, activityId: 'activity-1', attemptNumber: 1, status: 'ready', response: 'answer',
      responseFingerprint: 'answer-hash', result: { score: 100, passed: true } });
    await Upload.create({ assignmentId: assignment._id, studentId: student._id, submissionId: submission._id,
      uploadedBy: student._id, originalFilename: 'legacy.pdf', originalFilePath: diskPath });
    await Notification.create({ recipient: teacher._id, actor: student._id, type: 'assignment_submitted',
      title: 'Submitted', description: 'Submitted', data: { submissionId: String(submission._id) } });
    return submission;
  }

  test('owning teacher removes the canonical submission and all current dependencies', async () => {
    const submission = await seedSubmission();
    const response = await request(app).delete(`/api/submissions/${submission._id}`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, message: 'Submission removed successfully.',
      data: { submissionId: String(submission._id), assignmentId: String(assignment._id), classId: String(classDoc._id) } });
    expect(await Submission.countDocuments({ _id: submission._id })).toBe(0);
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(0);
    expect(await Feedback.countDocuments({ submission: submission._id })).toBe(0);
    expect(await AdaptivePracticeSession.countDocuments({ submissionId: submission._id })).toBe(0);
    expect(await AdaptivePracticeAttempt.countDocuments({ submissionId: submission._id })).toBe(0);
    expect(await Upload.countDocuments({ submissionId: submission._id })).toBe(0);
    expect(await Notification.countDocuments({ 'data.submissionId': String(submission._id) })).toBe(0);
    expect(await File.countDocuments({ uploadedBy: student._id, type: 'submissions' })).toBe(0);
    expect(fs.existsSync(diskPath)).toBe(false);
  });

  test('rejects another teacher, a student, and a submission whose class does not match its assignment', async () => {
    const submission = await seedSubmission();
    const deniedTeacher = await request(app).delete(`/api/submissions/${submission._id}`)
      .set('Authorization', `Bearer ${otherTeacherToken}`);
    expect(deniedTeacher.status).toBe(403);
    const deniedStudent = await request(app).delete(`/api/submissions/${submission._id}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(deniedStudent.status).toBe(403);

    const wrongClass = await Class.create({ name: 'Wrong Class', teacher: teacher._id, joinCode: 'WRONG1' });
    await Submission.updateOne({ _id: submission._id }, { $set: { class: wrongClass._id } });
    const deniedClass = await request(app).delete(`/api/submissions/${submission._id}`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(deniedClass.status).toBe(403);
    expect(await Submission.exists({ _id: submission._id })).toBeTruthy();
  });

  test('resets teacher/student current state and permits a normal first submission afterward', async () => {
    const submission = await seedSubmission();
    expect((await request(app).get(`/api/submissions/assignment/${assignment._id}`)
      .set('Authorization', `Bearer ${teacherToken}`)).body.data).toHaveLength(1);
    const summaryBefore = await request(app).get(`/api/classes/${classDoc._id}/summary`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(summaryBefore.body.data.submissionsCount).toBe(1);

    await request(app).delete(`/api/submissions/${submission._id}`).set('Authorization', `Bearer ${teacherToken}`);
    const teacherList = await request(app).get(`/api/submissions/assignment/${assignment._id}`)
      .set('Authorization', `Bearer ${teacherToken}`);
    const studentCurrent = await request(app).get(`/api/submissions/assignment/${assignment._id}/my`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(teacherList.body.data).toEqual([]);
    expect(studentCurrent.body.data).toBeNull();
    const summaryAfter = await request(app).get(`/api/classes/${classDoc._id}/summary`)
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(summaryAfter.body.data.submissionsCount).toBe(0);
    expect((await request(app).get(`/api/feedback/${submission._id}`)
      .set('Authorization', `Bearer ${teacherToken}`)).status).toBe(404);
    expect((await request(app).get(`/api/adaptive-practice/submissions/${submission._id}`)
      .set('Authorization', `Bearer ${studentToken}`)).status).toBe(404);

    const replacement = await request(app).post(`/api/submissions/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\nreplacement'), { filename: 'replacement.pdf', contentType: 'application/pdf' });
    expect(replacement.status).toBe(200);
    expect(replacement.body.data._id).not.toBe(String(submission._id));
    expect(await Submission.countDocuments({ student: student._id, assignment: assignment._id })).toBe(1);
  });

  test('returns a stable 404 for a missing submission', async () => {
    const response = await request(app).delete('/api/submissions/64b000000000000000000001')
      .set('Authorization', `Bearer ${teacherToken}`);
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, code: 'SUBMISSION_NOT_FOUND' });
  });
});
