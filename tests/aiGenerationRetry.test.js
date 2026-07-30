describe('AI generation transient retry lifecycle', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.resetModules();
    process.env.AI_PRIMARY_PROVIDER = 'openrouter';
    process.env.AI_PRIMARY_MODEL = 'test/model';
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.AI_ATTEMPT_TIMEOUT_MS = '60000';
    process.env.AI_TOTAL_BUDGET_MS = '120000';
    process.env.AI_RETRIES_PER_MODEL = '1';
    process.env.AI_RETRY_DELAY_MS = '1';
  });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  test('a timeout uses a fresh signal and the next bounded attempt can succeed', async () => {
    const signals = [];
    global.fetch = jest.fn(async (_url, options) => {
      signals.push(options.signal);
      if (signals.length === 1) { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }
      return { ok: true, status: 200, headers: { get: () => null },
        text: async () => JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '{"ok":true}' } }] }) };
    });
    const attempts = []; const retries = [];
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }], {
      onAttempt: (event) => attempts.push(event.attempt), onRetry: (event) => retries.push(event.code)
    })).resolves.toBe('{"ok":true}');
    expect(attempts).toEqual([1, 2]);
    expect(retries).toEqual(['AI_ATTEMPT_TIMEOUT']);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test('a permanent authentication failure is not retried', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => '' }));
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }]))
      .rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a billing failure is terminal and is not silently retried', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 402, text: async () => '' }));
    const retries = [];
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }], {
      onRetry: (event) => retries.push(event)
    })).rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });
});
