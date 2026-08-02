process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
process.env.LANGUAGETOOL_URL = 'https://languagetool.test';
process.env.ASSESSMENT_AI_PRIMARY_PROVIDER = 'openrouter';
process.env.ASSESSMENT_AI_PRIMARY_MODEL = 'openai/gpt-4.1';
process.env.ASSESSMENT_AI_FALLBACK_1_PROVIDER = 'openrouter';
process.env.ASSESSMENT_AI_FALLBACK_1_MODEL = 'openai/gpt-4.1-mini';
process.env.ASSESSMENT_AI_FALLBACK_2_PROVIDER = '';
process.env.ASSESSMENT_AI_FALLBACK_2_MODEL = '';
process.env.ASSESSMENT_AI_FALLBACK_3_PROVIDER = '';
process.env.ASSESSMENT_AI_FALLBACK_3_MODEL = '';
process.env.ASSESSMENT_AI_PRIMARY_RETRIES = '1';
process.env.ASSESSMENT_AI_FALLBACK_RETRIES = '0';
process.env.ASSESSMENT_AI_RETRY_DELAY_MS = '0';

let mockSemanticMode = 'success';
let mockOcrGate = Promise.resolve();
let mockRubricGate = Promise.resolve();
let mockOcrCall = 0;
let languageToolRequestCount = 0;
let rubricProviderRequestCount = 0;
let assessmentPrimaryRequestCount = 0;
let correctionProviderRequestCount = 0;
let retryAnalysisRequestCount = 0;
let lifecycleEvents = [];

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
      : 'This are the second test paragraph. It has vague wording and teh error.';
    lifecycleEvents.push('ocr-completed');
    return pageResult(text);
  })
}));

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
const waitForCondition = async (predicate, timeoutMs = 10000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for lifecycle condition');
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

function rubricFixtureFromPrompt(prompt) {
  const sourceHash = String(prompt.match(/^sourceHash=(.+)$/mu)?.[1] || '');
  const transcriptEvidence = lineJson(prompt, 'evidenceCatalog=');
  const evidence = Object.fromEntries([
    ['CONTENT', 'first test paragraph'], ['ORGANIZATION', 'second test paragraph'], ['VOCABULARY', 'vague wording']
  ].map(([category, quote]) => [category, transcriptEvidence.find((item) => item.quotedText.includes(quote))]));
  const categories = Object.fromEntries(['CONTENT', 'ORGANIZATION', 'VOCABULARY'].map((category, index) => {
    return [category, {
      score: 18 - index,
      maxScore: 20,
      comment: `${category} evidence is grounded in the submitted transcript.`,
      strengthEvidence: [{ evidenceId: evidence[category].evidenceId, explanation: 'This is exact synthetic transcript evidence.' }],
      improvementEvidence: [{
        evidenceType: 'transcript',
        correctionId: null,
        evidenceId: evidence[category].evidenceId,
        explanation: 'This validated correction identifies a specific improvement.',
        suggestion: `Improve the grounded ${category.toLowerCase()} evidence.`
      }]
    }];
  }));
  return { sourceHash, categories };
}

function rubricPromptFromRequest(options) {
  const requestBody = JSON.parse(options.body);
  if (Array.isArray(requestBody.messages)) return requestBody.messages.map((item) => item.content || '').join('\n');
  return requestBody.contents.flatMap((item) => item.parts || []).map((part) => part.text || '').join('\n');
}

function correctionFixtureFromPrompt(prompt) {
  const transcriptHash = String(prompt.match(/^transcriptHash=(.+)$/mu)?.[1] || '');
  const corrections = [
    { category: 'CONTENT', symbol: 'DEV', correctionKind: 'global', quotedText: 'first test paragraph', occurrence: 1, message: 'Develop this evidence.', suggestedText: '', confidence: 0.95, severity: 'medium', stylePreference: false },
    { category: 'ORGANIZATION', symbol: 'COH', correctionKind: 'global', quotedText: 'second test paragraph', occurrence: 1, message: 'Improve the transition.', suggestedText: '', confidence: 0.95, severity: 'medium', stylePreference: false },
    { category: 'VOCABULARY', symbol: 'WC', correctionKind: 'localized', quotedText: 'vague wording', occurrence: 1, message: 'Use more precise wording.', suggestedText: 'precise wording', confidence: 0.95, severity: 'medium', stylePreference: false },
    { category: 'GRAMMAR', symbol: 'AGR', correctionKind: 'localized', quotedText: 'This are', occurrence: 1, message: 'Correct subject-verb agreement.', suggestedText: 'This is', confidence: 0.95, severity: 'medium', stylePreference: false },
    { category: 'MECHANICS', symbol: 'SP', correctionKind: 'localized', quotedText: 'teh', occurrence: 1, message: 'Correct the spelling.', suggestedText: 'the', confidence: 0.95, severity: 'medium', stylePreference: false }
  ];
  const categories = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'];
  const symbols = require('../src/services/structuredOutputSchemas.service').CATEGORY_SYMBOLS;
  const grouped = Object.fromEntries(categories.map((category) => [category, {
    reviewed: true,
    reviewedSymbols: [...symbols[category]],
    noFindingReason: corrections.some((item) => item.category === category) ? '' : 'No grounded finding after review.',
    corrections: corrections.filter((item) => item.category === category).map(({ category: _category, ...item }) => item)
  }]));
  if (mockSemanticMode === 'failure') delete grouped.MECHANICS;
  return { transcriptHash, categories: grouped };
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
        lifecycleEvents.push('evaluation-started');
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
                { text: JSON.stringify(rubricFixtureFromPrompt(rubricPromptFromRequest(options))) }
              ] }
            }],
            usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 100, totalTokenCount: 200 }
          })
        };
      }
      if (String(url).includes('/chat/completions')) {
        const prompt = rubricPromptFromRequest(options);
        if (prompt.includes('schema=semantic-corrections-v11-provider-compatible-symbol-coverage')) {
          correctionProviderRequestCount += 1;
          lifecycleEvents.push('correction-started');
          return { ok: true, status: 200, headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
              content: JSON.stringify(correctionFixtureFromPrompt(prompt)) } }],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) };
        }
        if (prompt.includes('correctionCatalog=')) {
          assessmentPrimaryRequestCount += 1;
          rubricProviderRequestCount += 1;
          lifecycleEvents.push('evaluation-started');
          await mockRubricGate;
          return { ok: true, status: 200, headers: { get: () => 'application/json' },
            text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
              content: JSON.stringify(rubricFixtureFromPrompt(prompt)) } }],
            usage: { prompt_tokens: 100, completion_tokens: 100, total_tokens: 200 } }) };
        }
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

  async function retryCorrections(id, token) {
    retryAnalysisRequestCount += 1;
    return request(app).post(`/api/submissions/${id}/ocr-corrections/regenerate`).set('Authorization', `Bearer ${token}`);
  }

  test('success, semantic failure, and manual retry remain canonical across student, teacher, and PDF', async () => {
    const firstAssignment = await assignment('Lifecycle success', 'success');
    mockSemanticMode = 'success'; mockOcrCall = 0; lifecycleEvents = []; retryAnalysisRequestCount = 0;
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
    expect(processingDoc.writingCorrections).toHaveLength(5);
    await waitForCondition(() => lifecycleEvents.includes('evaluation-started'));
    expect(lifecycleEvents.slice(0, 4)).toEqual(['ocr-completed', 'ocr-completed', 'correction-started', 'evaluation-started']);
    expect(retryAnalysisRequestCount).toBe(0);
    releaseRubric();
    const completedDoc = await waitFor(successId, (doc) => doc.correctionStatus === 'completed' && doc.evaluationStatus === 'completed');
    expect(completedDoc.ocrPages).toHaveLength(2);
    expect(completedDoc.semanticMetrics).toMatchObject({ allCategoriesReviewed: true,
      totalExpectedSymbols: 28, totalReceivedUniqueSymbols: 28, incompleteReviewCategories: [] });
    expect(Object.values(completedDoc.semanticMetrics.symbolReviewCoverage)
      .every((item) => item.complete === true)).toBe(true);
    const canonicalOcr = await getOcrCorrections(successId, studentToken);
    expect(canonicalOcr.transcriptLayoutVersion).toBe('ocr-layout-v5-native-text');
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
    expect(successStudent.correctionStatistics).toMatchObject({ grammar: 1, mechanics: 1, content: 1, organization: 1, vocabulary: 1, total: 5 });
    expect(completedDoc.writingCorrections).toHaveLength(5);
    expect(successStudent.correctionStatistics.total).toBe(['content', 'organization', 'grammar', 'vocabulary', 'mechanics']
      .reduce((sum, category) => sum + successStudent.correctionStatistics[category], 0));
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
    mockSemanticMode = 'failure'; mockOcrCall = 0; mockRubricGate = Promise.resolve();
    let releaseFailureOcr; mockOcrGate = new Promise((resolve) => { releaseFailureOcr = resolve; });
    const failedUpload = await uploadTwoImages(secondAssignment._id, failureToken);
    expect(failedUpload.status).toBe(200);
    const failureId = String(failedUpload.body.data._id);
    await SubmissionFeedback.create({ submissionId: failureId, classId: classDoc._id,
      studentId: failureStudent._id, teacherId: teacher._id, evaluationStatus: 'pending',
      evaluationSource: 'deterministic_fallback', overallScore: 0, grade: 'F', overriddenByTeacher: false });
    releaseFailureOcr();
    await waitFor(failureId, (doc) => doc.semanticStatus === 'failed');
    const failedStudent = await getResult(failureId, failureToken);
    const failedTeacher = await getResult(failureId, teacherToken);
    expect(canonicalFields(failedStudent)).toEqual(canonicalFields(failedTeacher));
    expect(failedStudent).toMatchObject({ submissionId: failureId, score: null, rubricScores: null, evaluationStatus: 'blocked', detailedFeedbackStatus: 'blocked', statisticsCompleteness: 'none', manualRetryAllowed: true, automaticPollingAllowed: false });
    expect(failedStudent.correctionStatistics).toMatchObject({ grammar: 0, mechanics: 0 });
    expect(failedStudent.score).not.toBe(77);
    expect(failedStudent.overallScore).not.toBe(77);
    expect(failedStudent.score).not.toBe(successStudent.score);
    const failedPersistedFeedback = await SubmissionFeedback.findOne({ submissionId: failureId }).lean();
    expect(failedPersistedFeedback).toMatchObject({ evaluationStatus: 'blocked',
      overallScore: null, grade: null, rubricScores: null, correctionStats: null, overriddenByTeacher: false });
    // In AI-only pipeline, when corrections fail completely, PDF generation returns 409
    const failedPdfResponse = await request(app).get(`/api/pdf/download/${failureId}`).set('Authorization', `Bearer ${teacherToken}`);
    expect(failedPdfResponse.status).toBe(409);

    mockSemanticMode = 'success';
    const retry = await retryCorrections(failureId, failureToken);
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
    expect(languageToolRequestCount).toBe(0); // AI-only pipeline does not call LanguageTool
    expect(rubricProviderRequestCount).toBe(2);
    // Both rubric evaluations succeed on the first GPT-4.1 request; no fallback
    // or non-OpenRouter assessment request is needed.
    expect(assessmentPrimaryRequestCount).toBe(2);
    expect(rubricProviderRequestCount).toBe(assessmentPrimaryRequestCount);
    expect(correctionProviderRequestCount).toBe(4);
    expect(global.fetch).toHaveBeenCalledTimes(
      languageToolRequestCount + assessmentPrimaryRequestCount + correctionProviderRequestCount
    );
  }, 30000);
});
