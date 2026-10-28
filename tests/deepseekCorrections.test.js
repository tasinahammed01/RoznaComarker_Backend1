'use strict';
const semantic = require('../src/services/semanticWritingCorrections.service');
const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
const gateway = require('../src/services/aiGateway.service');
const client = require('../src/services/semanticAIClient.service');
const wire = require('../src/services/compactCorrectionWire.service');
const policy = require('../src/services/teacherEvaluationPolicy.service');
const canonical = require('../src/services/correctionCanonical.service');
const budgets = require('../src/services/assessmentExecutionPolicy.service');
const { defaultLegend } = require('../src/services/writingCorrections.service');
const { reviewPayload, finding } = require('./helpers/astraAssessmentFixtures.cjs');
const fixture = require('./helpers/claudeQualityFixtures.cjs');
const model = 'deepseek/deepseek-v4.1-flash';
const env = { OPENROUTER_API_KEY: 'offline-only', AI_PRIMARY_PROVIDER: 'openrouter', AI_PRIMARY_MODEL: 'openai/gpt-4.1-mini',
  CORRECTION_DETECTION_MODEL: model, ASSESSMENT_AI_PRIMARY_RETRIES: '0' };
const legend = semantic.compactSemanticLegend(defaultLegend());
const contract = semantic.contractVersions(model);
const input = (transcript = 'mispell', teacher = {}) => ({ transcript, transcriptHash: require('crypto').createHash('sha256').update(transcript).digest('hex'),
  transcriptComplete: true, disableCategoryAudit: true, policy: teacher });
function compact(data, findings = []) {
  const categories = policy.enabledCorrectionCategories(data.policy);
  const payload = reviewPayload(data.transcriptHash, categories, findings);
  return { reviewContract: wire.DEEPSEEK_VERSION, transcriptHash: data.transcriptHash,
    categories: Object.fromEntries(Object.entries(payload.categories).map(([category, r]) => [category, {
      reviewed: true, reviewedSymbols: Object.fromEntries(r.reviewedSymbols.map(symbol => [symbol, true])),
      corrections: r.corrections.map(({ stylePreference, ...c }) => c)
    }])) };
}
const response = (payload, returnedModel = model, finish = 'stop') => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: returnedModel, choices: [{ finish_reason: finish, message: {
    content: typeof payload === 'string' ? payload : JSON.stringify(payload) } }], usage: { prompt_tokens: 100, completion_tokens: 80,
    total_tokens: 180, cost: .0001 } }) });
async function run(data, findings = [], options = {}) {
  const fetchImpl = jest.fn(async () => response(compact(data, findings)));
  const result = await semantic.analyze(data, { env, fetchImpl, ...options });
  return { result, fetchImpl };
}
beforeEach(() => { for (const key of ['info', 'debug', 'warn', 'error']) jest.spyOn(require('../src/utils/logger'), key).mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

test('dedicated routing, rollback, model-specific identities and unchanged OCR/scoring/comments/global selector', () => {
  expect(gateway.getAIConfig(env).chain[0].model).toBe('openai/gpt-4.1-mini');
  expect(client.getCorrectionAIConfig(env)).toMatchObject({ model, thinkingLevel: 'none', fallback: null, chain: [{ provider: 'openrouter', model, fallbackIndex: 0 }] });
  expect(gateway.getAssessmentAIConfig(env).chain[0].model).toBe('openai/gpt-6-astra');
  expect(gateway.getTeacherCommentAIConfig(env).chain[0].model).toBe('anthropic/claude-haiku-5.5');
  expect(client.getCorrectionAIConfig({ ...env, CORRECTION_DETECTION_MODEL: 'openai/gpt-4.1-mini' }).model).toBe('openai/gpt-4.1-mini');
  expect(semantic.contractVersions('openai/gpt-4.1-mini')).toMatchObject({ promptVersion: semantic.SEMANTIC_PROMPT_VERSION, schemaVersion: semantic.SEMANTIC_SCHEMA_VERSION, wireVersion: wire.VERSION });
  expect(contract.promptVersion).not.toBe(semantic.SEMANTIC_PROMPT_VERSION);
  expect(semantic.semanticSourceKey({ correctionSourceHash: 'same', config: client.getCorrectionAIConfig(env) }))
    .not.toBe(semantic.semanticSourceKey({ correctionSourceHash: 'same', config: client.getCorrectionAIConfig({ ...env, CORRECTION_DETECTION_MODEL: 'openai/gpt-4.1-mini' }) }));
  const sourceModels = require('../src/services/gptVisionExact/contract').models();
  expect(sourceModels).toContain('qwen/qwen3.8-27b'); expect(sourceModels).not.toContain(model);
  const { runtimeContractFingerprint } = require('../src/services/runtimeContractFingerprint.service');
  expect(runtimeContractFingerprint(env).contracts).toMatchObject({ correctionPrompt: contract.promptVersion, correctionSchema: contract.schemaVersion });
  const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
  const oldIdentity = pipeline.buildCorrectionReviewIdentity({ model: 'openai/gpt-4.1-mini' });
  expect(oldIdentity).not.toBe(pipeline.buildCorrectionReviewIdentity({ model }));
});

test.each(['semantic_rubric_assessment', 'teacher_comment_draft'])('%s cannot use DeepSeek correction authority', async feature => {
  const fetchImpl = jest.fn();
  await expect(gateway.generate({ feature, config: client.getCorrectionAIConfig(env), env, fetchImpl, messages: [] })).rejects.toBeDefined();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('strict one-call schema, disabled reasoning and no temperature/fallback; source unchanged, explanation preserved', async () => {
  const data = input('  mispell\r\n“Exact”  text.');
  const message = 'The word has a spelling error; use the standard spelling “misspell”.';
  const { result, fetchImpl } = await run(data, [finding('MECHANICS', 'SP', 'mispell', { message, suggestedText: 'misspell' })]);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
  const [url, options] = fetchImpl.mock.calls[0], body = JSON.parse(options.body);
  expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
  expect(body.model).toBe(model); expect(body.reasoning).toEqual({ effort: 'none' }); expect(body).not.toHaveProperty('temperature');
  expect(body.max_tokens).toBe(8000);
  expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
  expect(body.response_format.json_schema.strict).toBe(true);
  expect(body.response_format.json_schema.schema.$defs.finding.required).toContain('message');
  expect(body.messages[1].content.endsWith('transcript=' + data.transcript)).toBe(true);
  expect(result.corrections[0]).toMatchObject({ message, startChar: 2, endChar: 9, quotedText: 'mispell' });
  expect(result.usage.cost).toBe(.0001);
  expect(result.metrics.providerCostUSD).toBe(.0001);
});

test.each(['friendly', 'balanced', 'strict'])('%s preserves frozen synthetic defect targets and all 28 enabled symbols', async strictness => {
  const data = { ...fixture.mixed, transcriptComplete: true, disableCategoryAudit: true, policy: { strictness } };
  const findings = fixture.defects.map(f => finding(f.category, f.symbol, f.quote, { suggestedText: f.allowedSuggestions[0], message: 'This specific synthetic defect requires the indicated minimal revision.' }));
  const { result, fetchImpl } = await run(data, findings);
  expect(fetchImpl).toHaveBeenCalledTimes(1); expect(result.corrections).toHaveLength(7);
  expect(result.diagnostics.totalExpectedSymbols).toBe(28);
  for (const f of fixture.defects) expect(result.corrections.find(c => c.symbol === f.symbol)).toMatchObject({ quotedText: f.quote, category: f.category, suggestedText: f.allowedSuggestions[0] });
  for (const group of legend) for (const item of group.symbols) {
    const data = input('A controlled exact phrase.', { strictness });
    const value = await run(data, [finding(group.category, item.symbol, data.transcript, { suggestedText: 'A revised exact phrase.' })]);
    expect(value.result.corrections[0]).toMatchObject({ symbol: item.symbol, category: group.category });
  }
});

test('valid zero stays zero with one coordinator request; disabled checks remain disabled', async () => {
  const data = input('A correct complete response explains its claim.', { checks: { grammarSpelling: false } });
  const fetchImpl = jest.fn(async () => response(compact(data)));
  const result = await coordinator.analyze(data, { env, fetchImpl });
  expect(result.corrections).toEqual([]); expect(result.status).toBe('completed'); expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(result.diagnostics.reviewedCategories).not.toContain('GRAMMAR');
  expect(result.diagnostics.reviewedCategories).not.toContain('MECHANICS');
});

test.each(['missing-message', 'empty-message', 'unexpected-key', 'missing-review', 'false-review', 'old-wire', 'fenced-json', 'truncated', 'wrong-model'])(
  '%s fails closed without a fallback or fake zero', async mode => {
    const data = input(), payload = compact(data, [finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' })]);
    const c = payload.categories.MECHANICS.corrections[0];
    if (mode === 'missing-message') delete c.message;
    if (mode === 'empty-message') c.message = ' ';
    if (mode === 'unexpected-key') c.unknown = true;
    if (mode === 'missing-review') delete payload.categories.GRAMMAR.reviewedSymbols.FRAG;
    if (mode === 'false-review') payload.categories.GRAMMAR.reviewedSymbols.FRAG = false;
    if (mode === 'old-wire') payload.reviewContract = wire.VERSION;
    const fetchImpl = jest.fn(async () => response(mode === 'fenced-json' ? '```json\n' + JSON.stringify(payload) + '\n```' : payload,
      mode === 'wrong-model' ? 'deepseek/deepseek-v4.1-flash-alias' : model, mode === 'truncated' ? 'length' : 'stop'));
    await expect(semantic.analyze(data, { env, fetchImpl })).rejects.toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

test('repeated quotes, nonliteral quotes and thresholds remain distinct; all rejected findings fail', async () => {
  const data = input('she go. she go. mispell');
  const findings = [finding('GRAMMAR', 'AGR', 'she go', { occurrence: 1, suggestedText: 'she goes' }),
    finding('MECHANICS', 'SP', 'mispell', { suggestedText: 'misspell' }),
    finding('GRAMMAR', 'VF', 'she goes', { suggestedText: 'she went' }),
    finding('VOCABULARY', 'WC', 'she go', { suggestedText: 'they go', confidence: .01 })];
  const { result } = await run(data, findings);
  expect(result.corrections).toHaveLength(2);
  expect(result.corrections[0]).toMatchObject({ symbol: 'AGR', startChar: 8 });
  expect(result.diagnostics.rejectionReasons).toMatchObject({ QUOTE_NOT_FOUND: 1, LOW_CONFIDENCE: 1 });
  await expect(run(data, [findings[2]])).rejects.toBeDefined();
});

test.each([429, 503])('%i has bounded same-model retry, never a different model', async status => {
  const data = input(), fetchImpl = jest.fn().mockResolvedValueOnce({ ok: false, status, headers: { get: () => '0' }, text: async () => '{}' })
    .mockResolvedValueOnce(response(compact(data)));
  const config = { ...client.getCorrectionAIConfig(env), primaryRetries: 1, retryDelayMs: 0 };
  await semantic.analyze(data, { env, config, fetchImpl });
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(fetchImpl.mock.calls.every(([, options]) => JSON.parse(options.body).model === model)).toBe(true);
});

test('attempt timeout is bounded and terminal when retries are zero', async () => {
  const data = input(), fetchImpl = jest.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort',
    () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true })));
  await expect(semantic.analyze(data, { env, fetchImpl, config: { ...client.getCorrectionAIConfig(env), attemptTimeoutMs: 10, totalBudgetMs: 100 } })).rejects.toBeDefined();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('unsupported required reasoning parameter fails closed without removing it or trying another model', async () => {
  const fetchImpl = jest.fn(async (_url, options) => {
    const body = JSON.parse(options.body);
    expect(body.reasoning).toEqual({ effort: 'none' });
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false });
    return { ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({
      error: { code: 400, message: 'Required reasoning parameter unsupported.', param: 'reasoning' }
    }) };
  });
  await expect(semantic.analyze(input(), { env, fetchImpl })).rejects.toMatchObject({ finalFailureCode: 'AI_PROVIDER_INVALID_REQUEST' });
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});

test('DeepSeek-only disable survives unrelated settings; compact output guidance keeps exact strings and schema limits', () => {
  const altered = { ...env, CORRECTION_REASONING_EFFORT: 'high', GEMINI_CORRECTION_REASONING_EFFORT: 'high', GPT54_MINI_CORRECTION_REASONING_EFFORT: 'high' };
  const config = client.getCorrectionAIConfig(altered);
  expect(config.thinkingLevel).toBe('none');
  expect(gateway.correctionRequestPolicy({ provider: 'openrouter', model, feature: 'semantic_corrections', env: altered }).reasoning).toEqual({ effort: 'none' });
  expect(gateway.correctionRequestPolicy({ provider: 'openrouter', model: 'openai/gpt-4.1-mini', feature: 'semantic_corrections', env: altered }).reasoning).toBeNull();
  const data = { ...input('word\r\n  word'), correctionModel: model }, request = semantic.buildSemanticRequest(data);
  expect(request.messages[1].content).toContain('compact JSON object without indentation');
  expect(request.messages[1].content).toContain('preserve whitespace inside string values exactly');
  expect(request.messages[1].content.endsWith('transcript=' + data.transcript)).toBe(true);
  const schema = wire.schema(data.transcriptHash, Object.keys(semantic.categorySymbolCatalog(request.legend)), semantic.categorySymbolCatalog(request.legend), wire.DEEPSEEK_VERSION);
  expect(schema.$defs.finding.properties.message.maxLength).toBe(240);
  expect(schema.$defs.finding.properties.quotedText.maxLength).toBe(500);
  expect(schema.$defs.finding.properties.suggestedText.maxLength).toBe(300);
  for (const category of Object.values(schema.properties.categories.properties)) expect(category.properties.corrections).not.toHaveProperty('maxItems');
});

test.each([10, 25, 50])('%i concurrent students keep four active provider calls and no extra calls', async count => {
  const data = input('A correct response.'), payload = compact(data); let active = 0, peak = 0;
  const fetchImpl = jest.fn(async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return response(payload); });
  const results = await Promise.all(Array.from({ length: count }, () => semantic.analyze(data, { env, fetchImpl })));
  expect(results).toHaveLength(count); expect(fetchImpl).toHaveBeenCalledTimes(count); expect(peak).toBeLessThanOrEqual(4);
  expect(require('../src/services/correctionAdmission.service').shared.snapshot()).toEqual({ active: 0, queued: 0, limit: 4, queueLimit: 64 });
});

test('no source-ID catalog, no benchmark hints, versioned prompt/profile and bounded explanation budget', () => {
  const data = { ...input(), correctionModel: model }, request = semantic.buildSemanticRequest(data);
  const text = JSON.stringify(request.messages);
  expect(text).toContain(contract.promptVersion); expect(text).toContain('possessive apostrophe (P)');
  expect(text).not.toContain('sourceSpanCatalog');
  for (const f of fixture.defects) expect(text).not.toContain(f.quote);
  const measured = budgets.correctionOutputBudget({ transcript: 'word '.repeat(127), model });
  expect(measured.requestedOutputTokenBudget).toBeLessThanOrEqual(8000);
  expect(measured.estimatedRequiredOutputTokens).toBeGreaterThan(budgets.correctionOutputBudget({ transcript: 'word '.repeat(127) }).estimatedRequiredOutputTokens);
  expect(request.tokenProfile.responseSchemaTokens).toBeGreaterThan(0);
});

test('quality diagnostics flag a grounded wrong-target finding and correct-text false positive', async () => {
  const data = { ...fixture.mixed, transcriptComplete: true, disableCategoryAudit: true };
  const correct = fixture.negativeControls.find(s => data.transcript.includes(s));
  const raw = [finding('GRAMMAR', 'AGR', correct, { suggestedText: 'A changed synthetic sentence.' })];
  const { result } = await run(data, raw);
  const metrics = require('../src/services/correctionQualityDiagnostics.service').measureGrounding({ transcript: data.transcript,
    rawCorrections: raw, acceptedCorrections: result.corrections, defects: [fixture.defects[0]], negativeControls: [correct], catalog: semantic.categorySymbolCatalog(legend) });
  expect(metrics.expectedSymbols[0].stage).toBe('SYMBOL_ACCEPTED_WRONG_DEFECT');
  expect(metrics.acceptedNegativeControlIntersectionCount).toBe(1);
});

test.each([['one image', 1, false], ['two images', 2, false], ['five images', 5, false], ['two PDF pages', 2, true]])(
  '%s preserves original word/page/file identities with one correction request', async (_label, count, pdf) => {
    const fidelity = require('../src/utils/sourceFidelity');
    const pages = Array.from({ length: count }, (_, index) => ({ fileId: pdf ? 'pdf' : `file-${index}`, fileOrder: pdf ? 0 : index,
      pageIndex: index, pageNumber: pdf ? index + 1 : 1, sourceFidelityMode: 'gpt_vision_exact', sourceFidelityStatus: 'GPT_SOURCE_ACCEPTED',
      sourceFidelityVersion: require('../src/services/gptVisionExact/contract').VERSION, sourceTextExact: 'mispell', sourceTextSha256: fidelity.sha('mispell'),
      words: [{ id: `word-${index}`, text: 'mispell', sourceStart: 0, sourceEnd: 7 }] }));
    const doc = { files: [...new Set(pages.map(p => p.fileId))], ocrPages: pages, ...fidelity.aggregate({ ocrPages: pages }) };
    const source = require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript(doc);
    const data = { ...input(source.text), spans: source.wordSpans, pageManifest: source.pages };
    const raw = pages.map((_, index) => finding('MECHANICS', 'SP', 'mispell', { occurrence: index, suggestedText: 'misspell' }));
    const { result, fetchImpl } = await run(data, raw);
    expect(fetchImpl).toHaveBeenCalledTimes(1); expect(result.corrections).toHaveLength(count);
    result.corrections.forEach((c, index) => expect(c).toMatchObject({ fileId: pages[index].fileId, page: pages[index].pageNumber, wordIds: [`word-${index}`] }));
    expect(canonical.mergeCanonicalCorrections({ aiCorrections: [...result.corrections, result.corrections[0]] }).corrections).toHaveLength(count);
  });

test('DeepSeek replay mock checks the current wire/one-fetch guard without consuming a marker; live needs authorization', () => {
  const fs = require('fs'), path = require('path'), cp = require('child_process');
  const root = path.resolve(__dirname, '../..'), marker = path.join(root, 'backend/tmp/deepseek-correction-replay-v2/one-call-consumed.json');
  const before = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  const invoke = mode => cp.spawnSync(process.execPath, ['--require', './backend/tests/offlineProviderGuard.cjs',
    'tmp/gpt41-symbol-map-one-shot.cjs', mode, '--deepseek'], { cwd: root, encoding: 'utf8', timeout: 15000 });
  const mock = invoke('--mock-replay');
  expect(mock.status).toBe(0); expect(JSON.parse(mock.stdout)).toMatchObject({ mockPassed: true, hardGuardPassed: true, liveProviderCallCount: 0 });
  const denied = invoke('--live-replay');
  expect(denied.status).toBe(1);
  expect(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null).toBe(before);
});
