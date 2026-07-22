'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const client = require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');

const config = { provider: 'google', model: 'gemini-3.6-flash', approvedModels: ['gemini-3.6-flash', 'openai/gpt-oss-20b'],
  attemptTimeoutMs: 45000, totalBudgetMs: 90000, maxRetries: 1, retryDelayMs: 0,
  minAttemptBudgetMs: 10000, maxOutputTokens: 2400, fallback: { provider: 'openrouter', model: 'openai/gpt-oss-20b' } };
const env = { GEMINI_API_KEY: 'gemini-secret', OPENROUTER_API_KEY: 'router-secret' };
const googleOk = (content) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
  candidates: [{ content: { parts: [{ text: content }] } }],
  usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
}) });
const googlePayload = (payload) => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(payload) });
const attempt = (payload) => client.providerAttempt({ messages: [{ role: 'user', content: 'private-prompt' }], provider: 'google',
  model: 'gemini-3.6-flash', maxOutputTokens: 2400, attemptTimeoutMs: 1000,
  fetchImpl: jest.fn(async () => googlePayload(payload)), env, now: Date.now });

describe('direct Google semantic provider', () => {
  test('resolves gemini-3.6-flash through Google with only GEMINI_API_KEY', async () => {
    const fetchImpl = jest.fn(async () => googleOk('{"transcriptHash":"hash","corrections":[]}'));
    const result = await client.runSemanticCompletion({ messages: [{ role: 'user', content: 'bounded prompt' }], config, env, fetchImpl });
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(options.headers).toMatchObject({ 'x-goog-api-key': 'gemini-secret', 'Content-Type': 'application/json' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(options)).not.toContain('router-secret');
    expect(result).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash', content: '{"transcriptHash":"hash","corrections":[]}' });
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
    expect(result).toMatchObject({ corrections: [], provider: 'google', model: 'gemini-3.6-flash' });
  });

  test('rejects invalid JSON and hash mismatches before returning corrections', async () => {
    expect(() => semantic.parseJson('not json', 'hash')).toThrow(expect.objectContaining({ code: 'SEMANTIC_RESPONSE_INVALID', validationStage: 'json_parse' }));
    expect(() => semantic.parseJson('{"corrections":[]}', 'hash')).toThrow(expect.objectContaining({ code: 'SEMANTIC_SOURCE_MISMATCH' }));
    expect(() => semantic.parseJson('{"transcriptHash":"stale","corrections":[]}', 'hash')).toThrow(expect.objectContaining({ code: 'SEMANTIC_SOURCE_MISMATCH', validationStage: 'source_hash' }));
    expect(() => semantic.parseJson('{"transcriptHash":"hash"}', 'hash')).toThrow(expect.objectContaining({ code: 'SEMANTIC_SCHEMA_INVALID', validationStage: 'schema_validation' }));
  });

  test('rejects incomplete and fabricated/non-verbatim evidence', () => {
    const legend = semantic.compactSemanticLegend();
    expect(() => semantic.validateCorrections([{ category: 'CONTENT', symbol: 'DEV', quotedText: 'real' }],
      { transcript: 'real essay', legend })).toThrow(expect.objectContaining({ code: 'SEMANTIC_SCHEMA_INVALID' }));
    expect(() => semantic.validateCorrections([{ category: 'CONTENT', symbol: 'DEV', quotedText: 'fabricated', occurrence: 0,
      message: 'Develop this.', suggestedText: 'Add evidence.', confidence: 0.9 }],
    { transcript: 'real essay', legend })).toThrow(expect.objectContaining({ code: 'SEMANTIC_EVIDENCE_UNGROUNDED' }));
  });

  test('joins genuine text parts and ignores thought and non-text parts', async () => {
    const result = await attempt({ candidates: [{ finishReason: 'STOP', content: { parts: [
      { text: '{"transcriptHash":"hash",' }, { thought: true, text: 'private reasoning' }, { inlineData: { mimeType: 'x' } },
      { text: '"corrections":[]}' }
    ] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 } });
    expect(result).toMatchObject({ content: '{"transcriptHash":"hash","corrections":[]}', candidateCount: 1,
      finishReason: 'STOP', responseTextLength: 42 });
    expect(result.content).not.toContain('private reasoning');
  });

  test.each([
    [{ candidates: [] }, 'GOOGLE_RESPONSE_EMPTY'],
    [{ candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }, 'GOOGLE_RESPONSE_EMPTY'],
    [{ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] }, 'GOOGLE_RESPONSE_BLOCKED'],
    [{ candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'hidden' }] } }] }, 'GOOGLE_RESPONSE_BLOCKED'],
    [{ candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [] } }] }, 'GOOGLE_OUTPUT_TRUNCATED']
  ])('normalizes unusable Google response %#', async (payload, code) => {
    await expect(attempt(payload)).rejects.toMatchObject({ code, validationStage: 'provider_response' });
  });

  test('MAX_TOKENS with incomplete JSON is normalized as truncation', async () => {
    const input = { transcript: 'Essay', transcriptHash: 'hash' };
    const runCompletion = jest.fn(async () => ({ content: '{"transcriptHash":"hash",', provider: 'google', model: 'gemini-3.6-flash',
      finishReason: 'MAX_TOKENS', candidateCount: 1, responseTextLength: 25, metrics: {} }));
    await expect(semantic.analyze(input, { config: { ...config, fallback: null }, env, runCompletion }))
      .rejects.toMatchObject({ code: 'GOOGLE_OUTPUT_TRUNCATED', validationStage: 'json_parse', finishReason: 'MAX_TOKENS' });
  });

  test.each([400, 401, 403, 404, 429, 500])('preserves safe Google HTTP metadata for %s', async (status) => {
    const fetchImpl = jest.fn(async () => ({ ok: false, status, headers: { get: (name) => name === 'retry-after' ? '2' : null },
      text: async () => JSON.stringify({ error: { code: status, status: 'SAFE_STATUS', message: 'private provider message' } }) }));
    await expect(client.providerAttempt({ messages: [], provider: 'google', model: 'gemini-3.6-flash', maxOutputTokens: 256,
      attemptTimeoutMs: 1000, fetchImpl, env, now: Date.now })).rejects.toMatchObject({ code: `HTTP_${status}`,
      httpStatus: status, googleErrorCode: status, googleErrorStatus: 'SAFE_STATUS', retryAfterMs: 2000 });
  });

  test('accepts only the pinned direct Google model and reports its credential without exposing it', () => {
    const valid = client.getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash', GEMINI_API_KEY: 'secret' });
    expect(client.getSemanticAIConfigStatus(valid, { GEMINI_API_KEY: 'secret' }))
      .toMatchObject({ configured: true, modelConfigured: true, credentialConfigured: true });
    expect(client.credentialFor('google', { GEMINI_API_KEY: 'secret', OPENROUTER_API_KEY: 'wrong' })).toBe('secret');
    for (const model of ['gemini-2.5-flash', 'google/gemini-3.6-flash']) {
      const invalid = client.getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: model, GEMINI_API_KEY: 'secret' });
      expect(client.getSemanticAIConfigStatus(invalid, { GEMINI_API_KEY: 'secret' }))
        .toMatchObject({ configured: false, modelConfigured: false, credentialConfigured: true });
    }
  });

  test('missing Google key fails before any HTTP request', async () => {
    const fetchImpl = jest.fn();
    await expect(client.runSemanticCompletion({ messages: [{ role: 'user', content: 'x' }], config, env: {}, fetchImpl }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('trims approved models and permits fallback only after a transient failure', async () => {
    const parsed = client.getSemanticAIConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash', GEMINI_API_KEY: 'g',
      SEMANTIC_AI_FALLBACK_PROVIDER: 'openrouter', SEMANTIC_AI_FALLBACK_MODEL: 'openai/gpt-oss-20b',
      SEMANTIC_AI_APPROVED_MODELS: ' gemini-3.6-flash , openai/gpt-oss-20b ' });
    expect(parsed.approvedModels).toEqual(['gemini-3.6-flash', 'openai/gpt-oss-20b']);
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
