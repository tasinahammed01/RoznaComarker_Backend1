'use strict';

jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const { getRubricAiConfig } = require('../src/services/rubricAiConfig.service');
const { completeRubric, validateRubric } = require('../src/services/rubricCompletion.service');
const logger = require('../src/utils/logger');

const env = (overrides = {}) => ({
  AI_PRIMARY_PROVIDER: 'google', AI_PRIMARY_MODEL: 'global-rubric-model',
  AI_ATTEMPT_TIMEOUT_MS: '30000', AI_TOTAL_BUDGET_MS: '120000',
  AI_RETRIES_PER_MODEL: '0', AI_RETRY_DELAY_MS: '0',
  GEMINI_API_KEY: 'google-key', RUBRIC_AI_MAX_OUTPUT_TOKENS: '4000',
  ...overrides
});
const valid = { title: 'Writing Rubric', levels: [
  { title: 'Strong', maxPoints: 3 }, { title: 'Developing', maxPoints: 2 }, { title: 'Beginning', maxPoints: 1 }
], criteria: [
  { title: 'Content', cells: ['a', 'b', 'c'] }, { title: 'Organization', cells: ['a', 'b', 'c'] },
  { title: 'Language', cells: ['a', 'b', 'c'] }
] };

describe('rubric global AI configuration and completion', () => {
  test('uses the global provider/model and retains the rubric token limit', () => {
    expect(getRubricAiConfig(env())).toMatchObject({
      provider: 'google', model: 'global-rubric-model',
      attemptTimeoutMs: 30000, maxOutputTokens: 4000
    });
    expect(getRubricAiConfig(env({
      RUBRIC_AI_PROVIDER: 'openrouter', RUBRIC_AI_MODEL: 'ignored'
    }))).toMatchObject({ provider: 'google', model: 'global-rubric-model' });
  });

  test('changing the global primary model changes rubric transport', async () => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200,
      headers: { get: () => null }, text: async () => JSON.stringify({
        candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(valid) }] } }]
      }) }));
    await expect(completeRubric({ systemInstruction: 'system', userPrompt: 'prompt' }, {
      config: getRubricAiConfig(env({ AI_PRIMARY_MODEL: 'changed-rubric-model' })),
      env: env({ AI_PRIMARY_MODEL: 'changed-rubric-model' }), fetchImpl
    })).resolves.toEqual(valid);
    expect(fetchImpl.mock.calls[0][0]).toContain('/models/changed-rubric-model:generateContent');
  });

  test('missing primary credential fails before transport', async () => {
    const runCompletion = jest.fn();
    const missing = env({ GEMINI_API_KEY: '' });
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
    for (const privateValue of ['secret-system', 'secret-prompt', '{bad', 'google-key']) {
      expect(logs).not.toContain(privateValue);
    }
    info.mockRestore();
    warn.mockRestore();
  });
});
