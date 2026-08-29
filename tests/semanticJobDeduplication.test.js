'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));
jest.mock('../src/models/SubmissionFeedback', () => ({ updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }) }));
jest.mock('../src/services/semanticAIClient.service', () => ({ getSemanticAIConfig: () => ({ provider: 'openrouter', model: 'approved/model',
  maxRetries: 1, fallback: null }), getSemanticAIConfigStatus: () => ({ credentialConfigured: true }) }));
jest.mock('../src/services/semanticWritingCorrections.service', () => ({ SEMANTIC_PROMPT_VERSION: 'semantic-compact-v2',
  semanticSourceKey: () => 'semantic-key', analyze: jest.fn(async () => ({ corrections: [], provider: 'openrouter', model: 'approved/model',
    metrics: { attemptCount: 1, promptInputTokenEstimate: 100 } })) }));
jest.mock('../src/services/canonicalEvaluation.service', () => ({ stable: (value) => value,
  prepareRubricAssessment: jest.fn().mockResolvedValue({ sourceHash: 'prepared' }),
  persistProvisionalScore: jest.fn().mockResolvedValue({ status: 'partial', overallScore: 78 }),
  generate: jest.fn().mockResolvedValue(null) }));

const semantic = require('../src/services/semanticWritingCorrections.service');
const canonicalEvaluation = require('../src/services/canonicalEvaluation.service');
const writing = require('../src/services/writingCorrections.service');
const metrics = require('../src/services/semanticMetrics.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const canonical = require('../src/services/correctionCanonical.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION, buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const logger = require('../src/utils/logger');

describe('semantic single-flight job lock', () => {
  beforeEach(() => {
    metrics.resetForTests();
    jest.spyOn(writing, 'getLegend').mockResolvedValue(writing.defaultLegend());
    jest.spyOn(writing, 'check').mockResolvedValue({ issues: [] });
    semantic.analyze.mockClear();
    canonicalEvaluation.generate.mockClear();
    canonicalEvaluation.prepareRubricAssessment.mockClear();
    canonicalEvaluation.persistProvisionalScore.mockClear();
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
    expect(canonicalEvaluation.prepareRubricAssessment).toHaveBeenCalledTimes(1);
    expect([first, second].filter((item) => item?.duplicate)).toHaveLength(1);
    expect(metrics.snapshot()).toMatchObject({ semanticJobsStarted: 1, semanticJobsRejectedAsDuplicate: 1 });
  });

  test('chunking configuration participates in the semantic idempotency key', () => {
    const first = pipeline.buildSemanticSourceKey('base', { SEMANTIC_AI_CHUNK_INPUT_TOKENS: '3000' });
    const second = pipeline.buildSemanticSourceKey('base', { SEMANTIC_AI_CHUNK_INPUT_TOKENS: '3500' });
    expect(first).not.toBe(second);
    expect(first).toBe(pipeline.buildSemanticSourceKey('base', { SEMANTIC_AI_CHUNK_INPUT_TOKENS: '3000' }));
  });

  test.each([2000, 5000, 10000])('rubric preparation overlaps semantic correction analysis for %i transcript chars and runs once', async (transcriptChars) => {
    let releaseSemantic;
    const semanticGate = new Promise((resolve) => { releaseSemantic = resolve; });
    const starts = {};
    semantic.analyze.mockImplementationOnce(async () => {
      starts.semantic = Date.now();
      await semanticGate;
      return { corrections: [], provider: 'openrouter', model: 'approved/model', metrics: { attemptCount: 1 } };
    });
    canonicalEvaluation.prepareRubricAssessment.mockImplementationOnce(async () => {
      starts.rubric = Date.now();
      releaseSemantic();
      return { sourceHash: 'prepared' };
    });
    const state = { _id: 'submission-parallel', ocrJobId: 'ocr-job' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };

    await pipeline.generateAndPersist({ ...state, files: ['f1'], ocrStatus: 'completed',
      ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'x'.repeat(transcriptChars) }],
      writingCorrections: [], constructor: model }, { assignment: { title: 'Essay' } });

    expect(starts.semantic).toBeDefined();
    expect(starts.rubric).toBeDefined();
    expect(Math.abs(starts.semantic - starts.rubric)).toBeLessThan(100);
    expect(canonicalEvaluation.prepareRubricAssessment).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledTimes(1);
  });

  test('publishes the provisional score before a slow semantic correction request finishes', async () => {
    let releaseSemantic;
    const semanticGate = new Promise((resolve) => { releaseSemantic = resolve; });
    let semanticFinished = false;
    semantic.analyze.mockImplementationOnce(async () => {
      await semanticGate; semanticFinished = true;
      return { corrections: [], provider: 'openrouter', model: 'approved/model', metrics: { attemptCount: 1 } };
    });
    canonicalEvaluation.prepareRubricAssessment.mockResolvedValueOnce({ sourceHash: 'prepared' });
    const state = { _id: 'submission-score-first', ocrJobId: 'ocr-job' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };
    const running = pipeline.generateAndPersist({ ...state, files: ['f1'], ocrStatus: 'completed',
      ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'A long-running semantic essay.' }],
      writingCorrections: [], constructor: model }, { assignment: { title: 'Essay' } });
    await new Promise((resolve) => setImmediate(resolve));
    expect(canonicalEvaluation.persistProvisionalScore).toHaveBeenCalledTimes(1);
    expect(semanticFinished).toBe(false);
    releaseSemantic();
    await running;
  });

  test('semantic may finish first and finalization still waits for and reuses the one rubric result', async () => {
    let releaseRubric;
    const rubricGate = new Promise((resolve) => { releaseRubric = resolve; });
    let semanticFinished = false;
    semantic.analyze.mockImplementationOnce(async () => {
      semanticFinished = true;
      return { corrections: [], provider: 'openrouter', model: 'approved/model', metrics: { attemptCount: 1 } };
    });
    canonicalEvaluation.prepareRubricAssessment.mockImplementationOnce(async () => {
      await rubricGate;
      return { sourceHash: 'semantic-first-rubric' };
    });
    const state = { _id: 'submission-semantic-first', ocrJobId: 'ocr-job' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };
    const running = pipeline.generateAndPersist({ ...state, files: ['f1'], ocrStatus: 'completed',
      ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'Semantic completes before rubric.' }],
      writingCorrections: [], constructor: model }, { assignment: { title: 'Essay' } });

    await new Promise((resolve) => setImmediate(resolve));
    expect(semanticFinished).toBe(true);
    expect(canonicalEvaluation.generate).not.toHaveBeenCalled();
    releaseRubric();
    await running;
    expect(canonicalEvaluation.prepareRubricAssessment).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledWith(expect.objectContaining({
      preparedRubricRequired: true,
      preparedRubricAssessment: expect.objectContaining({ sourceHash: 'semantic-first-rubric' })
    }));
  });

  test('retains a successful prepared rubric when provisional persistence fails before 46 corrections finalize', async () => {
    const categoryPlan = [
      ['CONTENT', 'REL', 5], ['ORGANIZATION', 'COH', 4], ['VOCABULARY', 'WC', 4],
      ['GRAMMAR', 'T', 29], ['MECHANICS', 'SP', 4]
    ];
    const tokens = Array.from({ length: 46 }, (_, index) => `error${index}`);
    const transcript = tokens.join(' ');
    const prepared = { sourceHash: 'retained-rubric', semantic: { provider: 'openrouter', model: 'openai/gpt-4.1-mini' } };
    canonicalEvaluation.prepareRubricAssessment.mockResolvedValueOnce(prepared);
    canonicalEvaluation.persistProvisionalScore.mockRejectedValueOnce(new Error('temporary feedback write failure'));
    semantic.analyze.mockImplementationOnce(async (input) => {
      let cursor = 0;
      const corrections = categoryPlan.flatMap(([category, symbol, count]) => Array.from({ length: count }, () => {
        const quotedText = tokens[cursor++];
        return canonical.normalizeCorrection({ category, symbol, quotedText,
          suggestedText: `fixed-${quotedText}`, message: 'Concise correction.', confidence: 0.99,
          correctionKind: 'localized', severity: 'medium', occurrence: 0 },
        input.transcript, input.spans || [], input.legend, 'AI');
      })).filter(Boolean);
      return { corrections, provider: 'openrouter', model: 'approved/model', metrics: { attemptCount: 1 } };
    });
    canonicalEvaluation.generate.mockResolvedValueOnce({ status: 'completed', overallScore: 81,
      timings: { detailedFeedbackMs: 1 } });
    const state = { _id: 'submission-rubric-handoff', ocrJobId: 'ocr-job' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };

    await pipeline.generateAndPersist({ ...state, files: ['f1'], ocrStatus: 'completed',
      ocrPages: [{ fileId: 'f1', pageNumber: 1, text: transcript }],
      writingCorrections: [], constructor: model }, { assignment: { title: 'Essay' } });

    expect(canonicalEvaluation.prepareRubricAssessment).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.persistProvisionalScore).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledWith(expect.objectContaining({
      preparedRubricRequired: true, preparedRubricAssessment: prepared,
      submission: expect.objectContaining({ writingCorrections: expect.any(Array) })
    }));
    expect(canonicalEvaluation.generate.mock.calls[0][0].submission.writingCorrections).toHaveLength(46);
  });

  test('completed result with the same semantic source key is reused without a provider call', async () => {
    const assignment = { title: 'Essay' };
    const transcript = 'A complete essay.';
    const source = { files: ['f1'], ocrPages: [{ fileId: 'f1', pageNumber: 1, text: transcript }] };
    const pages = buildCanonicalSubmissionTranscript(source).pages;
    const correctionSourceHash = pipeline.buildCorrectionSourceHash({ transcript, pages, assignment });
    const model = { updateOne: jest.fn() };
    const result = await pipeline.generateAndPersist({ _id: 'submission-2', ocrJobId: 'ocr-job', files: ['f1'],
      ocrPages: source.ocrPages, correctionSourceHash,
      correctionVersion: canonical.VERSION, correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      correctionStatus: 'completed', semanticStatus: 'completed',
      semanticSourceKey: pipeline.buildSemanticSourceKey('semantic-key'), constructor: model }, { assignment });
    expect(result).toMatchObject({ reused: true, semanticSourceKey: pipeline.buildSemanticSourceKey('semantic-key') });
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
    const diagnostic = warn.mock.calls.find(([entry]) => entry?.message === 'AI-only correction analysis failure')?.[0];
    expect(diagnostic).toMatchObject({ attempt: 1, errorCode: 'SEMANTIC_RESPONSE_INVALID', credentialConfigured: true });
    const serialized = JSON.stringify(diagnostic);
    for (const secret of ['private transcript evidence', 'private prompt', 'must-not-be-logged-provider-output']) expect(serialized).not.toContain(secret);
    warn.mockRestore();
  });

  test('two-page semantic timeout degrades corrections but still runs transcript-based scoring', async () => {
    const timeout = Object.assign(new Error('semantic timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
    semantic.analyze.mockRejectedValueOnce(timeout);
    canonicalEvaluation.generate.mockResolvedValueOnce({ overallScore: 76 });
    const state = { _id: 'submission-degraded', ocrJobId: 'ocr-job', semanticStatus: undefined };
    const model = {
      updateOne: jest.fn(async (query, update) => {
        if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
        Object.assign(state, update.$set || {});
        return { modifiedCount: 1 };
      }),
      findById: jest.fn(async () => ({ ...state, constructor: model }))
    };
    const submission = { ...state, files: ['page-1', 'page-2'], ocrPages: [
      { fileId: 'page-1', pageNumber: 1, text: 'First page of the student essay.' },
      { fileId: 'page-2', pageNumber: 2, text: 'Second page concludes the essay.' }
    ], writingCorrections: [], constructor: model };

    const result = await pipeline.generateAndPersist(submission, { assignment: { title: 'Two-page essay' } });

    expect(result).toMatchObject({ semanticSucceeded: false, correctionsAvailable: false });
    expect(state).toMatchObject({ correctionStatus: 'partial', semanticStatus: 'failed' });
    expect(state.writingCorrections).toEqual([]);
    expect(canonicalEvaluation.generate).toHaveBeenCalledTimes(1);
    expect(canonicalEvaluation.generate).toHaveBeenCalledWith(expect.objectContaining({
      allowDegradedCorrections: true,
      prelockedJobId: expect.any(String),
      preparedRubricAssessment: expect.any(Object),
      submission: expect.objectContaining({ _id: 'submission-degraded', correctionStatus: 'partial', semanticStatus: 'failed' })
    }));
  });

  test('AI-only failure does not retain stale corrections', async () => {
    const assignment = { title: 'Essay' };
    const transcript = 'A complete essay.';
    const hash = pipeline.buildCorrectionSourceHash({ transcript, assignment });
    const state = { _id: 'submission-failed', ocrJobId: 'ocr-job', semanticStatus: 'failed' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };
    await pipeline.generateAndPersist({ ...state, files: ['f1'], ocrPages: [{ fileId: 'f1', pageNumber: 1, text: transcript }],
      correctionSourceHash: hash, correctionVersion: canonical.VERSION,
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      writingCorrections: [], constructor: model }, { assignment, force: true });
    expect(state).toMatchObject({ correctionStatus: 'completed', semanticStatus: 'completed' });
    expect(state.writingCorrections).toEqual([]);
    expect(state.correctionStatistics.grammar).toBe(0);
  });

  test('Source change triggers re-analysis in AI-only pipeline', async () => {
    const state = { _id: 'submission-changed', ocrJobId: 'ocr-job', semanticStatus: 'failed' };
    const model = { updateOne: jest.fn(async (query, update) => {
      if (query.correctionJobId && query.correctionJobId !== state.correctionJobId) return { modifiedCount: 0 };
      Object.assign(state, update.$set || {}); return { modifiedCount: 1 };
    }), findById: jest.fn(async () => ({ ...state, constructor: model })) };
    await pipeline.generateAndPersist({ ...state, files: ['f1'], ocrPages: [{ fileId: 'f1', pageNumber: 1,
      text: 'A changed essay.' }], correctionSourceHash: 'new-hash', correctionVersion: canonical.VERSION,
      correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
      writingCorrections: [], constructor: model },
    { assignment: { title: 'Essay' }, force: true });
    expect(state).toMatchObject({ correctionStatus: 'completed', semanticStatus: 'completed' });
    expect(state.correctionStatistics).toMatchObject({ grammar: 0, mechanics: 0 });
  });
});
