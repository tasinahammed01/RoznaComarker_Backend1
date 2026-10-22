'use strict';
const gateway = require('../src/services/aiGateway.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const { REQUIRED, fallbackLegend } = require('../src/services/correctionLegendResolver.service');
const { createBudgetFetch } = require('../src/services/aiRequestDiagnostics.service');
const config = { provider: 'openrouter', model: 'openai/gpt-4.1-mini', chain: [{ provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbackIndex: 0 }],
  attemptTimeoutMs: 1000, totalBudgetMs: 2000, primaryRetries: 0, fallbackRetries: 0, retriesPerModel: 0, retryDelayMs: 0, maxOutputTokens: 4500 };
const env = { OPENROUTER_API_KEY: 'secret-do-not-log', OPENROUTER_BASE_URL: 'https://router.invalid/v1' };
const response = (payload, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => JSON.stringify(payload) });
const router = content => response({ choices: [{ message: { content }, finish_reason: 'stop' }] });
const input = { transcript: 'relize', transcriptHash: 'h', legend: fallbackLegend(), disableCategoryAudit: true };
function valid() {
  return { transcriptHash: 'h', categories: Object.fromEntries(Object.entries(REQUIRED).map(([category, reviewedSymbols]) => [category, {
    reviewed: true, reviewedSymbols, noFindingReason: category === 'MECHANICS' ? '' : 'No objective findings in this synthetic text.',
    corrections: category === 'MECHANICS' ? [{ symbol: 'SP', correctionKind: 'localized', quotedText: 'relize', occurrence: 0,
      message: 'Spelling error.', suggestedText: 'realize', confidence: 1, severity: 'low', stylePreference: false }] : [] }])) };
}
async function exercise(fetchImpl) {
  const events = []; let result, error;
  try { result = await semantic.analyze(input, { config, env, fetchImpl, onDiagnostic: d => events.push(d) }); } catch (e) { error = e; }
  return { events, result, error };
}
test.each([['ENOTFOUND'], ['CERT_HAS_EXPIRED'], ['ECONNRESET'], ['UND_ERR_SOCKET']])('transport %s retains only sanitized cause identifiers', async code => {
  const cause = Object.assign(new Error('secret-do-not-log https://private.invalid?key=secret'), { code });
  const error = new TypeError('fetch failed secret-do-not-log', { cause });
  const r = await exercise(jest.fn().mockRejectedValue(error));
  expect(r.events[0]).toMatchObject({ failureStage: 'TRANSPORT_FAILURE', responseReceived: false, httpStatus: null, internalCauseCode: code });
  expect(JSON.stringify(r.events)).not.toMatch(/secret-do-not-log|private\.invalid|fetch failed/);
  expect(JSON.stringify(r.error)).not.toContain('TRANSPORT_FAILURE'); // private callback, not public error fields
});
test('AbortError is distinct from transport failure', async () => {
  const r = await exercise(jest.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  expect(r.events[0]).toMatchObject({ failureStage: 'REQUEST_ABORTED', safeCode: 'AI_ATTEMPT_TIMEOUT' });
});
test.each([400, 429, 500])('HTTP %i retains response boundary and public safe code', async status => {
  const r = await exercise(jest.fn().mockResolvedValue(response({ error: { code: status, message: 'safe synthetic provider failure' } }, status)));
  expect(r.events[0]).toMatchObject({ failureStage: 'HTTP_ERROR_RESPONSE', httpStatus: status, responseReceived: true, bodyRead: true });
});
test('unreadable response body is not a missing HTTP response', async () => {
  const r = await exercise(jest.fn().mockResolvedValue({ ...response({}), text: async () => { throw Object.assign(new Error('socket closed'), { code: 'UND_ERR_SOCKET' }); } }));
  expect(r.events[0]).toMatchObject({ failureStage: 'RESPONSE_BODY_READ_FAILURE', httpStatus: 200, responseReceived: true, bodyRead: false });
});
test('malformed outer JSON is distinguished from malformed model content', async () => {
  const r = await exercise(jest.fn().mockResolvedValue({ ...response({}), text: async () => '<html>bad</html>' }));
  expect(r.events[0]).toMatchObject({ failureStage: 'RESPONSE_JSON_PARSE_FAILURE', bodyRead: true });
});
test('missing choices is a provider shape defect', async () => {
  const r = await exercise(jest.fn().mockResolvedValue(response({ usage: {} })));
  expect(r.events[0]).toMatchObject({ failureStage: 'PROVIDER_RESPONSE_SHAPE_INVALID', safeCode: 'AI_RESPONSE_EMPTY' });
});
test('non-JSON model content is classified at structured output parsing', async () => {
  const r = await exercise(jest.fn().mockResolvedValue(router('not json')));
  expect(r.events[0]).toMatchObject({ failureStage: 'MODEL_STRUCTURED_OUTPUT_INVALID', safeCode: 'AI_OUTPUT_VALIDATION_FAILED' });
});
test('parsed correction schema violation is distinct from normalization', async () => {
  const r = await exercise(jest.fn().mockResolvedValue(router(JSON.stringify({ transcriptHash: 'h', categories: {} }))));
  expect(r.events[0]).toMatchObject({ failureStage: 'CORRECTION_SCHEMA_VALIDATION_FAILURE' });
});
test('valid raw schema rejected by grounding/normalization retains its stage', async () => {
  const payload = valid(); payload.categories.MECHANICS.corrections[0].quotedText = 'invented';
  const r = await exercise(jest.fn().mockResolvedValue(router(JSON.stringify(payload))));
  expect(r.events[0]).toMatchObject({ failureStage: 'NORMALIZATION_FAILURE' });
  expect(r.error.validationDiagnostics.rejectionReasons).toHaveProperty('QUOTE_NOT_FOUND');
});
test('fully valid completion is unchanged and emits no failure', async () => {
  const r = await exercise(jest.fn().mockResolvedValue(router(JSON.stringify(valid()))));
  expect(r.error).toBeUndefined(); expect(r.events).toEqual([]);
  expect(r.result.corrections[0]).toMatchObject({ symbol: 'SP', quotedText: 'relize', suggestedText: 'realize', startChar: 0, endChar: 6 });
});
test('serialization failure occurs before any transport', async () => {
  const events = [], fetchImpl = jest.fn(), cyclic = {}; cyclic.self = cyclic;
  await expect(gateway.providerAttempt({ entry: config.chain[0], messages: [cyclic], responseFormat: 'json', maxOutputTokens: 100,
    temperature: 0, attemptTimeoutMs: 1000, fetchImpl, env, now: Date.now, onDiagnostic: d => events.push(d) })).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled(); expect(events[0].failureStage).toBe('REQUEST_BUILD_FAILURE');
});
test('observer exceptions cannot change public gateway behavior', async () => {
  const fetchImpl = jest.fn().mockRejectedValue(Object.assign(new Error('dns'), { code: 'ENOTFOUND' }));
  await expect(gateway.generate({ messages: [], config, env, fetchImpl, onDiagnostic: () => { throw Error('observer'); } })).rejects.toMatchObject({ code: 'AI_CHAIN_EXHAUSTED', finalFailureCode: 'AI_PROVIDER_UNAVAILABLE' });
});
test('first reserved fetch passes exact URL/options/signal and response; fallback is blocked before transport', async () => {
  const mockResponse = new Response('{"choices":[]}', { status: 200 });
  const native = jest.fn().mockResolvedValue(mockResponse), observed = jest.fn(); let count = 0;
  const wrapped = createBudgetFetch({ fetchImpl: native, admit: () => { if (count) throw Object.assign(Error('budget'), { code: 'AI_BENCHMARK_BUDGET_STOP' }); count++; }, onResponseText: observed });
  const options = { method: 'POST', body: 'exact-body', headers: { Authorization: 'secret-do-not-log' }, signal: new AbortController().signal };
  const result = await wrapped('https://router.invalid/v1/chat/completions', options);
  expect(result).toBe(mockResponse); expect(native.mock.calls[0][1]).toBe(options);
  expect(await result.text()).toBe('{"choices":[]}'); expect(observed).toHaveBeenCalledTimes(1);
  await expect(wrapped('https://router.invalid/v1/chat/completions', options)).rejects.toMatchObject({ code: 'AI_BENCHMARK_BUDGET_STOP' });
  expect(native).toHaveBeenCalledTimes(1);
});
test('diagnostic storage error cannot mask a valid response', async () => {
  const wrapped = createBudgetFetch({ fetchImpl: async () => new Response('ok'), admit: () => {}, onResponseText: () => { throw Error('disk full'); } });
  expect(await (await wrapped('unused', {})).text()).toBe('ok');
});
