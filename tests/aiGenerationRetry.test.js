describe('AI generation transient retry lifecycle', () => {
  const originalFetch = global.fetch;
  beforeEach(() => {
    jest.resetModules();
    process.env.PRIMARY_AI_PROVIDER = 'openrouter';
    process.env.PRIMARY_AI_MODEL = 'test/model';
    process.env.OPENROUTER_API_KEY = 'test-key';
    process.env.OPENROUTER_TIMEOUT_MS = '60000';
    process.env.AI_MAX_RETRIES = '2';
    process.env.AI_RETRY_DELAY_MS = '1';
  });
  afterEach(() => { global.fetch = originalFetch; jest.restoreAllMocks(); });

  test('a timeout uses a fresh signal and the next bounded attempt can succeed', async () => {
    const signals = [];
    global.fetch = jest.fn(async (_url, options) => {
      signals.push(options.signal);
      if (signals.length === 1) { const error = new Error('timed out'); error.name = 'TimeoutError'; throw error; }
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}' } }] }) };
    });
    const attempts = []; const retries = [];
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }], {
      onAttempt: (event) => attempts.push(event.attempt), onRetry: (event) => retries.push(event.code)
    })).resolves.toBe('{"ok":true}');
    expect(attempts).toEqual([1, 2]);
    expect(retries).toEqual(['AI_PROVIDER_TIMEOUT']);
    expect(signals).toHaveLength(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  test('a permanent authentication failure is not retried', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 401, text: async () => '' }));
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }])).rejects.toThrow('401');
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('a billing failure is terminal and is not silently retried', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 402, text: async () => '' }));
    const retries = [];
    const service = require('../src/services/aiGeneration.service');
    await expect(service.generateChatCompletion([{ role: 'user', content: 'safe fixture' }], {
      onRetry: (event) => retries.push(event)
    })).rejects.toThrow('402');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(retries).toEqual([]);
  });
});
