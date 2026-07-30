'use strict';

const client = require('../src/services/semanticAIClient.service');

const env = (overrides = {}) => ({
  AI_PRIMARY_PROVIDER: 'google', AI_PRIMARY_MODEL: 'any-google-model',
  AI_ATTEMPT_TIMEOUT_MS: '30000', AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0', AI_RETRY_DELAY_MS: '0',
  GEMINI_API_KEY: 'google-key', GEMINI_BASE_URL: 'https://google.test/v1',
  SEMANTIC_AI_MAX_OUTPUT_TOKENS: '1800', ...overrides
});
const response = (status, payload, retryAfter = null) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (name) => name.toLowerCase() === 'retry-after' ? retryAfter : null },
  text: async () => JSON.stringify(payload)
});

describe('Google adapter through the global semantic facade', () => {
  test('uses any globally configured Google model and JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response(200, {
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { text: '{"ok":' }, { thought: true, text: 'private reasoning' }, { text: 'true}' }
      ] } }]
    }));
    const result = await client.runSemanticCompletion({
      messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'fixture' }],
      config: client.getSemanticAIConfig(env()), env: env(), fetchImpl
    });
    expect(result.content).toBe('{"ok":true}');
    expect(fetchImpl.mock.calls[0][0]).toBe(
      'https://google.test/v1/models/any-google-model:generateContent');
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.generationConfig).toMatchObject({
      maxOutputTokens: 1800, responseMimeType: 'application/json'
    });
    expect(result.content).not.toContain('private reasoning');
  });

  test.each([
    [{}, 'AI_RESPONSE_EMPTY'],
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [] } }] }, 'AI_RESPONSE_BLOCKED'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }, 'AI_RESPONSE_TRUNCATED'],
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }, 'AI_RESPONSE_EMPTY']
  ])('normalizes unusable Google output', async (payload, code) => {
    await expect(client.providerAttempt({ messages: [], provider: 'google',
      model: 'any-google-model', maxOutputTokens: 256, attemptTimeoutMs: 1000,
      fetchImpl: async () => response(200, payload), env: env(), now: Date.now }))
      .rejects.toMatchObject({ code });
  });

  test('preserves safe MAX_TOKENS usage and thinking metadata', async () => {
    const payload = {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [
        { thought: true, text: 'private reasoning' }, { text: '{"partial":true' }
      ] } }],
      usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 7000,
        thoughtsTokenCount: 900, totalTokenCount: 8200 }
    };
    await expect(client.providerAttempt({ messages: [], provider: 'google',
      model: 'any-google-model', maxOutputTokens: 8000, attemptTimeoutMs: 1000,
      fetchImpl: async () => response(200, payload), env: env(), now: Date.now }))
      .rejects.toMatchObject({
        code: 'AI_RESPONSE_TRUNCATED', finishReason: 'MAX_TOKENS',
        promptTokenCount: 1200, candidatesTokenCount: 7000, thoughtsTokenCount: 900,
        totalTokenCount: 8200, maxOutputTokens: 8000, responseTextLength: 15, candidateCount: 1
      });
  });

  test.each([
    [401, 'AI_PROVIDER_AUTH_ERROR'], [402, 'AI_PROVIDER_PAYMENT_REQUIRED'],
    [429, 'AI_PROVIDER_RATE_LIMIT'], [500, 'AI_PROVIDER_UNAVAILABLE']
  ])('normalizes HTTP %i without exposing provider response text', async (status, code) => {
    await expect(client.providerAttempt({ messages: [], provider: 'google',
      model: 'any-google-model', maxOutputTokens: 256, attemptTimeoutMs: 1000,
      fetchImpl: async () => response(status, { error: { message: 'private body' } }, '2'),
      env: env(), now: Date.now })).rejects.toMatchObject({ code, status, retryAfterMs: 2000 });
  });

  test('does not hard-code a Google model allowlist', () => {
    expect(client.getSemanticAIConfig(env({ AI_PRIMARY_MODEL: 'new-google-model' })))
      .toMatchObject({ provider: 'google', model: 'new-google-model' });
  });

  test('missing credentials fail deterministically before transport', () => {
    expect(() => client.getSemanticAIConfig(env({ GEMINI_API_KEY: '' })))
      .toThrow(expect.objectContaining({ code: 'AI_CHAIN_NOT_CONFIGURED' }));
  });
});
