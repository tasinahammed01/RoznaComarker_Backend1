'use strict';

const service = require('../src/services/adaptivePracticeGenerationAI.service');

const env = {
  AI_PRIMARY_PROVIDER: 'google',
  AI_PRIMARY_MODEL: 'gemini-3.6-flash',
  AI_ATTEMPT_TIMEOUT_MS: '60000',
  AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0',
  AI_RETRY_DELAY_MS: '0',
  ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS: '4000',
  GEMINI_API_KEY: 'test-key',
  OPENROUTER_API_KEY: 'must-not-be-used',
  GEMINI_BASE_URL: 'https://gemini.test/v1beta'
};

function response(payload, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

describe('Adaptive Practice generation Gemini transport', () => {
  it('concatenates normal parts, excludes thoughts, and uses Google JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: '{"activities":' }, { thought: true, text: 'private' }, { text: '[]}' }
    ] } }] }));
    const result = await service.generate([], { env, fetchImpl });
    expect(result.content).toBe('{"activities":[]}');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toContain('gemini.test/v1beta/models/gemini-3.6-flash:generateContent');
    expect(url).not.toContain('openrouter');
    const generationConfig = JSON.parse(options.body).generationConfig;
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'minimal' });
  });

  it('uses a bounded 6000-token default when the feature limit is absent', () => {
    const withoutLimit = { ...env };
    delete withoutLimit.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS;
    expect(service.config(withoutLimit).maxOutputTokens).toBe(6000);
  });

  it.each([
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'blocked' }] } }] }],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"activities":[' }] } }] }]
  ])('exhausts the configured chain for unusable output', async (payload) => {
    await expect(service.generate([], { env, fetchImpl: async () => response(payload) }))
      .rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
  });

  it('surfaces 429 without an internal hot retry', async () => {
    const fetchImpl = jest.fn(async () => response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429));
    await expect(service.generate([], { env, fetchImpl })).rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
