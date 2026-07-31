process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
process.env.LANGUAGETOOL_URL = 'https://languagetool.test';

let mockSemanticMode = 'success';
let mockOcrGate = Promise.resolve();
let mockRubricGate = Promise.resolve();
let mockOcrCall = 0;
let languageToolRequestCount = 0;
let rubricProviderRequestCount = 0;
let assessmentPrimaryRequestCount = 0;

const pageResult = (text) => ({
  fullText: text,
  transcriptText: text,
  pages: [{ pageNumber: 1, words: [...text.split(/\s+/).map((word, index) => ({
    text: word, paragraphIndex: 0, bbox: { x: 8 + index * 10, y: 15, w: Math.min(9, word.length + 2), h: 4 }
  })),
  { text: 'D', paragraphIndex: 8, bbox: { x: 95, y: 12, w: 2, h: 3 } },
  { text: 'D', paragraphIndex: 9, bbox: { x: 95, y: 20, w: 2, h: 3 } },
  { text: 'B', paragraphIndex: 10, bbox: { x: 95, y: 28, w: 2, h: 3 } },
  { text: '#', paragraphIndex: 11, bbox: { x: 96, y: 36, w: 2, h: 3 } }] }]
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
        const error = new Error('Synthetic invalid provider response');
        error.code = 'AI_CHAIN_EXHAUSTED';
        error.attemptCount = 4;
        error.timeoutCount = 3;
        error.attempts = [
          { provider: 'google', model: 'gemini', code: 'AI_RESPONSE_TRUNCATED' },
          { provider: 'openrouter', model: 'ultra', code: 'AI_ATTEMPT_TIMEOUT' },
          { provider: 'openrouter', model: 'super', code: 'AI_ATTEMPT_TIMEOUT' },
          { provider: 'openrouter', model: 'gpt-oss', code: 'AI_ATTEMPT_TIMEOUT' }
        ];
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

jest.mock('../src/services/autoRubricDesigner.service', () => ({
  autoGenerateRubricDesignerForSubmission: jest.fn(async () => ({ skipped: true, reason: 'DETERMINISTIC_TEST' }))
}));

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
  evaluationSourceHash: data.evaluationSourceHash,
  score: data.score,
  rubricScores: data.rubricScores,
  correctionStatistics: data.correctionStatistics,
  semanticStatus: data.semanticStatus,
  evaluationStatus: data.evaluationStatus,
  detailedFeedbackStatus: data.detailedFeedbackStatus,
  detailedFeedback: data.detailedFeedback
});

function lineJson(prompt, prefix) {
  const line = String(prompt).split('\n').find((item) => item.startsWith(prefix));
  return JSON.parse(line.slice(prefix.length));
}

function rubricFixtureFromGoogleRequest(options) {
  const requestBody = JSON.parse(options.body);
  const prompt = requestBody.contents.flatMap((item) => item.parts || [])
    .map((part) => part.text || '').join('\n');
  const sourceHash = String(prompt.match(/^sourceHash=(.+)$/mu)?.[1] || '');
  const corrections = lineJson(prompt, 'correctionCatalog=');
  const byCategory = Object.fromEntries(corrections.map((item) => [item.category, item]));
  const evidence = {
    CONTENT: 'first test paragraph',
    ORGANIZATION: 'second test paragraph',
    VOCABULARY: 'erors'
  };
  const categories = Object.fromEntries(['CONTENT', 'ORGANIZATION', 'VOCABULARY'].map((category, index) => {
    const correction = byCategory[category];
    return [category, {
      score: 18 - index,
      maxScore: 20,
      comment: `${category} evidence is grounded in the submitted transcript.`,
      strengthEvidence: [{ quotedText: evidence[category], explanation: 'This is exact synthetic transcript evidence.' }],
      improvementEvidence: [{
        evidenceType: 'correction',
        correctionId: correction.correctionId,
        quotedText: correction.quotedText,
        explanation: 'This validated correction identifies a specific improvement.',
        suggestion: correction.suggestedText
      }]
    }];
  }));
  return { sourceHash, categories };
}

describe('isolated canonical two-image HTTP lifecycle', () => {
  let teacher; let student; let failureStudent; let classDoc; let teacherToken; let studentToken; let failureToken;
  const originalFetch = global.fetch;

  beforeAll(async () => {
    await connectInMemoryMongo();
    await Plan.seedDefaults();
    global.fetch = jest.fn(async (url, options) => {
      if (String(url).includes(':generateContent')) {
        rubricProviderRequestCount += 1;
        await mockRubricGate;
        return {
          ok: true,
          status: 200,
          headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
          text: async () => JSON.stringify({
            candidates: [{
              finishReason: 'STOP',
              content: { parts: [
                { thought: true, text: 'synthetic thought content must be ignored' },
                { text: JSON.stringify(rubricFixtureFromGoogleRequest(options)) }
              ] }
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 }
          })
        };
      }
      if (String(url).includes('/chat/completions')) {
        assessmentPrimaryRequestCount += 1;
        return { ok: false, status: 503, headers: { get: () => null },
          text: async () => JSON.stringify({ error: { code: 503 } }) };
      }
      expect(String(url)).toBe(`${process.env.LANGUAGETOOL_URL}/v2/check`);
      languageToolRequestCount += 1;
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
  }, 15000);

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

  async function getOcrCorrections(id, token) {
    const response = await request(app).get(`/api/submissions/${id}/ocr-corrections`)
      .set('Authorization', `Bearer ${token}`);
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
    let releaseRubric; mockRubricGate = new Promise((resolve) => { releaseRubric = resolve; });
    let releaseOcr; mockOcrGate = new Promise((resolve) => { releaseOcr = resolve; });
    const uploaded = await uploadTwoImages(firstAssignment._id, studentToken);
    expect(uploaded.status).toBe(200);
    const successId = String(uploaded.body.data._id);
    const pending = await getResult(successId, studentToken);
    const pendingTeacher = await getResult(successId, teacherToken);
    expect(canonicalFields(pending)).toEqual(canonicalFields(pendingTeacher));
    expect(pending).toMatchObject({ submissionId: successId, score: null, rubricScores: null, evaluationStatus: 'pending', detailedFeedbackStatus: 'pending' });
    expect(pending.detailedFeedback).toBeNull();
    expect(pending).toMatchObject({ score: null, overallScore: null, rubricScores: null });
    releaseOcr();
    const processingDoc = await waitFor(successId, (doc) => doc.evaluationStatus === 'processing');
    expect(processingDoc.semanticStatus).toBe('completed');
    expect(processingDoc.correctionStatus).toBe('completed');
    releaseRubric();
    const completedDoc = await waitFor(successId, (doc) => doc.correctionStatus === 'completed' && doc.evaluationStatus === 'completed');
    expect(completedDoc.ocrPages).toHaveLength(2);
    const canonicalOcr = await getOcrCorrections(successId, studentToken);
    expect(canonicalOcr.transcriptLayoutVersion).toBe('ocr-layout-v3');
    expect(canonicalOcr.ocr.map((page) => page.fileId)).toEqual(completedDoc.files.map(String));
    expect(canonicalOcr.ocr.map((page) => page.pageNumber)).toEqual([1, 1]);
    const canonicalWordTexts = canonicalOcr.ocr.flatMap((page) => page.words).map((word) => word.text);
    expect(canonicalWordTexts).not.toContain('D');
    expect(canonicalWordTexts).not.toContain('B');
    expect(canonicalWordTexts).not.toContain('#');
    expect(new Set(canonicalOcr.ocr.flatMap((page) => page.words).map((word) => word.id)).size)
      .toBe(canonicalOcr.ocr.flatMap((page) => page.words).length);
    expect(canonicalOcr.transcript).not.toContain('\n\n');
    const teacherCanonicalOcr = await getOcrCorrections(successId, teacherToken);
    expect(teacherCanonicalOcr.ocr).toEqual(canonicalOcr.ocr);
    expect(teacherCanonicalOcr.transcript).toBe(canonicalOcr.transcript);
    const successStudent = await getResult(successId, studentToken);
    const successTeacher = await getResult(successId, teacherToken);
    expect(canonicalFields(successStudent)).toEqual(canonicalFields(successTeacher));
    expect(successStudent.score).not.toBeNull();
    expect(successStudent.grade).toBeTruthy();
    expect(successStudent.evaluationSourceHash).toBe(successStudent.correctionSourceHash);
    expect(successStudent.detailedFeedback).not.toBeNull();
    expect(successStudent.correctionStatistics).toMatchObject({ grammar: 1, mechanics: 1, content: 1, organization: 1, vocabulary: 1 });
    expect(canonicalFields(await getResult(successId, studentToken))).toEqual(canonicalFields(successStudent));
    expect(canonicalFields(await getResult(successId, teacherToken))).toEqual(canonicalFields(successTeacher));
    const successPdf = await getPdf(successId, studentToken);
    expect(successPdf.submission.submissionId).toBe(successId);
    expect(successPdf.result.overallScore).toBe(successStudent.score);
    expect(successPdf.statistics).toMatchObject(successStudent.correctionStatistics);
    expect(successPdf.detailedFeedback).toEqual(successStudent.detailedFeedback);
    const adaptive = await request(app).get(`/api/adaptive-practice/submissions/${successId}`)
      .set('Authorization', `Bearer ${studentToken}`);
    expect(adaptive.status).toBe(200);
    expect(['idle', 'no-weaknesses']).toContain(adaptive.body.data.state);
    const readsBefore = { languageToolRequestCount, rubricProviderRequestCount };
    await getResult(successId, studentToken);
    await getResult(successId, teacherToken);
    await getOcrCorrections(successId, studentToken);
    await getPdf(successId, teacherToken);
    expect({ languageToolRequestCount, rubricProviderRequestCount }).toEqual(readsBefore);

    const secondAssignment = await assignment('Lifecycle failure', 'failure');
    mockSemanticMode = 'failure'; mockOcrCall = 0; mockOcrGate = Promise.resolve(); mockRubricGate = Promise.resolve();
    const failedUpload = await uploadTwoImages(secondAssignment._id, failureToken);
    expect(failedUpload.status).toBe(200);
    const failureId = String(failedUpload.body.data._id);
    await waitFor(failureId, (doc) => doc.semanticStatus === 'failed');
    const failedStudent = await getResult(failureId, failureToken);
    const failedTeacher = await getResult(failureId, teacherToken);
    expect(canonicalFields(failedStudent)).toEqual(canonicalFields(failedTeacher));
    expect(failedStudent).toMatchObject({ submissionId: failureId, score: null, rubricScores: null, evaluationStatus: 'blocked', detailedFeedbackStatus: 'blocked', statisticsCompleteness: 'language_only', manualRetryAllowed: true, automaticPollingAllowed: false });
    expect(failedStudent.correctionStatistics).toMatchObject({ grammar: 1, mechanics: 1 });
    expect(failedStudent.score).not.toBe(77);
    expect(failedStudent.overallScore).not.toBe(77);
    expect(failedStudent.score).not.toBe(successStudent.score);
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
    expect(retriedStudent).toMatchObject({ evaluationStatus: 'completed', semanticErrorCode: null });
    expect(retriedStudent.score).not.toBeNull();
    expect(retriedStudent.detailedFeedback).not.toBeNull();
    const retriedAdaptive = await request(app).get(`/api/adaptive-practice/submissions/${failureId}`)
      .set('Authorization', `Bearer ${failureToken}`);
    expect(retriedAdaptive.status).toBe(200);
    const retriedPdf = await getPdf(failureId, failureToken);
    expect(retriedPdf.submission.submissionId).toBe(failureId);
    expect(retriedPdf.result.overallScore).toBe(retriedStudent.score);
    expect(await SubmissionFeedback.countDocuments({ submissionId: failureId })).toBe(1);
    expect(require('../src/services/semanticWritingCorrections.service').analyze).toHaveBeenCalledTimes(3);
    expect(languageToolRequestCount).toBe(2);
    expect(rubricProviderRequestCount).toBe(2);
    expect(assessmentPrimaryRequestCount).toBe(4);
    expect(global.fetch).toHaveBeenCalledTimes(languageToolRequestCount + rubricProviderRequestCount
      + assessmentPrimaryRequestCount);
  }, 30000);
});
