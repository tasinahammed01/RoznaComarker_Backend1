'use strict';

const gateway = require('../src/services/aiGateway.service');

const env = (overrides = {}) => ({
  AI_PRIMARY_PROVIDER: 'google',
  AI_PRIMARY_MODEL: 'primary-model',
  AI_FALLBACK_1_PROVIDER: 'openrouter',
  AI_FALLBACK_1_MODEL: 'fallback-one',
  AI_FALLBACK_2_PROVIDER: 'openrouter',
  AI_FALLBACK_2_MODEL: 'fallback-two',
  AI_FALLBACK_3_PROVIDER: 'openrouter',
  AI_FALLBACK_3_MODEL: 'fallback-three',
  AI_ATTEMPT_TIMEOUT_MS: '30000',
  AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0',
  AI_RETRY_DELAY_MS: '0',
  GEMINI_API_KEY: 'google-secret',
  OPENROUTER_API_KEY: 'router-secret',
  ...overrides
});

const response = (status, payload, headers = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (name) => headers[name.toLowerCase()] || null },
  text: async () => JSON.stringify(payload)
});
const google = (content) => response(200, {
  candidates: [{ finishReason: 'STOP', content: { parts: [{ text: content }] } }],
  usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2, totalTokenCount: 3 }
});
const router = (content) => response(200, {
  choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 }
});

describe('global AI gateway', () => {
  test('constructs the exact configured chain order', () => {
    expect(gateway.getAIConfig(env()).chain).toEqual([
      { provider: 'google', model: 'primary-model', fallbackIndex: 0 },
      { provider: 'openrouter', model: 'fallback-one', fallbackIndex: 1 },
      { provider: 'openrouter', model: 'fallback-two', fallbackIndex: 2 },
      { provider: 'openrouter', model: 'fallback-three', fallbackIndex: 3 }
    ]);
  });

  test('keeps the required Gemini-first production chain order', () => {
    const config = gateway.getAIConfig(env({
      AI_PRIMARY_MODEL: 'gemini-3.6-flash',
      AI_FALLBACK_1_MODEL: 'nvidia/nemotron-3-ultra-550b-a55b:free',
      AI_FALLBACK_2_MODEL: 'nvidia/nemotron-3-super-120b-a12b:free',
      AI_FALLBACK_3_MODEL: 'openai/gpt-oss-20b:free'
    }));
    expect(config.chain).toEqual([
      { provider: 'google', model: 'gemini-3.6-flash', fallbackIndex: 0 },
      { provider: 'openrouter', model: 'nvidia/nemotron-3-ultra-550b-a55b:free', fallbackIndex: 1 },
      { provider: 'openrouter', model: 'nvidia/nemotron-3-super-120b-a12b:free', fallbackIndex: 2 },
      { provider: 'openrouter', model: 'openai/gpt-oss-20b:free', fallbackIndex: 3 }
    ]);
  });

  test('rejects partial fallback and unsupported providers', () => {
    expect(() => gateway.getAIConfig(env({ AI_FALLBACK_1_MODEL: '' }))).toThrow(/invalid/i);
    expect(() => gateway.getAIConfig(env({ AI_PRIMARY_PROVIDER: 'openai' }))).toThrow(/invalid/i);
  });

  test('primary success prevents fallback', async () => {
    const fetchImpl = jest.fn(async () => google('ok'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env(), fetchImpl });
    expect(result.content).toBe('ok');
    expect(result.fallbackUsed).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([402, 408, 429, 500, 502, 503, 504])('HTTP %i selects fallback', async (status) => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(status, {}))
      .mockResolvedValueOnce(router('fallback'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env(), fetchImpl });
    expect(result.content).toBe('fallback');
    expect(result.model).toBe('fallback-one');
    expect(result.fallbackUsed).toBe(true);
  });

  test('invalid JSON and feature validation failure select fallback', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(google('not json'))
      .mockResolvedValueOnce(router('{"valid":true}'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      responseFormat: 'json', validate: (content) => {
        const parsed = JSON.parse(content);
        if (!parsed.valid) throw new Error('schema');
        return parsed;
      }, env: env(), fetchImpl });
    expect(result.value).toEqual({ valid: true });
    expect(result.attempts[0].code).toBe('AI_OUTPUT_VALIDATION_FAILED');
  });

  test('truncated Gemini output is discarded and selects fallback', async () => {
    const truncated = response(200, {
      candidates: [{ finishReason: 'MAX_TOKENS', content: { parts: [{ text: '{"partial":' }] } }],
      usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 8000,
        thoughtsTokenCount: 500, totalTokenCount: 9000 }
    });
    const fetchImpl = jest.fn().mockResolvedValueOnce(truncated).mockResolvedValueOnce(router('{"valid":true}'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      responseFormat: 'json', validate: (content) => JSON.parse(content), env: env(), fetchImpl });
    expect(result.value).toEqual({ valid: true });
    expect(result.attempts[0]).toMatchObject({ provider: 'google', code: 'AI_RESPONSE_TRUNCATED',
      finishReason: 'MAX_TOKENS', promptTokenCount: 1000, candidatesTokenCount: 8000,
      thoughtsTokenCount: 500, totalTokenCount: 9000 });
  });

  test('passes an 8000-token limit to Google and OpenRouter unchanged', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(router('ok'));
    await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      maxOutputTokens: 8000, env: env(), fetchImpl });
    const googleBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    const routerBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(googleBody.generationConfig.maxOutputTokens).toBe(8000);
    expect(routerBody.max_tokens).toBe(8000);
  });

  test('walks through all fallbacks and reports the actual successful model', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(500, {}))
      .mockResolvedValueOnce(response(502, {}))
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(router('last'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env(), fetchImpl });
    expect(result.model).toBe('fallback-three');
    expect(result.attemptCount).toBe(4);
    expect(result.fallbackIndex).toBe(3);
  });

  test('allocates a meaningful bounded window to every fallback under the 200s policy', async () => {
    const allocated = [];
    await expect(gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env({ AI_ATTEMPT_TIMEOUT_MS: '45000', AI_TOTAL_BUDGET_MS: '200000' }),
      fetchImpl: async () => response(503, {}),
      onAttempt: (attempt) => allocated.push(attempt.attemptTimeoutMs) }))
      .rejects.toHaveProperty('code', 'AI_CHAIN_EXHAUSTED');
    expect(allocated).toEqual([45000, 45000, 45000, 45000]);
  });

  test('reports fallback two when primary and fallback one fail', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(503, {}))
      .mockResolvedValueOnce(response(429, {}))
      .mockResolvedValueOnce(router('fallback two'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env(), fetchImpl });
    expect(result).toMatchObject({
      content: 'fallback two',
      model: 'fallback-two',
      attemptCount: 3,
      fallbackIndex: 2,
      fallbackUsed: true
    });
  });

  test('aborts a timed-out primary attempt before fallback succeeds', async () => {
    const fetchImpl = jest.fn()
      .mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        }, { once: true });
      }))
      .mockResolvedValueOnce(router('after timeout'));
    const result = await gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env({ AI_ATTEMPT_TIMEOUT_MS: '5', AI_TOTAL_BUDGET_MS: '1000' }), fetchImpl });
    expect(result).toMatchObject({ content: 'after timeout', model: 'fallback-one', fallbackUsed: true });
    expect(result.attempts[0].code).toBe('AI_ATTEMPT_TIMEOUT');
  });

  test('all failures return a sanitized chain error', async () => {
    const fetchImpl = jest.fn(async () => response(500, { secret: 'raw-provider-body' }));
    await expect(gateway.generate({ messages: [{ role: 'user', content: 'private essay' }],
      env: env(), fetchImpl })).rejects.toMatchObject({
      code: 'AI_CHAIN_EXHAUSTED',
      attemptCount: 4,
      timeoutCount: 0,
      finalFailureCode: 'AI_PROVIDER_UNAVAILABLE',
      attempts: expect.any(Array)
    });
    try {
      await gateway.generate({ messages: [{ role: 'user', content: 'private essay' }],
        env: env(), fetchImpl });
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain('google-secret');
      expect(JSON.stringify(error)).not.toContain('private essay');
      expect(JSON.stringify(error)).not.toContain('raw-provider-body');
    }
  });

  test('total budget prevents another attempt and clamps attempt timeout', async () => {
    let time = 0;
    const now = () => time;
    const fetchImpl = jest.fn(async (_url, options) => {
      expect(options.signal).toBeDefined();
      time = 10;
      return response(500, {});
    });
    await expect(gateway.generate({ messages: [{ role: 'user', content: 'x' }],
      env: env({ AI_TOTAL_BUDGET_MS: '10', AI_ATTEMPT_TIMEOUT_MS: '30' }),
      fetchImpl, now })).rejects.toHaveProperty('code', 'AI_TOTAL_BUDGET_EXHAUSTED');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
