'use strict';
// Candidate prompt modes (A plain-first, C production-trim, D lean-json), --temperature, word-level S/D/I columns,
// incremental reports and --rescore. Synthetic, local data only; a global fetch trap fails any real network call.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

const prompts = require('../scripts/ocr-eval/lib/prompts.cjs');
const candidates = require('../scripts/ocr-eval/lib/candidates.cjs');
const openrouter = require('../scripts/ocr-eval/lib/openrouter.cjs');
const dataset = require('../scripts/ocr-eval/lib/dataset.cjs');
const runner = require('../scripts/ocr-eval/lib/runner.cjs');
const csv = require('../scripts/ocr-eval/lib/csv.cjs');
const cli = require('../scripts/ocr-eval/run.cjs');
const contract = require('../src/services/gptVisionExact/contract.js');

jest.setTimeout(120000);

const KEY = 'sk-or-v1-TESTKEY0123456789abcdefTESTKEY';
const MODEL = 'test/model-a';
const TRUTH = {
  image1: 'The zephyrquill was powerfull and strong.\nShe go to market yesterday.',
  image2: 'My quixotic brother recieve a letter last week.',
  image10: 'Plain sentence about marmalade jars.',
};

let dataDir, outDir, realFetch;
const sink = () => { const chunks = []; return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') }; };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const CATALOG = (params = ['temperature', 'reasoning', 'structured_outputs', 'response_format']) =>
  [{ id: MODEL, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: params, pricing: { prompt: '0.0000003', completion: '0.0000012' } }];
const okReply = (options, content) => {
  const body = JSON.parse(options.body);
  return response(200, { model: body.model, provider: 'TestProvider', usage: { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost: 0.001 },
    choices: [{ finish_reason: 'stop', message: { content } }] });
};
function makeFetch({ content = TRUTH.image1, catalog = CATALOG(), chat = null } = {}) {
  const calls = [];
  const fn = jest.fn(async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (String(url).endsWith('/models')) return response(200, { data: catalog });
    return chat ? chat(options, calls) : okReply(options, typeof content === 'function' ? content(options) : content);
  });
  fn.posts = () => calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body));
  return fn;
}
async function makeJpeg(file) {
  const width = 600, height = 800, pixels = Buffer.alloc(width * height * 3, 220);
  fs.writeFileSync(file, await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer());
}
const load = () => dataset.loadDataset(dataDir);
function run(extra = {}, deps = {}) {
  const out = sink();
  const logger = openrouter.createLogger({ secrets: [KEY], stdout: out, stderr: out });
  return runner.runEvaluation({ dataset: load(), models: ['fake/perfect'], variants: ['original'], outDir, ...extra },
    { logger, fetchImpl: global.fetch, apiKey: null, ...deps }).then(result => ({ result, log: out.text() }));
}
const live = (extra = {}) => ({ live: true, models: [MODEL], confirm: 3, ...extra });
const csvRows = file => csv.parseCsv(fs.readFileSync(file, 'utf8'));

beforeAll(async () => {
  realFetch = global.fetch;
  global.fetch = jest.fn(() => { throw new Error('REAL NETWORK CALL ATTEMPTED IN A TEST'); });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-cand-data-'));
  for (const [name, text] of Object.entries(TRUTH)) {
    await makeJpeg(path.join(dataDir, `${name}.jpeg`));
    fs.writeFileSync(path.join(dataDir, `${name}.txt`), text);
  }
});
afterAll(() => { global.fetch = realFetch; fs.rmSync(dataDir, { recursive: true, force: true }); });
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-cand-out-')); });
afterEach(() => { fs.rmSync(outDir, { recursive: true, force: true }); });

const codeOf = fn => { try { fn(); return null; } catch (error) { return error.code; } };

// ---------------------------------------------------------------------------------------------------------------------
describe('candidate converter: transcription text -> production evidence', () => {
  test('plain lines become one active segment per line and pass the production validators', () => {
    const wire = candidates.plainTextToWire('First line here.\n\n  Second line.  \n');
    const value = contract.validateWire(wire);
    expect(value.activeTranscript).toBe('First line here.\nSecond line.');
    expect(JSON.parse(wire).physicalLines.every(l => l.segments.length === 1 && l.segments[0].classification === 'STUDENT_ACTIVE_TEXT')).toBe(true);
    expect(() => contract.validateCanonical(JSON.stringify(value))).not.toThrow();
  });
  test('[?] becomes an uncertain segment, so production would reject the page; readable words keep single spaces', () => {
    const wire = candidates.plainTextToWire('I saw the [?] cat\nok line');
    expect(codeOf(() => contract.validateWire(wire))).toBe('OCR_GPT_SOURCE_UNCERTAIN');
    const parsed = JSON.parse(wire);
    expect(parsed.physicalLines[0].segments.map(s => s.classification)).toEqual(['STUDENT_ACTIVE_TEXT', 'UNCERTAIN', 'STUDENT_ACTIVE_TEXT']);
    expect(parsed.uncertainties).toEqual([expect.objectContaining({ lineIndex: 0, segmentIndex: 1, kind: 'ACTIVE_TEXT_UNCERTAIN' })]);
    expect(prompts.extractTranscript('plain-first', 'I saw the [?] cat\nok line')).toMatchObject({ status: 'ok', text: 'I saw the cat\nok line', validation: 'OCR_GPT_SOURCE_UNCERTAIN' });
  });
  test('the suffix form word[?] keeps the best guess as the uncertain text', () => {
    const segments = JSON.parse(candidates.plainTextToWire('powerfull[?] things')).physicalLines[0].segments;
    expect(segments).toEqual([expect.objectContaining({ classification: 'UNCERTAIN', text: 'powerfull' }), expect.objectContaining({ classification: 'STUDENT_ACTIVE_TEXT', text: 'things' })]);
  });
  test('several markers in a line, and a line that is only a marker', () => {
    const parsed = JSON.parse(candidates.plainTextToWire('a [?] [?] b\n[?]'));
    expect(parsed.physicalLines[0].segments.filter(s => s.classification === 'STUDENT_ACTIVE_TEXT').map(s => s.text).join('')).toBe('a b');
    expect(parsed.physicalLines[1].segments.map(s => s.classification)).toEqual(['UNCERTAIN']);
    expect(parsed.uncertainties).toHaveLength(3);
  });
  test('a very long line is split into segments within the schema limit that still join to the exact line', () => {
    const line = 'word '.repeat(900).trim();
    const parsed = JSON.parse(candidates.plainTextToWire(line));
    expect(parsed.physicalLines[0].segments.length).toBeGreaterThan(1);
    expect(parsed.physicalLines[0].segments.every(s => s.text.length <= 2000)).toBe(true);
    expect(contract.validateWire(candidates.plainTextToWire(line)).activeTranscript).toBe(line);
  });
  test('more than 300 lines is a structural failure, not a readability rejection', () => {
    const text = Array.from({ length: 301 }, (_, i) => `line ${i}`).join('\n');
    expect(prompts.extractTranscript('plain-first', text).validation).toBe('OCR_GPT_SOURCE_SCHEMA');
  });
  test('lean JSON: student lines are active, excluded lines stay out of the transcript', () => {
    const content = JSON.stringify({ version: candidates.LEAN_VERSION, lines: [{ text: 'Name: ____  Date: ____', kind: 'excluded' }, { text: 'Hello there', kind: 'student' }] });
    expect(prompts.extractTranscript('lean-json', content)).toMatchObject({ status: 'ok', text: 'Hello there', validation: 'accepted' });
    const parsed = JSON.parse(candidates.leanToWire(content));
    expect(parsed.physicalLines[0].segments[0]).toMatchObject({ classification: 'HEADER_OR_TEMPLATE' });
  });
  test('lean JSON in the wrong shape, or not JSON at all, is invalid', () => {
    expect(prompts.extractTranscript('lean-json', '{"lines":"x"}')).toMatchObject({ status: 'invalid_json', text: '' });
    expect(prompts.extractTranscript('lean-json', 'not json')).toMatchObject({ status: 'invalid_json', text: '' });
  });
  test('an empty reply is reported as empty', () => {
    expect(prompts.extractTranscript('plain-first', '  ').status).toBe('empty');
  });
  test('an accepted production reply is also checked against the stricter canonical validator', () => {
    const wire = candidates.plainTextToWire(TRUTH.image1);
    expect(prompts.extractTranscript('production', wire)).toMatchObject({ status: 'ok', validation: 'accepted', text: TRUTH.image1 });
  });
});

describe('prompt modes', () => {
  test('the new modes are available next to plain and production', () => {
    expect(prompts.PROMPT_MODES).toEqual(['plain', 'production', 'plain-first', 'production-trim', 'lean-json', 'verbatim-json', 'plain-first-excl', 'verbatim-json-v2', 'verbatim-json-v2-no14']);
  });
  test('A plain-first: the measured plain prompt with one change, genuinely unreadable words become [?]', () => {
    const plain = prompts.promptSpec('plain').system.split('\n'), first = prompts.promptSpec('plain-first');
    const lines = first.system.split('\n');
    expect(lines).toHaveLength(plain.length);
    expect(lines.filter((line, i) => line !== plain[i])).toHaveLength(1);
    expect(first.system).toMatch(/genuinely unreadable.*write \[\?\]/);
    expect(first.system).not.toMatch(/never write \[\?\]/);
    expect(first.system).toMatch(/handwritten copy of the question/);
    expect(first).toMatchObject({ responseSchema: null, output: 'text', callsPerPage: 1 });
  });
  test('C production-trim: the production prompt without the self-check paragraph, plus line-level and copied-question rules', () => {
    const wire = contract.wireContract(contract.QWEN_MODEL), trim = prompts.promptSpec('production-trim');
    expect(wire.prompt).toContain('Inside this SAME request');
    expect(trim.system).not.toContain('Inside this SAME request');
    expect(trim.system.startsWith(wire.prompt.split('\n')[0])).toBe(true);
    expect(trim.system).toMatch(/ONE STUDENT_ACTIVE_TEXT segment/);
    expect(trim.system).toMatch(/handwritten copy of the question/);
    expect(trim.responseSchema).toBe(wire.schema);
    expect(trim.schemaName).toBe(wire.name);
  });
  test('D lean-json: one object per line with a strict two-field schema', () => {
    const lean = prompts.promptSpec('lean-json');
    const item = lean.responseSchema.properties.lines.items;
    expect(Object.keys(item.properties)).toEqual(['text', 'kind']);
    expect(item.properties.kind.enum).toEqual(['student', 'excluded']);
    expect(item.additionalProperties).toBe(false);
    expect(lean.system).toMatch(/one object per physical line/);
    expect(lean.system).toMatch(/genuinely unreadable.*write \[\?\]/);
    expect(lean.schemaName).toBe('ocr_eval_lean_lines_v1');
  });
  test('every mode has its own fingerprint and makes one call per page', () => {
    const specs = prompts.PROMPT_MODES.map(prompts.promptSpec);
    expect(new Set(specs.map(s => s.sha256)).size).toBe(specs.length);
    expect(specs.every(s => s.callsPerPage === 1)).toBe(true);
  });
});

describe('--temperature 0|omit', () => {
  const image = { mimeType: 'image/jpeg', bytes: Buffer.from('abc') };
  test('the request leaves temperature out on request; 0 stays the default', () => {
    const plain = prompts.promptSpec('plain');
    expect(openrouter.buildRequest({ model: MODEL, prompt: plain, image }).body.temperature).toBe(0);
    const { body, sent } = openrouter.buildRequest({ model: MODEL, prompt: plain, image, options: { temperature: 'omit' } });
    expect(body.temperature).toBeUndefined();
    expect(sent.temperature).toBe(false);
    expect(openrouter.TEMPERATURE_MODES).toEqual(['0', 'omit']);
  });
  test('CLI: --temperature accepts 0 (default) or omit only', () => {
    expect(cli.parseArgs([]).temperature).toBe('0');
    expect(cli.parseArgs(['--temperature', 'omit']).temperature).toBe('omit');
    expect(() => cli.parseArgs(['--temperature', '0.7'])).toThrow(/--temperature/);
  });
  test('a live run with omit sends no temperature, records it, and is not reused by a temperature-0 resume', async () => {
    const fetchImpl = makeFetch();
    const { result } = await run(live({ temperature: 'omit', runId: 't1' }), { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts().every(body => !('temperature' in body))).toBe(true);
    expect(result.rows.every(r => r.temperatureMode === 'omit' && r.temperatureSent === false)).toBe(true);
    expect(csvRows(result.files.csv).every(r => r.temperature_mode === 'omit')).toBe(true);
    expect(result.summary).toContain('not sent (requested omit)');
    expect(result.summary).toMatch(/temperature omitted on request/);
    const again = await run(live({ resume: true, runId: 't1' }), { fetchImpl: makeFetch(), apiKey: KEY });
    expect(again.result.reusedCalls).toBe(0);
  });
});

describe('new modes end to end', () => {
  test('plain-first sends plain text at temperature 0 and records the production verdict', async () => {
    const fetchImpl = makeFetch({ content: TRUTH.image1 });
    const { result } = await run(live({ promptMode: 'plain-first' }), { fetchImpl, apiKey: KEY });
    const body = fetchImpl.posts()[0];
    expect(body.response_format).toBeUndefined();
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toBe(prompts.promptSpec('plain-first').system);
    expect(result.rows.every(r => r.validation === 'accepted')).toBe(true);
    expect(result.rows.find(r => r.name === 'image1').cerCs).toBe(0);
  });
  test('production-trim and lean-json request a strict schema and parse their replies', async () => {
    const trimFetch = makeFetch({ content: candidates.plainTextToWire(TRUTH.image1) });
    const trim = await run(live({ promptMode: 'production-trim' }), { fetchImpl: trimFetch, apiKey: KEY });
    expect(trimFetch.posts()[0].response_format.json_schema.name).toBe(contract.wireContract(contract.QWEN_MODEL).name);
    expect(trim.result.rows.find(r => r.name === 'image1')).toMatchObject({ status: 'ok', validation: 'accepted', cerCs: 0 });
    const leanReply = JSON.stringify({ version: candidates.LEAN_VERSION, lines: TRUTH.image1.split('\n').map(text => ({ text, kind: 'student' })) });
    const leanFetch = makeFetch({ content: leanReply });
    const lean = await run(live({ promptMode: 'lean-json' }), { fetchImpl: leanFetch, apiKey: KEY });
    expect(leanFetch.posts()[0].response_format.json_schema).toMatchObject({ name: 'ocr_eval_lean_lines_v1', strict: true });
    expect(lean.result.rows.find(r => r.name === 'image1')).toMatchObject({ status: 'ok', validation: 'accepted', cerCs: 0 });
  });
  test('a JSON mode is refused before any paid call when the catalog says the model has no structured output', async () => {
    const fetchImpl = makeFetch({ catalog: CATALOG(['temperature', 'reasoning']) });
    await expect(run(live({ promptMode: 'lean-json' }), { fetchImpl, apiKey: KEY })).rejects.toThrow(/structured outputs/);
    expect(fetchImpl.posts()).toHaveLength(0);
  });
  test.each(['plain-first', 'production-trim', 'lean-json'])('dry run: %s works with the fake models', async mode => {
    const { result } = await run({ promptMode: mode });
    expect(result.rows.every(r => r.status === 'ok' && r.cerCs === 0 && r.validation === 'accepted')).toBe(true);
  });
});

describe('word-level substitutions, deletions and insertions', () => {
  test('S/D/I and calls per page are recorded in results.csv', async () => {
    const fetchImpl = makeFetch({ content: 'The zephyrquill was powerfull and\nShe go to market yesterday.' }); // "strong." left out
    const { result } = await run(live(), { fetchImpl, apiKey: KEY });
    const rows = csvRows(result.files.csv);
    // Appended after the earlier columns, in this order (later steps append more after them).
    const header = Object.keys(rows[0]), start = header.indexOf('substitutions');
    expect(header.slice(start, start + 5)).toEqual(['substitutions', 'deletions', 'insertions', 'calls_per_page', 'temperature_mode']);
    expect(header.slice(start - 2, start)).toEqual(['reasoning_mode', 'reasoning_sent']);
    expect(rows.find(r => r.photo === 'image1')).toMatchObject({ substitutions: '0', deletions: '1', insertions: '0', calls_per_page: '1', temperature_mode: '0' });
  });
});

describe('incremental reports', () => {
  test('results.csv and summary.md are rewritten after every call, so an interrupted run keeps what it did', async () => {
    const runDir = path.join(outDir, 'inc');
    let seenRows = null, seenSummary = null;
    const fetchImpl = makeFetch({ chat: (options, calls) => {
      if (calls.filter(c => c.method === 'POST').length === 2) {
        seenRows = csvRows(path.join(runDir, 'results.csv')).length;
        seenSummary = fs.readFileSync(path.join(runDir, 'summary.md'), 'utf8');
      }
      return okReply(options, TRUTH.image1);
    } });
    const { result } = await run(live({ runId: 'inc' }), { fetchImpl, apiKey: KEY });
    expect(seenRows).toBe(1);
    expect(seenSummary).toMatch(/Partial results: 1 of 3/);
    expect(result.summary).not.toMatch(/Partial results/);
    expect(csvRows(result.files.csv)).toHaveLength(3);
  });
});

describe('--rescore (offline, no network, no API key)', () => {
  const env = () => ({ OCR_EVAL_DIR: dataDir, OCR_EVAL_OUT: outDir });
  const rawRecord = (over = {}) => ({ toolVersion: 'ocr-eval-1', fingerprint: 'x', mode: 'live', savedAt: '2026-11-01T00:00:00.000Z', model: MODEL, variant: 'original',
    name: 'image1', sent: { temperature: true, reasoning: true }, result: { ok: true, content: TRUTH.image1, latencyMs: 1500, provider: 'P', returnedModel: MODEL, finishReason: 'stop',
      usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, costUsd: 0.001, reasoningTokens: 0 } }, ...over });
  const writeRaw = (runId, record) => {
    const file = path.join(outDir, runId, 'raw', 'test__model-a', record.variant, `${record.name}.json`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(record));
  };

  test('rebuilds results.csv and summary.md of an interrupted run from saved calls', async () => {
    const { result } = await run(live({ runId: 'rs', promptMode: 'plain-first' }), { fetchImpl: makeFetch(), apiKey: KEY });
    const before = csvRows(result.files.csv);
    for (const file of ['results.csv', 'summary.md', 'run.json']) fs.rmSync(path.join(result.files.runDir, file));
    const spy = makeFetch(), out = sink();
    const code = await cli.main(['--rescore', 'rs'], { env: env(), stdout: out, stderr: sink(), fetchImpl: spy });
    expect(code).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    const after = csvRows(path.join(result.files.runDir, 'results.csv'));
    expect(after.map(r => [r.photo, r.cer_case, r.wer_case, r.validation, r.prompt_mode])).toEqual(before.map(r => [r.photo, r.cer_case, r.wer_case, r.validation, r.prompt_mode]));
    expect(after.every(r => r.deletions !== '')).toBe(true);
    expect(fs.existsSync(path.join(result.files.runDir, 'summary.md'))).toBe(true);
    expect(out.text()).toContain('# OCR evaluation summary');
  });
  test('saved calls now record the prompt mode, sort, pinned provider and temperature', async () => {
    const { result } = await run(live({ runId: 'meta', promptMode: 'plain-first', temperature: 'omit', sort: 'latency' }), { fetchImpl: makeFetch(), apiKey: KEY });
    const record = JSON.parse(fs.readFileSync(path.join(result.files.runDir, 'raw', 'test__model-a', 'original', 'image1.json'), 'utf8'));
    expect(record).toMatchObject({ promptMode: 'plain-first', sort: 'latency', pinnedProvider: null, temperatureMode: 'omit' });
  });
  test('older saved calls without a prompt mode need --prompt; a conflicting --prompt is refused', async () => {
    writeRaw('old', rawRecord());
    const err = sink();
    expect(await cli.main(['--rescore', 'old'], { env: env(), stdout: sink(), stderr: err })).toBe(1);
    expect(err.text()).toMatch(/--prompt/);
    expect(await cli.main(['--rescore', 'old', '--prompt', 'plain'], { env: env(), stdout: sink(), stderr: sink() })).toBe(0);
    writeRaw('conflict', rawRecord({ promptMode: 'production' }));
    const err2 = sink();
    expect(await cli.main(['--rescore', 'conflict', '--prompt', 'plain'], { env: env(), stdout: sink(), stderr: err2 })).toBe(1);
    expect(err2.text()).toMatch(/does not match/);
  });
  test('a missing run is an error, and --rescore cannot be combined with --live', async () => {
    expect(await cli.main(['--rescore', 'nothing'], { env: env(), stdout: sink(), stderr: sink() })).toBe(1);
    expect(await cli.main(['--rescore', 'x', '--live'], { env: env(), stdout: sink(), stderr: sink() })).toBe(2);
  });
});
