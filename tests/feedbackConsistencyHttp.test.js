process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'feedback-consistency-test-secret';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
jest.mock('../src/modules/submissionFeedbackPdfGenerator', () => ({
  generateSubmissionFeedbackPdf: jest.fn(async (vm, outputPath) => {
    await require('fs').promises.writeFile(outputPath, '%PDF-1.4\n% HTTP authorization fixture');
    return outputPath;
  })
}));
const request = require('supertest');
const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const File = require('../src/models/File');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Membership = require('../src/models/membership.model');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const { feedbackConsistencyFixture } = require('./helpers/feedbackConsistencyFixture');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { generateSubmissionFeedbackPdf } = require('../src/modules/submissionFeedbackPdfGenerator');

describe('new persisted submission: authorized feedback reports and hidden scores', () => {
  let studentToken, teacherToken, otherToken, otherTeacherToken, submission, assignment, input, imagePath;
  beforeAll(async () => {
    await connectInMemoryMongo();
    const users = await User.create(['teacher', 'student', 'student', 'teacher'].map((role, i) => ({
      role, firebaseUid: `feedback-consistency-${i}`, email: `qa-${i}@example.test`, displayName: `QA ${role} ${i}` })));
    const tokens = users.map((u) => signTestJwt({ id: u._id, firebaseUid: u.firebaseUid, role: u.role }));
    [teacherToken, studentToken, otherToken, otherTeacherToken] = tokens;
    const classroom = await Class.create({ name: 'Feedback QA', teacher: users[0]._id, joinCode: 'CONSISTENCY', qrCodeUrl: 'data:,' });
    await Membership.create({ student: users[1]._id, class: classroom._id, status: 'active' });
    assignment = await Assignment.create({ title: 'New feedback consistency QA', writingType: 'essay',
      deadline: new Date(Date.now() + 86400000), class: classroom._id, teacher: users[0]._id,
      qrToken: 'feedback-consistency-qa', showMarksToStudent: false });
    const filename = `feedback-consistency-${assignment._id}.png`;
    imagePath = path.resolve(__dirname, '../uploads', filename);
    await fs.promises.mkdir(path.dirname(imagePath), { recursive: true });
    const file = await File.create({ originalName: filename, filename, path: imagePath, url: `/uploads/${filename}`,
      uploadedBy: users[1]._id, role: 'student', type: 'submissions' });
    input = feedbackConsistencyFixture(String(file._id));
    const canvas = createCanvas(900, 1200), ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fffdf7'; ctx.fillRect(0, 0, 900, 1200); ctx.fillStyle = '#253346'; ctx.font = '24px Arial';
    for (const w of input.submission.ocrPages[0].words) ctx.fillText(w.text, w.bbox.x * 9, (w.bbox.y + w.bbox.h) * 12, w.bbox.w * 9);
    await fs.promises.writeFile(imagePath, canvas.toBuffer('image/png'));
    const { _id, canonicalText, transcriptPages, ...data } = input.submission;
    submission = await Submission.create({ ...data, student: users[1]._id, assignment: assignment._id, class: classroom._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, semanticStatus: 'completed', evaluationStatus: 'completed',
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION });
    await SubmissionFeedback.create({ ...input.evaluation, ...input.feedback, submissionId: submission._id,
      studentId: users[1]._id, teacherId: users[0]._id, classId: classroom._id, evaluationStatus: 'completed' });
  }, 90000);
  afterAll(async () => { if (imagePath) await fs.promises.unlink(imagePath).catch(() => {}); await disconnectInMemoryMongo(); });

  test('owner receives redacted PDF, teacher receives marks, and web/PDF targets match for every new correction', async () => {
    const before = await Submission.findById(submission._id).lean();
    const web = await request(app).get(`/api/submissions/${submission._id}/ocr-corrections`).set('Authorization', `Bearer ${studentToken}`);
    expect(web.status).toBe(200); expect(web.body.data.corrections).toHaveLength(4);
    const student = await request(app).get(`/api/pdf/download/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(student.status).toBe(200); expect(student.headers['cache-control']).toContain('no-store');
    const studentVm = generateSubmissionFeedbackPdf.mock.calls.at(-1)[0];
    expect(studentVm.marksVisible).toBe(false); expect(studentVm.result.overallScore).toBeUndefined();
    expect(studentVm.teacherComments).toBe('Keep developing your ideas.');
    expect(studentVm.aiEvaluationFeedback.some((f) => f.feedback === 'Review sentence agreement.')).toBe(true);
    const teacher = await request(app).get(`/api/pdf/download/${submission._id}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(teacher.status).toBe(200);
    const teacherVm = generateSubmissionFeedbackPdf.mock.calls.at(-1)[0];
    expect(teacherVm.result.overallScore).toBe(83.7);
    const matrix = web.body.data.corrections.map((c) => {
      const pdf = studentVm.submittedPages.flatMap((p) => p.corrections).find((p) => p.id === c.id);
      expect(pdf.renderTarget).toEqual(c.renderTarget);
      return { correctionId: c.id, code: c.symbol, website: c.renderTarget, pdf: pdf.renderTarget, match: 'YES' };
    });
    expect((await Submission.findById(submission._id).lean()).writingCorrections).toEqual(before.writingCorrections);
    if (process.env.FEEDBACK_CONSISTENCY_QA_DIR) {
      const dir = path.resolve(process.env.FEEDBACK_CONSISTENCY_QA_DIR); await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.writeFile(path.join(dir, 'new-submission-matrix.json'), JSON.stringify({
        provenance: 'Fresh isolated Mongo submission; current canonical correction pipeline; deterministic provider input; no live AI/OCR calls', matrix }, null, 2));
      await fs.promises.writeFile(path.join(dir, 'report-view-models.json'), JSON.stringify({ student: studentVm, teacher: teacherVm }));
      await fs.promises.writeFile(path.join(dir, 'website-response.json'), JSON.stringify(web.body.data));
    }
  }, 90000);
  test('other students, unrelated teachers, and unauthenticated requests remain denied', async () => {
    for (const token of [otherToken, otherTeacherToken]) {
      const response = await request(app).get(`/api/pdf/download/${submission._id}`).set('Authorization', `Bearer ${token}`);
      expect(response.status).toBe(403);
    }
    expect((await request(app).get(`/api/pdf/download/${submission._id}`)).status).toBe(401);
  });
  test('not-ready reports return a controlled conflict', async () => {
    await Submission.updateOne({ _id: submission._id }, { $set: { correctionStatus: 'processing', writingCorrections: [] } });
    const response = await request(app).get(`/api/pdf/download/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(response.status).toBe(409);
  });
});
