'use strict';
// The handwriting mechanics check on a document built exactly as production builds it: the real reader entry point
// (extractOcrFromImageFile), the real Vision geometry parsing and alignment, the real OCR persistence (runOcrAndPersistForFiles,
// which stores exact-source word boxes as corners {x0, y0, x1, y1}), then the real correction pipeline, stage and engine.
// Mocked: the AI answers (reader, check, correction), the rubric, the legend, the file record. Synthetic image and text, no network.
const mockDetect = jest.fn();
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockDetect })) }));
jest.mock('../src/services/gptVisionExact/attempt', () => ({ acquire: jest.fn(async () => ({ _id: 'r', cached: false })), complete: jest.fn(async () => {}) }));
jest.mock('../src/services/gptVisionExact/preflight', () => ({ claimReservation: () => require('../src/services/gptVisionExact/attempt') }));
jest.mock('../src/models/File', () => ({ findById: jest.fn(id => {
  const doc = { _id: id, path: require('path').join('tmp', `hm-integration-${process.pid}.jpg`) };
  const query = { select: () => query, lean: async () => doc, then: (resolve, reject) => Promise.resolve(doc).then(resolve, reject) };
  return query;
}) }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
jest.mock('../src/models/SubmissionFeedback', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../src/services/semanticCorrectionCoordinator.service', () => ({ ...jest.requireActual('../src/services/semanticCorrectionCoordinator.service'), analyze: jest.fn() }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({
  resolveAssessmentPolicy: jest.fn(async () => { const p = require('../src/services/teacherEvaluationPolicy.service');
    const policy = p.normalizeTeacherEvaluationPolicy({ strictness: 'balanced' }); return { policy, policyHash: p.evaluationPolicyHash(policy) }; }),
  prepareRubricAssessment: jest.fn(async () => ({ semantic: { model: 'openai/gpt-6-astra', metrics: { attemptCount: 1 } } })),
  persistProvisionalScore: jest.fn(async () => ({ status: 'partial', overallScore: 78 })), generate: jest.fn(async () => null)
}));
const fs = require('fs'), path = require('path'), sharp = require('sharp');
const gateway = require('../src/services/aiGateway.service');
const contract = require('../src/services/gptVisionExact/contract');
const profile = require('../src/services/handwritingMechanics/profile');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const logger = require('../src/utils/logger');
const { runOcrAndPersistForFiles } = require('../src/services/ocrPipeline.service');
const { reviewedResult } = require('./helpers/astraAssessmentFixtures.cjs');

const W = 1200, H = 600;
const LINES = ['Kids these days , they win.', 'Our team has .Many fans.', 'My dog runs fast.'];
const TEXT = LINES.join('\n');
const filename = path.resolve(__dirname, '..', 'tmp', `hm-integration-${process.pid}.jpg`);
const before = { ...process.env };

/** A Vision annotation with one paragraph per handwritten line; every whitespace token is one Vision word, in pixels. */
function annotation() {
  const paragraphs = LINES.map((line, row) => ({ words: [...line.matchAll(/\S+/gu)].map((m, col) => {
    const x = 40 + col * 150, y = 60 + row * 160;
    return { symbols: [...m[0]].map(text => ({ text })), confidence: 0.98,
      boundingBox: { vertices: [{ x, y }, { x: x + 120, y }, { x: x + 120, y: y + 60 }, { x, y: y + 60 }] } };
  }) }));
  return [{ fullTextAnnotation: { text: TEXT, pages: [{ width: W, height: H, blocks: [{ paragraphs }] }] } }];
}
const readerReply = () => ({ version: contract.VERSION, activeTranscript: TEXT, uncertainties: [],
  physicalLines: LINES.map(text => ({ segments: [{ text, classification: 'STUDENT_ACTIVE_TEXT', confidence: 0.99 }] })) });
/** The check's reply: everything as written is normal (small letters, normal spacing); the test is about reaching the call. */
function checkReply(options) {
  const text = options.messages[1].content[0].text;
  const list = label => { const line = text.split('\n').find(l => l.startsWith(label)); return !line || line.endsWith('(none)') ? [] : line.slice(label.length).split(' | '); };
  const words = list('Words: ').map(w => w.replace(/^\d+\. /u, '').replace(/ \(line \d+\)$/u, ''));
  return { marks: list('Punctuation marks: ').map(() => ({ space_before: false, space_after: true, confidence: 0.95 })),
    cases: words.map(w => ({ case_as_written: /^\p{Lu}/u.test(w) ? 'capital' : 'small', is_proper_noun: 'false', confidence: 0.95 })) };
}
function targetDoc() {
  const saved = {};
  const doc = { _id: 'hm-integration', files: ['file-a'], ocrJobId: 'job', assignment: null, writingCorrections: [],
    constructor: { exists: jest.fn(async () => true), findById: jest.fn(() => ({ lean: async () => ({ ...doc, ...saved }) })),
      updateOne: jest.fn(async (query, update) => { Object.assign(saved, update.$set || {}); return { matchedCount: 1, modifiedCount: 1 }; }) },
    toObject() { const { constructor, toObject, ...rest } = this; return rest; } };
  return { doc, saved };
}
const checkEvents = info => info.mock.calls.map(([e]) => e).filter(e => e?.event === 'handwriting_mechanics_check');

beforeAll(async () => {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, await sharp({ create: { width: W, height: H, channels: 3, background: '#ffffff' } }).jpeg().toBuffer());
});
afterAll(() => { try { fs.unlinkSync(filename); } catch { /* already gone */ } });
beforeEach(() => {
  Object.assign(process.env, { NODE_ENV: 'test', OCR_SOURCE_MODE: 'gpt_vision_exact', OCR_GPT_VISION_MODEL: 'openai/gpt-5.6-sol', OPENROUTER_API_KEY: 'mock-only',
    OCR_PREPROCESS: 'handwriting', CORRECTION_DETECTION_MODEL: profile.MODEL, HANDWRITING_MECHANICS_CHECK_ENABLED: 'true' });
  delete process.env.GOOGLE_CLOUD_KEY_FILE; delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  jest.clearAllMocks();
  mockDetect.mockReset().mockResolvedValue(annotation());
  jest.spyOn(gateway, 'providerAttempt').mockImplementation(async options => (options.requestProfile === profile.REQUEST_PROFILE
    ? { content: JSON.stringify(checkReply(options)), returnedModel: profile.MODEL, usage: { prompt_tokens: 900, completion_tokens: 40, cost: 0.001 } }
    : { content: JSON.stringify(readerReply()), returnedModel: options.entry.model }));
  coordinator.analyze.mockImplementation(async input => ({ ...reviewedResult(input), model: profile.MODEL, status: 'completed',
    metrics: { attemptCount: 1 }, coverage: { complete: true } }));
});
afterEach(() => {
  jest.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in before)) delete process.env[key];
  Object.assign(process.env, before);
});

test('a new exact-source essay: the check reads the stored word boxes, checks all 3 lines and calls the model', async () => {
  const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const { doc, saved } = targetDoc();
  await runOcrAndPersistForFiles({ fileIds: ['file-a'], targetDoc: doc, jobId: 'job' });
  // The document the check read: stored exactly as production stores it (corner boxes), with geometry for the words.
  const words = doc.ocrPages[0].words;
  expect(words.filter(w => w.bbox).length).toBeGreaterThan(0);
  expect(Object.keys(words.find(w => w.bbox).bbox).sort()).toEqual(['x0', 'x1', 'y0', 'y1']);
  const [event] = checkEvents(info);
  expect(event).toMatchObject({ lines: 3, linesChecked: 3, status: 'completed' });
  // toMatchObject treats {} as 'any object': compare the skip counts exactly.
  expect(event.linesSkipped).toEqual({});
  expect(event.pagesSkipped).toEqual({});
  expect(event.calls).toBeGreaterThan(0);
  expect(gateway.providerAttempt.mock.calls.filter(([o]) => o.requestProfile === profile.REQUEST_PROFILE)).toHaveLength(event.calls);
  expect(saved.handwritingMechanicsCheck).toMatchObject({ linesChecked: 3, status: 'completed' });
  expect(saved.handwritingMechanicsCheck.linesSkipped).toEqual({});
  expect(saved.correctionStatus).toBe('completed');
});

test('geometry genuinely unavailable: every line is skipped as NO_GEOMETRY, no call, marking completes', async () => {
  mockDetect.mockResolvedValue([{ fullTextAnnotation: { text: '', pages: [] } }]);
  const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
  jest.spyOn(logger, 'warn').mockImplementation(() => {});
  const { doc, saved } = targetDoc();
  await runOcrAndPersistForFiles({ fileIds: ['file-a'], targetDoc: doc, jobId: 'job' });
  expect(doc.ocrPages[0].words.every(w => w.bbox === null)).toBe(true);
  const [event] = checkEvents(info);
  expect(event).toMatchObject({ lines: 3, linesChecked: 0, calls: 0, status: 'skipped' });
  expect(event.linesSkipped).toEqual({ NO_GEOMETRY: 3 });
  // The check finished at once: it was not stopped by the wait limit.
  expect(event.aborted).toBeNull();
  expect(gateway.providerAttempt.mock.calls.some(([o]) => o.requestProfile === profile.REQUEST_PROFILE)).toBe(false);
  expect(saved.correctionStatus).toBe('completed');
});
