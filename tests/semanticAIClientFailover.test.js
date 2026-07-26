const { runSemanticCompletion, classifyProviderFailure } = require('../src/services/semanticAIClient.service');

const response = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: () => null },
  text: async () => typeof body === 'string' ? body : JSON.stringify(body)
});

const config = {
  provider: 'google', model: 'gemini-3.6-flash',
  fallback: { provider: 'openrouter', model: 'openai/gpt-oss-20b' },
  approvedModels: ['gemini-3.6-flash', 'openai/gpt-oss-20b'],
  maxRetries: 1, retryDelayMs: 0, attemptTimeoutMs: 5000,
  totalBudgetMs: 20000, minAttemptBudgetMs: 1000, maxOutputTokens: 512, googleThinkingLevel: 'low'
};
const env = { GEMINI_API_KEY: 'google-secret', OPENROUTER_API_KEY: 'router-secret',
  OPENROUTER_BASE_URL: 'https://openrouter.test/api/v1' };

describe('semantic provider failover policy', () => {
  test('classifies payment rejection as fallback-only', () => {
    expect(classifyProviderFailure({ status: 402, code: 'HTTP_402' }, {
      isPrimary: true, fallbackConfigured: true
    })).toEqual({ retrySameProvider: false, tryFallbackProvider: true,
      terminalCode: 'PRIMARY_PROVIDER_PAYMENT_REQUIRED' });
  });

  test('primary success performs no fallback', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(200, {
      candidates: [{ content: { parts: [{ text: '{"ok":true}' }] }, finishReason: 'STOP' }]
    }));
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
      config, env, fetchImpl });
    expect(result.provider).toBe('google');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('primary 402 skips same-provider retry and uses approved fallback credential once', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response(402, { error: { status: 'PAYMENT_REQUIRED', code: 402 } }))
      .mockResolvedValueOnce(response(200, { choices: [{ message: { content: '{"ok":true}' } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    const result = await runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
      config, env, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][0]).toContain('google');
    expect(fetchImpl.mock.calls[1][0]).toContain('openrouter.test');
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer router-secret');
    expect(result).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-oss-20b' });
    expect(result.metrics.attempts.map((item) => item.status)).toEqual(['provider_refusal', 'completed']);
  });

  test('no approved fallback leaves 402 terminal after one request', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(402, 'payment required'));
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
      config: { ...config, fallback: null, maxRetries: 1 }, env, fetchImpl })).rejects.toMatchObject({ code: 'HTTP_402' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an unapproved fallback model is never attempted', async () => {
    const fetchImpl = jest.fn().mockResolvedValue(response(402, 'payment required'));
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
      config: { ...config, approvedModels: ['gemini-3.6-flash'] }, env, fetchImpl }))
      .rejects.toMatchObject({ code: 'HTTP_402' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('insufficient remaining budget prevents fallback safely', async () => {
    let clock = 0;
    const fetchImpl = jest.fn().mockImplementation(async () => {
      clock = 700;
      return response(402, 'payment required');
    });
    await expect(runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
      config: { ...config, totalBudgetMs: 1500, minAttemptBudgetMs: 1000 }, env, fetchImpl, now: () => clock }))
      .rejects.toMatchObject({ code: 'SEMANTIC_BUDGET_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('failed fallback preserves safe summaries for both attempts', async () => {
    const fetchImpl = jest.fn().mockResolvedValueOnce(response(402, 'payment required'))
      .mockResolvedValueOnce(response(503, 'provider unavailable'));
    let failure;
    try {
      await runSemanticCompletion({ messages: [{ role: 'user', content: 'safe fixture' }],
        config, env, fetchImpl, sleepFn: async () => {} });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'HTTP_503' });
    expect(failure.attempts).toHaveLength(2);
    expect(failure.attempts[0]).toMatchObject({ provider: 'google', code: 'HTTP_402' });
    expect(failure.attempts[1]).toMatchObject({ provider: 'openrouter', code: 'HTTP_503' });
    expect(JSON.stringify(failure.attempts)).not.toContain('secret');
  });
});
