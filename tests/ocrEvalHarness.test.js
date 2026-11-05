'use strict';
// Harness tests: guards, runner, reports, CLI, OpenRouter client, image variants, fake models.
// Everything is synthetic and local. A global fetch trap makes any accidental real network call fail the test.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const guards = require('../scripts/ocr-eval/lib/guards.cjs');
const dataset = require('../scripts/ocr-eval/lib/dataset.cjs');
const openrouter = require('../scripts/ocr-eval/lib/openrouter.cjs');
const prompts = require('../scripts/ocr-eval/lib/prompts.cjs');
const fake = require('../scripts/ocr-eval/lib/fakeModel.cjs');
const report = require('../scripts/ocr-eval/lib/report.cjs');
const variants = require('../scripts/ocr-eval/lib/imageVariants.cjs');
const runner = require('../scripts/ocr-eval/lib/runner.cjs');
const cli = require('../scripts/ocr-eval/run.cjs');
const contract = require('../src/services/gptVisionExact/contract.js');

jest.setTimeout(120000);

const KEY = 'sk-or-v1-TESTKEY0123456789abcdefTESTKEY';
const MODEL_A = 'test/model-a', MODEL_B = 'test/model-b';
const BACKEND = path.resolve(__dirname, '..');
const TRUTH = {
  image1: 'The zephyrquill was powerfull and strong.\nShe go to market yesterday.',
  image2: 'My quixotic brother recieve a letter from [?] last week.',
  image10: 'Plain sentence about marmalade jars.',
};
const SECRET_WORDS = ['zephyrquill', 'quixotic', 'marmalade'];

let dataDir, outDir, realFetch;
const sink = () => { const chunks = []; return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') }; };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const CATALOG = ids => ids.map(id => ({ id, architecture: { input_modalities: ['text', 'image'] },
  supported_parameters: ['temperature', 'reasoning', 'structured_outputs', 'response_format'], pricing: { prompt: '0.0000003', completion: '0.0000012' }, context_length: 32000 }));

/** A fake OpenRouter: answers the catalog request and chat completions, and records every request. */
function makeFetch({ text = TRUTH.image1, cost = 0.01, reasoningTokens = 0, reasoningText = null, provider = 'TestProvider', catalog = CATALOG([MODEL_A, MODEL_B]), chat = null } = {}) {
  const calls = [];
  const fn = jest.fn(async (url, options = {}) => {
    calls.push({ url, method: options.method, headers: options.headers, body: options.body });
    if (String(url).endsWith('/models')) return response(200, { data: catalog });
    if (chat) return chat(url, options);
    const body = JSON.parse(options.body);
    const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: reasoningTokens } };
    if (cost !== null) usage.cost = cost;
    return response(200, { model: body.model, provider, usage,
      choices: [{ finish_reason: 'stop', message: { content: text, ...(reasoningText ? { reasoning: reasoningText } : {}) } }] });
  });
  fn.calls = calls;
  fn.posts = () => calls.filter(c => c.method === 'POST');
  return fn;
}

/** Scripted chat replies for failure tests. */
const okChat = (options, { cost = 0.01, text = TRUTH.image1, reasoningTokens = 0, provider = 'TestProvider' } = {}) => {
  const body = JSON.parse(options.body);
  const usage = { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, completion_tokens_details: { reasoning_tokens: reasoningTokens } };
  if (cost !== null) usage.cost = cost;
  return response(200, { model: body.model, provider, usage, choices: [{ finish_reason: 'stop', message: { content: text } }] });
};
const errChat = (status, message, extra = {}) => response(status, { error: { code: status, message, ...extra } });
const bodyOf = call => JSON.parse(call.body);
const postsFor = (fetchImpl, model) => fetchImpl.posts().filter(call => bodyOf(call).model === model);
const PRICES = model => ({ [model]: { inputPerMillion: 1, outputPerMillion: 2 } });

function listAll(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => (e.isDirectory() ? listAll(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
const textOf = dir => listAll(dir).map(f => fs.readFileSync(f, 'latin1')).join('\n');

async function makeJpeg(file, { width = 900, height = 1200, orientation } = {}) {
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 200 + ((i * 7) % 40);
  let image = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (orientation) image = image.withMetadata({ orientation });
  fs.writeFileSync(file, await image.jpeg({ quality: 90 }).toBuffer());
}

beforeAll(async () => {
  realFetch = global.fetch;
  global.fetch = jest.fn(() => { throw new Error('REAL NETWORK CALL ATTEMPTED IN A TEST'); });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-data-'));
  for (const [name, text] of Object.entries(TRUTH)) {
    await makeJpeg(path.join(dataDir, `${name}.jpeg`));
    fs.writeFileSync(path.join(dataDir, `${name}.txt`), text);
  }
  fs.writeFileSync(path.join(dataDir, 'image1.mistakes.tsv'), 'powerfull\tpowerful\nShe go\tShe goes\n');
});
afterAll(() => { global.fetch = realFetch; fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-out-')); global.fetch.mockClear(); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

const load = () => dataset.loadDataset(dataDir);
function run(extra = {}, deps = {}) {
  const out = sink();
  const logger = openrouter.createLogger({ secrets: [KEY], stdout: out, stderr: out });
  return runner.runEvaluation({ dataset: load(), models: ['fake/perfect'], variants: ['original'], outDir, ...extra },
    { logger, fetchImpl: global.fetch, apiKey: null, ...deps }).then(result => ({ result, log: out.text() }));
}

// ---------------------------------------------------------------------------------------------------------------------
describe('call guards: paid calls need --live and a matching --confirm N', () => {
  const live = { live: true, plannedCalls: 6, apiKeyPresent: true, models: [MODEL_A] };

  test('without --live a real model id is only simulated', () => {
    expect(guards.authorizeRun({ live: false, plannedCalls: 6, apiKeyPresent: true, models: [MODEL_A] })).toMatchObject({ mode: 'dry-run', paidCalls: false });
  });
  test('--live without --confirm is refused, and the message says which number to confirm', () => {
    expect(() => guards.authorizeRun(live)).toThrow(guards.GuardError);
    expect(() => guards.authorizeRun(live)).toThrow(/--confirm 6/);
  });
  test('a --confirm that does not match the planned number of calls is refused', () => {
    expect(() => guards.authorizeRun({ ...live, confirm: 5 })).toThrow(/does not match/);
    expect(() => guards.authorizeRun({ ...live, confirm: 7 })).toThrow(guards.GuardError);
  });
  test('--live needs an API key in the environment', () => {
    expect(() => guards.authorizeRun({ ...live, confirm: 6, apiKeyPresent: false })).toThrow(/OPENROUTER_API_KEY/);
  });
  test('--confirm without --live is refused instead of being ignored', () => {
    expect(() => guards.authorizeRun({ live: false, confirm: 6, plannedCalls: 6, apiKeyPresent: true, models: [MODEL_A] })).toThrow(/only applies with --live/);
  });
  test('fake models cannot be combined with --live', () => {
    expect(() => guards.authorizeRun({ ...live, confirm: 6, models: ['fake/noisy'] })).toThrow(/fake/i);
  });
  test('a matching --confirm with a key authorizes live mode', () => {
    expect(guards.authorizeRun({ ...live, confirm: 6 })).toMatchObject({ mode: 'live', paidCalls: true });
  });
  test('a resumed run with nothing left to call needs --confirm 0', () => {
    expect(() => guards.authorizeRun({ ...live, plannedCalls: 0 })).toThrow(/--confirm 0/);
    expect(guards.authorizeRun({ ...live, plannedCalls: 0, confirm: 0 })).toMatchObject({ mode: 'live', paidCalls: false });
  });

  test('end to end: no --live means zero network requests, even for real model ids', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run({ models: [MODEL_A, MODEL_B], live: false }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.mode).toBe('dry-run');
    expect(result.rows.every(r => r.source === 'dry-run')).toBe(true);
  });
  test('end to end: --live without --confirm makes no request at all, not even the catalog lookup', async () => {
    const fetchImpl = makeFetch();
    await expect(run({ models: [MODEL_A], live: true }, { fetchImpl, apiKey: KEY })).rejects.toThrow(guards.GuardError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('end to end: a mismatched --confirm makes no request', async () => {
    const fetchImpl = makeFetch();
    await expect(run({ models: [MODEL_A], live: true, confirm: 2 }, { fetchImpl, apiKey: KEY })).rejects.toThrow(/does not match/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('end to end: --live without a key makes no request', async () => {
    const fetchImpl = makeFetch();
    await expect(run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: null })).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('end to end: a matching --confirm makes exactly the planned paid calls plus one free catalog request', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(3);
    expect(fetchImpl.calls.filter(c => c.method === 'GET')).toHaveLength(1);
    expect(fetchImpl.calls[0].method).toBe('GET'); // the free catalog lookup comes first
    expect(result.callsMade).toBe(3);
  });
  test('CLI: --live without --confirm exits 2, names the number to confirm, and makes no request', async () => {
    const fetchImpl = makeFetch(), out = sink(), err = sink();
    // 3 photos x 2 default variants x 1 model = 6 planned calls
    const code = await cli.main(['--models', MODEL_A, '--live', '--out', outDir], { env: { OCR_EVAL_DIR: dataDir, OPENROUTER_API_KEY: KEY }, stdout: out, stderr: err, fetchImpl });
    expect(code).toBe(2);
    expect(err.text()).toMatch(/--confirm 6/);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(out.text() + err.text()).not.toContain(KEY);
  });
  test('CLI: a wrong --confirm exits 2 and makes no request', async () => {
    const fetchImpl = makeFetch(), err = sink();
    const code = await cli.main(['--models', MODEL_A, '--live', '--confirm', '99', '--out', outDir], { env: { OCR_EVAL_DIR: dataDir, OPENROUTER_API_KEY: KEY }, stdout: sink(), stderr: err, fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  test('CLI: dry run never touches the network function it was given', async () => {
    const fetchImpl = makeFetch(), out = sink();
    const code = await cli.main(['--models', MODEL_A, '--out', outDir], { env: { OCR_EVAL_DIR: dataDir, OPENROUTER_API_KEY: KEY }, stdout: out, stderr: sink(), fetchImpl });
    expect(code).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('cost cap, resume and output safety', () => {
  test('--max-cost-usd stops further calls once the cap is reached', async () => {
    const fetchImpl = makeFetch({ cost: 0.04 });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3, maxCostUsd: 0.07 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(2);
    expect(result.stoppedEarly).toMatch(/max-cost-usd 0\.07 reached/);
    expect(result.summary).toContain('Run stopped early');
  });
  test('a call that reports no cost, with no price to estimate from, stops a capped run because the cap cannot be enforced', async () => {
    const fetchImpl = makeFetch({ cost: null });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3, maxCostUsd: 1, noCatalog: true }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(1);
    expect(result.stoppedEarly).toMatch(/cannot be enforced/);
  });
  test('with catalog prices, a missing API cost is estimated from tokens and the cap keeps working', async () => {
    const fetchImpl = makeFetch({ cost: null });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3, maxCostUsd: 1 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(3);
    expect(result.rows.every(r => r.costSource === 'estimated')).toBe(true);
    expect(result.rows[0].costUsd).toBeCloseTo((1000 * 0.3 + 200 * 1.2) / 1e6, 10);
  });
  test('--price lets the harness estimate cost from tokens when the API reports none', async () => {
    const fetchImpl = makeFetch({ cost: null });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3, prices: { [MODEL_A]: { inputPerMillion: 1, outputPerMillion: 2 } }, noCatalog: true }, { fetchImpl, apiKey: KEY });
    expect(result.rows[0]).toMatchObject({ costSource: 'estimated' });
    expect(result.rows[0].costUsd).toBeCloseTo((1000 * 1 + 200 * 2) / 1e6, 10);
  });
  test('--resume reuses saved successful calls and spends nothing again', async () => {
    const first = makeFetch();
    await run({ models: [MODEL_A], live: true, confirm: 3, runId: 'r1' }, { fetchImpl: first, apiKey: KEY });
    const second = makeFetch();
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 0, resume: true, runId: 'r1' }, { fetchImpl: second, apiKey: KEY });
    expect(second).not.toHaveBeenCalled();
    expect(result.reusedCalls).toBe(3);
    expect(result.rows.every(r => r.source === 'resumed' && r.status === 'ok')).toBe(true);
  });
  test('--resume never reuses a record made for different settings (a dry run is not a live result)', async () => {
    await run({ models: [MODEL_A], runId: 'r2' });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3, resume: true, runId: 'r2' }, { fetchImpl: makeFetch(), apiKey: KEY });
    expect(result.reusedCalls).toBe(0);
  });
  test('resuming a run that does not exist is an error', async () => {
    await expect(run({ resume: true, runId: 'missing' })).rejects.toThrow(/No earlier run/);
  });
  test('output inside the repository (outside the ignored default) is refused', () => {
    expect(() => runner.assertOutputAllowed(path.join(BACKEND, 'scripts'))).toThrow(guards.GuardError);
    expect(() => runner.assertOutputAllowed(path.join(BACKEND, 'src', 'x'))).toThrow(/inside the repository/);
    expect(() => runner.assertOutputAllowed(runner.DEFAULT_OUT)).not.toThrow();
    expect(() => runner.assertOutputAllowed(outDir)).not.toThrow();
  });
  test('the default output folder is git-ignored', () => {
    const ignore = fs.readFileSync(path.join(BACKEND, '.gitignore'), 'utf8');
    expect(ignore.split(/\r?\n/)).toContain('tmp/ocr-eval-results/');
  });
});

describe('API key safety', () => {
  test('redact removes the key, key-shaped tokens and bearer headers', () => {
    expect(openrouter.redact(`oops ${KEY} and Bearer abcdefghijklmnop and sk-or-v1-OTHERKEY12345`, [KEY])).not.toMatch(/TESTKEY|abcdefghijklmnop|OTHERKEY/);
  });
  test('the logger redacts the key from every stream', () => {
    const out = sink(), err = sink();
    const logger = openrouter.createLogger({ secrets: [KEY], stdout: out, stderr: err });
    logger.info(`key=${KEY}`); logger.warn(KEY); logger.error(`x ${KEY}`);
    expect(out.text() + err.text()).not.toContain(KEY);
    expect(out.text()).toContain('[REDACTED]');
  });
  test('a provider error that echoes the key never reaches the log, CSV, summary, raw files or run.json', async () => {
    const fetchImpl = makeFetch({ chat: async () => response(401, { error: { code: 401, message: `Invalid key ${KEY} sent as Bearer ${KEY}` } }) });
    const { result, log } = await run({ models: [MODEL_A], live: true, confirm: 3, runId: 'k1' }, { fetchImpl, apiKey: KEY });
    // An authentication error would repeat for every call, so the run stops after the first one.
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'AUTH_ERROR' });
    expect(result.stoppedEarly).toMatch(/AUTH_ERROR/);
    expect(log).not.toContain(KEY);
    expect(textOf(result.files.runDir)).not.toContain('TESTKEY');
  });
  test('the key is only sent in the Authorization header, never in the request body', async () => {
    const fetchImpl = makeFetch();
    await run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY });
    for (const call of fetchImpl.posts()) {
      expect(call.headers.Authorization).toBe(`Bearer ${KEY}`);
      expect(call.body).not.toContain('TESTKEY');
    }
    expect(fetchImpl.calls.find(c => c.method === 'GET').headers.Authorization).toBeUndefined(); // the catalog lookup is unauthenticated
  });
  test('outputs of a successful live run contain no key and no transcript text outside raw/ and diffs/', async () => {
    const fetchImpl = makeFetch({ text: 'zephyrquill output from a model, quixotic marmalade' });
    const { result, log } = await run({ models: [MODEL_A], live: true, confirm: 3, runId: 'k2' }, { fetchImpl, apiKey: KEY });
    expect(log).not.toContain(KEY);
    const dir = result.files.runDir;
    for (const file of ['results.csv', 'summary.md', 'run.json']) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(content).not.toContain('TESTKEY');
      for (const word of SECRET_WORDS) expect(content.toLowerCase()).not.toContain(word);
    }
    for (const word of SECRET_WORDS) expect(log.toLowerCase()).not.toContain(word);
  });
});

describe('request construction and call handling', () => {
  const image = { mimeType: 'image/jpeg', bytes: Buffer.from('abc') };
  const plain = prompts.promptSpec('plain');

  test('same body for every model: temperature 0, reasoning off, strict routing, no sort by default', () => {
    const { body, sent } = openrouter.buildRequest({ model: MODEL_A, prompt: plain, image });
    expect(body).toMatchObject({ model: MODEL_A, temperature: 0, reasoning: { effort: 'none' }, max_tokens: 16000, provider: { require_parameters: true, allow_fallbacks: false } });
    expect(body.provider.sort).toBeUndefined();
    expect(body.provider.only).toBeUndefined();
    expect(body.response_format).toBeUndefined();
    expect(sent).toEqual({ temperature: true, reasoning: true });
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,YWJj');
  });
  test('--provider pins one provider and --sort sets the sort order', () => {
    expect(openrouter.buildRequest({ model: MODEL_A, prompt: plain, image, options: { provider: 'Parasail' } }).body.provider.only).toEqual(['Parasail']);
    expect(openrouter.buildRequest({ model: MODEL_A, prompt: plain, image, options: { sort: 'latency' } }).body.provider.sort).toBe('latency');
    expect(openrouter.buildRequest({ model: MODEL_A, prompt: plain, image, options: { sort: 'default' } }).body.provider.sort).toBeUndefined();
  });
  test('parameters a model cannot take are left out (so require_parameters does not reject every route)', () => {
    const caps = openrouter.capabilitiesFromCatalog({ id: 'x/y', supported_parameters: ['max_tokens'], architecture: { input_modalities: ['image'] } });
    const { body, sent } = openrouter.buildRequest({ model: 'x/y', prompt: plain, image, capabilities: caps });
    expect(body.temperature).toBeUndefined();
    expect(body.reasoning).toBeUndefined();
    expect(sent).toEqual({ temperature: false, reasoning: false });
  });
  test('production mode sends the production prompt and strict schema', () => {
    const spec = prompts.promptSpec('production');
    const wire = contract.wireContract(contract.QWEN_MODEL);
    const { body } = openrouter.buildRequest({ model: MODEL_A, prompt: spec, image });
    expect(body.messages[0].content).toBe(wire.prompt);
    expect(body.response_format).toMatchObject({ type: 'json_schema', json_schema: { name: wire.name, strict: true } });
  });

  test('usage, cost, provider, reasoning tokens and latency are read from the response', async () => {
    const fetchImpl = makeFetch({ reasoningTokens: 50, provider: 'Parasail', cost: 0.0123 });
    let t = 0;
    const result = await openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl, now: () => (t += 500) });
    expect(result).toMatchObject({ ok: true, provider: 'Parasail', latencyMs: 500, returnedModel: null, finishReason: 'stop' });
    expect(result.usage).toEqual({ promptTokens: 1000, completionTokens: 200, totalTokens: 1200, costUsd: 0.0123, reasoningTokens: 50 });
  });
  test('failures are classified, carry no key, and are never retried', async () => {
    const cases = [
      [400, { error: { message: 'No endpoints found that support the requested parameter reasoning' } }, 'PARAMETER_REJECTED'],
      [402, { error: { message: 'Insufficient credits' } }, 'PAYMENT_REQUIRED'],
      [429, { error: { message: 'Rate limited' } }, 'RATE_LIMITED'],
      [401, { error: { message: `bad ${KEY}` } }, 'AUTH_ERROR'],
      [500, { error: { message: 'Upstream failed' } }, 'HTTP_500'],
    ];
    for (const [status, body, code] of cases) {
      const fetchImpl = jest.fn(async () => response(status, body));
      const result = await openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl });
      expect(result).toMatchObject({ ok: false, errorCode: code });
      expect(JSON.stringify(result)).not.toContain('TESTKEY');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
    expect((await openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl: async () => response(200, 'not json') })).errorCode).toBe('BAD_RESPONSE');
    expect((await openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl: async () => { throw new Error(`connect failed for ${KEY}`); } }))).toMatchObject({ errorCode: 'NETWORK_ERROR' });
    expect((await openrouter.callOpenRouter({ body: {}, apiKey: KEY, timeoutMs: 5, fetchImpl: (_u, o) => new Promise((_r, rej) => o.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' })))) })).errorCode).toBe('TIMEOUT');
    expect((await openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl: async () => response(200, { choices: [{ message: { content: '  ' } }] }) })).errorCode).toBe('EMPTY_RESPONSE');
  });

  test('every call logs the serving provider, and reasoning tokens flag a model that did not switch reasoning off', async () => {
    const fetchImpl = makeFetch({ reasoningTokens: 120, provider: 'Parasail' });
    const { result, log } = await run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY });
    expect(result.rows.every(r => r.provider === 'Parasail' && r.reasoningNotOff === true)).toBe(true);
    expect(log).toMatch(/via Parasail/);
    expect(log).toMatch(/REASONING NOT OFF/);
    expect(result.summary).toMatch(/reasoning was NOT off\*\* on 3\/3 calls/);
  });
  test('reasoning text in the message also counts as reasoning not being off', async () => {
    const fetchImpl = makeFetch({ reasoningTokens: 0, reasoningText: 'Let me think...' });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY });
    expect(result.rows.every(r => r.reasoningNotOff)).toBe(true);
  });
  test('--provider and --sort reach the request, and the CSV records them', async () => {
    const pinned = makeFetch();
    const a = await run({ models: [MODEL_A], live: true, confirm: 3, provider: 'Parasail', runId: 'p1' }, { fetchImpl: pinned, apiKey: KEY });
    expect(JSON.parse(pinned.posts()[0].body).provider.only).toEqual(['Parasail']);
    expect(fs.readFileSync(a.result.files.csv, 'utf8')).toContain('Parasail');
    const sorted = makeFetch();
    await run({ models: [MODEL_A], live: true, confirm: 3, sort: 'latency', runId: 's1' }, { fetchImpl: sorted, apiKey: KEY });
    expect(JSON.parse(sorted.posts()[0].body).provider.sort).toBe('latency');
  });
  test('a model whose catalog entry has no temperature is run without it and the summary says so', async () => {
    const catalog = [{ ...CATALOG([MODEL_A])[0], supported_parameters: ['reasoning'] }];
    const fetchImpl = makeFetch({ catalog });
    const { result } = await run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY });
    expect(JSON.parse(fetchImpl.posts()[0].body).temperature).toBeUndefined();
    expect(result.summary).toMatch(/does not accept temperature/);
  });
  test('a model that is not in the catalog stops the run before any paid call', async () => {
    const fetchImpl = makeFetch({ catalog: CATALOG([MODEL_B]) });
    await expect(run({ models: [MODEL_A], live: true, confirm: 3 }, { fetchImpl, apiKey: KEY })).rejects.toThrow(/not in the OpenRouter catalog/);
    expect(fetchImpl.posts()).toHaveLength(0);
  });
  test('--check-models reads the catalog without an API key and prints capabilities and prices', async () => {
    const fetchImpl = makeFetch(), out = sink();
    const code = await cli.main(['--check-models', '--models', `${MODEL_A},missing/model`], { env: {}, stdout: out, stderr: sink(), fetchImpl });
    expect(code).toBe(0);
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].headers.Authorization).toBeUndefined();
    expect(out.text()).toMatch(new RegExp(`${MODEL_A} \\| yes \\| yes \\| yes \\| yes \\| yes \\| 0\\.3 / 1\\.2`));
    expect(out.text()).toMatch(/missing\/model \| no \| unknown/);
  });
});

describe('dry run end to end', () => {
  const MODELS = ['fake/perfect', 'fake/noisy', 'fake/autocorrect', 'fake/reasoning'];

  test('writes results.csv, summary.md, run.json, raw outputs and worst-3 diffs; leaves the dataset folder untouched', async () => {
    const before = fs.readdirSync(dataDir).sort();
    const { result } = await run({ models: MODELS, variants: ['original', 'preprocessed'], runId: 'd1' });
    expect(fs.readdirSync(dataDir).sort()).toEqual(before);
    const dir = result.files.runDir;
    expect(result.rows).toHaveLength(3 * 2 * 4);
    const csv = fs.readFileSync(path.join(dir, 'results.csv'), 'utf8').trim().split('\r\n');
    expect(csv).toHaveLength(1 + 24);
    expect(csv[0]).toMatch(/^photo,model,variant,source,status,error_code,validation,cer_case,wer_case,cer_nocase,wer_nocase/);
    expect(fs.existsSync(path.join(dir, 'summary.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'raw', 'fake__noisy', 'original', 'image1.json'))).toBe(true);
    expect(result.files.diffs.length).toBeGreaterThan(0);
    expect(result.files.diffs.every(f => f.includes(path.join(dir, 'diffs')))).toBe(true);
    for (const model of ['fake/noisy', 'fake/autocorrect']) {
      const perGroup = result.files.diffs.filter(f => f.includes(report.safeName(model)));
      expect(perGroup.length).toBeLessThanOrEqual(3 * 2);
    }
    expect(result.files.diffs.some(f => f.includes('fake__perfect'))).toBe(false); // nothing to show for a perfect reader
  });
  test('fake/perfect has zero CER and preserves every listed mistake; fake/autocorrect over-corrects every one', async () => {
    const { result } = await run({ models: ['fake/perfect', 'fake/autocorrect'], variants: ['original', 'preprocessed'] });
    for (const row of result.rows.filter(r => r.model === 'fake/perfect')) { expect(row.cerCs).toBe(0); expect(row.werCs).toBe(0); }
    const withList = name => result.rows.filter(r => r.name === name && r.overcorrection?.available);
    expect(withList('image1').filter(r => r.model === 'fake/perfect').every(r => r.overcorrection.preserved === 2)).toBe(true);
    expect(withList('image1').filter(r => r.model === 'fake/autocorrect').every(r => r.overcorrection.overcorrected === 2 && r.overcorrection.overcorrectionRate === 1)).toBe(true);
    expect(result.rows.find(r => r.name === 'image2').overcorrection.available).toBe(false); // no sidecar: unavailable, not zero
  });
  test('summary has the results table, the dry-run banner, the preprocessing comparison and warnings', async () => {
    const { result } = await run({ models: MODELS, variants: ['original', 'preprocessed'] });
    const s = result.summary;
    expect(s).toContain('DRY RUN - simulated models');
    expect(s).toMatch(/\| fake\/perfect \| original \| 3 \/ 3 \| 0\.0% \|/);
    expect(s).toContain('## Does preprocessing help?');
    expect(s).toMatch(/fake\/reasoning: reasoning was NOT off/);
    expect(s).toContain('## Serving provider per call');
  });
  test('production prompt mode runs through the production parser and records its verdict', async () => {
    const { result } = await run({ models: ['fake/perfect', 'fake/noisy'], promptMode: 'production' });
    const accepted = result.rows.filter(r => r.model === 'fake/perfect');
    expect(accepted.every(r => r.status === 'ok' && r.validation === 'accepted')).toBe(true);
    expect(result.rows.every(r => r.promptMode === 'production')).toBe(true);
  });
  test('the client-export variant is accepted alongside the others', async () => {
    const { result } = await run({ models: ['fake/perfect'], variants: ['original', 'preprocessed', 'client-export'] });
    expect(result.rows.map(r => r.variant)).toContain('client-export');
  });
  test('--suggest-mistakes writes draft files into the run folder, never into the dataset folder', async () => {
    const before = fs.readdirSync(dataDir).sort();
    const { result } = await run({ models: ['fake/autocorrect'], suggestMistakes: true, runId: 's2' });
    expect(fs.readdirSync(dataDir).sort()).toEqual(before);
    const draft = result.files.drafts.find(f => f.endsWith('image1.mistakes.draft.tsv'));
    expect(draft).toBeTruthy();
    expect(draft.startsWith(result.files.runDir)).toBe(true);
    expect(fs.readFileSync(draft, 'utf8')).toContain('powerfull\tpowerful');
  });
  test('an unreadable image becomes an error row for that photo; the rest of the run continues', async () => {
    const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-broken-'));
    try {
      await makeJpeg(path.join(broken, 'good.jpeg')); fs.writeFileSync(path.join(broken, 'good.txt'), 'A good page.');
      fs.writeFileSync(path.join(broken, 'bad.jpeg'), 'not an image'); fs.writeFileSync(path.join(broken, 'bad.txt'), 'A bad page.');
      const out = sink();
      const result = await runner.runEvaluation({ dataset: dataset.loadDataset(broken), models: ['fake/perfect'], variants: ['original'], outDir },
        { logger: openrouter.createLogger({ stdout: out, stderr: out }), fetchImpl: global.fetch });
      expect(result.rows.find(r => r.name === 'bad')).toMatchObject({ status: 'error', errorCode: 'IMAGE_FORMAT' });
      expect(result.rows.find(r => r.name === 'good')).toMatchObject({ status: 'ok' });
    } finally { fs.rmSync(broken, { recursive: true, force: true }); }
  });
  test('an unknown fake model is reported as an error row', async () => {
    const { result } = await run({ models: ['fake/unknown'] });
    expect(result.rows.every(r => r.status === 'error' && r.errorCode === 'UNKNOWN_FAKE_MODEL')).toBe(true);
  });
});

describe('CLI', () => {
  const env = () => ({ OCR_EVAL_DIR: dataDir, OCR_EVAL_OUT: outDir });

  test('--inspect prints counts and file names only, never ground-truth text', async () => {
    const out = sink();
    const code = await cli.main(['--inspect'], { env: env(), stdout: out, stderr: sink() });
    expect(code).toBe(0);
    const text = out.text();
    expect(text).toContain('Pairs: 3');
    expect(text.indexOf('image1 |')).toBeLessThan(text.indexOf('image2 |'));
    expect(text.indexOf('image2 |')).toBeLessThan(text.indexOf('image10 |'));
    expect(text).toMatch(/image1 \| image1\.jpeg \| \d+ \| 11 \| 0 \| 2 entries/);
    expect(text).toMatch(/image2 \| image2\.jpeg \| \d+ \| 10 \| 1 \| none/);
    for (const word of SECRET_WORDS) expect(text.toLowerCase()).not.toContain(word);
  });
  test('a dry run prints the summary and the run folder, and exits 0', async () => {
    const out = sink();
    const code = await cli.main(['--models', 'fake/perfect,fake/noisy', '--run-id', 'c1'], { env: env(), stdout: out, stderr: sink() });
    expect(code).toBe(0);
    expect(out.text()).toContain('# OCR evaluation summary');
    expect(out.text()).toContain(path.join(outDir, 'c1'));
    for (const word of SECRET_WORDS) expect(out.text().toLowerCase()).not.toContain(word);
  });
  test('usage errors exit 2 with a hint', async () => {
    for (const argv of [['--bogus'], ['--live', '--dry-run'], ['--provider', 'x', '--sort', 'latency'], ['--models', 'nonsense'], ['--resume'], ['--prompt', 'x'], ['--confirm', 'abc'], ['--max-cost-usd', '0']]) {
      const err = sink();
      expect(await cli.main(argv, { env: env(), stdout: sink(), stderr: err })).toBe(2);
      expect(err.text()).toMatch(/ERROR/);
    }
  });
  test('missing OCR_EVAL_DIR is a clear data error', async () => {
    const err = sink();
    expect(await cli.main(['--inspect'], { env: {}, stdout: sink(), stderr: err })).toBe(1);
    expect(err.text()).toMatch(/OCR_EVAL_DIR is not set/);
  });
  test('parseArgs reads values, defaults and --price', () => {
    const args = cli.parseArgs(['--models', `${MODEL_A},${MODEL_B},${MODEL_A}`, '--confirm=12', '--price', `${MODEL_A}=0.3:1.2`, '--sort', 'default', '--limit', '2']);
    expect(args).toMatchObject({ models: [MODEL_A, MODEL_B], confirm: 12, sort: 'default', limit: 2, promptMode: 'plain', live: false, variants: ['original', 'preprocessed'] });
    expect(args.prices[MODEL_A]).toEqual({ inputPerMillion: 0.3, outputPerMillion: 1.2 });
  });
});

describe('image variants', () => {
  const sample = path.join(os.tmpdir(), `ocr-eval-variant-${process.pid}.jpg`);
  afterAll(() => fs.rmSync(sample, { force: true }));

  test('original is exactly what production sends: untouched bytes when there is no EXIF rotation', async () => {
    await makeJpeg(sample);
    const bytes = fs.readFileSync(sample);
    const prepared = await variants.prepareVariant('original', bytes);
    expect(prepared.bytes.equals(bytes)).toBe(true);
    expect(prepared.mimeType).toBe('image/jpeg');
  });
  test('original re-encodes an EXIF-rotated JPEG as a high-quality JPEG with swapped dimensions, as production does', async () => {
    await makeJpeg(sample, { width: 900, height: 600, orientation: 6 });
    const prepared = await variants.prepareVariant('original', fs.readFileSync(sample));
    expect(prepared.mimeType).toBe('image/jpeg');
    expect([prepared.width, prepared.height]).toEqual([600, 900]);
  });
  test('preprocessed is a three-channel gray JPEG with the same dimensions', async () => {
    await makeJpeg(sample, { width: 900, height: 1200 });
    const prepared = await variants.prepareVariant('preprocessed', fs.readFileSync(sample));
    expect(prepared.mimeType).toBe('image/jpeg');
    expect([prepared.width, prepared.height, prepared.channels]).toEqual([900, 1200, 3]);
    const { data } = await sharp(prepared.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(data[0]).toBe(data[1]); expect(data[1]).toBe(data[2]); // gray: R = G = B
  });
  test('client-export never upscales and fits a heavy photo under 8 MB with the long edge kept at 2000 or more', async () => {
    await makeJpeg(sample, { width: 900, height: 1200 });
    const small = await variants.prepareVariant('client-export', fs.readFileSync(sample));
    expect([small.width, small.height]).toEqual([900, 1200]);

    const width = 4000, height = 3000, noise = crypto.randomBytes(width * height * 3);
    const heavy = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 100 }).toBuffer();
    expect(heavy.length).toBeGreaterThan(variants.CLIENT_EXPORT.targetBytes);
    const exported = await variants.prepareVariant('client-export', heavy);
    expect(exported.byteLength).toBeLessThanOrEqual(variants.CLIENT_EXPORT.targetBytes);
    expect(Math.max(exported.width, exported.height)).toBeGreaterThanOrEqual(variants.CLIENT_EXPORT.minLongEdge);
    expect(Math.abs(exported.width / exported.height - 4 / 3)).toBeLessThan(0.01);
  });
  test('bad inputs are rejected with clear codes', async () => {
    await expect(variants.prepareVariant('original', Buffer.from('not an image'))).rejects.toMatchObject({ code: 'IMAGE_FORMAT' });
    await expect(variants.prepareVariant('original', Buffer.alloc(0))).rejects.toMatchObject({ code: 'IMAGE_EMPTY' });
    const huge = Buffer.alloc(variants.MAX_IMAGE_BYTES + 1); huge[0] = 0xff; huge[1] = 0xd8; huge[2] = 0xff;
    await expect(variants.prepareVariant('original', huge)).rejects.toMatchObject({ code: 'IMAGE_TOO_LARGE' });
    await expect(variants.prepareVariant('sepia', Buffer.from('x'))).rejects.toMatchObject({ code: 'UNKNOWN_VARIANT' });
  });
});

describe('prompts and fake models', () => {
  test('the plain prompt tells the model to transcribe exactly, never correct, and follows the ground-truth conventions', () => {
    const spec = prompts.promptSpec('plain');
    expect(spec.system).toMatch(/Never correct, normalise/);
    expect(spec.system).toMatch(/powerfull. stays .powerfull./);
    expect(spec.system).toMatch(/crossed out .* leave it out/s);
    expect(spec.system).toMatch(/handwritten copy of the question/);
    expect(spec.system).toMatch(/Exclude printed header/);
    expect(spec.system).toMatch(/never write \[\?\]/);
    expect(spec.responseSchema).toBeNull();
  });
  test('the production prompt is the contract prompt, byte for byte, with its schema', () => {
    const spec = prompts.promptSpec('production'), wire = contract.wireContract(contract.QWEN_MODEL);
    expect(spec.system).toBe(wire.prompt);
    expect(spec.responseSchema).toBe(wire.schema);
  });
  test('prompts do not depend on the model, so every model gets the same one', () => {
    expect(prompts.promptSpec('plain')).toEqual(prompts.promptSpec('plain'));
    expect(prompts.promptSpec('plain').sha256).not.toBe(prompts.promptSpec('production').sha256);
  });
  test('extractTranscript removes only a wrapping code fence and nothing else', () => {
    expect(prompts.extractTranscript('plain', '```\nI go to  school\n```').text).toBe('I go to  school');
    expect(prompts.extractTranscript('plain', 'I go to school.\n\n').text).toBe('I go to school.');
    expect(prompts.extractTranscript('plain', '').status).toBe('empty');
  });
  test('extractTranscript production: joins active segments, ignores excluded ones, reports the validator verdict', () => {
    const json = segments => JSON.stringify({ version: 'qwen-physical-source-v1', uncertainties: [], physicalLines: [{ segments }] });
    const ok = prompts.extractTranscript('production', json([
      { classification: 'PROMPT_OR_INSTRUCTION', text: 'Write about...', confidence: 0.9 },
      { classification: 'STUDENT_ACTIVE_TEXT', text: 'I go ', confidence: 0.9 }, { classification: 'STUDENT_ACTIVE_TEXT', text: 'home', confidence: 0.9 }]));
    expect(ok).toMatchObject({ text: 'I go home', status: 'ok', validation: 'accepted' });
    expect(prompts.extractTranscript('production', 'not json')).toMatchObject({ status: 'invalid_json', text: '' });
    const rejected = JSON.stringify({ version: 'qwen-physical-source-v1', physicalLines: [{ segments: [
      { classification: 'STUDENT_ACTIVE_TEXT', text: 'I go', confidence: 0.9 }, { classification: 'UNCERTAIN', text: null, confidence: 0.1 }] }],
      uncertainties: [{ lineIndex: 0, segmentIndex: 1, kind: 'ACTIVE_TEXT_UNCERTAIN', reason: 'x' }] });
    expect(prompts.extractTranscript('production', rejected)).toMatchObject({ text: 'I go', validation: 'OCR_GPT_SOURCE_UNCERTAIN' });
  });
  test('fake models are deterministic, and fake/perfect returns the ground truth', () => {
    const item = load().items[0], image = { width: 900, height: 1200 };
    const a = fake.simulate({ model: 'fake/noisy', item, variant: 'original', promptMode: 'plain', image });
    const b = fake.simulate({ model: 'fake/noisy', item, variant: 'original', promptMode: 'plain', image });
    expect(a).toEqual(b);
    expect(fake.simulate({ model: 'fake/perfect', item, variant: 'original', promptMode: 'plain', image }).content).toBe(TRUTH.image1);
    expect(fake.simulate({ model: 'fake/reasoning', item, variant: 'original', promptMode: 'plain', image }).usage.reasoningTokens).toBeGreaterThan(0);
    expect(fake.simulate({ model: 'real/looking-model', item, variant: 'original', promptMode: 'plain', image })).toMatchObject({ ok: true, simulated: true });
  });
});

describe('reports', () => {
  const row = (over = {}) => ({ name: 'image1', model: MODEL_A, variant: 'original', source: 'live', status: 'ok', errorCode: null, validation: null,
    cerCs: 0.1, werCs: 0.2, cerCi: 0.08, werCi: 0.15, referenceWords: 10, uncertainMasked: 0, overcorrection: { available: false },
    costUsd: 0.01, costSource: 'api', promptTokens: 1000, completionTokens: 200, reasoningTokens: 0, reasoningNotOff: false, latencyMs: 2000,
    provider: 'P', returnedModel: MODEL_A, finishReason: 'stop', truncated: false, temperatureSent: true, reasoningParamSent: true,
    promptMode: 'plain', sort: 'default', pinnedProvider: null, imageBytes: 1, imageWidth: 1, imageHeight: 1, ...over });

  test('CSV escapes commas, quotes and line breaks and leaves null cells empty', () => {
    const csv = report.toCsv([row({ name: 'a,"b"\nc', costUsd: null })]);
    expect(csv).toContain('"a,""b""\nc"');
    expect(csv.split('\r\n')[1]).toMatch(/,,api,/);
  });
  test('averages skip failed calls and missing values', () => {
    const [group] = report.aggregate([row({ cerCs: 0.1 }), row({ name: 'image2', cerCs: 0.3 }), row({ name: 'image3', status: 'error', cerCs: null, costUsd: null })]);
    expect(group).toMatchObject({ calls: 3, ok: 2, failed: 1 });
    expect(group.cerCs).toBeCloseTo(0.2, 10);
    expect(group.costMean).toBeCloseTo(0.01, 10);
  });
  test('over-correction is pooled per occurrence across photos that have a list', () => {
    const o = (listed, overcorrected) => ({ available: true, listed, overcorrected });
    const pooled = report.pooledOvercorrection([row({ overcorrection: o(4, 1) }), row({ overcorrection: o(1, 1) }), row({ overcorrection: { available: false } })]);
    expect(pooled).toEqual({ listed: 5, overcorrected: 2, rate: 0.4 });
  });
  test('worst photos are chosen per model and variant by case-sensitive CER, ignoring errors and perfect results', () => {
    const rows = ['image1', 'image2', 'image3', 'image4', 'image5'].map((name, i) => row({ name, cerCs: [0.05, 0.4, 0.2, 0.3, 0][i] }));
    rows.push(row({ name: 'image6', status: 'error', cerCs: null }), row({ name: 'image1', variant: 'preprocessed', cerCs: 0.9 }));
    const worst = report.selectWorst(rows, 3);
    expect(worst.filter(r => r.variant === 'original').map(r => r.name)).toEqual(['image2', 'image4', 'image3']);
    expect(worst.filter(r => r.variant === 'preprocessed').map(r => r.name)).toEqual(['image1']);
  });
  test('the diff marks differences, escapes markdown, and treats [?] regions as ignored', () => {
    const md = report.renderDiff({ name: 'image9', model: MODEL_A, variant: 'original', groundTruth: 'a *b* c | [?] e', output: 'a *x* c | zzz e', cerCs: 0.1, werCs: 0.2 });
    expect(md).toContain('Private: this file contains student text');
    expect(md).toContain('**\\*b\\***');
    expect(md).toContain('\\|');
    expect(md).toContain('Uncertain in ground truth (ignored)');
    expect(md).toMatch(/Differences \(2\)/);
  });
  test('the summary pairs photos for the preprocessing comparison and reports provider variance', () => {
    const rows = [row({ name: 'image1', cerCs: 0.2 }), row({ name: 'image2', cerCs: 0.2, provider: 'Q' }),
      row({ name: 'image1', variant: 'preprocessed', cerCs: 0.1, werCs: 0.1 }), row({ name: 'image2', variant: 'preprocessed', cerCs: 0.1, werCs: 0.1 })];
    const meta = { runId: 'x', mode: 'live', startedAt: 't', promptMode: 'plain', sort: null, provider: null, variants: ['original', 'preprocessed'], models: [MODEL_A],
      photoCount: 2, reusedCalls: 0, totalCostUsd: 0.04, stoppedEarly: null, wildcardSpan: 2, datasetWarnings: ['image3.jpeg: skipped'] };
    const summary = report.renderSummary({ meta, rows });
    expect(summary).toMatch(/\| test\/model-a \| preprocessed \| 2 \| -10\.0 pp \| -10\.0 pp \|.*\| better \|/);
    expect(summary).toMatch(/served by 2 different providers \(P, Q\)/);
    expect(summary).toContain('Dataset: image3.jpeg: skipped');
    expect(summary).not.toContain('DRY RUN');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('a failed call is recorded and the run continues', () => {
  const live = { live: true, noCatalog: true };

  test('a failed call with --max-cost-usd and --price set does not stop the run', async () => {
    let n = 0;
    const fetchImpl = makeFetch({ chat: async (_u, o) => (++n === 1 ? errChat(503, 'Upstream unavailable') : okChat(o)) });
    const { result } = await run({ ...live, models: [MODEL_A], confirm: 3, maxCostUsd: 1, prices: PRICES(MODEL_A) }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(3);
    expect(result.stoppedEarly).toBeNull();
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'HTTP_503', httpStatus: 503, costUsd: 0, costSource: 'failed-no-charge' });
    expect(result.rows.slice(1).every(r => r.status === 'ok')).toBe(true);
  });
  test('--max-cost-usd is still enforced on successful calls, with failures in between', async () => {
    let n = 0;
    const fetchImpl = makeFetch({ chat: async (_u, o) => (++n === 1 ? errChat(503, 'Upstream unavailable') : okChat(o, { cost: 0.04 })) });
    const { result } = await run({ ...live, models: [MODEL_A], variants: ['original', 'preprocessed'], confirm: 6, maxCostUsd: 0.07 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(3); // failed, ok (0.04), ok (0.08 >= 0.07) -> stop
    expect(result.stoppedEarly).toMatch(/max-cost-usd 0\.07 reached/);
    expect(result.totalCostUsd).toBeCloseTo(0.08, 10);
  });
  test('a failed call that still reports a cost counts toward the cap', async () => {
    let n = 0;
    const fetchImpl = makeFetch({ chat: async (_u, o) => (++n === 1
      ? response(200, { model: bodyOf({ body: o.body }).model, usage: { prompt_tokens: 900, completion_tokens: 0, total_tokens: 900, cost: 0.05 }, choices: [{ finish_reason: 'stop', message: { content: '' } }] })
      : okChat(o, { cost: 0.04 })) });
    const { result } = await run({ ...live, models: [MODEL_A], confirm: 3, maxCostUsd: 0.07 }, { fetchImpl, apiKey: KEY });
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'EMPTY_RESPONSE', costUsd: 0.05 });
    expect(fetchImpl.posts()).toHaveLength(2);
    expect(result.stoppedEarly).toMatch(/reached/);
  });
  test('a timeout does not stop the run and is flagged as possibly billed', async () => {
    let n = 0;
    const fetchImpl = makeFetch({ chat: async (_u, o) => { if (++n === 1) throw Object.assign(new Error('aborted'), { name: 'AbortError' }); return okChat(o); } });
    const { result } = await run({ ...live, models: [MODEL_A], confirm: 3, maxCostUsd: 1, prices: PRICES(MODEL_A) }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'TIMEOUT', mayBeBilled: true, costUsd: null });
    expect(result.summary).toMatch(/may have been billed/);
    expect(result.stoppedEarly).toBeNull();
  });
  test('a successful call with no cost and no price still stops a capped run (the cap cannot be enforced)', async () => {
    const fetchImpl = makeFetch({ cost: null });
    const { result } = await run({ ...live, models: [MODEL_A], confirm: 3, maxCostUsd: 1 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(1);
    expect(result.stoppedEarly).toMatch(/cannot be enforced/);
  });
});

describe('--max-failures and fatal errors', () => {
  const ALL = ['original', 'preprocessed', 'client-export']; // 3 photos x 3 variants = 9 calls per model
  const failing = (status = 503, message = 'Upstream unavailable') => makeFetch({ chat: async (_u, o) => (bodyOf({ body: o.body }).model === MODEL_A ? errChat(status, message) : okChat(o)) });

  test('a model that fails every time is cut off after 5 consecutive failures (default); other models finish', async () => {
    const fetchImpl = failing();
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], variants: ALL, confirm: 18 }, { fetchImpl, apiKey: KEY });
    expect(postsFor(fetchImpl, MODEL_A)).toHaveLength(5);
    expect(postsFor(fetchImpl, MODEL_B)).toHaveLength(9);
    const a = result.rows.filter(r => r.model === MODEL_A);
    expect(a.filter(r => r.status === 'error')).toHaveLength(5);
    expect(a.filter(r => r.status === 'skipped')).toHaveLength(4);
    expect(a.filter(r => r.status === 'skipped').every(r => r.errorCode === 'SKIPPED_MAX_FAILURES' && r.source === 'skipped')).toBe(true);
    expect(result.rows.filter(r => r.model === MODEL_B).every(r => r.status === 'ok')).toBe(true);
    expect(result.callsMade).toBe(14);
    expect(result.summary).toMatch(/\| test\/model-a \| original \| 0 \/ \d+ \(\d+ skipped\)/);
  });
  test('--max-failures N sets the limit', async () => {
    const fetchImpl = failing();
    await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], variants: ALL, confirm: 18, maxFailures: 2 }, { fetchImpl, apiKey: KEY });
    expect(postsFor(fetchImpl, MODEL_A)).toHaveLength(2);
  });
  test('the count is of consecutive failures: a success resets it', async () => {
    const pattern = ['fail', 'fail', 'ok', 'fail', 'fail', 'ok', 'fail', 'fail', 'ok'];
    let n = 0;
    const fetchImpl = makeFetch({ chat: async (_u, o) => (pattern[n++] === 'fail' ? errChat(503, 'Upstream unavailable') : okChat(o)) });
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A], variants: ALL, confirm: 9, maxFailures: 3 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(9);
    expect(result.rows.some(r => r.status === 'skipped')).toBe(false);
  });
  test('skipped calls are not saved, so a later --resume tries them again', async () => {
    const fetchImpl = failing();
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], variants: ALL, confirm: 18, runId: 'mf' }, { fetchImpl, apiKey: KEY });
    const files = listAll(path.join(result.files.runDir, 'raw', 'test__model-a'));
    expect(files).toHaveLength(5);
  });
  test.each([[401, 'No auth credentials found', 'AUTH_ERROR'], [402, 'Insufficient credits', 'PAYMENT_REQUIRED']])('an HTTP %i (%s) stops the whole run at once', async (status, message, code) => {
    const fetchImpl = makeFetch({ chat: async () => errChat(status, message) });
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], confirm: 6 }, { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()).toHaveLength(1);
    expect(result.rows).toHaveLength(1);
    expect(result.stoppedEarly).toContain(code);
    expect(result.summary).toContain('Run stopped early');
  });
  test('a parameter rejection skips that model\'s remaining calls at once; other models continue', async () => {
    const fetchImpl = failing(400, 'No endpoints found that support the requested parameter reasoning');
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], confirm: 6 }, { fetchImpl, apiKey: KEY });
    expect(postsFor(fetchImpl, MODEL_A)).toHaveLength(1);
    expect(postsFor(fetchImpl, MODEL_B)).toHaveLength(3);
    const a = result.rows.filter(r => r.model === MODEL_A);
    expect(a.map(r => [r.status, r.errorCode])).toEqual([['error', 'PARAMETER_REJECTED'], ['skipped', 'SKIPPED_PARAMETER_REJECTED'], ['skipped', 'SKIPPED_PARAMETER_REJECTED']]);
    expect(result.stoppedEarly).toBeNull();
  });
  test('dry run: fake/always-fails is cut off after the limit while fake/perfect completes', async () => {
    const { result } = await run({ models: ['fake/always-fails', 'fake/perfect'], variants: ALL });
    const failed = result.rows.filter(r => r.model === 'fake/always-fails');
    expect(failed.filter(r => r.status === 'error')).toHaveLength(5);
    expect(failed.filter(r => r.status === 'skipped')).toHaveLength(4);
    expect(result.rows.filter(r => r.model === 'fake/perfect').every(r => r.status === 'ok')).toBe(true);
  });
  test('the summary counts skipped calls separately from failures', () => {
    const base = { name: 'image1', model: MODEL_A, variant: 'original', source: 'live', status: 'ok', cerCs: 0.1, werCs: 0.1, cerCi: 0.1, werCi: 0.1, costUsd: 0.01, latencyMs: 1 };
    const [group] = report.aggregate([base, { ...base, status: 'error', errorCode: 'HTTP_503' }, { ...base, status: 'skipped', source: 'skipped', errorCode: 'SKIPPED_MAX_FAILURES', costUsd: null }]);
    expect(group).toMatchObject({ calls: 3, ok: 1, failed: 1, skipped: 1 });
  });
  test('failed calls (cost 0) do not dilute the cost per page, but they stay in the total', () => {
    const base = { name: 'image1', model: MODEL_A, variant: 'original', source: 'live', status: 'ok', cerCs: 0.1, werCs: 0.1, cerCi: 0.1, werCi: 0.1, costUsd: 0.01, latencyMs: 1 };
    const [group] = report.aggregate([base, { ...base, name: 'image2' }, { ...base, name: 'image3', status: 'error', errorCode: 'HTTP_503', costUsd: 0, costSource: 'failed-no-charge' }]);
    expect(group.costMean).toBeCloseTo(0.01, 10);
    expect(group.costTotal).toBeCloseTo(0.02, 10);
  });
  test('CLI: --max-failures defaults to 5 and must be a whole number of at least 1', () => {
    expect(cli.parseArgs([]).maxFailures).toBe(5);
    expect(cli.parseArgs(['--max-failures', '3']).maxFailures).toBe(3);
    for (const bad of ['0', 'abc', '-1', '2.5']) expect(() => cli.parseArgs(['--max-failures', bad])).toThrow(/--max-failures/);
  });
});

describe('error details are captured, never lost in a generic message', () => {
  const nested = (innerMessage, extra = {}) => ({ error: { code: 400, message: 'Provider returned error',
    metadata: { provider_name: 'Google AI Studio', raw: JSON.stringify({ error: { message: innerMessage, type: 'invalid_request_error', ...extra } }) } } });
  const call = (status, body) => openrouter.callOpenRouter({ body: {}, apiKey: KEY, fetchImpl: async () => response(status, body) });

  test('the real reason inside an OpenRouter "Provider returned error" wrapper is read, classified, and the parameter named', async () => {
    const result = await call(400, nested("Invalid value for 'reasoning.effort': 'none'. Supported values are: 'low', 'medium', 'high'.", { param: 'reasoning.effort' }));
    expect(result).toMatchObject({ ok: false, errorCode: 'PARAMETER_REJECTED', httpStatus: 400, rejectedParam: 'reasoning.effort', providerName: 'Google AI Studio' });
    expect(result.errorDetail).toContain('Supported values are');
    expect(result.errorDetail).not.toBe('Provider returned error');
  });
  test('the rejected parameter is inferred from the text when the API does not name it', async () => {
    const cases = [
      [404, { error: { message: 'No endpoints found that support the requested parameter reasoning' } }, 'reasoning'],
      [400, { error: { message: 'temperature is not supported for this model' } }, 'temperature'],
      [400, { error: { message: "'max_tokens' must be less than 8192" } }, 'max_tokens'],
      [400, { error: { message: 'Unsupported value: reasoning effort none' } }, 'reasoning.effort'],
      [400, { error: { message: 'something else entirely' } }, null],
      [500, { error: { message: 'reasoning backend crashed' } }, null],
    ];
    for (const [status, body, param] of cases) expect((await call(status, body)).rejectedParam).toBe(param);
  });
  test('a plain-text provider message is used as the detail', async () => {
    const result = await call(400, { error: { code: 400, message: 'Provider returned error', metadata: { raw: 'Model does not support effort none' } } });
    expect(result.errorDetail).toContain('does not support effort none');
    expect(result.rejectedParam).toBe('reasoning.effort');
  });
  test('details are bounded and carry no key or long encoded blobs', async () => {
    const blob = 'QUJD'.repeat(80);
    const result = await call(400, { error: { message: `bad request with ${KEY} and ${blob} ${'x '.repeat(400)}` } });
    expect(result.errorDetail).not.toContain('TESTKEY');
    expect(result.errorDetail).not.toContain(blob);
    expect(result.errorDetail).toContain('[...]');
    expect(result.errorDetail.length).toBeLessThanOrEqual(400);
  });
  test('results.csv gets http_status, error_detail and rejected_param, and summary.md a Failed calls section', async () => {
    const fetchImpl = makeFetch({ chat: async (_u, o) => (bodyOf({ body: o.body }).model === MODEL_A
      ? response(400, nested("Invalid value for 'reasoning.effort': 'none'. Supported values are: 'low', 'medium', 'high'.", { param: 'reasoning.effort' }))
      : okChat(o)) });
    const { result } = await run({ live: true, noCatalog: true, models: [MODEL_A, MODEL_B], confirm: 6, runId: 'ed' }, { fetchImpl, apiKey: KEY });
    const lines = fs.readFileSync(result.files.csv, 'utf8').trim().split('\r\n');
    // Newer columns (S/D/I, calls_per_page, temperature_mode) are appended after these.
    expect(lines[0]).toMatch(/,http_status,error_detail,rejected_param,may_be_billed,reasoning_mode,reasoning_sent(,|$)/);
    const failedLine = lines.find(l => l.includes('PARAMETER_REJECTED') && !l.includes('SKIPPED'));
    expect(failedLine).toContain('400');
    expect(failedLine).toContain('reasoning.effort');
    expect(failedLine).toContain('Supported values are');
    const summary = result.summary;
    expect(summary).toContain('## Failed calls');
    expect(summary).toMatch(/test\/model-a.*PARAMETER_REJECTED.*HTTP 400.*reasoning\.effort.*Supported values are/);
    expect(summary).toContain('--reasoning-for');
    expect(summary + fs.readFileSync(result.files.csv, 'utf8')).not.toContain('TESTKEY');
  });
  test('dry run: fake/needs-reasoning is rejected with reasoning.effort named, then skipped', async () => {
    const { result } = await run({ models: ['fake/needs-reasoning'] });
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'PARAMETER_REJECTED', httpStatus: 400, rejectedParam: 'reasoning.effort' });
    expect(result.rows.slice(1).every(r => r.status === 'skipped')).toBe(true);
  });
});

describe('--reasoning-for: what was sent is recorded', () => {
  const reasoningOf = (fetchImpl, model) => postsFor(fetchImpl, model).map(c => bodyOf(c).reasoning);

  test('a per-model mode changes only that model\'s request', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run({ live: true, models: [MODEL_A, MODEL_B], confirm: 6, reasoningFor: { [MODEL_A]: 'low' } }, { fetchImpl, apiKey: KEY });
    expect(new Set(reasoningOf(fetchImpl, MODEL_A).map(r => JSON.stringify(r)))).toEqual(new Set(['{"effort":"low"}']));
    expect(new Set(reasoningOf(fetchImpl, MODEL_B).map(r => JSON.stringify(r)))).toEqual(new Set(['{"effort":"none"}']));
    expect(result.rows.find(r => r.model === MODEL_A)).toMatchObject({ reasoningMode: 'low', reasoningSent: '{"effort":"low"}', reasoningParamSent: true });
    expect(result.rows.find(r => r.model === MODEL_B)).toMatchObject({ reasoningMode: 'none', reasoningSent: '{"effort":"none"}' });
  });
  test.each(['minimal', 'medium', 'high'])('%s is sent as that effort', async mode => {
    const fetchImpl = makeFetch();
    await run({ live: true, models: [MODEL_A], confirm: 3, reasoningFor: { [MODEL_A]: mode } }, { fetchImpl, apiKey: KEY });
    expect(reasoningOf(fetchImpl, MODEL_A)[0]).toEqual({ effort: mode });
  });
  test('omit sends no reasoning parameter and says so', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run({ live: true, models: [MODEL_A, MODEL_B], confirm: 6, reasoningFor: { [MODEL_A]: 'omit' } }, { fetchImpl, apiKey: KEY });
    expect(postsFor(fetchImpl, MODEL_A).every(c => !('reasoning' in bodyOf(c)))).toBe(true);
    expect(result.rows.find(r => r.model === MODEL_A)).toMatchObject({ reasoningMode: 'omit', reasoningSent: 'omitted (not requested)', reasoningParamSent: false });
  });
  test('a mode the catalog says the model cannot take is omitted, with the reason recorded', async () => {
    const catalog = [{ ...CATALOG([MODEL_A])[0], supported_parameters: ['temperature'] }];
    const fetchImpl = makeFetch({ catalog });
    const { result } = await run({ live: true, models: [MODEL_A], confirm: 3, reasoningFor: { [MODEL_A]: 'low' } }, { fetchImpl, apiKey: KEY });
    expect(postsFor(fetchImpl, MODEL_A).every(c => !('reasoning' in bodyOf(c)))).toBe(true);
    expect(result.rows[0].reasoningSent).toBe('omitted (catalog: no reasoning control)');
  });
  test('summary.md has a Request settings table, and warns when models are not like-for-like', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run({ live: true, models: [MODEL_A, MODEL_B], confirm: 6, reasoningFor: { [MODEL_A]: 'omit' } }, { fetchImpl, apiKey: KEY });
    const s = result.summary;
    expect(s).toContain('## Request settings per model');
    expect(s).toMatch(/\| test\/model-a \| sent: 0 \| omit -> omitted \(not requested\) \| 16000 \|/);
    expect(s).toMatch(/\| test\/model-b \| sent: 0 \| none -> \{"effort":"none"\} \| 16000 \|/);
    expect(s).toMatch(/different reasoning settings/);
  });
  test('when every model uses the default, the table is there but there is no like-for-like warning', async () => {
    const { result } = await run({ live: true, models: [MODEL_A, MODEL_B], confirm: 6 }, { fetchImpl: makeFetch(), apiKey: KEY });
    expect(result.summary).toContain('## Request settings per model');
    expect(result.summary).not.toMatch(/different reasoning settings/);
  });
  test('results.csv records reasoning_mode and reasoning_sent for every call', async () => {
    const { result } = await run({ live: true, models: [MODEL_A], confirm: 3, reasoningFor: { [MODEL_A]: 'high' } }, { fetchImpl: makeFetch(), apiKey: KEY });
    const lines = fs.readFileSync(result.files.csv, 'utf8').trim().split('\r\n');
    expect(lines[1]).toMatch(/,high,"\{""effort"":""high""\}"(,|$)/);
  });
  test('a different mode is a different request: --resume does not reuse the other mode\'s results', async () => {
    await run({ live: true, models: [MODEL_A], confirm: 3, runId: 'rf', reasoningFor: { [MODEL_A]: 'none' } }, { fetchImpl: makeFetch(), apiKey: KEY });
    const { result } = await run({ live: true, models: [MODEL_A], confirm: 3, resume: true, runId: 'rf', reasoningFor: { [MODEL_A]: 'low' } }, { fetchImpl: makeFetch(), apiKey: KEY });
    expect(result.reusedCalls).toBe(0);
  });
  test('dry run: fake/needs-reasoning accepts low, and its reasoning tokens are reported', async () => {
    const { result } = await run({ models: ['fake/needs-reasoning'], reasoningFor: { 'fake/needs-reasoning': 'low' } });
    expect(result.rows.every(r => r.status === 'ok' && r.reasoningSent === '{"effort":"low"}')).toBe(true);
    expect(result.rows.every(r => r.reasoningNotOff && r.reasoningTokens > 0)).toBe(true);
    expect(result.summary).toContain('low -> {"effort":"low"}');
  });
  test('invalid settings are rejected before anything runs', async () => {
    await expect(run({ models: [MODEL_A], reasoningFor: { [MODEL_A]: 'bogus' } })).rejects.toThrow(/reasoning/i);
    await expect(run({ models: [MODEL_A], reasoningFor: { [MODEL_B]: 'low' } })).rejects.toThrow(/not in --models/);
  });
  test('CLI: parses --reasoning-for (repeatable) and rejects bad modes, bad format and models not in --models', async () => {
    expect(cli.parseArgs(['--models', `${MODEL_A},${MODEL_B}`, '--reasoning-for', `${MODEL_A}=low`, '--reasoning-for', `${MODEL_B}=omit`]).reasoningFor)
      .toEqual({ [MODEL_A]: 'low', [MODEL_B]: 'omit' });
    expect(cli.parseArgs([]).reasoningFor).toEqual({});
    for (const argv of [['--models', MODEL_A, '--reasoning-for', `${MODEL_A}=bogus`], ['--models', MODEL_A, '--reasoning-for', 'nonsense'],
      ['--models', MODEL_A, '--reasoning-for', `${MODEL_B}=low`]]) {
      const err = sink();
      expect(await cli.main(argv, { env: { OCR_EVAL_DIR: dataDir, OCR_EVAL_OUT: outDir }, stdout: sink(), stderr: err })).toBe(2);
      expect(err.text()).toMatch(/--reasoning-for/);
    }
  });
});
