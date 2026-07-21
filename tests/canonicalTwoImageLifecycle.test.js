process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
process.env.LANGUAGETOOL_URL = 'https://languagetool.test';

let mockSemanticMode = 'success';
let mockOcrGate = Promise.resolve();
let mockOcrCall = 0;

const pageResult = (text) => ({
  fullText: text,
  transcriptText: text,
  pages: [{ pageNumber: 1, words: text.split(/\s+/).map((word, index) => ({
    text: word, paragraphIndex: 0, bbox: { x: 8 + index * 10, y: 15, w: Math.min(9, word.length + 2), h: 4 }
  })) }]
});

jest.mock('../src/services/visionOcr.service', () => ({
  extractOcrFromImageFile: jest.fn(async () => {
    await mockOcrGate;
    const text = mockOcrCall++ % 2 === 0
      ? 'This is the first test paragraph.'
      : 'This are the second test paragraph with erors.';
    return pageResult(text);
  })
}));

jest.mock('../src/services/semanticWritingCorrections.service', () => {
  const actual = jest.requireActual('../src/services/semanticWritingCorrections.service');
  return {
    ...actual,
    analyze: jest.fn(async () => {
      if (mockSemanticMode === 'failure') {
        const error = new Error('Synthetic provider configuration failure');
        error.code = 'AI_PROVIDER_NOT_CONFIGURED';
        throw error;
      }
      return {
        provider: 'synthetic', model: 'canonical-test-model',
        metrics: { attemptCount: 1, timeoutCount: 0, promptInputTokenEstimate: 30, outputTokenCount: 50 },
        corrections: [
          { category: 'CONTENT', symbol: 'DEV', quotedText: 'first test paragraph', occurrence: 1, message: 'Develop this evidence.', suggestedText: 'Develop the first test paragraph with evidence.', confidence: 0.95 },
          { category: 'ORGANIZATION', symbol: 'COH', quotedText: 'second test paragraph', occurrence: 1, message: 'Improve the transition.', suggestedText: 'Connect the second paragraph clearly.', confidence: 0.95 },
          { category: 'VOCABULARY', symbol: 'WF', quotedText: 'erors', occurrence: 1, message: 'Use the correct word form.', suggestedText: 'errors', confidence: 0.95 }
        ]
      };
    })
  };
});

jest.mock('../src/modules/submissionFeedbackPdfGenerator', () => {
  const fs = require('fs');
  let captured = null;
  return {
    generateSubmissionFeedbackPdf: jest.fn(async (viewModel, outputPath) => {
      captured = JSON.parse(JSON.stringify(viewModel));
      await fs.promises.writeFile(outputPath, Buffer.from('%PDF-1.4\n%synthetic canonical report\n'));
      return outputPath;
    }),
    getCapturedViewModel: () => captured
  };
});

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const Plan = require('../src/models/Plan');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const File = require('../src/models/File');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');
const pdfMock = require('../src/modules/submissionFeedbackPdfGenerator');

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const waitFor = async (id, predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const doc = await Submission.findById(id).lean();
    if (doc && predicate(doc)) return doc;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for submission ${id}`);
};
const canonicalFields = (data) => ({
  submissionId: data.submissionId,
  correctionSourceHash: data.correctionSourceHash,
  score: data.score,
  rubricScores: data.rubricScores,
  correctionStatistics: data.correctionStatistics,
  semanticStatus: data.semanticStatus,
  evaluationStatus: data.evaluationStatus,
  detailedFeedbackStatus: data.detailedFeedbackStatus
});

describe('isolated canonical two-image HTTP lifecycle', () => {
  let teacher; let student; let failureStudent; let classDoc; let teacherToken; let studentToken; let failureToken;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    await connectInMemoryMongo();
    await Plan.seedDefaults();
    global.fetch = jest.fn(async (_url, options) => {
      const transcript = String(options?.body?.get?.('text') || '');
      const areOffset = transcript.indexOf('are');
      const errorsOffset = transcript.indexOf('erors');
      return { ok: true, json: async () => ({ matches: [
        { offset: areOffset, length: 3, message: 'Agreement error', replacements: [{ value: 'is' }], rule: { id: 'SUBJECT_VERB_AGREEMENT', issueType: 'grammar', category: { id: 'GRAMMAR' } } },
        { offset: errorsOffset, length: 5, message: 'Spelling error', replacements: [{ value: 'errors' }], rule: { id: 'MORFOLOGIK_RULE_EN_US', issueType: 'misspelling', category: { id: 'TYPOS' } } }
      ] }), text: async () => '' };
    });
    teacher = await User.create({ firebaseUid: 'lifecycle-teacher', email: 'teacher.lifecycle@example.test', role: 'teacher' });
    student = await User.create({ firebaseUid: 'lifecycle-student', email: 'student.lifecycle@example.test', role: 'student' });
    failureStudent = await User.create({ firebaseUid: 'lifecycle-failure-student', email: 'failure.lifecycle@example.test', role: 'student' });
    classDoc = await Class.create({ name: 'Synthetic lifecycle class', teacher: teacher._id, joinCode: 'LIFECYCLE', qrCodeUrl: 'data:,' });
    await Membership.create([{ student: student._id, class: classDoc._id, status: 'active' }, { student: failureStudent._id, class: classDoc._id, status: 'active' }]);
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: teacher.role });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: student.role });
    failureToken = signTestJwt({ id: failureStudent._id, firebaseUid: failureStudent.firebaseUid, role: failureStudent.role });
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    const files = await File.find({}).lean();
    await Promise.all(files.map((item) => fs.promises.unlink(path.resolve(__dirname, '..', item.path)).catch(() => {})));
    await disconnectInMemoryMongo();
  });

  async function assignment(title, suffix) {
    return Assignment.create({ title, description: 'Write two connected paragraphs.', writingType: 'essay', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: `lifecycle-${suffix}` });
  }

  async function uploadTwoImages(assignmentId, token) {
    return request(app).post(`/api/submissions/${assignmentId}`).set('Authorization', `Bearer ${token}`)
      .attach('files', png, { filename: 'page-1.png', contentType: 'image/png' })
      .attach('files', png, { filename: 'page-2.png', contentType: 'image/png' });
  }

  async function getResult(id, token) {
    const response = await request(app).get(`/api/feedback/${id}`).set('Authorization', `Bearer ${token}`);
    expect(response.status).toBe(200);
    return response.body.data;
  }

  async function getPdf(id, token) {
    const response = await request(app).get(`/api/pdf/download/${id}`).set('Authorization', `Bearer ${token}`).buffer(true);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/application\/pdf/);
    return pdfMock.getCapturedViewModel();
  }

  test('success, semantic failure, and manual retry remain canonical across student, teacher, and PDF', async () => {
    const firstAssignment = await assignment('Lifecycle success', 'success');
    mockSemanticMode = 'success'; mockOcrCall = 0;
    let releaseOcr; mockOcrGate = new Promise((resolve) => { releaseOcr = resolve; });
    const uploaded = await uploadTwoImages(firstAssignment._id, studentToken);
    expect(uploaded.status).toBe(200);
    const successId = String(uploaded.body.data._id);
    const pending = await getResult(successId, studentToken);
    expect(pending).toMatchObject({ submissionId: successId, score: null, rubricScores: null, evaluationStatus: 'pending', detailedFeedbackStatus: 'pending' });
    expect(pending.detailedFeedback).toBeNull();
    expect(JSON.stringify(pending)).not.toContain('77');
    releaseOcr();
    const completedDoc = await waitFor(successId, (doc) => doc.correctionStatus === 'completed' && doc.evaluationStatus === 'completed');
    expect(completedDoc.ocrPages).toHaveLength(2);
    const successStudent = await getResult(successId, studentToken);
    const successTeacher = await getResult(successId, teacherToken);
    expect(canonicalFields(successStudent)).toEqual(canonicalFields(successTeacher));
    expect(successStudent.score).not.toBeNull();
    expect(successStudent.correctionStatistics).toMatchObject({ grammar: 1, mechanics: 1, content: 1, organization: 1, vocabulary: 1 });
    expect(canonicalFields(await getResult(successId, studentToken))).toEqual(canonicalFields(successStudent));
    expect(canonicalFields(await getResult(successId, teacherToken))).toEqual(canonicalFields(successTeacher));
    const successPdf = await getPdf(successId, studentToken);
    expect(successPdf.submission.submissionId).toBe(successId);
    expect(successPdf.result.overallScore).toBe(successStudent.score);
    expect(successPdf.statistics).toMatchObject(successStudent.correctionStatistics);

    const secondAssignment = await assignment('Lifecycle failure', 'failure');
    mockSemanticMode = 'failure'; mockOcrCall = 0; mockOcrGate = Promise.resolve();
    const failedUpload = await uploadTwoImages(secondAssignment._id, failureToken);
    expect(failedUpload.status).toBe(200);
    const failureId = String(failedUpload.body.data._id);
    await waitFor(failureId, (doc) => doc.semanticStatus === 'failed');
    const failedStudent = await getResult(failureId, failureToken);
    const failedTeacher = await getResult(failureId, teacherToken);
    expect(canonicalFields(failedStudent)).toEqual(canonicalFields(failedTeacher));
    expect(failedStudent).toMatchObject({ submissionId: failureId, score: null, rubricScores: null, evaluationStatus: 'blocked', detailedFeedbackStatus: 'blocked', statisticsCompleteness: 'language_only', manualRetryAllowed: true, automaticPollingAllowed: false });
    expect(failedStudent.correctionStatistics).toMatchObject({ grammar: 1, mechanics: 1 });
    expect(JSON.stringify(failedStudent)).not.toContain('77');
    expect(JSON.stringify(failedStudent)).not.toContain(String(successStudent.score));
    const failedPdf = await getPdf(failureId, teacherToken);
    expect(failedPdf.submission.submissionId).toBe(failureId);
    expect(failedPdf.result.overallScore).toBeNull();

    mockSemanticMode = 'success';
    const retry = await request(app).post(`/api/submissions/${failureId}/ocr-corrections/regenerate`).set('Authorization', `Bearer ${failureToken}`);
    expect(retry.status).toBe(202);
    await waitFor(failureId, (doc) => doc.correctionStatus === 'completed' && doc.evaluationStatus === 'completed');
    const retriedStudent = await getResult(failureId, failureToken);
    const retriedTeacher = await getResult(failureId, teacherToken);
    expect(canonicalFields(retriedStudent)).toEqual(canonicalFields(retriedTeacher));
    const retriedPdf = await getPdf(failureId, failureToken);
    expect(retriedPdf.submission.submissionId).toBe(failureId);
    expect(retriedPdf.result.overallScore).toBe(retriedStudent.score);
    expect(await SubmissionFeedback.countDocuments({ submissionId: failureId })).toBe(1);
    expect(require('../src/services/semanticWritingCorrections.service').analyze).toHaveBeenCalledTimes(3);
  }, 30000);
});
