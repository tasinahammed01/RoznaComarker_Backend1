'use strict';

const service = require('../src/services/adaptivePracticeGenerationAI.service');

const env = {
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter',
  ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter',
  ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '60000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '120000',
  ASSESSMENT_AI_PRIMARY_RETRIES: '0', ASSESSMENT_AI_FALLBACK_RETRIES: '0', ASSESSMENT_AI_RETRY_DELAY_MS: '0',
  ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS: '4000',
  OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: 'https://router.test/v1'
};

function response(payload, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

describe('Adaptive Practice generation assessment transport', () => {
  it('uses GPT-4.1 through OpenRouter JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '{"activities":[]}' } }] }));
    const result = await service.generate([], { env, fetchImpl });
    expect(result.content).toBe('{"activities":[]}');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://router.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('openai/gpt-4.1');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses a bounded 6000-token default when the feature limit is absent', () => {
    const withoutLimit = { ...env };
    delete withoutLimit.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS;
    expect(service.config(withoutLimit).maxOutputTokens).toBe(6000);
  });

  it.each([
    [{ choices: [] }],
    [{ choices: [{ finish_reason: 'length', message: { content: '{"activities":[' } }] }]
  ])('exhausts the configured chain for unusable output', async (payload) => {
    await expect(service.generate([], { env, fetchImpl: async () => response(payload) }))
      .rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
  });

  it('falls back after 429 without a same-model hot retry', async () => {
    const fetchImpl = jest.fn(async () => response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429));
    await expect(service.generate([], { env, fetchImpl })).rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body).model))
      .toEqual(['openai/gpt-4.1', 'openai/gpt-4.1-mini']);
  });
});
