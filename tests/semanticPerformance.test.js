'use strict';

const { getSemanticAIConfig, runSemanticCompletion } =
  require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');

const env = (overrides = {}) => ({
  AI_PRIMARY_PROVIDER: 'openrouter', AI_PRIMARY_MODEL: 'global-semantic-model',
  AI_ATTEMPT_TIMEOUT_MS: '45000', AI_TOTAL_BUDGET_MS: '90000',
  AI_RETRIES_PER_MODEL: '1', AI_RETRY_DELAY_MS: '0',
  OPENROUTER_API_KEY: 'router-key', OPENROUTER_BASE_URL: 'https://router.test/v1',
  SEMANTIC_AI_MAX_OUTPUT_TOKENS: '1800', ...overrides
});
const response = (status, content = '{"ok":true}') => ({
  ok: status >= 200 && status < 300, status, headers: { get: () => null },
  text: async () => status < 300
    ? JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] })
    : '{}'
});

describe('semantic performance contract', () => {
  test('uses global selection while retaining semantic output size', () => {
    expect(getSemanticAIConfig(env({
      SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'ignored'
    }))).toMatchObject({
      provider: 'openrouter', model: 'global-semantic-model',
      attemptTimeoutMs: 45000, totalBudgetMs: 90000, maxOutputTokens: 1800
    });
  });

  test('one timeout stays in the single gateway retry layer and uses a fresh signal', async () => {
    const signals = [];
    const fetchImpl = jest.fn(async (_url, options) => {
      signals.push(options.signal);
      if (signals.length === 1) throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
      return response(200);
    });
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl });
    expect(result.content).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test('permanent authentication failure is not retried on the same model', async () => {
    const fetchImpl = jest.fn(async () => response(401));
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl }))
      .rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('compact prompt remains smaller than the legacy benchmark prompt', () => {
    const input = { transcript: 'Evidence based writing '.repeat(100), transcriptHash: 'hash',
      assignment: { title: 'Synthetic assignment' }, pageManifest: [],
      languageToolCorrections: [] };
    expect(semantic.buildSemanticRequest(input).promptCharacters)
      .toBeLessThan(semantic.buildLegacySemanticRequestForBenchmark(input).promptCharacters);
  });
});
