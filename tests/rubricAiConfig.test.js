'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const { getRubricAiConfig } = require('../src/services/rubricAiConfig.service');
const { completeRubric, validateRubric } = require('../src/services/rubricCompletion.service');
const logger = require('../src/utils/logger');

const valid = { title: 'Writing Rubric', levels: [
  { title: 'Strong', maxPoints: 3 }, { title: 'Developing', maxPoints: 2 }, { title: 'Beginning', maxPoints: 1 }
], criteria: [
  { title: 'Content', cells: ['a', 'b', 'c'] }, { title: 'Organization', cells: ['a', 'b', 'c'] },
  { title: 'Language', cells: ['a', 'b', 'c'] }
] };

describe('rubric AI configuration and completion', () => {
  test('defaults to semantic provider/model and permits explicit rubric overrides', () => {
    expect(getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash' }))
      .toMatchObject({ provider: 'google', model: 'gemini-3.6-flash', attemptTimeoutMs: 60000, maxOutputTokens: 4000 });
    expect(getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash',
      RUBRIC_AI_PROVIDER: 'openrouter', RUBRIC_AI_MODEL: 'approved/model' }))
      .toMatchObject({ provider: 'openrouter', model: 'approved/model' });
  });

  test('accepts direct Gemini identifier and rejects the routed identifier', async () => {
    const runCompletion = jest.fn(async () => ({ content: JSON.stringify(valid), provider: 'google', model: 'gemini-3.6-flash', metrics: { attemptCount: 1 } }));
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, { runCompletion,
      config: { ...getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash' }), maxRetries: 0 },
      env: { GEMINI_API_KEY: 'key' } })).resolves.toEqual(valid);
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, { runCompletion,
      config: { ...getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'google/gemini-3.6-flash' }), maxRetries: 0 },
      env: { GEMINI_API_KEY: 'key' } })).rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' });
  });

  test('missing Google key fails before transport', async () => {
    const runCompletion = jest.fn();
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, { runCompletion,
      config: getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash' }), env: {} }))
      .rejects.toMatchObject({ code: 'AI_PROVIDER_NOT_CONFIGURED' });
    expect(runCompletion).not.toHaveBeenCalled();
  });

  test('rubric completion uses the direct Google endpoint and never uses OpenRouter credentials', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(valid).slice(0, 100) },
        { thought: true, text: 'internal' }, { inlineData: {} }, { text: JSON.stringify(valid).slice(100) }] } }]
    }) }));
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, {
      config: { ...getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash' }), maxRetries: 0 },
      env: { GEMINI_API_KEY: 'google-key', OPENROUTER_API_KEY: 'router-key', GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta' },
      fetchImpl
    })).resolves.toEqual(valid);
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent');
    expect(options.headers).toMatchObject({ 'x-goog-api-key': 'google-key' });
    expect(options.headers).not.toHaveProperty('Authorization');
    expect(JSON.stringify(options)).not.toContain('router-key');
  });

  test('strict rubric validation rejects malformed levels, cells, and points', () => {
    expect(validateRubric(valid)).toEqual(valid);
    expect(validateRubric({ ...valid, levels: valid.levels.slice(0, 2) })).toBeNull();
    expect(validateRubric({ ...valid, levels: valid.levels.map((x, i) => ({ ...x, maxPoints: i ? x.maxPoints : 1.5 })) })).toBeNull();
    expect(validateRubric({ ...valid, criteria: valid.criteria.map((x, i) => i ? x : { ...x, cells: ['a'] }) })).toBeNull();
  });

  test('malformed provider output is rejected without retries in the validation layer', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const runCompletion = jest.fn(async () => ({ content: '{bad', provider: 'google', model: 'gemini-3.6-flash', metrics: { attemptCount: 1 } }));
    await expect(completeRubric({ systemInstruction: 'secret-system', userPrompt: 'secret-prompt' }, { runCompletion,
      config: getRubricAiConfig({ SEMANTIC_AI_PROVIDER: 'google', SEMANTIC_AI_MODEL: 'gemini-3.6-flash' }), env: { GEMINI_API_KEY: 'secret-key' } }))
      .rejects.toMatchObject({ code: 'RUBRIC_RESPONSE_INVALID', statusCode: 422 });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    for (const privateValue of ['secret-system', 'secret-prompt', '{bad', 'secret-key']) expect(logs).not.toContain(privateValue);
    info.mockRestore(); warn.mockRestore();
  });
});
