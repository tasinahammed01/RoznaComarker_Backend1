'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));
jest.mock('../src/models/SubmissionFeedback', () => ({ updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
jest.mock('../src/services/semanticAIClient.service', () => ({ getSemanticAIConfig: () => ({ provider: 'openrouter', model: 'approved/model',
  maxRetries: 1, fallback: null }), getSemanticAIConfigStatus: () => ({ credentialConfigured: true }) }));
jest.mock('../src/services/semanticWritingCorrections.service', () => ({ SEMANTIC_PROMPT_VERSION: 'semantic-compact-v2',
  semanticSourceKey: () => 'semantic-key', analyze: jest.fn(async () => ({ corrections: [], provider: 'openrouter', model: 'approved/model',
    metrics: { attemptCount: 1, promptInputTokenEstimate: 100 } })) }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({ stable: (value) => value, generate: jest.fn().mockResolvedValue(null) }));

const semantic = require('../src/services/semanticWritingCorrections.service');
const writing = require('../src/services/writingCorrections.service');
const metrics = require('../src/services/semanticMetrics.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const canonical = require('../src/services/correctionCanonical.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const logger = require('../src/utils/logger');

describe('semantic single-flight job lock', () => {
  beforeEach(() => {
    metrics.resetForTests();
    jest.spyOn(writing, 'getLegend').mockResolvedValue(writing.defaultLegend());
    jest.spyOn(writing, 'check').mockResolvedValue({ issues: [] });
    semantic.analyze.mockClear();
  });

  test('two concurrent starts for one source hash create exactly one semantic request', async () => {
    const state = { _id: 'submission-1', ocrJobId: 'ocr-job', semanticStatus: undefined };
    const model = {
      updateOne: jest.fn(async (query, update) => {
        if (query.semanticStatus?.$nin && ['processing', 'retry_wait'].includes(state.semanticStatus)) return { modifiedCount: 0 };
        if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
        Object.assign(state, update.$set || {});
        return { modifiedCount: 1 };
      }),
      findById: jest.fn(async () => ({ ...state, constructor: model }))
    };
    const doc = { ...state, files: ['f1'], ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'A complete essay.' }],
      constructor: model, writingCorrections: [] };
    const [first, second] = await Promise.all([
      pipeline.generateAndPersist(doc, { assignment: { title: 'Essay' } }),
      pipeline.generateAndPersist(doc, { assignment: { title: 'Essay' } })
    ]);
    expect(semantic.analyze).toHaveBeenCalledTimes(1);
    expect([first, second].filter((item) => item?.duplicate)).toHaveLength(1);
    expect(metrics.snapshot()).toMatchObject({ semanticJobsStarted: 1, semanticJobsRejectedAsDuplicate: 1 });
  });

  test('completed result with the same semantic source key is reused without a provider call', async () => {
    const assignment = { title: 'Essay' };
    const transcript = 'A complete essay.';
    const correctionSourceHash = pipeline.buildCorrectionSourceHash({ transcript, assignment });
    const model = { updateOne: jest.fn() };
    const result = await pipeline.generateAndPersist({ _id: 'submission-2', ocrJobId: 'ocr-job', files: ['f1'],
      ocrPages: [{ fileId: 'f1', pageNumber: 1, text: transcript }], correctionSourceHash,
      correctionVersion: canonical.VERSION, correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      correctionStatus: 'completed', semanticStatus: 'completed', semanticSourceKey: 'semantic-key', constructor: model }, { assignment });
    expect(result).toMatchObject({ reused: true, semanticSourceKey: 'semantic-key' });
    expect(semantic.analyze).not.toHaveBeenCalled();
    expect(model.updateOne).not.toHaveBeenCalled();
    expect(metrics.snapshot().semanticJobsReused).toBe(1);
  });

  test('failed provider attempt is numbered and safe diagnostics exclude request and response data', async () => {
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    semantic.analyze.mockImplementationOnce(async (input) => {
      await input.onAttempt({ attempt: 1, maxAttempts: 2, provider: 'openrouter', model: 'approved/model',
        attemptTimeoutMs: 1000, remainingBudgetMs: 2000 });
      const error = new Error('must-not-be-logged-provider-output');
      Object.assign(error, { code: 'SEMANTIC_RESPONSE_INVALID', validationStage: 'json_parse', responseTextLength: 27,
        candidateCount: 1, finishReason: 'STOP', httpStatus: 200 });
      throw error;
    });
    const state = { _id: 'submission-failure', ocrJobId: 'ocr-job', semanticStatus: undefined };
    const model = { updateOne: jest.fn(async (_query, update) => { Object.assign(state, update.$set || {}); return { modifiedCount: 1 }; }),
      findById: jest.fn() };
    await pipeline.generateAndPersist({ ...state, files: ['f1'], ocrPages: [{ fileId: 'f1', pageNumber: 1,
      text: 'private transcript evidence' }], constructor: model, writingCorrections: [] }, { assignment: { title: 'private prompt' } });
    const diagnostic = warn.mock.calls.find(([entry]) => entry?.message === 'Semantic analysis failure')?.[0];
    expect(diagnostic).toMatchObject({ attempt: 1, errorCode: 'SEMANTIC_RESPONSE_INVALID', validationStage: 'json_parse',
      responseTextLength: 27, candidateCount: 1, finishReason: 'STOP', credentialConfigured: true });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of ['private transcript evidence', 'private prompt', 'must-not-be-logged-provider-output']) expect(serialized).not.toContain(secret);
    warn.mockRestore();
  });
});
