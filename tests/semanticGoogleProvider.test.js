'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const client = require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');

const config = { provider: 'google', model: 'gemini-2.5-flash', approvedModels: ['gemini-2.5-flash', 'openai/gpt-oss-20b'],
  attemptTimeoutMs: 45000, totalBudgetMs: 90000, maxRetries: 1, retryDelayMs: 0,
  minAttemptBudgetMs: 10000, maxOutputTokens: 2400, fallback: { provider: 'openrouter', model: 'openai/gpt-oss-20b' } };
const env = { GEMINI_API_KEY: 'gemini-secret', OPENROUTER_API_KEY: 'router-secret' };
const googleOk = (content) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
  candidates: [{ content: { parts: [{ text: content }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
}) });

describe('direct Google semantic provider', () => {
  test('resolves gemini-2.5-flash through Google with only GEMINI_API_KEY', async () => {
    const fetchImpl = jest.fn(async () => googleOk('{"transcriptHash":"hash","corrections":[]}'));
    const result = await client.runSemanticCompletion({ messages: [{ role: 'user', content: 'bounded prompt' }], config, env, fetchImpl });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(options.headers).toMatchObject({ 'x-goog-api-key': 'gemini-secret', 'Content-Type': 'application/json' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(options)).not.toContain('router-secret');
    expect(result).toMatchObject({ provider: 'google', model: 'gemini-2.5-flash', content: '{"transcriptHash":"hash","corrections":[]}' });
  });

  test('uses the unchanged bounded semantic prompt and validates a structured response', async () => {
    const input = { transcript: 'Students need clear evidence.', transcriptHash: 'hash', assignment: { title: 'Essay' }, pageManifest: [] };
    const request = semantic.buildSemanticRequest(input);
    const fetchImpl = jest.fn(async (_url, options) => {
      const body = JSON.parse(options.body);
      expect(body.contents[0].parts[0].text).toBe(request.messages[1].content);
      expect(body.generationConfig).toMatchObject({ responseMimeType: 'application/json', maxOutputTokens: 2400 });
      return googleOk('{"transcriptHash":"hash","corrections":[]}');
    });
    const result = await semantic.analyze(input, { config: { ...config, maxRetries: 0, fallback: null }, env, fetchImpl });
    expect(result).toMatchObject({ corrections: [], provider: 'google', model: 'gemini-2.5-flash' });
  });

  test('rejects invalid JSON and hash mismatches before returning corrections', async () => {
    expect(() => semantic.parseJson('not json', 'hash')).toThrow();
    expect(() => semantic.parseJson('{"transcriptHash":"stale","corrections":[]}', 'hash')).toThrow('complete transcript hash');
  });

  test('rejects incomplete and fabricated/non-verbatim evidence', () => {
    const legend = semantic.compactSemanticLegend();
    expect(() => semantic.validateCorrections([{ category: 'CONTENT', symbol: 'DEV', quotedText: 'real' }],
      { transcript: 'real essay', legend })).toThrow('incomplete correction');
    expect(() => semantic.validateCorrections([{ category: 'CONTENT', symbol: 'DEV', quotedText: 'fabricated', occurrence: 0,
      message: 'Develop this.', suggestedText: 'Add evidence.', confidence: 0.9 }],
    { transcript: 'real essay', legend })).toThrow('non-verbatim evidence');
  });

  test('rejects unsupported Google model configuration instead of switching models', () => {
    const invalid = client.getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'google/gemini-2.5-flash',
      SEMANTIC_AI_APPROVED_MODELS: ' google/gemini-2.5-flash ', GEMINI_API_KEY: 'secret' });
    expect(client.getSemanticAIConfigStatus(invalid, { GEMINI_API_KEY: 'secret' })).toMatchObject({ configured: false, modelConfigured: false });
  });

  test('trims approved models and permits fallback only after a transient failure', async () => {
    const parsed = client.getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-2.5-flash', GEMINI_API_KEY: 'g',
      SEMANTIC_AI_FALLBACK_PROVIDER: 'openrouter', SEMANTIC_AI_FALLBACK_MODEL: 'openai/gpt-oss-20b',
      SEMANTIC_AI_APPROVED_MODELS: ' gemini-2.5-flash , openai/gpt-oss-20b ' });
    expect(parsed.approvedModels).toEqual(['gemini-2.5-flash', 'openai/gpt-oss-20b']);
    const fetchImpl = jest.fn(async (url) => url.includes('googleapis.com')
      ? { ok: false, status: 503, headers: { get: () => null }, text: async () => '' }
      : ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: '{}' } }] }) }));
    const result = await client.runSemanticCompletion({ messages: [{ role: 'user', content: 'x' }], config: { ...parsed, retryDelayMs: 0 },
      env: { GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'o' }, fetchImpl, sleepFn: async () => {} });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-oss-20b' });
  });

  test.each([401, 402])('terminal HTTP %s never retries or invokes fallback', async (status) => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status, headers: { get: () => null }, text: async () => '' }));
    await expect(client.runSemanticCompletion({ messages: [{ role: 'user', content: 'x' }], config, env, fetchImpl })).rejects.toMatchObject({ code: `HTTP_${status}` });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('quota is bounded and cannot create an automatic retry loop', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status: 429, headers: { get: () => null }, text: async () => '' }));
    await expect(client.runSemanticCompletion({ messages: [{ role: 'user', content: 'x' }], config, env, fetchImpl,
      sleepFn: async () => {} })).rejects.toMatchObject({ code: 'HTTP_429' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
