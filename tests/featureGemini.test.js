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
  PRIMARY_AI_PROVIDER: 'openrouter',
  PRIMARY_AI_MODEL: 'must-not-be-used',
  OPENROUTER_API_KEY: 'must-not-be-used',
  GEMINI_API_KEY: 'test-gemini-key',
  GEMINI_BASE_URL: 'https://gemini.test/v1beta',
  [`${feature}_AI_PROVIDER`]: ' google ',
  [`${feature}_AI_MODEL`]: ' gemini-3.6-flash ',
  [`${feature}_AI_TIMEOUT_MS`]: '60000',
  [`${feature}_AI_MAX_OUTPUT_TOKENS`]: feature === 'FLASHCARD' ? '4000' : '6000',
  [`${feature}_AI_MAX_RETRIES`]: '1'
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

describe('dedicated feature Gemini configuration', () => {
  test.each([
    ['FLASHCARD', 'flashcard', 4000],
    ['WORKSHEET', 'worksheet', 6000]
  ])('%s selects Google without inheriting primary OpenRouter settings', (prefix, feature, tokens) => {
    expect(getFeatureGeminiConfig(feature, envFor(prefix))).toMatchObject({
      provider: 'google', model: 'gemini-3.6-flash', timeoutMs: 60000,
      maxOutputTokens: tokens, maxRetries: 1, configured: true
    });
  });

  test('missing or invalid dedicated settings never fall back to PRIMARY_AI_PROVIDER', () => {
    expect(getFeatureGeminiConfig('flashcard', {
      PRIMARY_AI_PROVIDER: 'openrouter', PRIMARY_AI_MODEL: 'paid/model', GEMINI_API_KEY: 'key'
    })).toMatchObject({ provider: '', model: '', configured: false });
    expect(getFeatureGeminiConfig('worksheet', {
      ...envFor('WORKSHEET'), WORKSHEET_AI_PROVIDER: 'openrouter'
    }).configured).toBe(false);
  });

  test('uses the Google endpoint once and never the OpenRouter URL', async () => {
    const fetchImpl = jest.fn(async (url) => {
      expect(url).toBe('https://gemini.test/v1beta/models/gemini-3.6-flash:generateContent');
      expect(url).not.toContain('openrouter');
      return googleResponse('[{"front":"Root","back":"Absorbs water."}]');
    });
    const result = await generateFeatureJson('flashcard', [{ role: 'user', content: 'synthetic' }],
      { env: envFor('FLASHCARD'), fetchImpl });
    expect(result.metadata).toMatchObject({ provider: 'google', model: 'gemini-3.6-flash', attemptCount: 1 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('strict Gemini JSON handling', () => {
  test('concatenated final text and one surrounding JSON fence are supported', async () => {
    expect(stripSingleJsonFence('```json\n{"ok":true}\n```')).toBe('{"ok":true}');
    expect(strictJson('```json\n{"ok":true}\n```')).toEqual({ ok: true });
    const fetchImpl = jest.fn(async () => googleResponse('', {
      candidates: [{ finishReason: 'STOP', content: { parts: [
        { text: '{"cards":[' }, { thought: true, text: 'private reasoning' },
        { text: '{"front":"A","back":"B"}]}' }
      ] } }]
    }));
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
