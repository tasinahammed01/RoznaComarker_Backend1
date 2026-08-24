'use strict';

const { getSemanticAIConfig, runSemanticCompletion } =
  require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');

const env = (overrides = {}) => ({
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: '', ASSESSMENT_AI_FALLBACK_1_MODEL: '',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '45000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '90000',
  ASSESSMENT_AI_PRIMARY_RETRIES: '1', ASSESSMENT_AI_FALLBACK_RETRIES: '0', ASSESSMENT_AI_RETRY_DELAY_MS: '0',
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
  test('uses assessment selection while retaining semantic output size', () => {
    expect(getSemanticAIConfig(env({
      SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'ignored'
    }))).toMatchObject({
      provider: 'openrouter', model: 'openai/gpt-4.1',
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

  test('permanent authentication failure is terminal across the assessment chain', async () => {
    const fetchImpl = jest.fn(async () => response(401));
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_AUTH_ERROR', attemptCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body).model))
      .toEqual(['openai/gpt-4.1']);
  });

  test('audited category-review prompt keeps bounded overhead over the incomplete legacy contract', () => {
    const input = { transcript: 'Evidence based writing '.repeat(100), transcriptHash: 'hash',
      assignment: { title: 'Synthetic assignment' }, pageManifest: [],
      languageToolCorrections: [] };
    const audited = semantic.buildSemanticRequest(input).promptCharacters;
    const legacy = semantic.buildLegacySemanticRequestForBenchmark(input).promptCharacters;
    // The strict contract now proves all five categories were reviewed and includes
    // both correction kinds and the learner-English taxonomy/examples; that
    // required evidence did not exist in the legacy prompt.
    // AI-only pipeline adds GRAMMAR and MECHANICS categories, increasing overhead
    expect(audited - legacy).toBeLessThanOrEqual(7500);
    // The complete 28-symbol legend now includes authoritative descriptions and
    // deductions; keep the serialized request below a conservative 15k chars.
    expect(audited).toBeLessThan(15000);
  });
});
