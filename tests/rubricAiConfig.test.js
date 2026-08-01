'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const { getRubricAiConfig } = require('../src/services/rubricAiConfig.service');
const { completeRubric, validateRubric } = require('../src/services/rubricCompletion.service');
const logger = require('../src/utils/logger');

const env = (overrides = {}) => ({
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter', ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_PRIMARY_RETRIES: '1', ASSESSMENT_AI_FALLBACK_RETRIES: '0',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '30000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '120000',
  ASSESSMENT_AI_RETRY_DELAY_MS: '0', OPENROUTER_API_KEY: 'router-key',
  OPENROUTER_BASE_URL: 'https://router.test/v1', RUBRIC_AI_MAX_OUTPUT_TOKENS: '4000',
  ...overrides
});
const valid = { title: 'Writing Rubric', levels: [
  { title: 'Strong', maxPoints: 3 }, { title: 'Developing', maxPoints: 2 }, { title: 'Beginning', maxPoints: 1 }
], criteria: [
  { title: 'Content', cells: ['a', 'b', 'c'] }, { title: 'Organization', cells: ['a', 'b', 'c'] },
  { title: 'Language', cells: ['a', 'b', 'c'] }
] };

describe('rubric assessment AI configuration and completion', () => {
  test('uses the assessment provider/model and retains the rubric token limit', () => {
    expect(getRubricAiConfig(env())).toMatchObject({
      provider: 'openrouter', model: 'openai/gpt-4.1',
      attemptTimeoutMs: 30000, maxOutputTokens: 4000
    });
    expect(getRubricAiConfig(env({
      RUBRIC_AI_PROVIDER: 'openrouter', RUBRIC_AI_MODEL: 'ignored'
    }))).toMatchObject({ provider: 'openrouter', model: 'openai/gpt-4.1' });
  });

  test('changing the assessment primary model changes rubric transport', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200,
      headers: { get: () => null }, text: async () => JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(valid) } }]
      }) }));
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, {
      config: getRubricAiConfig(env({ ASSESSMENT_AI_PRIMARY_MODEL: 'openai/changed-rubric-model' })),
      env: env({ ASSESSMENT_AI_PRIMARY_MODEL: 'openai/changed-rubric-model' }), fetchImpl
    })).resolves.toEqual(valid);
    expect(fetchImpl.mock.calls[0][0]).toBe('https://router.test/v1/chat/completions');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).model).toBe('openai/changed-rubric-model');
  });

  test('missing primary credential fails before transport', async () => {
    const runCompletion = jest.fn();
    const missing = env({ OPENROUTER_API_KEY: '' });
    expect(() => getRubricAiConfig(missing)).toThrow(expect.objectContaining({ code: 'AI_CHAIN_NOT_CONFIGURED' }));
    expect(runCompletion).not.toHaveBeenCalled();
  });

  test('strict rubric validation rejects malformed levels, cells, and points', () => {
    expect(validateRubric(valid)).toEqual(valid);
    expect(validateRubric({ ...valid, levels: valid.levels.slice(0, 2) })).toBeNull();
    expect(validateRubric({ ...valid, levels: valid.levels.map((x, i) => ({ ...x, maxPoints: i ? x.maxPoints : 1.5 })) })).toBeNull();
    expect(validateRubric({ ...valid, criteria: valid.criteria.map((x, i) => i ? x : { ...x, cells: ['a'] }) })).toBeNull();
  });

  test('malformed output is rejected without logging prompts or credentials', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const runCompletion = jest.fn(async ({ validate }) => {
      validate('{bad');
      return null;
    });
    await expect(completeRubric({ systemInstruction: 'secret-system', userPrompt: 'secret-prompt' }, {
      runCompletion, config: getRubricAiConfig(env()), env: env()
    })).rejects.toMatchObject({ code: 'RUBRIC_RESPONSE_INVALID', statusCode: 422 });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(runCompletion.mock.calls[0][0]).toMatchObject({ schemaName: 'rubric_generation',
      responseSchema: { type: 'object', additionalProperties: false } });
    const logs = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    for (const privateValue of ['secret-system', 'secret-prompt', '{bad', 'router-key']) {
      expect(logs).not.toContain(privateValue);
    }
    info.mockRestore();
    warn.mockRestore();
  });
});
