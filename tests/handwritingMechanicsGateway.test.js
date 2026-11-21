'use strict';
// Gateway profile handwriting_mechanics_v1. Offline: every provider call is a fetch mock; no key, no network.
const gateway = require('../src/services/aiGateway.service');
const engine = require('../src/services/handwritingMechanics/profile');

const GEMINI = 'google/gemini-3.8-flash';
const env = { NODE_ENV: 'test', OPENROUTER_API_KEY: 'mock-only' };
const schema = { type: 'object', additionalProperties: false, required: ['marks'], properties: { marks: { type: 'array', items: { type: 'boolean' } } } };
const apiBody = (over = {}) => JSON.stringify({ model: GEMINI, provider: 'Google AI Studio',
  choices: [{ finish_reason: 'stop', message: { content: '{"marks":[]}' } }],
  usage: { prompt_tokens: 1400, completion_tokens: 60, total_tokens: 1460, cost: 0.0014 }, ...over });
const ok = (over) => ({ ok: true, status: 200, text: async () => apiBody(over) });
const attempt = (over = {}, fetchImpl = jest.fn(async () => ok())) => ({ fetchImpl, run: () => gateway.providerAttempt({
  entry: { provider: 'openrouter', model: GEMINI }, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 4000, attemptTimeoutMs: 20000,
  env, now: Date.now, requestProfile: engine.REQUEST_PROFILE, feature: 'handwriting_mechanics_check', fetchImpl,
  responseFormat: 'json', responseSchema: schema, schemaName: 'handwriting_mechanics', temperature: 0, ...over }) });

describe('gateway profile handwriting_mechanics_v1', () => {
  test('the profile constants are fixed in code', () => {
    expect(engine).toMatchObject({ REQUEST_PROFILE: 'handwriting_mechanics_v1', MODEL: GEMINI, SEED: 20261105, MAX_OUTPUT_TOKENS: 4000 });
  });

  test('one call: strict schema, temperature 0, fixed seed, reasoning low, Google AI Studio standard tier only, max_tokens 4000', async () => {
    const a = attempt();
    const result = await a.run();
    expect(a.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = a.fetchImpl.mock.calls[0], body = JSON.parse(request.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.redirect).toBe('error');
    expect(body).toMatchObject({ model: GEMINI, temperature: 0, seed: 20261105, reasoning: { effort: 'low' }, max_tokens: 4000 });
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false, only: ['google-ai-studio'],
      ignore: ['google-ai-studio/flex', 'google-ai-studio/priority'] });
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'handwriting_mechanics', strict: true, schema } });
    expect(result).toMatchObject({ content: '{"marks":[]}', returnedModel: GEMINI, usage: expect.objectContaining({ cost: 0.0014, prompt_tokens: 1400 }) });
  });

  test.each([
    ['another model', { entry: { provider: 'openrouter', model: 'qwen/qwen3.8-27b' } }],
    ['text output', { responseFormat: 'text' }],
    ['no schema', { responseSchema: undefined }],
    ['a temperature other than 0', { temperature: 0.4 }],
    ['no temperature', { temperature: undefined }],
    ['the Google direct endpoint', { entry: { provider: 'google', model: GEMINI } }]
  ])('the gateway refuses %s before any transport', async (_name, override) => {
    const a = attempt(override);
    await expect(a.run()).rejects.toMatchObject({ code: 'OCR_SOURCE_PROFILE_INVALID' });
    expect(a.fetchImpl).not.toHaveBeenCalled();
  });

  test('a reply from another model id is rejected', async () => {
    const a = attempt({}, jest.fn(async () => ok({ model: 'google/gemini-3.8-flash-20260902' })));
    await expect(a.run()).rejects.toMatchObject({ code: 'OCR_SOURCE_MODEL_IDENTITY' });
  });

  test('the check never takes a shared correction admission slot', async () => {
    const admission = require('../src/services/correctionAdmission.service').shared;
    const acquire = jest.spyOn(admission, 'acquire');
    try { await attempt().run(); expect(acquire).not.toHaveBeenCalled(); } finally { acquire.mockRestore(); }
  });

  test('the reader profile is unchanged (still pins its own seed and 16000 tokens)', async () => {
    const verbatim = require('../src/services/gptVisionExact/verbatimReader');
    const fetchImpl = jest.fn(async () => ok());
    await gateway.providerAttempt({ entry: { provider: 'openrouter', model: GEMINI }, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 16000,
      attemptTimeoutMs: 20000, env, now: Date.now, requestProfile: 'gpt_vision_exact_verbatim_v1', fetchImpl, responseFormat: 'json',
      responseSchema: schema, schemaName: 'verbatim_page_v2', temperature: 0 });
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body).toMatchObject({ seed: verbatim.SEED, max_tokens: 16000 });
  });
});
