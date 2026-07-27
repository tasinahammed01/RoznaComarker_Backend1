'use strict';

const service = require('../src/services/adaptivePracticeGenerationAI.service');

const env = {
  ADAPTIVE_PRACTICE_AI_PROVIDER: 'google',
  ADAPTIVE_PRACTICE_AI_MODEL: 'gemini-3.6-flash',
  ADAPTIVE_PRACTICE_AI_TIMEOUT_MS: '60000',
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
    expect(JSON.parse(options.body).generationConfig.responseMimeType).toBe('application/json');
  });

  it.each([
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'blocked' }] } }] }, 'GOOGLE_RESPONSE_BLOCKED'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"activities":[' }] } }] }, 'GOOGLE_OUTPUT_TRUNCATED']
  ])('classifies non-repairable Gemini output', async (payload, code) => {
    await expect(service.generate([], { env, fetchImpl: async () => response(payload) })).rejects.toMatchObject({ code });
  });

  it('surfaces 429 without an internal hot retry', async () => {
    const fetchImpl = jest.fn(async () => response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429));
    await expect(service.generate([], { env, fetchImpl })).rejects.toMatchObject({ status: 429 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
