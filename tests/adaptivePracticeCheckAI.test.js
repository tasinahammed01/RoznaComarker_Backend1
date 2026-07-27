'use strict';

const service = require('../src/services/adaptivePracticeCheckAI.service');

const env = {
  ADAPTIVE_PRACTICE_AI_PROVIDER: 'google',
  ADAPTIVE_PRACTICE_AI_MODEL: 'gemini-3.6-flash',
  ADAPTIVE_PRACTICE_AI_TIMEOUT_MS: '60000',
  ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS: '3000',
  GEMINI_API_KEY: 'gemini-test-key',
  PRIMARY_AI_PROVIDER: 'openrouter',
  PRIMARY_AI_MODEL: 'openai/gpt-oss-120b',
  OPENROUTER_API_KEY: 'must-not-be-used',
  GEMINI_BASE_URL: 'https://gemini.test/v1beta'
};

function response(payload, status = 200, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'retry-after' ? retryAfter : 'application/json' },
    text: async () => JSON.stringify(payload)
  };
}

describe('adaptive practice dedicated Gemini checker', () => {
  it('ignores PRIMARY_AI settings and calls only Google Gemini in JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response({
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { text: '{"score":' }, { thought: true, text: 'private reasoning' }, { text: '1}' }
      ] } }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 }
    }));
    await expect(service.generateCheckCompletion([{ role: 'user', content: 'test' }], { env, fetchImpl }))
      .resolves.toBe('{"score":1}');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://gemini.test/v1beta/models/gemini-3.6-flash:generateContent');
    expect(options.headers).toMatchObject({ 'x-goog-api-key': 'gemini-test-key' });
    expect(JSON.parse(options.body).generationConfig).toMatchObject({ maxOutputTokens: 3000, responseMimeType: 'application/json' });
  });

  it.each([
    [{}, 'ADAPTIVE_CHECK_AI_RESPONSE_EMPTY', 502],
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'blocked' }] } }] }, 'ADAPTIVE_CHECK_AI_SAFETY_BLOCKED', 502]
  ])('maps unusable Gemini responses', async (payload, code, status) => {
    await expect(service.generateCheckCompletion([], { env: { ...env, ADAPTIVE_PRACTICE_AI_MAX_RETRIES: '0' }, fetchImpl: async () => response(payload) }))
      .rejects.toMatchObject({ code, status });
  });

  it('respects Retry-After with a bounded retry', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429, '2'))
      .mockResolvedValueOnce(response({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '{}' }] } }] }));
    const sleepFn = jest.fn(async () => {});
    await expect(service.generateCheckCompletion([], { env, fetchImpl, sleepFn })).resolves.toBe('{}');
    expect(sleepFn).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, placeholder, wrong-provider, and unsupported-model configuration', async () => {
    for (const overrides of [
      { GEMINI_API_KEY: '' },
      { GEMINI_API_KEY: '<backend-only key>' },
      { ADAPTIVE_PRACTICE_AI_PROVIDER: 'openrouter' },
      { ADAPTIVE_PRACTICE_AI_MODEL: 'openai/gpt-oss-120b' }
    ]) {
      await expect(service.generateCheckCompletion([], { env: { ...env, ...overrides }, fetchImpl: jest.fn() }))
        .rejects.toMatchObject({ code: 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', status: 503 });
    }
  });
});
