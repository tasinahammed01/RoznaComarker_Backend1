const { DEFAULT_RUBRIC_MODEL, getRubricAiConfig } = require('../src/services/rubricAiConfig.service');

describe('rubric AI configuration', () => {
  const original = { ...process.env };

  afterEach(() => {
    process.env = { ...original };
  });

  test('prefers RUBRIC_AI_MODEL, then PRIMARY_AI_MODEL, then the safe default', () => {
    process.env.RUBRIC_AI_MODEL = 'openai/gpt-oss-120b';
    process.env.PRIMARY_AI_MODEL = 'legacy/model';
    process.env.LLAMA_MODEL = 'meta-llama/llama-3-8b-instruct';
    expect(getRubricAiConfig().model).toBe('openai/gpt-oss-120b');

    delete process.env.RUBRIC_AI_MODEL;
    expect(getRubricAiConfig().model).toBe('legacy/model');

    delete process.env.PRIMARY_AI_MODEL;
    expect(getRubricAiConfig().model).toBe(DEFAULT_RUBRIC_MODEL);
  });

  test('defaults the provider to OpenRouter and never reads deprecated provider names', () => {
    delete process.env.PRIMARY_AI_PROVIDER;
    process.env.AI_PROVIDER = 'openai';
    expect(getRubricAiConfig().provider).toBe('openrouter');
  });
});
