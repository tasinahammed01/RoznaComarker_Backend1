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
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const Feedback = require('../src/models/Feedback');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../src/models/AdaptivePracticeAttempt');
const { showMarksToStudent, redactStudentMarks } = require('../src/services/assignmentAccessPolicy.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../src/services/rubricLanguageScoring.service');
const { loadOwnedSource } = require('../src/services/adaptivePractice.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { seedTestPlans } = require('./helpers/seedTestPlans');

describe('Phase 2 assignment controls', () => {
  let teacher;
  let student;
  let classDoc;
  let teacherToken;
  let studentToken;

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    await seedTestPlans();
    teacher = await User.create({ firebaseUid: 'phase2-teacher', email: 'phase2-teacher@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'phase2-student', email: 'phase2-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Phase 2 Class', teacher: teacher._id, joinCode: 'PHASE2', qrCodeUrl: 'data:,' });
    await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });
  });

  async function createAssignment(overrides = {}) {
    return Assignment.create({
      title: 'Writing assignment', writingType: 'essay', deadline: new Date(Date.now() + 86400000),
      class: classDoc._id, teacher: teacher._id, qrToken: `phase2-${Math.random()}`,
      ...overrides
    });
  }

  async function upload(assignmentId, name = 'draft.pdf') {
    return request(app).post(`/api/submissions/${assignmentId}`).set('Authorization', `Bearer ${studentToken}`)
      .attach('file', Buffer.from('%PDF-1.4\n%phase2\n'), { filename: name, contentType: 'application/pdf' });
  }

  async function makeEvaluatedSubmission(assignment, { weak = true } = {}) {
    const sourceHash = `current-${Math.random()}`;
    const fileId = new (require('mongoose').Types.ObjectId)();
    const submission = await Submission.create({
      student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
      semanticStatus: 'completed', evaluationStatus: 'completed', correctionSourceHash: sourceHash,
      ocrJobId: `job-${Math.random()}`, correctionTranscriptLayoutVersion: 'ocr-layout-v5-native-text',
      evaluationVersion: EVALUATION_VERSION, files: [fileId],
      ocrPages: [{ fileId, fileOrder: 0, pageNumber: 1, text: 'A current evaluated student draft.' }],
      writingCorrections: []
    });
    const score = weak ? 10 : 16;
    const feedback = await SubmissionFeedback.create({
      submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      evaluationSourceHash: sourceHash, evaluationStatus: 'completed', assessmentVersion: ASSESSMENT_VERSION,
      evaluationVersion: EVALUATION_VERSION,
      rubricScores: {
        CONTENT: { score, maxScore: 20, comment: 'Content feedback.' },
        ORGANIZATION: { score: 16, maxScore: 20, comment: 'Organization feedback.' },
        VOCABULARY: { score: 16, maxScore: 20, comment: 'Vocabulary feedback.' },
        GRAMMAR: { score: 20, maxScore: 25, comment: 'Grammar feedback.' },
        MECHANICS: { score: 8, maxScore: 10, comment: 'Mechanics feedback.' }
      }
    });
    return { submission, feedback };
  }

  async function completeCurrentAdaptivePractice(submission, feedback, sourceFingerprintOverride) {
    const source = await loadOwnedSource(submission._id, student._id);
    const activity = {
      activityId: 'content-1', questionType: 'open_response', skillId: 'CONTENT', category: 'Content',
      title: 'Strengthen evidence', description: 'Practice adding evidence.', evidence: 'A current draft excerpt.',
      task: 'Revise the paragraph with stronger evidence.', tip: 'Use a specific example.', checklist: ['Specific evidence'],
      modelAnswer: 'A revised paragraph with specific evidence.', difficulty: 'developing'
    };
    const session = await AdaptivePracticeSession.create({
      submissionId: submission._id, studentId: student._id, assignmentId: submission.assignment, status: 'ready',
      sourceFingerprint: sourceFingerprintOverride || source.sourceFingerprint,
      sourceSnapshot: { transcriptFingerprint: source.transcriptFingerprint, feedbackId: feedback._id,
        feedbackUpdatedAt: feedback.updatedAt, skills: source.assessedSkills },
      targetSkills: ['CONTENT'], activities: [activity]
    });
    await AdaptivePracticeAttempt.create({
      sessionId: session._id, submissionId: submission._id, studentId: student._id, activityId: activity.activityId,
      attemptNumber: 1, status: 'ready', response: 'A sufficiently meaningful revised response.',
      responseFingerprint: `response-${Math.random()}`, result: { score: 100, passed: true, summary: 'Passed.' }
    });
    return { session, source };
  }

  test('uses backward-compatible defaults and preserves the canonical unique index', async () => {
    const assignment = await createAssignment();
    expect(assignment.showMarksToStudent).toBe(true);
    expect(assignment.allowResubmission).toBe(false);
    expect(assignment.requireAdaptiveBeforeResubmission).toBe(false);
    expect(showMarksToStudent({})).toBe(true);
    const uniqueIndex = Submission.schema.indexes().find(([keys, options]) =>
      keys.student === 1 && keys.assignment === 1 && options.unique === true);
    expect(uniqueIndex).toBeTruthy();
  });

  test('only the owning teacher can update mark and resubmission settings', async () => {
    const assignment = await createAssignment();
    const denied = await request(app).patch(`/api/assignments/${assignment._id}`)
      .set('Authorization', `Bearer ${studentToken}`).send({ showMarksToStudent: false, allowResubmission: true });
    expect(denied.status).toBe(403);

    const updated = await request(app).patch(`/api/assignments/${assignment._id}`)
      .set('Authorization', `Bearer ${teacherToken}`).send({ showMarksToStudent: false, allowResubmission: true, requireAdaptiveBeforeResubmission: true });
    expect(updated.status).toBe(200);
    expect(updated.body.data).toMatchObject({ showMarksToStudent: false, allowResubmission: true, requireAdaptiveBeforeResubmission: true });

    const normalized = await request(app).patch(`/api/assignments/${assignment._id}`)
      .set('Authorization', `Bearer ${teacherToken}`).send({ allowResubmission: false, requireAdaptiveBeforeResubmission: true });
    expect(normalized.body.data).toMatchObject({ allowResubmission: false, requireAdaptiveBeforeResubmission: false });
  });

  test('allows a first submission but rejects a forged replacement when disabled', async () => {
    const assignment = await createAssignment({ allowResubmission: false });
    expect((await upload(assignment._id, 'first.pdf')).status).toBe(200);
    const denied = await upload(assignment._id, 'forged-second.pdf');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ success: false, code: 'RESUBMISSION_NOT_ALLOWED' });
    expect(await Submission.countDocuments({ student: student._id, assignment: assignment._id })).toBe(1);
  });

  test('replaces the canonical submission and restarts processing when enabled', async () => {
    const assignment = await createAssignment({ allowResubmission: true });
    const first = await upload(assignment._id, 'first.pdf');
    const second = await upload(assignment._id, 'second.pdf');
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.data._id).toBe(first.body.data._id);
    const saved = await Submission.findById(first.body.data._id).lean();
    const revision = await SubmissionRevision.findOne({ sourceSubmissionId: saved._id, draftNumber: 1 }).lean();
    expect(saved.ocrStatus).toBe('pending');
    expect(saved.evaluationStatus).toBe('pending');
    expect(saved.files).toHaveLength(1);
    expect(revision.files).toHaveLength(1);
    expect(String(saved.files[0])).not.toBe(String(revision.files[0]));
    expect(saved.ocrPages).toEqual([]);
    expect(await Submission.countDocuments({ student: student._id, assignment: assignment._id })).toBe(1);
  });

  test('requires completed adaptive practice only for replacement submissions', async () => {
    const assignment = await createAssignment({ allowResubmission: true, requireAdaptiveBeforeResubmission: true });
    expect((await upload(assignment._id, 'first.pdf')).status).toBe(200);
    const denied = await upload(assignment._id, 'second.pdf');
    expect(denied.status).toBe(403);
    expect(denied.body).toMatchObject({ success: false, code: 'ADAPTIVE_PRACTICE_REQUIRED' });
  });

  test('allows replacement after current adaptive practice is complete even when marks are hidden', async () => {
    const assignment = await createAssignment({ allowResubmission: true, requireAdaptiveBeforeResubmission: true, showMarksToStudent: false });
    const { submission, feedback } = await makeEvaluatedSubmission(assignment);
    await completeCurrentAdaptivePractice(submission, feedback);
    expect((await upload(assignment._id, 'next.pdf')).status).toBe(200);
    const revised = await Submission.findById(submission._id).lean();
    const snapshot = await SubmissionRevision.findOne({ sourceSubmissionId: submission._id, draftNumber: 1 }).lean();
    expect(revised).toMatchObject({ draftNumber: 2, evaluationStatus: 'pending' });
    expect(String(revised.previousRevision)).toBe(String(snapshot._id));
    expect(snapshot.feedbackSnapshot.overallScore).toBe(feedback.overallScore);
    expect(snapshot.ocrPages[0].text).toBe('A current evaluated student draft.');
  });

  test('does not let a completed stale adaptive session authorize a newer draft', async () => {
    const assignment = await createAssignment({ allowResubmission: true, requireAdaptiveBeforeResubmission: true });
    const { submission, feedback } = await makeEvaluatedSubmission(assignment);
    await completeCurrentAdaptivePractice(submission, feedback, `stale-${Math.random()}`);
    const denied = await upload(assignment._id, 'next.pdf');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('ADAPTIVE_PRACTICE_REQUIRED');
  });

  test('treats a current evaluation with no weak skills as satisfying the adaptive requirement', async () => {
    const assignment = await createAssignment({ allowResubmission: true, requireAdaptiveBeforeResubmission: true });
    await makeEvaluatedSubmission(assignment, { weak: false });
    expect((await upload(assignment._id, 'next.pdf')).status).toBe(200);
  });

  test('redacts student marks across canonical, legacy, and PDF APIs while teachers retain them', async () => {
    const assignment = await createAssignment({ showMarksToStudent: false });
    const submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
      semanticStatus: 'completed', evaluationStatus: 'completed', correctionSourceHash: 'current',
      correctionTranscriptLayoutVersion: 'ocr-layout-v5-native-text', evaluationVersion: EVALUATION_VERSION,
      writingCorrections: [] });
    await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
      teacherId: teacher._id, evaluationSourceHash: 'current', evaluationStatus: 'completed', overallScore: 84, grade: 'B',
      assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
      rubricScores: { CONTENT: { score: 17, maxScore: 20, comment: 'Clear ideas.' } }, teacherComments: 'Keep revising.' });
    await Feedback.create({ teacher: teacher._id, student: student._id, class: classDoc._id, assignment: assignment._id,
      submission: submission._id, score: 8, maxScore: 10, textFeedback: 'Good structure.' });

    const studentCanonical = await request(app).get(`/api/feedback/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(studentCanonical.status).toBe(200);
    expect(studentCanonical.body.data.marksVisible).toBe(false);
    expect(studentCanonical.body.data.overallScore).toBeUndefined();
    expect(studentCanonical.body.data.grade).toBeUndefined();
    expect(studentCanonical.body.data.rubricScores.CONTENT.score).toBeUndefined();
    expect(studentCanonical.body.data.rubricScores.CONTENT.comment).toBe('Clear ideas.');
    expect(studentCanonical.body.data.teacherComments).toBe('Keep revising.');

    const legacy = await request(app).get(`/api/feedback/submission/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(legacy.status).toBe(200);
    expect(legacy.body.data.score).toBeUndefined();
    expect(legacy.body.data.evaluation?.overallScore).toBeUndefined();
    expect(legacy.body.data.textFeedback).toBe('Good structure.');

    const teacherCanonical = await request(app).get(`/api/feedback/${submission._id}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacherCanonical.body.data.overallScore).toBe(84);
    expect(teacherCanonical.body.data.rubricScores.CONTENT.score).toBe(17);

    const pdf = await request(app).get(`/api/pdf/download/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(pdf.status).toBe(403);

    assignment.showMarksToStudent = true;
    await assignment.save();
    const released = await request(app).get(`/api/feedback/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(released.body.data.overallScore).toBe(84);
    expect(redactStudentMarks({ score: 4, message: 'Useful feedback' })).toEqual({ message: 'Useful feedback', marksVisible: false, previousEvaluation: null });
  });
});
