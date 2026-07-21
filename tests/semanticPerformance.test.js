'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const { getSemanticAIConfig, runSemanticCompletion } = require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');

const env = { OPENROUTER_API_KEY: 'test-key', OPENAI_API_KEY: 'test-openai-key', FRONTEND_URL: 'https://example.test' };
const ok = (content, usage = {}) => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ choices: [{ message: { content } }], usage }) });

describe('semantic performance contract', () => {
  test('semantic provider/model override the primary config only when explicitly configured', () => {
    expect(getSemanticAIConfig({ PRIMARY_AI_PROVIDER: 'openrouter', PRIMARY_AI_MODEL: 'large/model' }))
      .toMatchObject({ provider: 'openrouter', model: 'large/model' });
    expect(getSemanticAIConfig({ PRIMARY_AI_PROVIDER: 'openrouter', PRIMARY_AI_MODEL: 'large/model',
      SEMANTIC_AI_PROVIDER: 'openai', SEMANTIC_AI_MODEL: 'approved/fast' }))
      .toMatchObject({ provider: 'openai', model: 'approved/fast' });
  });

  test('compact prompt excludes OCR geometry, identity, verbose LanguageTool text, and non-semantic legend groups', () => {
    const input = { transcript: 'A compact sanitized essay.', transcriptHash: 'hash-1',
      assignment: { title: 'Essay', description: 'Explain a position.', student: { name: 'private' }, createdAt: 'ignored',
        rubric: { criteria: [{ category: 'Content', expectation: 'Evidence' }] } },
      pageManifest: [{ fileId: 'f1', pageNumber: 1, startChar: 0, endChar: 26, bbox: { x: 1 } }],
      languageToolCorrections: [{ symbol: 'AGR', startChar: 2, endChar: 8, quotedText: 'private quotation',
        message: 'verbose private provider message', bboxList: [{ x: 1 }] }] };
    const request = semantic.buildSemanticRequest(input);
    const serialized = JSON.stringify(request.messages);
    expect(serialized).not.toContain('bbox');
    expect(serialized).not.toContain('private quotation');
    expect(serialized).not.toContain('verbose private provider message');
    expect(serialized).not.toContain('"student"');
    expect(serialized).not.toContain('"GRAMMAR"');
    expect(serialized).not.toContain('"MECHANICS"');
    expect(request.legend.map((group) => group.category)).toEqual(['CONTENT', 'ORGANIZATION', 'VOCABULARY']);
    expect(request.exclusions).toEqual([{ symbol: 'AGR', startChar: 2, endChar: 8 }]);
  });

  test('transcript hash is mandatory in both request and response', () => {
    expect(() => semantic.buildSemanticRequest({ transcript: 'Essay' })).toThrow('transcript hash');
    expect(() => semantic.parseJson('{"transcriptHash":"wrong","corrections":[]}', 'right')).toThrow('complete transcript hash');
    expect(semantic.parseJson('{"transcriptHash":"right","corrections":[]}', 'right')).toEqual([]);
  });

  test('one transient timeout uses a fresh signal and stays in one bounded retry layer', async () => {
    const signals = [];
    const fetchImpl = jest.fn(async (_url, options) => {
      signals.push(options.signal);
      if (signals.length === 1) { const error = new Error('timeout'); error.name = 'TimeoutError'; throw error; }
      return ok('{"transcriptHash":"h","corrections":[]}', { prompt_tokens: 100, completion_tokens: 20 });
    });
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }], env, fetchImpl,
      sleepFn: async () => {}, config: { provider: 'openrouter', model: 'approved/model', attemptTimeoutMs: 45000,
        totalBudgetMs: 90000, maxRetries: 1, retryDelayMs: 2000, minAttemptBudgetMs: 10000,
        maxOutputTokens: 2400, fallback: null } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[0]).not.toBe(signals[1]);
    expect(result.metrics).toMatchObject({ attemptCount: 2, timeoutCount: 1, retryDelayMs: 2000, outputTokenCount: 20 });
  });

  test('does not start a retry that cannot fit the remaining total budget', async () => {
    const response = { ok: false, status: 429, headers: { get: () => '30' }, text: async () => '' };
    const fetchImpl = jest.fn(async () => response);
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }], env, fetchImpl,
      sleepFn: async () => {}, config: { provider: 'openrouter', model: 'approved/model', attemptTimeoutMs: 45000,
        totalBudgetMs: 15000, maxRetries: 1, retryDelayMs: 2000, minAttemptBudgetMs: 10000,
        maxOutputTokens: 2400, fallback: null } })).rejects.toMatchObject({ code: 'SEMANTIC_BUDGET_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('permanent authentication and invalid-request failures never retry', async () => {
    for (const status of [400, 401]) {
      const fetchImpl = jest.fn(async () => ({ ok: false, status, headers: { get: () => null }, text: async () => '' }));
      await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }], env, fetchImpl,
        config: { provider: 'openrouter', model: 'approved/model', attemptTimeoutMs: 45000, totalBudgetMs: 90000,
          maxRetries: 1, retryDelayMs: 0, minAttemptBudgetMs: 10000, maxOutputTokens: 2400, fallback: null } })).rejects.toThrow(String(status));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  test('fallback is available only when explicitly approved and uses identical request validation', async () => {
    const approved = getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'openrouter', SEMANTIC_AI_MODEL: 'primary/model',
      SEMANTIC_AI_FALLBACK_PROVIDER: 'openai', SEMANTIC_AI_FALLBACK_MODEL: 'fast/model',
      SEMANTIC_AI_APPROVED_MODELS: 'fast/model' });
    const unapproved = getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'openrouter', SEMANTIC_AI_MODEL: 'primary/model',
      SEMANTIC_AI_FALLBACK_PROVIDER: 'openai', SEMANTIC_AI_FALLBACK_MODEL: 'unknown/model',
      SEMANTIC_AI_APPROVED_MODELS: 'fast/model' });
    expect(approved.fallback).toEqual({ provider: 'openai', model: 'fast/model' });
    expect(unapproved.fallback).toBeNull();
    const models = [];
    const fetchImpl = jest.fn(async (_url, options) => {
      models.push(JSON.parse(options.body).model);
      if (models.length === 1) return { ok: false, status: 503, headers: { get: () => null }, text: async () => '' };
      return ok('{"transcriptHash":"h","corrections":[]}');
    });
    await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }], env, fetchImpl, sleepFn: async () => {},
      config: { ...approved, retryDelayMs: 0 } });
    expect(models).toEqual(['primary/model', 'fast/model']);
  });

  test('semantic reuse key changes with the configured model', () => {
    const base = { correctionSourceHash: 'source', legendVersion: '1.0' };
    expect(semantic.semanticSourceKey({ ...base, config: { provider: 'openrouter', model: 'large', fallback: null } }))
      .not.toBe(semantic.semanticSourceKey({ ...base, config: { provider: 'openrouter', model: 'fast', fallback: null } }));
  });
});
