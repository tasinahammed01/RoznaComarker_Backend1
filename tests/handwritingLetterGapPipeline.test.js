'use strict';
// generateAndPersist must hand the coordinator sourceKind 'exact_source' for photographed (exact-source) essays and nothing for others.
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: async () => null })) }));
jest.mock('../src/models/SubmissionFeedback', () => ({ updateOne: jest.fn(async () => ({ modifiedCount: 1 })) }));
jest.mock('../src/services/semanticCorrectionCoordinator.service', () => ({ ...jest.requireActual('../src/services/semanticCorrectionCoordinator.service'), analyze: jest.fn() }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({
  resolveAssessmentPolicy: jest.fn(async () => { const p = require('../src/services/teacherEvaluationPolicy.service');
    const policy = p.normalizeTeacherEvaluationPolicy({ strictness: 'balanced' }); return { policy, policyHash: p.evaluationPolicyHash(policy) }; }),
  prepareRubricAssessment: jest.fn(async () => ({ semantic: { model: 'openai/gpt-6-astra', metrics: { attemptCount: 1 } } })),
  persistProvisionalScore: jest.fn(async () => ({ status: 'partial', overallScore: 78 })), generate: jest.fn(async () => null)
}));
const crypto = require('crypto');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { reviewedResult } = require('./helpers/astraAssessmentFixtures.cjs');
const model = 'google/gemini-3.8-flash';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function docFor(extra) {
  const state = { _id: 'gap-doc', ocrJobId: 'ocr-1', files: ['file-1'], writingCorrections: [], ...extra };
  const constructor = { updateOne: jest.fn(async (query, update) => { Object.assign(state, update.$set || {}); return { modifiedCount: 1, matchedCount: 1 }; }),
    findById: jest.fn(() => ({ lean: async () => state })), exists: jest.fn(async () => true) };
  return { ...state, constructor };
}
beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'mock-only'; process.env.CORRECTION_DETECTION_MODEL = model; jest.clearAllMocks();
  jest.spyOn(require('../src/utils/logger'), 'info').mockImplementation(() => {});
  jest.spyOn(require('../src/utils/logger'), 'warn').mockImplementation(() => {});
  coordinator.analyze.mockImplementation(async input => ({ ...reviewedResult(input), model, status: 'completed', metrics: { attemptCount: 1 }, coverage: { complete: true } }));
});
afterEach(() => jest.restoreAllMocks());

test('a legacy OCR essay is analysed without sourceKind', async () => {
  await pipeline.generateAndPersist(docFor({ ocrPages: [{ fileId: 'file-1', pageNumber: 1, text: 'A legacy essay with a bout one gap.' }] }));
  expect(coordinator.analyze).toHaveBeenCalledTimes(1);
  expect(coordinator.analyze.mock.calls[0][0]).not.toHaveProperty('sourceKind', 'exact_source');
  expect(coordinator.analyze.mock.calls[0][0].sourceKind).toBeUndefined();
});

test('an exact-source (photographed) essay is analysed with sourceKind exact_source', async () => {
  const text = 'An exact essay with a bout one gap.';
  const version = require('../src/services/gptVisionExact/contract').VERSION;
  await pipeline.generateAndPersist(docFor({ sourceFidelityMode: 'gpt_vision_exact', sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED',
    sourceTranscriptExact: text, sourceTranscriptSha256: sha(text),
    ocrPages: [{ fileId: 'file-1', fileOrder: 0, pageIndex: 0, pageNumber: 1, sourceFidelityMode: 'gpt_vision_exact', sourceFidelityVersion: version,
      sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED', sourceTextExact: text, sourceTextSha256: sha(text), words: [] }] }));
  expect(coordinator.analyze).toHaveBeenCalledTimes(1);
  expect(coordinator.analyze.mock.calls[0][0]).toMatchObject({ sourceKind: 'exact_source', transcript: text });
});
