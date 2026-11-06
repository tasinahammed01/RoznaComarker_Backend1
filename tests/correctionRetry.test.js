'use strict';
// Task 20: one bounded retry of the correction request, with different sampling, only for a malformed reply or a transient provider failure.
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const gateway = require('../src/services/aiGateway.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewedResult } = require('./helpers/astraAssessmentFixtures.cjs');

const failure = (code, extra = {}) => Object.assign(new Error(code), { code: 'AI_CHAIN_EXHAUSTED', finalFailureCode: 'AI_CHAIN_EXHAUSTED',
  attempts: [{ code, validationCode: code === 'AI_OUTPUT_VALIDATION_FAILED' ? 'SEMANTIC_SCHEMA_INVALID' : undefined, validationStage: 'compact_wire_schema' }], ...extra });

describe('which failures earn one retry', () => {
  test.each(['AI_OUTPUT_VALIDATION_FAILED', 'AI_RESPONSE_INVALID', 'AI_RESPONSE_EMPTY', 'AI_PROVIDER_UNAVAILABLE', 'AI_RATE_LIMITED'])('%s: yes', code => {
    expect(coordinator.sameRequestRetryable(failure(code))).toBe(true);
  });
  test.each(['AI_AUTH_FAILED', 'AI_PROVIDER_NOT_CONFIGURED', 'INSUFFICIENT_ASSESSMENT_CREDITS', 'AI_CORRECTION_AUTHORITY_INVALID', 'OCR_GPT_SOURCE_CONFIGURATION_INVALID',
    'AI_PAYMENT_REQUIRED', 'AI_ATTEMPT_TIMEOUT', 'AI_TOTAL_BUDGET_EXHAUSTED', 'SOMETHING_ELSE'])('%s: no', code => {
    expect(coordinator.sameRequestRetryable(failure(code))).toBe(false);
  });
  test('an auth or credit failure anywhere in the attempts blocks the retry, even after a malformed reply', () => {
    const error = failure('AI_OUTPUT_VALIDATION_FAILED'); error.attempts.unshift({ code: 'AI_AUTH_FAILED' });
    expect(coordinator.sameRequestRetryable(error)).toBe(false);
  });
});

describe('the retry in the correction stage', () => {
  const transcript = 'A clear short response explains one idea with supporting evidence.';
  const run = async (outcomes) => {
    const calls = [];
    const semanticService = {
      buildSemanticRequest: jest.fn(() => ({ promptInputTokenEstimate: 1800, promptCharacters: 5000 })),
      analyze: jest.fn(async (input, dependencies) => { calls.push(dependencies.config.samplingVariant || null); const next = outcomes.shift();
        if (next instanceof Error) throw next; return reviewedResult(input, []); })
    };
    const promise = coordinator.analyze({ transcript, transcriptHash: 'h', legend: defaultLegend(), spans: [], pageManifest: [], assignment: {} },
      { semanticService, config: { maxOutputTokens: 3500, attemptTimeoutMs: 90000 }, settings: { enabled: true, singleRequestThresholdTokens: 5000 } });
    return { promise, calls, semanticService };
  };
  test('a malformed reply is retried once, with different sampling, and the retry result is used', async () => {
    const { promise, calls } = await run([failure('AI_OUTPUT_VALIDATION_FAILED'), 'ok']);
    const result = await promise;
    expect(calls).toEqual([null, gateway.CORRECTION_RETRY_SAMPLING]);
    expect(result.metrics).toMatchObject({ correctionRecoveryStrategy: 'same_request_varied_sampling', correctionRecoveryOutcome: 'completed', recoveryRequestCount: 1 });
  });
  test('never more than one retry: a second malformed reply fails the stage', async () => {
    const { promise, calls } = await run([failure('AI_OUTPUT_VALIDATION_FAILED'), failure('AI_OUTPUT_VALIDATION_FAILED'), 'ok']);
    await expect(promise).rejects.toMatchObject({ correctionMetrics: expect.objectContaining({ correctionRecoveryStrategy: 'same_request_varied_sampling' }) });
    expect(calls).toHaveLength(2);
  });
  test('an auth failure is not retried', async () => {
    const { promise, calls } = await run([failure('AI_AUTH_FAILED'), 'ok']);
    await expect(promise).rejects.toBeTruthy();
    expect(calls).toEqual([null]);
  });
});

describe('the request a retry sends', () => {
  const body = async samplingVariant => {
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, headers: { get: () => null },
      text: async () => JSON.stringify({ model: 'google/gemini-3.8-flash', choices: [{ finish_reason: 'stop', message: { content: '{}' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }) }));
    await gateway.providerAttempt({ entry: { provider: 'openrouter', model: 'google/gemini-3.8-flash' }, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 100,
      responseFormat: 'json', responseSchema: { type: 'object' }, schemaName: 's', attemptTimeoutMs: 5000, fetchImpl, env: { OPENROUTER_API_KEY: 'mock-only' },
      now: Date.now, feature: 'semantic_corrections', samplingVariant }).catch(() => undefined);
    return JSON.parse(fetchImpl.mock.calls[0][1].body);
  };
  test('first attempt: reproducible, temperature 0 and the fixed seed', async () => {
    const sent = await body(null);
    expect(sent.temperature).toBe(0); expect(sent.seed).toBe(20261105);
  });
  test('retry: a small positive temperature and no seed, never the same sample', async () => {
    const sent = await body(gateway.CORRECTION_RETRY_SAMPLING);
    expect(sent.temperature).toBe(gateway.CORRECTION_RETRY_TEMPERATURE); expect(sent.temperature).toBeGreaterThan(0);
    expect(sent).not.toHaveProperty('seed');
  });
});
