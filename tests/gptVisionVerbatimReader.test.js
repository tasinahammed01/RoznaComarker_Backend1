'use strict';
// Gemini 3.8 Flash verbatim reader (OCR_GPT_VISION_READER=verbatim_json). Offline: every provider call is a fetch mock.
const c = require('../src/services/gptVisionExact/contract');
const source = require('../src/services/gptVisionExact.service');
const preflight = require('../src/services/gptVisionExact/preflight');
const gateway = require('../src/services/aiGateway.service');
const logger = require('../src/utils/logger');
const lazy = name => require(`../src/services/gptVisionExact/${name}`);
const verbatim = () => lazy('verbatimReader');
const second = () => lazy('secondReader');

const GEMINI = 'google/gemini-3.8-flash';
const QWEN = c.QWEN_MODEL;
const env = { NODE_ENV: 'test', OCR_SOURCE_MODE: 'gpt_vision_exact', OCR_GPT_VISION_MODEL: GEMINI, OCR_GPT_VISION_READER: 'verbatim_json', OPENROUTER_API_KEY: 'mock-only' };
const qwenEnv = { ...env, OCR_GPT_VISION_MODEL: QWEN, OCR_GPT_VISION_READER: 'json_contract' };
const assignment = { title: 'Social media', instructions: 'Do you think social media helps or harms friendships?' };
const QUESTION = 'Do you think social media helps or harms friendships?';
// Student mistakes that must survive unchanged.
const ANSWER = ['I thinks social media can chang the way', 'people see themselves because the will', 'always compare it to others and how they',
  'This artical show that social media chang the', 'This suggest that social media change people vision negatively.', 'Some friends end up feeling jealousy of the trips.'];
const reply = (over = {}) => JSON.stringify({ version: 'verbatim-page-v1', name_present: true, question_lines: [QUESTION], answer_lines: ANSWER,
  struck_through: [{ line: 1, text: 'For example,' }], uncertain: [{ line: 3, word: 'artical' }], ...over });
const apiBody = (content, over = {}) => JSON.stringify({ model: GEMINI, provider: 'Google AI Studio', choices: [{ finish_reason: 'stop', message: { content } }],
  usage: { prompt_tokens: 2100, completion_tokens: 420, total_tokens: 2520, cost: 0.0023, completion_tokens_details: { reasoning_tokens: 90 } }, ...over });
const ok = content => ({ ok: true, status: 200, text: async () => apiBody(content) });
function options(fetchImpl = jest.fn(async () => ok(reply())), e = env) {
  const reservation = { acquire: jest.fn(async () => ({ _id: 'source', cached: false })), complete: jest.fn(async () => {}), annotate: jest.fn(async () => {}) };
  return { bytes: Buffer.from([255, 216, 255]), mimeType: 'image/jpeg', identity: { submissionId: 's', fileId: 'f', pageNumber: 1, sourceSha256: c.sha('crop') },
    assignment, env: e, reservation, read: args => source.reader({ ...args, fetchImpl }), fetchImpl };
}
const bodyOf = o => JSON.parse(o.fetchImpl.mock.calls[0][1].body);

describe('configuration', () => {
  test('verbatim_json is a reader mode; Gemini is an approved source model only with it', () => {
    expect(c.GEMINI_MODEL).toBe(GEMINI);
    expect(c.readerMode(env)).toBe('verbatim_json');
    expect(c.config(env)).toEqual({ model: GEMINI });
    for (const reader of ['json_contract', 'plain_text']) expect(() => c.config({ ...env, OCR_GPT_VISION_READER: reader })).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
    for (const model of [QWEN, 'openai/gpt-6-astra', c.DEEPSEEK_MODEL]) expect(() => c.config({ ...env, OCR_GPT_VISION_MODEL: model })).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
    expect(c.config(qwenEnv)).toEqual({ model: QWEN }); // the current Qwen setup is untouched
  });
  test('temperature and reasoning settings are validated; defaults are temperature 0 and reasoning low', () => {
    expect(verbatim().settings(env)).toEqual({ temperature: 0, reasoning: 'low' });
    expect(verbatim().settings({ ...env, OCR_GPT_VISION_TEMPERATURE: 'omit', OCR_GPT_VISION_REASONING: 'medium' })).toEqual({ temperature: undefined, reasoning: 'medium' });
    for (const bad of [{ OCR_GPT_VISION_TEMPERATURE: '0.5' }, { OCR_GPT_VISION_REASONING: 'none' }, { OCR_GPT_VISION_REASONING: 'extreme' }])
      expect(() => c.config({ ...env, ...bad })).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  });
  test('the second reader is off by default; only the Qwen model is accepted, and only with verbatim_json', () => {
    expect(c.secondReaderModel(env)).toBeNull();
    expect(c.secondReaderModel({ ...env, OCR_GPT_VISION_SECOND_READER: 'off' })).toBeNull();
    expect(c.secondReaderModel({ ...env, OCR_GPT_VISION_SECOND_READER: QWEN })).toBe(QWEN);
    expect(() => c.config({ ...env, OCR_GPT_VISION_SECOND_READER: 'openai/gpt-6-astra' })).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
    expect(() => c.config({ ...qwenEnv, OCR_GPT_VISION_SECOND_READER: QWEN })).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  });
  test('startup in production fails when OCR_SOURCE_MODE or OCR_GPT_VISION_MODEL is missing; other environments keep their defaults', () => {
    const ocr = require('../src/config/ocr');
    const prod = { ...env, NODE_ENV: 'production' };
    expect(ocr.validateOcrConfiguration(prod)).toMatchObject({ mode: 'gpt_vision_exact', gptVisionModel: GEMINI, gptVisionReader: 'verbatim_json', gptVisionSecondReader: 'off', sourceCallsPerPage: 1 });
    const { OCR_SOURCE_MODE, ...noMode } = prod;
    const { OCR_GPT_VISION_MODEL, ...noModel } = prod;
    expect(() => ocr.validateOcrConfiguration(noMode)).toThrow('OCR_SOURCE_CONFIGURATION_INVALID');
    expect(() => ocr.validateOcrConfiguration(noModel)).toThrow('OCR_SOURCE_CONFIGURATION_INVALID');
    expect(() => ocr.validateOcrConfiguration({ ...prod, OCR_SOURCE_MODE: '' })).toThrow('OCR_SOURCE_CONFIGURATION_INVALID');
    expect(ocr.validateOcrConfiguration({ ...noMode, NODE_ENV: 'development' })).toEqual({ mode: 'legacy' });
    expect(ocr.validateOcrConfiguration({ ...qwenEnv, NODE_ENV: 'production' })).toMatchObject({ gptVisionModel: QWEN, gptVisionReader: 'json_contract' });
    expect(JSON.stringify(ocr.validateOcrConfiguration(prod))).not.toContain('mock-only');
  });
});

describe('prompt, schema and strict parsing', () => {
  test('the prompt and schema are exactly what the harness measured', () => {
    const prompts = require('../scripts/ocr-eval/lib/prompts.cjs'), verbatimHarness = require('../scripts/ocr-eval/lib/verbatim.cjs');
    const spec = prompts.promptSpec('verbatim-json');
    expect(verbatim().PROMPT).toBe(spec.system);
    expect(verbatim().SCHEMA).toEqual(verbatimHarness.VERBATIM_SCHEMA);
    expect(verbatim().userText(source.reference(assignment))).toBe(spec.userTextFor({ assignment }));
    expect(verbatim().userText({})).toBe(spec.userText);
  });
  test('a valid reply becomes canonical evidence: answer only, question excluded, crossed-out text excluded, mistakes untouched', () => {
    const { wire, review } = verbatim().convert(reply());
    const value = c.validateWire(wire);
    expect(value.activeTranscript).toBe(ANSWER.join('\n'));
    expect(value.activeTranscript).not.toContain('Do you think');
    expect(value.activeTranscript).not.toContain('For example');
    for (const mistake of ['I thinks', 'chang the way', 'the will', 'artical show', 'This suggest', 'feeling jealousy', 'people vision']) expect(value.activeTranscript).toContain(mistake);
    expect(JSON.parse(wire).physicalLines[0].segments[0].classification).toBe('PROMPT_OR_INSTRUCTION');
    expect(() => c.validateCanonical(JSON.stringify(value))).not.toThrow();
    expect(review).toEqual({ readerMode: 'verbatim_json', readerVersion: verbatim().VERSION, namePresent: true, questionLineCount: 1, struckCount: 1, uncertainCount: 1, uncertainDropped: 0,
      struck: [{ line: 1, text: 'For example,' }], uncertain: [{ line: 3, word: 'artical' }] });
  });
  test('an "uncertain" item that does not match its line is DROPPED, never fatal: the page, its transcript and the valid items are kept', () => {
    const bad = [{ line: 3, word: 'artical' }, { line: 0, word: 'zebra' }, { line: 99, word: 'will' }, { line: '1', word: 'will' }, { line: 1 }, 'junk', null, { line: 2, word: '  ' }];
    const { wire, review } = verbatim().convert(reply({ uncertain: bad }));
    expect(c.validateWire(wire).activeTranscript).toBe(ANSWER.join('\n'));
    expect(review).toMatchObject({ uncertain: [{ line: 3, word: 'artical' }], uncertainCount: 1, uncertainDropped: 7 });
    expect(JSON.stringify(review)).not.toMatch(/zebra|junk/);
  });
  test('the two replies the live gate rejected (one of three, and one of four, uncertain items not on their line) are now accepted', () => {
    const three = [{ line: 0, word: 'I' }, { line: 3, word: 'artical' }, { line: 1, word: 'themselfs' }];
    expect(verbatim().convert(reply({ uncertain: three })).review).toMatchObject({ uncertainCount: 2, uncertainDropped: 1 });
  });
  test('only the advisory item is forgiven: a reply whose uncertain field is not a list is still a schema failure', () => {
    for (const uncertain of ['x', null, { line: 0, word: 'I' }]) expect(() => verbatim().convert(reply({ uncertain }))).toThrow('OCR_GPT_SOURCE_SCHEMA');
  });
  test('uncertain words never block a page', () => {
    const { wire } = verbatim().convert(reply({ uncertain: ANSWER.map((l, i) => ({ line: i, word: l.split(' ')[0] })) }));
    expect(JSON.parse(wire).uncertainties).toEqual([]);
    expect(() => c.validateWire(wire)).not.toThrow();
  });
  test.each([
    ['not JSON', 'nope'], ['a student name field', reply({ name: 'A Student' })], ['wrong version', reply({ version: 'x' })],
    ['a line break inside a line', reply({ answer_lines: ['a\nb'], uncertain: [], struck_through: [] })],
  ])('%s is a schema failure with no partial transcript', (_n, content) => {
    expect(() => verbatim().convert(content)).toThrow('OCR_GPT_SOURCE_SCHEMA');
  });
  test('an answer with no text is reported as empty', () => {
    expect(() => verbatim().convert(reply({ answer_lines: [' '], uncertain: [], struck_through: [] }))).toThrow('OCR_GPT_SOURCE_EMPTY');
  });
});

describe('gateway profile gpt_vision_exact_verbatim_v1 and the request', () => {
  test('one call: strict schema, reasoning low, temperature 0, Google AI Studio standard tier only, no sort, one token field', async () => {
    const o = options();
    await source.readPage(o);
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    const [url, request] = o.fetchImpl.mock.calls[0], body = bodyOf(o);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(request.redirect).toBe('error');
    expect(body.model).toBe(GEMINI);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(16000);
    expect(body).not.toHaveProperty('max_completion_tokens');
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false, only: ['google-ai-studio'], ignore: ['google-ai-studio/flex', 'google-ai-studio/priority'] });
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'verbatim_page_v1', strict: true, schema: verbatim().SCHEMA } });
    expect(body.messages[0]).toEqual({ role: 'system', content: verbatim().PROMPT });
    expect(JSON.parse(body.messages[1].content[0].text).assignmentReference).toEqual(source.reference(assignment));
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/');
    for (const key of ['top_p', 'seed', 'models', 'transforms']) expect(body).not.toHaveProperty(key);
  });
  test('temperature omit and reasoning from the environment are honoured', async () => {
    const o = options(undefined, { ...env, OCR_GPT_VISION_TEMPERATURE: 'omit', OCR_GPT_VISION_REASONING: 'medium' });
    await source.readPage(o);
    expect(bodyOf(o)).not.toHaveProperty('temperature');
    expect(bodyOf(o).reasoning).toEqual({ effort: 'medium' });
  });
  test.each([
    ['another model', { entry: { provider: 'openrouter', model: QWEN }, temperature: 0 }],
    ['text output', { temperature: 0, responseFormat: 'text' }],
    ['a temperature other than 0', { temperature: 0.4 }],
  ])('the gateway refuses %s before any transport', async (_n, override) => {
    const fetchImpl = jest.fn();
    await expect(gateway.providerAttempt({ entry: { provider: 'openrouter', model: GEMINI }, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 16000, attemptTimeoutMs: 120000,
      env, now: Date.now, requestProfile: 'gpt_vision_exact_verbatim_v1', fetchImpl, responseFormat: 'json', responseSchema: verbatim().SCHEMA, schemaName: 'verbatim_page_v1', temperature: 0, ...override }))
      .rejects.toMatchObject({ code: 'OCR_SOURCE_PROFILE_INVALID' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('the older JSON profile can no longer be used with Gemini', async () => {
    const fetchImpl = jest.fn();
    await expect(gateway.providerAttempt({ entry: { provider: 'openrouter', model: GEMINI }, messages: [{ role: 'user', content: 'x' }], maxOutputTokens: 16000, attemptTimeoutMs: 120000,
      env, now: Date.now, requestProfile: 'gpt_vision_exact_v1', fetchImpl })).rejects.toMatchObject({ code: 'OCR_SOURCE_PROFILE_INVALID' });
  });
  test('a response from another model id is rejected exactly', async () => {
    const o = options(jest.fn(async () => ({ ok: true, status: 200, text: async () => apiBody(reply(), { model: 'google/gemini-3.8-flash-20260902' }) })));
    await expect(source.readPage(o)).rejects.toMatchObject({ code: 'OCR_SOURCE_MODEL_IDENTITY' });
    expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
  });
});

describe('readPage with the verbatim reader', () => {
  test('grading text is the answer only; question and crossed-out text never reach it; flags are stored for review', async () => {
    const o = options();
    const result = await source.readPage(o);
    expect(result.fullText).toBe(ANSWER.join('\n'));
    expect(result.transcriptText).toBe(ANSWER.join('\n'));
    expect(result.source).toMatchObject({ sourcePrimaryModel: GEMINI, sourceFidelityMode: 'gpt_vision_exact' });
    const summary = result.pages[0].sourceVerificationSummary;
    expect(summary.review).toEqual({ readerMode: 'verbatim_json', namePresent: true, questionLineCount: 1, struckCount: 1, uncertainCount: 1, uncertainDropped: 0, uncertain: [{ line: 3, word: 'artical' }] });
    expect(JSON.stringify(summary)).not.toContain('For example');
    const [, saved] = o.reservation.complete.mock.calls[0];
    expect(saved.status).toBe('GPT_SOURCE_ACCEPTED');
    expect(saved.payload.review.struck).toEqual([{ line: 1, text: 'For example,' }]);
    expect(c.validateCanonical(JSON.stringify(saved.payload.primary))).toEqual(saved.payload.primary);
    // the source records the very text that was graded, exactly
    expect(result.source.sourceTextExact).toBe(ANSWER.join('\n'));
    expect(result.source.sourceTextSha256).toBe(c.sha(ANSWER.join('\n')));
  });
  test('production logs: model, served provider, tokens, reasoning tokens, cost, latency and counts; never text or names', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await source.readPage(options());
      const event = info.mock.calls.map(call => call[0]).find(entry => entry?.event === 'gpt_source_performance');
      expect(event).toMatchObject({ model: GEMINI, servedProvider: 'Google AI Studio', readerMode: 'verbatim_json', struckCount: 1, questionLineCount: 1, uncertainCount: 1,
        sourceProviderMs: expect.any(Number), usage: { prompt_tokens: 2100, completion_tokens: 420, total_tokens: 2520, cost: 0.0023, thoughts_tokens: 90 } });
      const logged = JSON.stringify(info.mock.calls);
      for (const secret of ['artical', 'jealousy', 'Do you think', 'For example', 'A Student', 'I thinks']) expect(logged).not.toContain(secret);
    } finally { info.mockRestore(); }
  });
  test('a page whose reply has a mismatching uncertain item is accepted after one call, with the dropped count in the record and the log', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const o = options(jest.fn(async () => ok(reply({ uncertain: [{ line: 3, word: 'artical' }, { line: 0, word: 'zebra' }] }))));
      const result = await source.readPage(o);
      expect(o.fetchImpl).toHaveBeenCalledTimes(1);
      expect(result.fullText).toBe(ANSWER.join('\n'));
      expect(result.pages[0].sourceVerificationSummary.review).toMatchObject({ uncertainCount: 1, uncertainDropped: 1, uncertain: [{ line: 3, word: 'artical' }] });
      expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_ACCEPTED');
      expect(info.mock.calls.map(call => call[0]).find(entry => entry?.event === 'gpt_source_performance')).toMatchObject({ uncertainCount: 1, uncertainDropped: 1 });
      expect(JSON.stringify(info.mock.calls)).not.toContain('zebra');
    } finally { info.mockRestore(); }
  });
  test('a schema failure or empty answer fails the page after one call', async () => {
    for (const [content, code] of [['{', 'OCR_GPT_SOURCE_SCHEMA'], [reply({ answer_lines: [''], uncertain: [], struck_through: [] }), 'OCR_GPT_SOURCE_EMPTY']]) {
      const o = options(jest.fn(async () => ok(content)));
      await expect(source.readPage(o)).rejects.toMatchObject({ code });
      expect(o.fetchImpl).toHaveBeenCalledTimes(1);
      expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
    }
  });
  test('evidence from another approved model is reused as it is, and reported as that model\'s', async () => {
    const o = options();
    const evidence = verbatim().convert(reply());
    o.reservation.acquire.mockResolvedValue({ _id: 'source', cached: true, evidence: { identity: { model: QWEN }, payload: { primary: c.validateWire(evidence.wire), review: evidence.review } } });
    const result = await source.readPage(o);
    expect(o.fetchImpl).not.toHaveBeenCalled();
    expect(result.fullText).toBe(ANSWER.join('\n'));
    expect(result.source.sourcePrimaryModel).toBe(QWEN);
    expect(result.pages[0].sourceVerificationSummary.review).toMatchObject({ struckCount: 1, uncertainCount: 1 });
  });
  test('the default reader still sends the unchanged JSON-contract request for Qwen', async () => {
    const wire = { version: c.QWEN_WIRE_VERSION, physicalLines: [{ segments: [{ classification: 'STUDENT_ACTIVE_TEXT', text: 'The park is quiet.', confidence: 1 }] }], uncertainties: [] };
    const fetchImpl = jest.fn(async () => ({ ok: true, status: 200, text: async () => apiBody(JSON.stringify(wire), { model: QWEN }) }));
    const o = options(fetchImpl, qwenEnv);
    expect((await source.readPage(o)).fullText).toBe('The park is quiet.');
    const body = bodyOf(o);
    expect(body.response_format.json_schema.name).toBe('qwen_physical_source_v1');
    expect(body.provider).toEqual({ require_parameters: true, allow_fallbacks: false, sort: 'latency' });
    expect(body).not.toHaveProperty('temperature');
  });
});

describe('cache binding, switch-over and fingerprint', () => {
  const context = { ownerId: 's', uploaderId: 's', assignment: { _id: 'a', ...assignment } };
  const page = { bytes: Buffer.from('page'), sourceSha256: c.sha('page'), pageNumber: 1 };
  test('the Gemini binding records model, reader and version, and its key differs from Qwen\'s', () => {
    const g = preflight.binding(context, page, env), q = preflight.binding(context, page, qwenEnv);
    expect(g).toMatchObject({ model: GEMINI, readerMode: 'verbatim_json', readerVersion: verbatim().VERSION, promptSha256: verbatim().promptSha256(source.reference(assignment)) });
    expect(g.key).not.toBe(q.key);
    expect(g.key).toBe(preflight.binding(context, page, env).key);
    expect(preflight.binding({ ...context, assignment: { _id: 'a', title: 'Other' } }, page, env).key).not.toBe(g.key);
  });
  test('the Qwen binding and key are exactly what they were before (rollback changes only .env)', () => {
    const pinned = preflight.binding({ ownerId: 's', assignment: { _id: 'a', title: 'T', prompt: 'Describe your favourite place.' } }, page, { OCR_GPT_VISION_MODEL: QWEN, OPENROUTER_API_KEY: 'mock-only' });
    expect(pinned.key).toBe('2a6c5e8bad990da27e391a63');
    expect(pinned.promptSha256).toBe('ac9a6fa81a3ab29ac340e8e0249b02132c0721efad2b2a596aef35d271536bd7');
  });
  test('claims from the previously approved model are accepted in both directions, only for that pair and the same assignment text', () => {
    const g = preflight.binding(context, page, env), q = preflight.binding(context, page, qwenEnv);
    expect(c.claimModelAccepted(q.model, g.model)).toBe(true);
    expect(c.claimModelAccepted(g.model, q.model)).toBe(true);
    expect(c.claimModelAccepted(g.model, g.model)).toBe(true);
    for (const other of ['openai/gpt-6-astra', c.DEEPSEEK_MODEL]) { expect(c.claimModelAccepted(other, g.model)).toBe(false); expect(c.claimModelAccepted(other, q.model)).toBe(false); }
    expect(g.legacyPromptSha256).toBe(q.legacyPromptSha256);            // same stored assignment text
    const changed = preflight.binding({ ...context, assignment: { _id: 'a', title: 'Other' } }, page, env);
    expect(changed.legacyPromptSha256).not.toBe(q.legacyPromptSha256);
  });
  test('the runtime fingerprint changes with the verbatim reader, its settings and the second reader, and not for the default', () => {
    const { runtimeContractFingerprint } = require('../src/services/runtimeContractFingerprint.service');
    const base = runtimeContractFingerprint({ NODE_ENV: 'test' });
    expect(base.contractHash).toBe('d3702de2a5f7a860');
    expect(base.contracts).not.toHaveProperty('sourceReader');
    const g = runtimeContractFingerprint({ NODE_ENV: 'test', ...env });
    expect(g.contracts).toMatchObject({ sourceReader: 'verbatim_json', sourceReaderVersion: verbatim().VERSION, sourceModel: GEMINI, sourceReasoning: 'low', sourceTemperature: '0', sourceSecondReader: 'off' });
    const hashes = new Set([base.contractHash, g.contractHash,
      runtimeContractFingerprint({ NODE_ENV: 'test', ...env, OCR_GPT_VISION_TEMPERATURE: 'omit' }).contractHash,
      runtimeContractFingerprint({ NODE_ENV: 'test', ...env, OCR_GPT_VISION_REASONING: 'medium' }).contractHash,
      runtimeContractFingerprint({ NODE_ENV: 'test', ...env, OCR_GPT_VISION_SECOND_READER: QWEN }).contractHash]);
    expect(hashes.size).toBe(5);
    expect(runtimeContractFingerprint({ NODE_ENV: 'test', ...env, OCR_GPT_VISION_READER: 'bogus' }).contracts.sourceReader).toBe('invalid');
  });
});

describe('second reader (off by default, flags only)', () => {
  test('compare reports differing words by line, with the other reading, and never raises', () => {
    expect(second().compare(['a b c'], ['a x c'])).toEqual({ comparedWords: 3, differingWords: 1, differences: [{ line: 0, word: 'b', other: 'x' }] });
    expect(second().compare(['a b c'], ['a c'])).toMatchObject({ differingWords: 1, differences: [{ line: 0, word: 'b', other: null }] });
    expect(second().compare(['one two', 'three four'], ['one two', 'three four'])).toMatchObject({ differingWords: 0, differences: [] });
    expect(second().compare(['x'.repeat(2), ...Array(4000).fill('w')], ['w'])).toMatchObject({ skipped: 'TOO_LARGE' });
  });
  test('off: one call. On: a second Qwen plain read after the page is accepted; the differences are stored for review', async () => {
    const plain = ANSWER.map(l => l.replace('artical', 'article')).join('\n');
    const fetchImpl = jest.fn(async (url, request) => {
      const body = JSON.parse(request.body);
      return body.model === QWEN ? { ok: true, status: 200, text: async () => apiBody(`${QUESTION}\n${plain}`, { model: QWEN }) } : ok(reply());
    });
    const off = options(fetchImpl); await source.readPage(off);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    fetchImpl.mockClear();
    const on = options(fetchImpl, { ...env, OCR_GPT_VISION_SECOND_READER: QWEN });
    const result = await source.readPage(on);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const secondBody = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(secondBody.model).toBe(QWEN);
    expect(secondBody).not.toHaveProperty('response_format');
    expect(result.fullText).toBe(ANSWER.join('\n'));            // the second reader never changes what is graded
    const [id, patch] = on.reservation.annotate.mock.calls[0];
    expect(id).toBe('source');
    expect(patch.secondReader).toMatchObject({ model: QWEN, status: 'compared', differingWords: 1, differences: [{ line: 3, word: 'artical', other: 'article' }] });
  });
  test('a failing second reader cannot fail, block or change the page', async () => {
    const fetchImpl = jest.fn(async (url, request) => { if (JSON.parse(request.body).model === QWEN) throw Object.assign(new Error('private'), { code: 'ECONNRESET' }); return ok(reply()); });
    const o = options(fetchImpl, { ...env, OCR_GPT_VISION_SECOND_READER: QWEN });
    const info = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const result = await source.readPage(o);
      expect(result.fullText).toBe(ANSWER.join('\n'));
      expect(o.reservation.annotate.mock.calls[0][1].secondReader).toMatchObject({ model: QWEN, status: 'unavailable' });
      expect(JSON.stringify(info.mock.calls)).not.toContain('private');
    } finally { info.mockRestore(); }
  });
  test('cached evidence never triggers a second read', async () => {
    const fetchImpl = jest.fn();
    const o = options(fetchImpl, { ...env, OCR_GPT_VISION_SECOND_READER: QWEN });
    const evidence = verbatim().convert(reply());
    o.reservation.acquire.mockResolvedValue({ _id: 'source', cached: true, evidence: { identity: { model: GEMINI }, payload: { primary: c.validateWire(evidence.wire), review: evidence.review } } });
    await source.readPage(o);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
