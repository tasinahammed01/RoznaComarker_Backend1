'use strict';

const service = require('../src/services/adaptivePracticeCheckAI.service');

const env = {
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter', ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '60000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '120000',
  ASSESSMENT_AI_PRIMARY_RETRIES: '1', ASSESSMENT_AI_FALLBACK_RETRIES: '0', ASSESSMENT_AI_RETRY_DELAY_MS: '0',
  ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS: '3000',
  OPENROUTER_API_KEY: 'router-test-key', OPENROUTER_BASE_URL: 'https://router.test/v1'
};

function response(payload, status = 200, retryAfter = null) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => name.toLowerCase() === 'retry-after' ? retryAfter : 'application/json' },
    text: async () => JSON.stringify(payload)
  };
}

describe('adaptive practice assessment-chain checker', () => {
  it('uses GPT-4.1 and JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response({
      choices: [{ finish_reason: 'stop', message: { content: '{"score":1}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 3 }
    }));
    await expect(service.generateCheckCompletion([{ role: 'user', content: 'test' }], { env, fetchImpl }))
      .resolves.toBe('{"score":1}');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://router.test/v1/chat/completions');
    expect(options.headers).toMatchObject({ Authorization: 'Bearer router-test-key' });
    expect(JSON.parse(options.body)).toMatchObject({ model: 'openai/gpt-4.1', max_tokens: 3000,
      response_format: { type: 'json_object' } });
  });

  it.each([
    [{}, 'ADAPTIVE_CHECK_AI_RESPONSE_EMPTY', 502],
    [{ choices: [{ finish_reason: 'content_filter', message: { content: '' } }] }, 'ADAPTIVE_CHECK_AI_RESPONSE_EMPTY', 502]
  ])('maps unusable OpenRouter responses', async (payload, code, status) => {
    await expect(service.generateCheckCompletion([], { env: { ...env, ADAPTIVE_PRACTICE_AI_MAX_RETRIES: '0' }, fetchImpl: async () => response(payload) }))
      .rejects.toMatchObject({ code, status });
  });

  it('respects Retry-After with a bounded retry', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429, '2'))
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] }));
    const sleepFn = jest.fn(async () => {});
    await expect(service.generateCheckCompletion([], { env, fetchImpl, sleepFn })).resolves.toBe('{}');
    expect(sleepFn).toHaveBeenCalledWith(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('rejects missing, placeholder, wrong-provider, and unsupported-model configuration', async () => {
    for (const overrides of [
      { OPENROUTER_API_KEY: '' },
      { ASSESSMENT_AI_PRIMARY_PROVIDER: 'unsupported' },
      { ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'google' }
    ]) {
      await expect(service.generateCheckCompletion([], { env: { ...env, ...overrides }, fetchImpl: jest.fn() }))
        .rejects.toMatchObject({ code: 'ADAPTIVE_CHECK_AI_NOT_CONFIGURED', status: 503 });
    }
  });
});
