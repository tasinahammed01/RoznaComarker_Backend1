'use strict';
const crypto = require('crypto');
const semantic = require('../src/services/semanticWritingCorrections.service');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const client = require('../src/services/semanticAIClient.service');
const wire = require('../src/services/compactCorrectionWire.service');
const policy = require('../src/services/teacherEvaluationPolicy.service');
const budgets = require('../src/services/assessmentExecutionPolicy.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewPayload, finding } = require('./helpers/astraAssessmentFixtures.cjs');
const env = { OPENROUTER_API_KEY: 'offline-only', ASSESSMENT_AI_PRIMARY_RETRIES: '0' };
const compact = payload => ({ reviewContract: wire.VERSION, transcriptHash: payload.transcriptHash,
  categories: Object.fromEntries(Object.entries(payload.categories).map(([category, r]) => [category,
    { reviewed: r.reviewed, reviewedSymbols: r.reviewedSymbols,
      corrections: r.corrections.map(({ message, stylePreference, ...item }) => item) }])) });
const source = (transcript, teacher = {}) => ({ transcript, transcriptHash: crypto.createHash('sha256').update(transcript).digest('hex'),
  transcriptComplete: true, legend: defaultLegend(), spans: [], assignment: { instructions: 'Explain the claim with support.' },
  policy: policy.normalizeTeacherEvaluationPolicy(teacher), pageManifest: [{ startChar: 0, endChar: transcript.length }] });
const completion = payload => jest.fn(async request => ({ value: request.validate(JSON.stringify(payload)),
  provider: 'openrouter', model: 'openai/gpt-6-astra', usage: { prompt_tokens: 100, completion_tokens: 200, thoughts_tokens: 20, total_tokens: 300 },
  metrics: { attempts: [{ finishReason: 'stop' }], attemptCount: 1 }));

describe('compact Astra wire preserves canonical contracts', () => {
  test('dense ~100-word essay: five-category coverage, many findings, literal source and bounded output', async () => {
    const data = require('./fixtures/astraCoverageFeedback.cjs').fixture();
    const ending = 'For example, she closes the door.';
    const transcript = data.transcript + ' A clear point offers a useful starting position. '.repeat(3) + ending;
    const input = source(transcript), before = input.transcript;
    const findings = [...data.findings, finding('ORGANIZATION', 'CONC', ending)];
    const payload = compact(reviewPayload(input.transcriptHash, undefined, findings));
    const runCompletion = completion(payload);
    const result = await coordinator.analyze(input, { env, config: client.getAssessmentAIConfig(env), runCompletion });
    expect(transcript.split(/\s+/u).length).toBeGreaterThan(90);
    expect(transcript.split(/\s+/u).length).toBeLessThan(140);
    expect(runCompletion).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('completed');
    expect(result.coverage.coverageComplete).toBe(true);
    expect(result.corrections).toHaveLength(findings.length);
    for (const category of ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'])
      expect(result.corrections.some(c => c.category === category)).toBe(true);
    for (const c of result.corrections) {
      expect(transcript.slice(c.startChar, c.endChar)).toBe(c.quotedText);
      expect(c.message.length).toBeGreaterThan(0); expect(c.id).toBeTruthy();
    }
    expect(input.transcript).toBe(before); expect(source(before).transcriptHash).toBe(input.transcriptHash);
    const request = runCompletion.mock.calls[0][0];
    expect(request.config.model).toBe('openai/gpt-6-astra'); expect(request.config.chain).toHaveLength(1);
    expect(request.config.maxOutputTokens).toBeLessThan(5632);
    expect(Math.ceil(JSON.stringify(payload).length / 4)).toBeLessThan(request.config.maxOutputTokens);
    expect(request.responseSchema.$defs.finding.required).not.toContain('message');
    expect(request.responseSchema.$defs.finding.required).not.toContain('stylePreference');
    expect(result.metrics.recoveryRequestCount).toBe(0);
  });
  test('repeated exact quote maps requested occurrence; fuzzy and invalid quotes rejected individually', async () => {
    const input = source('she go. she go. mispell. A final sentence connects the claim.');
    const candidates = [finding('GRAMMAR', 'AGR', 'she go', { occurrence: 1, suggestedText: 'she goes' }),
      finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' }),
      finding('GRAMMAR', 'AGR', 'She go', { suggestedText: 'She goes' }),
      finding('GRAMMAR', 'AGR', 'she goes', { suggestedText: 'she goes' })];
    const result = await semantic.analyze({ ...input, disableCategoryAudit: true }, { env,
      runCompletion: completion(compact(reviewPayload(input.transcriptHash, undefined, candidates))) });
    expect(result.corrections).toHaveLength(2);
    expect(result.corrections.find(c => c.symbol === 'AGR').startChar).toBe(8);
    expect(result.diagnostics.rejectionReasons.QUOTE_NOT_FOUND).toBe(2);
  });
  test.each(['missing', 'invalid', 'symbols', 'reviewed-false'])('partial %s category never destroys other valid corrections or becomes zero', async mode => {
    const input = source('mispell. A complete ending connects this point.');
    const payload = compact(reviewPayload(input.transcriptHash, undefined, [finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' })]));
    if (mode === 'missing') delete payload.categories.CONTENT;
    if (mode === 'invalid') payload.categories.CONTENT.extra = 'unexpected';
    if (mode === 'symbols') payload.categories.CONTENT.reviewedSymbols.pop();
    if (mode === 'reviewed-false') payload.categories.CONTENT.reviewed = false;
    const runCompletion = completion(payload);
    const dependencies = { env, config: client.getAssessmentAIConfig(env), runCompletion };
    // Coverage repair receives an independently invalid response. No third call.
    runCompletion.mockImplementationOnce(async request => ({ value: request.validate(JSON.stringify(payload)), metrics: { attempts: [] } }))
      .mockImplementationOnce(async () => { throw Object.assign(Error('offline repair failure'), { code: 'AI_ATTEMPT_TIMEOUT' }); });
    const result = await coordinator.analyze(input, dependencies);
    expect(result.status).toBe('partial'); expect(result.coverage.complete).toBe(false);
    expect(result.coverage.categoryCoverageComplete.CONTENT).toBe(false);
    expect(result.coverage.categoryCoverageComplete.MECHANICS).toBe(true);
    expect(result.corrections).toHaveLength(1);
    expect(result.diagnostics.categoryReviewStatus.CONTENT).toBe('CATEGORY_PASS_FAILED');
    expect(runCompletion).toHaveBeenCalledTimes(2);
  });
  test.each(['friendly', 'balanced', 'strict'])('%s: reviewed zero and disabled checks remain honest; identity includes teacher policy', async strictness => {
    const input = source('A complete response connects its claim and its explanation.', { strictness, checks: { grammarSpelling: false } });
    const selected = policy.enabledCorrectionCategories(input.policy);
    const runCompletion = completion(compact(reviewPayload(input.transcriptHash, selected)));
    const result = await coordinator.analyze(input, { env, config: client.getAssessmentAIConfig(env), runCompletion });
    expect(result.coverage.complete).toBe(true); expect(result.corrections).toEqual([]);
    expect(result.diagnostics.reviewedCategories).toEqual(selected);
    expect(result.diagnostics.reviewedCategories).not.toContain('GRAMMAR');
    expect(result.diagnostics.reviewedCategories).not.toContain('MECHANICS');
    expect(runCompletion.mock.calls[0][0].messages[1].content).toContain(`"strictness":"${strictness}"`);
    expect(semantic.semanticSourceKey({ correctionSourceHash: input.transcriptHash, config: client.getAssessmentAIConfig(env), policyHash: policy.evaluationPolicyHash(input.policy) }))
      .not.toBe(semantic.semanticSourceKey({ correctionSourceHash: input.transcriptHash, config: client.getAssessmentAIConfig(env), policyHash: policy.evaluationPolicyHash({ strictness: strictness === 'strict' ? 'friendly' : 'strict' }) }));
  });
  test.each(['hash', 'root-extra', 'invented-symbol', 'malformed', 'all-unreviewed'])('%s fails without fabricated coverage', async mode => {
    const input = source('mispell.'), payload = compact(reviewPayload(input.transcriptHash, undefined, [finding('MECHANICS', 'SP', 'mispell')]));
    if (mode === 'hash') payload.transcriptHash = 'different';
    if (mode === 'root-extra') payload.extra = 'unexpected';
    if (mode === 'invented-symbol') for (const r of Object.values(payload.categories)) r.corrections = [{ ...payload.categories.MECHANICS.corrections[0], symbol: 'FAKE' }];
    if (mode === 'all-unreviewed') for (const r of Object.values(payload.categories)) r.reviewed = false;
    await expect(semantic.analyze({ ...input, disableCategoryAudit: true }, { env,
      runCompletion: mode === 'malformed' ? async request => request.validate('{"categories":') : completion(payload) })).rejects.toBeTruthy();
  });
  test('compact schema is closed and materially smaller; budgets scale with words and categories', () => {
    const input = source('word '.repeat(100));
    const request = semantic.buildSemanticRequest(input), verbose = semantic.buildVerboseSemanticRequest(input);
    expect(request.promptCharacters).toBeLessThan(verbose.promptCharacters * .7);
    const catalog = semantic.categorySymbolCatalog(request.legend);
    const compactSchema = wire.schema(input.transcriptHash, Object.keys(catalog), catalog);
    const oldSchema = require('../src/services/structuredOutputSchemas.service').semanticCorrectionsSchema(input.transcriptHash, Object.keys(catalog), catalog);
    expect(JSON.stringify(compactSchema).length).toBeLessThan(JSON.stringify(oldSchema).length * .6);
    const b = budgets.correctionOutputBudget({ transcript: input.transcript });
    expect(b.requestedOutputTokenBudget).toBeLessThan(5632);
    expect(b.requestedOutputTokenBudget).toBeGreaterThan(b.estimatedRequiredOutputTokens);
    expect(budgets.correctionOutputBudget({ transcript: 'word '.repeat(200) }).requestedOutputTokenBudget).toBeGreaterThan(b.requestedOutputTokenBudget);
  });
});
