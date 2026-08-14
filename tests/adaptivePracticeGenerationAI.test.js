'use strict';

const service = require('../src/services/adaptivePracticeGenerationAI.service');
const adaptive = require('../src/services/adaptivePractice.service');
const { buildAdaptiveEvidenceCandidates } = require('../src/utils/adaptivePracticeEvidenceCandidates');

const env = {
  ASSESSMENT_AI_PRIMARY_PROVIDER: 'openrouter',
  ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1',
  ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'openrouter',
  ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1-mini',
  ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '60000', ASSESSMENT_AI_TOTAL_BUDGET_MS: '120000',
  ASSESSMENT_AI_PRIMARY_RETRIES: '0', ASSESSMENT_AI_FALLBACK_RETRIES: '0', ASSESSMENT_AI_RETRY_DELAY_MS: '0',
  ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS: '4000',
  OPENROUTER_API_KEY: 'test-key', OPENROUTER_BASE_URL: 'https://router.test/v1'
};

function response(payload, status = 200) {
  return { ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(payload) };
}

describe('Adaptive Practice generation assessment transport', () => {
  it('uses GPT-4.1 through OpenRouter JSON mode', async () => {
    const fetchImpl = jest.fn(async () => response({ choices: [{ finish_reason: 'stop', message: { content: '{"activities":[]}' } }] }));
    const result = await service.generate([], { env, fetchImpl });
    expect(result.content).toBe('{"activities":[]}');
    const [url, options] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://router.test/v1/chat/completions');
    const body = JSON.parse(options.body);
    expect(body.model).toBe('openai/gpt-4.1');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('uses a bounded 6000-token default when the feature limit is absent', () => {
    const withoutLimit = { ...env };
    delete withoutLimit.ADAPTIVE_PRACTICE_AI_MAX_OUTPUT_TOKENS;
    expect(service.config(withoutLimit).maxOutputTokens).toBe(6000);
  });

  it.each([
    [{ choices: [] }],
    [{ choices: [{ finish_reason: 'length', message: { content: '{"activities":[' } }] }]
  ])('exhausts the configured chain for unusable output', async (payload) => {
    await expect(service.generate([], { env, fetchImpl: async () => response(payload) }))
      .rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
  });

  it('falls back after 429 without a same-model hot retry', async () => {
    const fetchImpl = jest.fn(async () => response({ error: { code: 429, status: 'RESOURCE_EXHAUSTED' } }, 429));
    await expect(service.generate([], { env, fetchImpl })).rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED' });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body).model))
      .toEqual(['openai/gpt-4.1', 'openai/gpt-4.1-mini']);
  });

  it('sends a flat strict adaptive schema accepted by the OpenRouter request builder', async () => {
    const targets = adaptive.buildTargets([
      { id: 'CONTENT', category: 'Task Achievement', percentage: 40 },
      { id: 'GRAMMAR', category: 'Grammar', percentage: 40 },
      { id: 'VOCABULARY', category: 'Lexical Resource', percentage: 40 }
    ]);
    const evidenceCandidates = buildAdaptiveEvidenceCandidates('This is canonical student writing.');
    const schema = adaptive.activitySchema(targets, evidenceCandidates);
    const unsupported = new Set(['oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', '$ref', 'default', 'nullable']);
    const inspect = (value) => {
      if (!value || typeof value !== 'object') return;
      expect(Object.keys(value).filter((key) => unsupported.has(key))).toEqual([]);
      if (value.type === 'object' && value.properties) {
        expect(value.additionalProperties).toBe(false);
        expect(new Set(value.required)).toEqual(new Set(Object.keys(value.properties)));
      }
      Object.values(value).forEach(inspect);
    };
    inspect(schema);

    const configured = { ...env, ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
      ASSESSMENT_AI_FALLBACK_1_MODEL: 'openai/gpt-4.1' };
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(response({ error: { code: 400, message: 'first model rejected for a non-schema reason' } }, 400))
      .mockResolvedValueOnce(response({ choices: [{ finish_reason: 'stop', message: { content: '{"activities":[]}' } }] }));
    await service.generate([], { env: configured, fetchImpl, responseSchema: schema, validate: JSON.parse });
    const bodies = fetchImpl.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies.map((body) => body.model)).toEqual(['openai/gpt-4.1-mini', 'openai/gpt-4.1']);
    expect(bodies[0].response_format).toEqual(bodies[1].response_format);
    expect(bodies[0].response_format).toMatchObject({ type: 'json_schema', json_schema: {
      name: 'adaptive_practice_activities', strict: true, schema
    } });
    const item = schema.properties.activities.items;
    expect(item.properties.evidenceId.enum).toEqual(['e1']);
    expect(item.properties.evidence).toBeUndefined();
    expect(item.required).toEqual(expect.arrayContaining(['evidenceId', 'questions']));
    expect(item.properties.questions).toMatchObject({ minItems: 1, maxItems: 3 });
    const question = item.properties.questions.items;
    expect(question.required).toEqual(expect.arrayContaining(['questionType', 'options', 'correctOptionId', 'acceptedAnswers']));
    expect(question.properties.options.minItems).toBe(0);
    expect(question.properties.acceptedAnswers.minItems).toBe(0);
  });
});
