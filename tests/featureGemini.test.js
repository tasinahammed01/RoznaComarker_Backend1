'use strict';

const {
  getFeatureGeminiConfig,
  stripSingleJsonFence,
  strictJson,
  mapGeminiError,
  generateFeatureJson,
  validateFlashcardOutput,
  validateWorksheetOutput,
  featureErrorHttp
} = require('../src/services/featureGemini.service');

const envFor = (feature) => ({
  AI_PRIMARY_PROVIDER: 'google',
  AI_PRIMARY_MODEL: 'global-test-model',
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_BASE_URL: 'https://gemini.test/v1beta',
  OPENROUTER_API_KEY: 'test-openrouter-key',
  OPENROUTER_BASE_URL: 'https://router.test/v1',
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter',
  ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter',
  ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_PRIMARY_RETRIES: '1',
  ASSESSMENT_AI_FALLBACK_RETRIES: '0',
  AI_ATTEMPT_TIMEOUT_MS: '60000',
  AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0',
  AI_RETRY_DELAY_MS: '0',
  [`${feature}_AI_MAX_OUTPUT_TOKENS`]: feature === 'FLASHCARD' ? '4000' : '6000',
});

const googleResponse = (text, overrides = {}) => ({
  ok: true, status: 200,
  headers: { get: (name) => name === 'content-type' ? 'application/json' : null },
  text: async () => JSON.stringify({
    candidates: [{ finishReason: 'STOP', content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 },
    ...overrides
  })
});

const openRouterResponse = (text, finishReason = 'stop') => ({
  ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({
    choices: [{ finish_reason: finishReason, message: { content: text } }]
  })
});

const worksheet = (types = ['ordering', 'classification', 'multipleChoice', 'fillBlanks', 'labeling']) => ({
  title: 'Plants Worksheet', description: 'Practice plant science.', subject: 'Science',
  tags: ['plants'], estimatedMinutes: 25,
  activities: types.map((type, index) => {
    const base = { type, title: `${type} activity`, instructions: `Complete ${type}.`, order: index + 1 };
    if (type === 'ordering') return { ...base, data: { items: [{ id: 'order-1', name: 'Seed', correctOrder: 1 }] } };
    if (type === 'classification') return { ...base, data: { categories: ['Plant'], items: [{ id: 'class-1', name: 'Fern', correctCategory: 'Plant' }] } };
    if (type === 'multipleChoice') return { ...base, data: { questions: [{ id: 'mc-1', text: 'What do roots absorb?', options: ['Water', 'Light'], correctAnswer: 'Water' }] } };
    if (type === 'fillBlanks') return { ...base, data: { wordBank: ['water'], sentences: [{ id: 'fill-1', parts: [{ type: 'blank', blankId: 'blank-1', correctAnswer: 'water' }] }] } };
    if (type === 'labeling') return { ...base, data: { labels: [{ id: 'label-1', text: 'Root', x: 50, y: 75, targetId: 'label-1' }] } };
    if (type === 'matching') return { ...base, data: { pairs: [{ id: 'match-1', leftItem: { text: 'Root' }, rightItem: { text: 'Water' } }] } };
    if (type === 'trueFalse') return { ...base, data: { questions: [{ id: 'tf-1', text: 'Roots absorb water.', correctAnswer: true, explanation: 'Roots take up water.' }] } };
    return { ...base, data: { questions: [{ id: 'short-1', text: 'Explain roots.', modelAnswer: 'They absorb water.', maxWords: 50 }] } };
  })
});

describe('global feature AI configuration', () => {
  test('flashcards use the existing paid assessment chain only', () => {
    const config = getFeatureGeminiConfig('flashcard', envFor('FLASHCARD'));
    expect(config).toMatchObject({
      provider: 'openrouter', model: 'openai/gpt-4.1-mini', maxOutputTokens: 4000,
      configured: true
    });
    expect(config.global.chain.map(({ provider, model }) => ({ provider, model }))).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-4.1-mini' },
      { provider: 'openrouter', model: 'openai/gpt-4.1' }
    ]);
  });

  test('worksheets use the existing paid assessment chain only', () => {
    const config = getFeatureGeminiConfig('worksheet', envFor('WORKSHEET'));
    expect(config).toMatchObject({
      provider: 'openrouter', model: 'openai/gpt-4.1-mini',
      maxOutputTokens: 6000, configured: true
    });
    expect(config.global.chain).toEqual([
      { provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbackIndex: 0 },
      { provider: 'openrouter', model: 'openai/gpt-4.1', fallbackIndex: 1 }
    ]);
  });

  test('deprecated feature selectors are ignored', () => {
    expect(getFeatureGeminiConfig('worksheet', {
      ...envFor('WORKSHEET'), WORKSHEET_AI_PROVIDER: 'openrouter',
      WORKSHEET_AI_MODEL: 'ignored-model'
    })).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1-mini', configured: true });
  });

  test('uses the paid flashcard primary endpoint once when it succeeds', async () => {
    const fetchImpl = jest.fn(async (url, options) => {
      expect(url).toBe('https://router.test/v1/chat/completions');
      expect(JSON.parse(options.body).model).toBe('openai/gpt-4.1-mini');
      return openRouterResponse('[{"front":"Root","back":"Absorbs water."}]');
    });
    const result = await generateFeatureJson('flashcard', [{ role: 'user', content: 'synthetic' }],
      { env: envFor('FLASHCARD'), fetchImpl });
    expect(result.metadata).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1-mini', attemptCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('strict Gemini JSON handling', () => {
  test('concatenated final text and one surrounding JSON fence are supported', async () => {
    expect(stripSingleJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(strictJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    const fetchImpl = jest.fn(async () => openRouterResponse('{"cards":[{"front":"A","back":"B"}]}'));
    await expect(generateFeatureJson('flashcard', [{ role: 'user', content: 'x' }],
      { env: envFor('FLASHCARD'), fetchImpl })).resolves.toMatchObject({ value: { cards: [{ front: 'A', back: 'B' }] } });
  });

  test.each([
    ['prose around JSON', 'Here is JSON: {"ok":true}'],
    ['malformed JSON', '{"ok":'],
    ['two fences', '```json\n{"ok":true}\n```\n```json\n{"other":true}\n```']
  ])('rejects %s without repair or substring extraction', (_name, text) => {
    expect(() => strictJson(text)).toThrow(expect.objectContaining({ code: 'GEMINI_RESPONSE_INVALID' }));
  });

  test('maps blocked, truncated, empty, timeout, authentication and quota failures distinctly', () => {
    expect(mapGeminiError({ code: 'GOOGLE_RESPONSE_BLOCKED' }).code).toBe('GEMINI_SAFETY_BLOCKED');
    expect(mapGeminiError({ code: 'GOOGLE_OUTPUT_TRUNCATED' }).code).toBe('GEMINI_RESPONSE_TRUNCATED');
    expect(mapGeminiError({ code: 'GOOGLE_CANDIDATES_EMPTY' }).code).toBe('GEMINI_RESPONSE_EMPTY');
    expect(mapGeminiError({ code: 'AI_PROVIDER_TIMEOUT', name: 'TimeoutError' }).code).toBe('GEMINI_TIMEOUT');
    expect(mapGeminiError({ status: 401 }).code).toBe('GEMINI_AUTHENTICATION_FAILED');
    expect(mapGeminiError({ status: 429 }).code).toBe('GEMINI_QUOTA_EXCEEDED');
    expect(mapGeminiError({ status: 429, retryAfterMs: 1000 }).code).toBe('GEMINI_RATE_LIMITED');
  });

  test('keeps safe frontend-compatible HTTP error envelopes', () => {
    expect(featureErrorHttp({ code: 'GEMINI_NOT_CONFIGURED' }).status).toBe(503);
    expect(featureErrorHttp({ code: 'GEMINI_TIMEOUT' }).status).toBe(504);
    expect(featureErrorHttp({ code: 'GEMINI_RATE_LIMITED' }).status).toBe(429);
    expect(featureErrorHttp({ code: 'GEMINI_RESPONSE_INVALID' }).status).toBe(502);
  });
});

describe('feature output validation', () => {
  test('worksheet generation retries one malformed validated response and returns one valid result', async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(openRouterResponse('{"title":"incomplete"}'))
      .mockResolvedValueOnce(openRouterResponse(JSON.stringify(worksheet(['ordering']))));

    const result = await generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'),
      fetchImpl,
      sleepFn: async () => {},
      validateValue: (value) => validateWorksheetOutput(value, ['ordering'])
    });

    expect(result.value.title).toBe('Plants Worksheet');
    expect(result.metadata.attemptCount).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('worksheet generation does not retry authentication failures', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: { get: () => null },
      text: async () => JSON.stringify({ error: { code: 401 } })
    });

    await expect(generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl, sleepFn: async () => {}
    })).rejects.toMatchObject({ code: 'AI_PROVIDER_AUTH_ERROR' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('worksheet primary succeeds without fallback', async () => {
    const fetchImpl = jest.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      expect(body.model).toBe('openai/gpt-4.1-mini');
      expect(url).toBe('https://router.test/v1/chat/completions');
      return openRouterResponse(JSON.stringify(worksheet(['ordering'])));
    });
    const result = await generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl,
      validateValue: (value) => validateWorksheetOutput(value, ['ordering'])
    });
    expect(result.metadata).toMatchObject({ model: 'openai/gpt-4.1-mini', attemptCount: 1 });
  });

  test('worksheet retries one primary timeout, then succeeds on the same paid model', async () => {
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const models = [];
    const fetchImpl = jest.fn(async (_url, options) => {
      models.push(JSON.parse(options.body).model);
      if (models.length === 1) throw timeout;
      return openRouterResponse(JSON.stringify(worksheet(['ordering'])));
    });
    const result = await generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateWorksheetOutput(value, ['ordering'])
    });
    expect(models).toEqual(['openai/gpt-4.1-mini', 'openai/gpt-4.1-mini']);
    expect(result.metadata.attemptCount).toBe(2);
  });

  test.each([
    ['invalid JSON', '{broken'],
    ['missing worksheet schema', '{"title":"incomplete"}']
  ])('worksheet falls back to gpt-4.1 after primary %s is exhausted', async (_label, invalid) => {
    const models = [];
    const fetchImpl = jest.fn(async (_url, options) => {
      models.push(JSON.parse(options.body).model);
      return models.length < 3 ? openRouterResponse(invalid)
        : openRouterResponse(JSON.stringify(worksheet(['ordering'])));
    });
    const result = await generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateWorksheetOutput(value, ['ordering'])
    });
    expect(models).toEqual([
      'openai/gpt-4.1-mini', 'openai/gpt-4.1-mini', 'openai/gpt-4.1'
    ]);
    expect(result.metadata).toMatchObject({ model: 'openai/gpt-4.1', attemptCount: 3 });
    expect(models.join(' ')).not.toMatch(/gemini|nemotron|gpt-oss/iu);
  });

  test('worksheet paid chain is capped at three attempts and returns a neutral validation error', async () => {
    const fetchImpl = jest.fn(async () => openRouterResponse('{broken'));
    await expect(generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateWorksheetOutput(value, ['ordering'])
    })).rejects.toMatchObject({ code: 'AI_OUTPUT_VALIDATION_FAILED', attemptCount: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test('worksheet configuration failure is provider-neutral and makes no request', async () => {
    const fetchImpl = jest.fn();
    await expect(generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: { ...envFor('WORKSHEET'), OPENROUTER_API_KEY: '' }, fetchImpl
    })).rejects.toMatchObject({ code: 'WORKSHEET_AI_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each([401, 402, 400])('worksheet terminal HTTP %i failure does not retry or fall back', async (status) => {
    const fetchImpl = jest.fn(async () => ({
      ok: false, status, headers: { get: () => null },
      text: async () => JSON.stringify({ error: { code: status } })
    }));
    await expect(generateFeatureJson('worksheet', [{ role: 'user', content: 'plants' }], {
      env: envFor('WORKSHEET'), fetchImpl, sleepFn: async () => {}
    })).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['malformed JSON', '{broken'],
    ['missing cards array', '{"unexpected":[]}'],
    ['empty cards', '[]'],
    ['duplicate cards', '[{"front":"A","back":"B"},{"front":"A","back":"B"}]']
  ])('flashcard %s retries and returns a strictly validated result', async (_label, invalid) => {
    const valid = '[{"front":"Root","back":"Absorbs water."}]';
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(openRouterResponse(invalid))
      .mockResolvedValueOnce(openRouterResponse(valid));
    const result = await generateFeatureJson('flashcard', [{ role: 'user', content: 'plants' }], {
      env: envFor('FLASHCARD'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateFlashcardOutput(value, 1)
    });
    expect(result.value).toEqual([{ front: 'Root', back: 'Absorbs water.' }]);
    expect(result.metadata.attemptCount).toBe(2);
  });

  test('flashcard primary timeout retries once and paid fallback succeeds after exhaustion', async () => {
    const models = [];
    const timeout = Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    const fetchImpl = jest.fn(async (_url, options) => {
      models.push(JSON.parse(options.body).model);
      if (models.length < 3) throw timeout;
      return openRouterResponse('[{"front":"Root","back":"Absorbs water."}]');
    });
    const result = await generateFeatureJson('flashcard', [{ role: 'user', content: 'plants' }], {
      env: envFor('FLASHCARD'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateFlashcardOutput(value, 1)
    });
    expect(models).toEqual([
      'openai/gpt-4.1-mini', 'openai/gpt-4.1-mini', 'openai/gpt-4.1'
    ]);
    expect(models.join(' ')).not.toMatch(/gemini|nemotron|gpt-oss/iu);
    expect(result.metadata).toMatchObject({ attemptCount: 3, model: 'openai/gpt-4.1' });
  });

  test('flashcard paid chain is capped at three attempts with a controlled error', async () => {
    const fetchImpl = jest.fn(async () => openRouterResponse('{broken'));
    await expect(generateFeatureJson('flashcard', [{ role: 'user', content: 'plants' }], {
      env: envFor('FLASHCARD'), fetchImpl, sleepFn: async () => {},
      validateValue: (value) => validateFlashcardOutput(value, 1)
    })).rejects.toMatchObject({ feature: 'flashcard', code: 'AI_OUTPUT_VALIDATION_FAILED', attemptCount: 3 });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  test.each([401, 402, 400])('flashcard terminal HTTP %i failure does not retry or fall back', async (status) => {
    const fetchImpl = jest.fn(async () => ({
      ok: false, status, headers: { get: () => null },
      text: async () => JSON.stringify({ error: { code: status } })
    }));
    await expect(generateFeatureJson('flashcard', [{ role: 'user', content: 'plants' }], {
      env: envFor('FLASHCARD'), fetchImpl, sleepFn: async () => {}
    })).rejects.toMatchObject({ feature: 'flashcard' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('flashcard configuration failure is provider-neutral and makes no request', async () => {
    const fetchImpl = jest.fn();
    await expect(generateFeatureJson('flashcard', [{ role: 'user', content: 'plants' }], {
      env: { ...envFor('FLASHCARD'), OPENROUTER_API_KEY: '' }, fetchImpl
    })).rejects.toMatchObject({ code: 'FLASHCARD_AI_NOT_CONFIGURED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test.each(['term-def', 'qa', 'concept'])('flashcard template %s retains the front/back contract', () => {
    const cards = validateFlashcardOutput([
      { front: 'Photosynthesis', back: 'Plants convert light into chemical energy.' },
      { front: 'Chlorophyll', back: 'A pigment that absorbs light.' }
    ], 2);
    expect(cards).toHaveLength(2);
    expect(cards[0]).toEqual({ front: 'Photosynthesis', back: 'Plants convert light into chemical energy.' });
  });

  test('flashcard count, empty values, duplicates and executable HTML are rejected', () => {
    expect(() => validateFlashcardOutput([{ front: 'A', back: 'B' }], 2)).toThrow();
    expect(() => validateFlashcardOutput([{ front: '', back: 'B' }], 1)).toThrow();
    expect(() => validateFlashcardOutput([{ front: 'A', back: 'B' }, { front: 'A', back: 'B' }], 2)).toThrow();
    expect(() => validateFlashcardOutput([{ front: '<script>x</script>', back: 'B' }], 1)).toThrow();
  });

  test('mixed worksheet and every supported prompt activity type retain their structures', () => {
    const types = ['ordering', 'classification', 'multipleChoice', 'fillBlanks', 'labeling',
      'matching', 'trueFalse', 'shortAnswer'];
    expect(validateWorksheetOutput(worksheet(types), types).activities.map((item) => item.type)).toEqual(types);
  });

  test('worksheet rejects missing answers, empty activities, duplicate IDs and unexpected types', () => {
    const noAnswer = worksheet(['multipleChoice']);
    delete noAnswer.activities[0].data.questions[0].correctAnswer;
    expect(() => validateWorksheetOutput(noAnswer, ['multipleChoice'])).toThrow();
    expect(() => validateWorksheetOutput({ ...worksheet([]), activities: [] }, ['ordering'])).toThrow();
    const duplicate = worksheet(['ordering', 'classification']);
    duplicate.activities[1].data.items[0].id = 'order-1';
    expect(() => validateWorksheetOutput(duplicate, ['ordering', 'classification'])).toThrow();
    expect(() => validateWorksheetOutput(worksheet(['ordering']), ['classification'])).toThrow();
  });
});
