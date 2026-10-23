'use strict';
const gateway = require('../src/services/aiGateway.service');
const client = require('../src/services/semanticAIClient.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const policy = require('../src/services/teacherEvaluationPolicy.service');
const canonical = require('../src/services/correctionCanonical.service');
const rubric = require('../src/services/semanticRubricAssessment.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { categories, reviewPayload, reviewedResult, finding } = require('./helpers/astraAssessmentFixtures.cjs');
const model = 'openai/gpt-6-astra';
const env = { OPENROUTER_API_KEY: 'offline-key', ASSESSMENT_AI_MODEL: model,
  ASSESSMENT_AI_PRIMARY_RETRIES: '0', AI_RETRY_DELAY_MS: '0' };
const config = () => client.getAssessmentAIConfig(env);
const response = (content, returnedModel = model) => ({ ok: true, status: 200,
  headers: { get: () => null }, text: async () => JSON.stringify({ model: returnedModel,
    choices: [{ finish_reason: 'stop', message: { content } }] }) });
const input = (transcript = 'A relevant, clear idea is supported by an example.') => ({
  transcript, transcriptHash: 'frozen-input-hash', spans: [], legend: defaultLegend(),
  transcriptComplete: true, policy: policy.normalizeTeacherEvaluationPolicy({}),
  assignment: { title: 'Discuss social expectations and sense of self.', instructions: 'Explain both dimensions with examples.' }
});
const mockCompletion = (payload) => jest.fn(async ({ validate, config: selected }) => ({
  content: JSON.stringify(payload), value: validate(JSON.stringify(payload)), model: selected.model, provider: selected.provider,
  metrics: { attempts: [] }
}));

describe('Astra assessment authority and closed transport', () => {
  test('ignores deprecated assessment/global fallback models and keeps global AI independent', () => {
    const configured = { ...env, AI_PRIMARY_PROVIDER: 'google', AI_PRIMARY_MODEL: 'unrelated-chat-model',
      GEMINI_API_KEY: 'test-google', ASSESSMENT_AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
      ASSESSMENT_AI_FALLBACK_1_PROVIDER: 'google', ASSESSMENT_AI_FALLBACK_1_MODEL: 'gemini' };
    expect(client.getAssessmentAIConfig(configured)).toMatchObject({ model, fallback: null,
      chain: [{ model, provider: 'openrouter', fallbackIndex: 0 }] });
    expect(gateway.getAIConfig(configured).chain[0].model).toBe('unrelated-chat-model');
    expect(() => client.getAssessmentAIConfig({ ...env, ASSESSMENT_AI_MODEL: 'openai/gpt-4.1' })).toThrow();
  });
  test.each(['semantic_corrections', 'semantic_corrections_category_audit', 'semantic_rubric_assessment',
    'rubric_completion', 'rubric_completion_repair', 'rubric_from_file', 'submission_feedback', 'teacher_comment_draft'])('%s cannot accept a substituted model or fallback chain', async feature => {
    const fetchImpl = jest.fn();
    await expect(gateway.generate({ feature, messages: [], env, fetchImpl,
      config: { ...gateway.getAssessmentAIConfig(env), chain: [{ provider: 'openrouter', model: 'openai/gpt-4.1', fallbackIndex: 0 }] }
    })).rejects.toMatchObject({ code: 'AI_ASSESSMENT_AUTHORITY_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test.each(['semantic_corrections', 'semantic_corrections_category_audit', 'semantic_rubric_assessment',
    'rubric_completion', 'rubric_completion_repair', 'rubric_from_file', 'submission_feedback', 'teacher_comment_draft'])
  ('%s rejects returned model mismatch with no fallback request', async feature => {
    const fetchImpl = jest.fn(async () => response('{}', 'openai/gpt-4.1-mini'));
    await expect(client.runSemanticCompletion({ messages: [], config: config(), env, fetchImpl,
      feature })).rejects.toMatchObject({ finalFailureCode: 'AI_ASSESSMENT_MODEL_MISMATCH' });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  test('expired shared budget makes zero attempts', async () => {
    const fetchImpl = jest.fn();
    await expect(client.runSemanticCompletion({ messages: [], config: config(), env, fetchImpl,
      deadlineAt: 100, now: () => 101 })).rejects.toMatchObject({ code: 'AI_TOTAL_BUDGET_EXHAUSTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('explicit category and exact-source review', () => {
  test('zero Content/Organization after explicit complete review is a valid zero', async () => {
    const data = input(), runCompletion = mockCompletion(reviewPayload(data.transcriptHash));
    const result = await coordinator.analyze(data, { config: config(), env, runCompletion });
    expect(result.status).toBe('completed'); expect(result.corrections).toEqual([]);
    expect(result.coverage.categoryCoverageComplete).toEqual(Object.fromEntries(categories.map(c => [c, true])));
    expect(result.diagnostics.categoryReviewStatus.CONTENT).toBe('ZERO_AFTER_REVIEW');
    expect(runCompletion).toHaveBeenCalledTimes(1);
  });
  test('missing category declaration or symbol coverage is invalid, never a fake zero', () => {
    const payload = reviewPayload('h'); delete payload.categories.CONTENT;
    expect(() => semantic.parseJson(JSON.stringify(payload), 'h')).toThrow();
    const incomplete = reviewPayload('h'); incomplete.categories.ORGANIZATION.reviewedSymbols.pop();
    expect(() => semantic.parseJson(JSON.stringify(incomplete), 'h')).toThrow();
  });
  test('transport success without semantic review cannot mark category coverage complete', async () => {
    const semanticService = { analyze: jest.fn(async () => ({ corrections: [], diagnostics: {} })) };
    const result = await coordinator.analyze(input(), { semanticService, config: config(), env });
    expect(result.status).toBe('partial'); expect(result.coverage.coverageComplete).toBe(false);
    expect(Object.values(result.coverage.categoryCoverageComplete)).not.toContain(true);
  });
  test.each(defaultLegend().groups.flatMap(group => group.symbols.map(item => [group.key, item.symbol])))
   ('supports authoritative %s/%s without changing source or taxonomy', (category, symbol) => {
      const data = input('marrige');
      const result = semantic.validateCorrections([finding(category, symbol, 'marrige', { suggestedText: 'marriage' })],
        { ...data, legend: semantic.compactSemanticLegend(data.legend) });
      expect(result.corrections).toHaveLength(1); expect(result.corrections[0].category).toBe(category);
      expect(result.corrections[0].quotedText).toBe('marrige'); expect(data.transcript).toBe('marrige');
    });
  test.each([
    ['CONTENT', 'DEV', 'Society controls people.'], ['CONTENT', 'SD', 'This expectation changes her life.'],
    ['CONTENT', 'TA', 'She feels free.'], ['CONTENT', 'CL', 'Her self is the ownership of other thoughts.'],
    ['CONTENT', 'REL', 'My bicycle has a new wheel.'], ['ORGANIZATION', 'COH', 'She feels free. My bicycle has a new wheel.'],
    ['ORGANIZATION', 'CO', 'However, she also feels free.'], ['ORGANIZATION', 'PU', 'My bicycle has a new wheel.'],
    ['ORGANIZATION', 'TS', 'This is what happens next.'], ['ORGANIZATION', 'CONC', 'Another example is']
  ])('accepts exact-source mocked %s/%s and rejects invented replacement quotes', (category, symbol, transcript) => {
    const data = input(transcript), legend = semantic.compactSemanticLegend(data.legend);
    const result = semantic.validateCorrections([finding(category, symbol, transcript)], { ...data, legend });
    expect(result.corrections).toHaveLength(1);
    expect(() => semantic.validateCorrections([finding(category, symbol, 'Invented source passage.')], { ...data, legend })).toThrow();
  });
  test('never accepts a conclusion correction from incomplete transcript context', () => {
    const data = input('Another example is'), legend = semantic.compactSemanticLegend(data.legend);
    expect(() => semantic.validateCorrections([finding('ORGANIZATION', 'CONC', data.transcript)],
      { ...data, legend, transcriptComplete: false })).toThrow();
  });
  test('a complete transcript still cannot ground CONC in an unrelated opening passage', () => {
    const data = input('An opening idea. ' + 'Supporting details follow. '.repeat(12));
    expect(() => semantic.validateCorrections([finding('ORGANIZATION', 'CONC', 'An opening idea.')],
      { ...data, legend: semantic.compactSemanticLegend(data.legend) })).toThrow();
  });
  test('exact occurrence disambiguates repeats and nonliteral quotes never fuzzy-match', () => {
    const data = input('relize and relize');
    const result = semantic.validateCorrections([finding('MECHANICS', 'SP', 'relize', { occurrence: 1, suggestedText: 'realize' })],
      { ...data, legend: semantic.compactSemanticLegend(data.legend) });
    expect(result.corrections[0].startChar).toBe(11);
    expect(() => semantic.validateCorrections([finding('MECHANICS', 'SP', 'realize')],
      { ...data, legend: semantic.compactSemanticLegend(data.legend) })).toThrow();
  });
});

describe('one bounded combined category audit', () => {
  const data = () => input('A relevant claim needs support. '.repeat(25));
  const settings = { preferredSingleRequestTokens: 1, chunkInputTokens: 3000, failedChunkRetries: 0 };
  test('single-request optional audit failure preserves explicitly reviewed zero coverage', async () => {
    const source = input('A relevant claim needs support. '.repeat(120));
    const runCompletion = jest.fn(async request => {
      if (runCompletion.mock.calls.length > 1) throw Object.assign(new Error('mocked failure'), { code: 'AI_PROVIDER_UNAVAILABLE' });
      return { value: request.validate(JSON.stringify(reviewPayload(source.transcriptHash))),
        provider: 'openrouter', model, metrics: { attempts: [] } };
    });
    const result = await coordinator.analyze(source, { env, config: config(), runCompletion, settings: { enabled: false } });
    expect(runCompletion).toHaveBeenCalledTimes(2);
    expect(result.status).toBe('completed'); expect(result.coverage.categoryCoverageComplete.CONTENT).toBe(true);
    expect(result.coverage.categoryCoverageComplete.ORGANIZATION).toBe(true);
    expect(result.corrections).toEqual([]);
  });
  test.each([false, true])('Content/Organization zero is audited together and may remain zero (findings=%s)', async addFinding => {
    const requests = [], source = data();
    const semanticService = { analyze: jest.fn(async request => {
      requests.push(request);
      const corrections = request.analysisMode === 'zero_result_audit' && addFinding
        ? [canonical.normalizeCorrection(finding('CONTENT', 'DEV', 'A relevant claim needs support.'),
          source.transcript, [], source.legend, 'AI')] : [];
      return reviewedResult(request, corrections);
    }) };
    const result = await coordinator.analyze(source, { semanticService, config: config(), env, settings });
    const audits = requests.filter(request => request.analysisMode === 'zero_result_audit');
    expect(audits).toHaveLength(1); expect(audits[0].categories).toEqual(expect.arrayContaining(['CONTENT', 'ORGANIZATION']));
    expect(requests.every(request => request.policy === source.policy)).toBe(true);
    expect(result.status).toBe('completed'); expect(result.corrections).toHaveLength(addFinding ? 1 : 0);
    expect(result.metrics.providerCallCount).toBe(semanticService.analyze.mock.calls.length);
  });
  test('failed optional audit preserves independently validated chunk/structural reviews', async () => {
    const semanticService = { analyze: jest.fn(async request => {
      if (request.analysisMode === 'zero_result_audit') throw Object.assign(new Error('offline mocked failure'), { code: 'AI_PROVIDER_UNAVAILABLE' });
      return reviewedResult(request);
    }) };
    const result = await coordinator.analyze(data(), { semanticService, config: config(), env, settings });
    expect(result.coverage.categoryCoverageComplete.CONTENT).toBe(true);
    expect(result.coverage.categoryCoverageComplete.ORGANIZATION).toBe(true);
    expect(result.status).toBe('completed'); expect(result.corrections).toEqual([]);
    expect(result.diagnostics.categoryAudit.status).toBe('audit_failed');
  });
  test('failed structural pass cannot be disguised as complete by successful local chunks or audit', async () => {
    const semanticService = { analyze: jest.fn(async request => {
      if (request.analysisMode === 'document_structure') throw new Error('structural failure');
      return reviewedResult(request);
    }) };
    const result = await coordinator.analyze(data(), { semanticService, config: config(), env, settings });
    expect(result.coverage.structuralPassStatus).toBe('failed');
    expect(result.coverage.categoryCoverageComplete.CONTENT).toBe(false);
    expect(result.coverage.categoryCoverageComplete.VOCABULARY).toBe(true);
  });
});

describe('immutable teacher policy and rubric evidence', () => {
  test.each([false, true])('rubric policy and exact evidence rules apply with language categories=%s', includeLanguageCategories => {
    const source = input();
    const prompt = rubric.buildRequest({ ...source, sourceHash: 'h', includeLanguageCategories }).messages[1].content;
    expect(prompt).toContain('Friendly suppresses trivial refinements but retains clear significant weaknesses');
    expect(prompt).toContain('factChecking=true never permits unsupported factual assertions');
    expect(prompt).toContain('Never rewrite or normalize it before assessment');
    expect(prompt).not.toContain('Canonical corrections are unavailable,');
  });
  test('strictness changes a defensible confidence threshold while grounding remains mandatory', () => {
    const source = input('Society controls people.'), legend = semantic.compactSemanticLegend(source.legend);
    const candidate = finding('CONTENT', 'DEV', source.transcript, { confidence: .74, severity: 'low' });
    expect(() => semantic.validateCorrections([candidate], { ...source, legend, policy: { strictness: 'balanced' } })).toThrow();
    expect(semantic.validateCorrections([candidate], { ...source, legend, policy: { strictness: 'strict' } }).corrections).toHaveLength(1);
    expect(() => semantic.validateCorrections([{ ...candidate, quotedText: 'Invented claim' }],
      { ...source, legend, policy: { strictness: 'strict' } })).toThrow();
  });
  test('the configured current rubric takes precedence over a stale legacy rubric in both prompts', () => {
    const source = input(); source.assignment = { ...source.assignment, rubric: { title: 'old' }, rubrics: { title: 'current' } };
    expect(semantic.compactAssignment(source.assignment).rubric.title).toBe('current');
    expect(rubric.buildRequest({ transcript: source.transcript, sourceHash: 'h', assignment: source.assignment })
      .messages[1].content).toContain('"rubric":{"title":"current"}');
  });
  test('review identity changes with policy or custom rubric without changing OCR/source identity', () => {
    const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
    const source = input();
    const identity = pipeline.buildCorrectionReviewIdentity(source);
    expect(pipeline.buildCorrectionReviewIdentity({ ...source, policy: { strictness: 'strict' } })).not.toBe(identity);
    expect(pipeline.buildCorrectionReviewIdentity({ ...source, assignment: { ...source.assignment,
      rubrics: { criteria: [{ title: 'Evidence', weight: 100 }] } } })).not.toBe(identity);
    expect(pipeline.buildCorrectionSourceHash({ transcript: source.transcript, assignment: source.assignment }))
      .toBe(pipeline.buildCorrectionSourceHash({ transcript: source.transcript, assignment: { ...source.assignment,
        rubrics: { criteria: [{ title: 'Evidence', weight: 100 }] } } }));
  });
  test('holistic and explicitly localized rubric concerns are diagnostics, never new corrections', () => {
    const { rubricCoverageDiagnostics } = require('../src/services/canonicalEvaluation.service');
    const semantic = { categories: {
      CONTENT: { score: 12, maxScore: 20, improvementEvidence: [{ findingScope: 'holistic' }] },
      ORGANIZATION: { score: 13, maxScore: 20, improvementEvidence: [{ findingScope: 'localized' }] }
    } };
    const statistics = { content: 0, organization: 0 }, before = JSON.stringify({ semantic, statistics });
    expect(rubricCoverageDiagnostics(semantic, statistics)).toEqual({ rubricConcernCategories: ['CONTENT', 'ORGANIZATION'],
      categoryCoverageDisagreements: [{ category: 'CONTENT', code: 'CONTENT_HOLISTIC_WITH_ZERO_LOCAL_CORRECTIONS' },
        { category: 'ORGANIZATION', code: 'CATEGORY_COVERAGE_DISAGREEMENT' }] });
    expect(JSON.stringify({ semantic, statistics })).toBe(before);
  });
  test.each(['friendly', 'balanced', 'strict'])('%s preserves clear significant Content/Organization/language errors and rejects style/ungrounded output', strictness => {
    const data = input('Society controls people. She Know the truth.');
    const snapshot = policy.normalizeTeacherEvaluationPolicy({ strictness });
    const findings = [finding('CONTENT', 'DEV', 'Society controls people.'),
      finding('ORGANIZATION', 'COH', 'She Know the truth.'), finding('GRAMMAR', 'AGR', 'She Know', { suggestedText: 'She knows' })];
    const result = semantic.validateCorrections(findings, { ...data, policy: snapshot, legend: semantic.compactSemanticLegend(data.legend) });
    expect(result.corrections).toHaveLength(3); expect(Object.isFrozen(snapshot.checks)).toBe(true);
    expect(policy.normalizeTeacherEvaluationPolicy(snapshot)).toBe(snapshot);
    expect(() => semantic.validateCorrections([finding('VOCABULARY', 'WC', 'people', { stylePreference: true })],
      { ...data, policy: snapshot, legend: semantic.compactSemanticLegend(data.legend) })).toThrow();
  });
  test('disabled checks remove their categories from the actual request, never claim they were reviewed', async () => {
    const source = input(); source.policy = policy.normalizeTeacherEvaluationPolicy({ checks: { coherenceLogic: false, grammarSpelling: false } });
    const runCompletion = mockCompletion(reviewPayload(source.transcriptHash, ['VOCABULARY']));
    const result = await coordinator.analyze(source, { config: config(), env, runCompletion });
    expect(runCompletion.mock.calls[0][0].responseSchema.properties.categories.required).toEqual(['VOCABULARY']);
    expect(result.coverage.categoryCoverageComplete.CONTENT).toBe(false); expect(result.status).toBe('completed');
  });
  test('prompt retains exact source and distinguishes category review from holistic observations', () => {
    const source = input('She Know  the truth.\nBut she was empty Soul.');
    const request = semantic.buildSemanticRequest(source), prompt = request.messages[1].content;
    expect(prompt).toContain(source.transcript); expect(prompt).toContain('Friendly suppresses trivial refinements');
    expect(prompt).toContain('CONTENT concerns meaning'); expect(prompt).toContain('COH (coherence): check progression');
    expect(prompt).toContain('CONC (closure): when transcriptComplete=true');
    expect(request.legend).toEqual(semantic.compactSemanticLegend(defaultLegend()));
    expect(rubric.buildRequest({ transcript: source.transcript, sourceHash: 'h', policy: source.policy }).messages[1].content)
      .toContain('findingScope=localized');
  });
});
