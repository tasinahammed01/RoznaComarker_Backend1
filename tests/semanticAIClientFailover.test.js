'use strict';

const { getSemanticAIConfig, runSemanticCompletion } =
  require('../src/services/semanticAIClient.service');

const env = (overrides = {}) => ({
  AI_PRIMARY_PROVIDER: 'google', AI_PRIMARY_MODEL: 'semantic-primary',
  AI_FALLBACK_1_PROVIDER: 'openrouter', AI_FALLBACK_1_MODEL: 'semantic-fallback',
  AI_ATTEMPT_TIMEOUT_MS: '30000', AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0', AI_RETRY_DELAY_MS: '0',
  GEMINI_API_KEY: 'google-key', OPENROUTER_API_KEY: 'router-key',
  GEMINI_BASE_URL: 'https://google.test/v1', OPENROUTER_BASE_URL: 'https://router.test/v1',
  SEMANTIC_AI_MAX_OUTPUT_TOKENS: '1800', ...overrides
});
const response = (status, payload) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null }, text: async () => JSON.stringify(payload)
});
const google = (content) => response(200, {
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }]
});
const router = (content) => response(200, {
  choices: [{ finish_reason: 'stop', message: { content } }]
});

describe('semantic global-chain facade', () => {
  test('uses a bounded 8000-token semantic default', () => {
    const withoutFeatureLimit = env();
    delete withoutFeatureLimit.SEMANTIC_AI_MAX_OUTPUT_TOKENS;
    expect(getSemanticAIConfig(withoutFeatureLimit).maxOutputTokens).toBe(8000);
  });

  test('does not clamp an explicit 8000-token semantic limit', () => {
    expect(getSemanticAIConfig(env({ SEMANTIC_AI_MAX_OUTPUT_TOKENS: '8000' })).maxOutputTokens).toBe(8000);
  });

  test('accepts 12000 and safely falls back for invalid, negative, or excessive limits', () => {
    expect(getSemanticAIConfig(env({ SEMANTIC_AI_MAX_OUTPUT_TOKENS: '12000' })).maxOutputTokens).toBe(12000);
    for (const invalid of ['nope', '-1', '999999999']) {
      expect(getSemanticAIConfig(env({ SEMANTIC_AI_MAX_OUTPUT_TOKENS: invalid })).maxOutputTokens).toBe(8000);
    }
  });

  test('reads the global chain and semantic token limit only', () => {
    expect(getSemanticAIConfig(env())).toMatchObject({
      provider: 'google', model: 'semantic-primary', maxOutputTokens: 1800,
      chain: [
        { provider: 'google', model: 'semantic-primary', fallbackIndex: 0 },
        { provider: 'openrouter', model: 'semantic-fallback', fallbackIndex: 1 }
      ]
    });
  });

  test('primary success performs no fallback', async () => {
    const fetchImpl = jest.fn(async () => google('{"ok":true}'));
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl });
    expect(result.content).toBe('{"ok":true}');
    expect(result.provider).toBe('google');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('payment failure selects the configured fallback', async () => {
    const attempts = [];
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(402, {}))
      .mockResolvedValueOnce(router('{"ok":true}'));
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl,
      onAttempt: (attempt) => attempts.push(attempt) });
    expect(result).toMatchObject({ provider: 'openrouter', model: 'semantic-fallback' });
    expect(result.metrics.attempts).toHaveLength(2);
    expect(attempts).toHaveLength(2);
    expect(attempts.map((attempt) => attempt.provider)).toEqual(['google', 'openrouter']);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).not.toHaveProperty('thinkingConfig');
  });

  test('12000 reaches both Google and OpenRouter transports', async () => {
    const configuredEnv = env({ AI_PRIMARY_MODEL: 'gemini-3.6-flash',
      SEMANTIC_AI_MAX_OUTPUT_TOKENS: '12000' });
    const fetchImpl = jest.fn().mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(router('{"ok":true}'));
    await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(configuredEnv), env: configuredEnv, fetchImpl });
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).generationConfig.maxOutputTokens).toBe(12000);
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body).max_tokens).toBe(12000);
  });

  test('configured chain exhaustion preserves complete terminal metadata', async () => {
    const fetchImpl = jest.fn(async () => response(503, {}));
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl })).rejects.toMatchObject({
      code: 'AI_CHAIN_EXHAUSTED',
      attemptCount: 2,
      timeoutCount: 0,
      finalFailureCode: 'AI_PROVIDER_UNAVAILABLE',
      attempts: [
        expect.objectContaining({ provider: 'google', model: 'semantic-primary' }),
        expect.objectContaining({ provider: 'openrouter', model: 'semantic-fallback' })
      ]
    });
  });

  test('feature validation failure selects fallback', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(google('{"ok":false}'))
      .mockResolvedValueOnce(router('{"ok":true}'));
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'fixture' }],
      config: getSemanticAIConfig(env()), env: env(), fetchImpl,
      validate: (content) => {
        const parsed = JSON.parse(content);
        if (!parsed.ok) throw new Error('schema');
        return parsed;
      } });
    expect(result.value).toEqual({ ok: true });
    expect(result.model).toBe('semantic-fallback');
  });
});
