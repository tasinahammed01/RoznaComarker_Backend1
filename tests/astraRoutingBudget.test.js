'use strict';
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const client = require('../src/services/semanticAIClient.service');
const gateway = require('../src/services/aiGateway.service');
const execution = require('../src/services/assessmentExecutionPolicy.service');
const canonical = require('../src/services/correctionCanonical.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewedResult, reviewPayload, finding, categories } = require('./helpers/astraAssessmentFixtures.cjs');
const fixture = require('./fixtures/astraAssessmentSmallEssay.cjs');
const env = { OPENROUTER_API_KEY: 'offline-key', ASSESSMENT_AI_PRIMARY_RETRIES: '0',
  SEMANTIC_AI_SINGLE_REQUEST_THRESHOLD_TOKENS: '3000' };
const config = () => client.getAssessmentAIConfig(env);
const source = (text = fixture.text) => ({ transcript: text, transcriptHash: 'frozen-source', transcriptComplete: true,
  legend: defaultLegend(), spans: [], pageManifest: [{ startChar: 0, endChar: text.length }], assignment: {} });
const response = content => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
  model: gateway.ASSESSMENT_MODEL, choices: [{ finish_reason: 'stop', message: { content } }] }) });

describe('Astra model-aware operational routing', () => {
  test.each([3432, 7000, 12000])('safe short/modest document with input estimate %i uses one full-document review', async estimate => {
    let clock = 1000;
    const plan = execution.plan({ startedAt: clock, env });
    const semanticService = { buildSemanticRequest: () => ({ promptInputTokenEstimate: estimate }),
      analyze: jest.fn(async input => {
        if (input.analysisMode) throw Error('Unnecessary optional request would time out');
        clock += 20000;
        return reviewedResult(input);
      }) };
    const result = await coordinator.analyze({ ...source(), deadlineAt: plan.correctionDeadlineAt },
      { env, now: () => clock, config: config(), semanticService });
    expect(fixture.text).toHaveLength(729);
    expect(fixture.text.split(/\s+/)).toHaveLength(127);
    expect(fixture.text.split('\n')).toHaveLength(19);
    expect(result.metrics).toMatchObject({ mode: 'single', mainCorrectionRequestCount: 1,
      structuralRequestCount: 0, auditRequestCount: 0, recoveryRequestCount: 0, routingReason: 'single_efficient' });
    expect(result.metrics.outputRisk).toMatchObject({ wordCount: 127, sentenceCount: 3, pageCount: 1, highRisk: false });
    expect(semanticService.analyze.mock.calls[0][0].categories).toEqual(expect.arrayContaining(categories));
    expect(result.status).toBe('completed');
    expect(plan.assessmentDeadlineAt - clock).toBeGreaterThanOrEqual(plan.rubricReservedBudgetMs);
    let rubricAttempts = 0;
    await client.runSemanticCompletion({ config: config(), env, messages: [], now: () => clock,
      deadlineAt: execution.stageDeadline(clock, plan.rubricBudgetMs, plan.assessmentDeadlineAt),
      feature: 'semantic_rubric_assessment', fetchImpl: async () => { rubricAttempts++; clock += 19000; return response('{}'); } });
    expect(rubricAttempts).toBe(1);
  });
  test.each([
    ['density', 'he are wrong . this has  two spaces. '.repeat(110), 4000, 1],
    ['long', 'A thoughtful explanation follows. '.repeat(700), 14000, 1],
    ['large multi-page', 'A thoughtful explanation follows. '.repeat(350), 10000, 4],
    ['context envelope', fixture.text, 27000, 1]
  ])('%s pressure preserves chunked/structural mode', async (_, text, estimate, pageCount) => {
    const data = source(text); data.pageManifest = Array.from({ length: pageCount }, () => ({ startChar: 0, endChar: text.length }));
    const semanticService = { buildSemanticRequest: () => ({ promptInputTokenEstimate: estimate }),
      analyze: jest.fn(async input => reviewedResult(input)) };
    const result = await coordinator.analyze(data, { env, config: config(), semanticService });
    expect(result.metrics.mode).toBe('chunked');
    expect(semanticService.analyze.mock.calls.some(([input]) => input.analysisMode === 'document_structure')).toBe(true);
    expect(result.metrics.routingReason).toBe(estimate === 27000 ? 'safe_request_envelope' : 'output_risk');
  });
  test('legacy models retain their own threshold; Astra ignores that obsolete env threshold', () => {
    expect(execution.modelCapabilities('legacy-model', env)).toBeNull();
    expect(execution.modelCapabilities(gateway.ASSESSMENT_MODEL, env).preferredSingleRequestTokens).toBe(16000);
  });
});

describe('absolute stage deadlines and bounded recovery', () => {
  test('long-document recovery still consumes only correction time and cannot starve the real rubric attempt', async () => {
    let clock = 1000;
    const plan = execution.plan({ startedAt: clock, env });
    const deadlines = [];
    const semanticService = { buildSemanticRequest: () => ({ promptInputTokenEstimate: 3432 }),
      analyze: jest.fn(async input => {
        deadlines.push(input.deadlineAt);
        clock = Math.min(clock + 90000, input.deadlineAt);
        throw Object.assign(Error('mock transport timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
      }) };
    await expect(coordinator.analyze({ ...source('word '.repeat(300)), deadlineAt: plan.correctionDeadlineAt },
      { env, now: () => clock, config: config(), semanticService })).rejects.toMatchObject({ code: 'AI_ATTEMPT_TIMEOUT' });
    expect(deadlines).toEqual([plan.correctionDeadlineAt, plan.correctionDeadlineAt]);
    const fetchImpl = jest.fn(async () => response('{}'));
    await client.runSemanticCompletion({ config: config(), env, messages: [], now: () => clock,
      deadlineAt: execution.stageDeadline(clock, plan.rubricBudgetMs, plan.assessmentDeadlineAt),
      feature: 'semantic_rubric_assessment', fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(plan.assessmentDeadlineAt - clock).toBeGreaterThanOrEqual(90000);
  });
  test('expired deadlines cannot reset at either facade or gateway', async () => {
    const fetchImpl = jest.fn();
    for (const run of [client.runSemanticCompletion, gateway.generate]) {
      await expect(run({ messages: [], config: config(), env, feature: 'semantic_corrections',
        deadlineAt: 100, now: () => 101, fetchImpl })).rejects.toMatchObject({ code: 'AI_TOTAL_BUDGET_EXHAUSTED' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('attempt timeout is assessment-specific and configurable without global inheritance', () => {
    expect(config().attemptTimeoutMs).toBe(90000);
    expect(client.getAssessmentAIConfig({ ...env, ASSESSMENT_AI_ATTEMPT_TIMEOUT_MS: '120000' }).attemptTimeoutMs).toBe(120000);
    expect(execution.plan({ startedAt: 1000, env }).correctionDeadlineAt).toBe(181000);
  });
  test('true hard-budget exhaustion is explicit and preserves safe stage-specific error codes', () => {
    const plan = execution.plan({ startedAt: 1000, env: { ...env, ASSESSMENT_AI_TOTAL_BUDGET_MS: '1000' } });
    expect(() => execution.assertRemaining(plan.correctionDeadlineAt, 1000)).toThrow();
    const { safeErrorCode } = require('../src/services/canonicalResultState.service');
    for (const code of ['ASSESSMENT_CORRECTION_STAGE_BUDGET_EXHAUSTED', 'ASSESSMENT_RUBRIC_STAGE_BUDGET_EXHAUSTED'])
      expect(safeErrorCode(Object.assign(Error('No budget'), { code }))).toBe(code);
  });
  test('structural and combined audit requests inherit the identical deadline, with no nested retries', async () => {
    const inputs = [], deadlineAt = Date.now() + 60000;
    const semanticService = { analyze: jest.fn(async (input, deps) => {
      inputs.push(input); expect(deps.config.primaryRetries).toBe(0);
      return reviewedResult(input);
    }) };
    const result = await coordinator.analyze({ ...source(fixture.text.repeat(12)), deadlineAt },
      { env, config: config(), semanticService, settings: { preferredSingleRequestTokens: 1 } });
    expect(inputs.every(input => input.deadlineAt === deadlineAt && input.disableCategoryAudit)).toBe(true);
    expect(inputs.some(input => input.analysisMode === 'document_structure')).toBe(true);
    expect(inputs.filter(input => input.analysisMode === 'zero_result_audit')).toHaveLength(1);
    expect(result.status).toBe('completed');
  });
});

describe('legitimate zero and bounded, source-preserving audit', () => {
  test('actual schema-valid short zero does not trigger the old length-only audit', async () => {
    const data = source(), runCompletion = jest.fn(async request => ({ value: request.validate(JSON.stringify(reviewPayload(data.transcriptHash))),
      provider: 'openrouter', model: gateway.ASSESSMENT_MODEL, metrics: { attempts: [] } }));
    const result = await coordinator.analyze(data, { env, config: config(), runCompletion });
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(result.diagnostics.categoryReviewStatus.CONTENT).toBe('ZERO_AFTER_REVIEW');
    expect(result.diagnostics.categoryReviewStatus.ORGANIZATION).toBe('ZERO_AFTER_REVIEW');
  });
  test('short fully reviewed candidate-dense essay skips optional audit and preserves accepted evidence', async () => {
    const data = source('He are here . this has  two spaces. '.repeat(20));
    const correction = canonical.normalizeCorrection(finding('CONTENT', 'TA', 'He are here'), data.transcript, [], data.legend, 'AI');
    const semanticService = { buildSemanticRequest: () => ({ promptInputTokenEstimate: 3432 }),
      analyze: jest.fn(async input => {
        if (input.analysisMode === 'zero_result_audit') throw Object.assign(Error('timeout'), { code: 'AI_ATTEMPT_TIMEOUT' });
        return reviewedResult(input, [correction]);
      }) };
    const result = await coordinator.analyze(data, { env, config: config(), semanticService, settings: { enabled: false } });
    expect(semanticService.analyze).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed'); expect(result.corrections).toEqual([correction]);
    expect(result.coverage.categoryCoverageComplete.GRAMMAR).toBe(true);
    expect(result.metrics.auditRequestCount).toBe(0);
    expect(result.diagnostics.qualityAuditStatus).toBe('skipped_complete_review');
  });
});
