'use strict';
// Phase 1 of the verbatim-reading work (harness only): ground-truth sidecars, answer-only scoring, question and
// crossed-out leak metrics, the verbatim-json and plain-first-excl prompt modes, provider/tier routing options,
// the cost-vs-price tier check, and the five regression fixtures. Synthetic text only; a global fetch trap fails
// any real network call, and no production file is changed by this work.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');

// Lazy requires: before the implementation exists each test fails on its own instead of the whole suite failing to load.
const lib = name => require(`../scripts/ocr-eval/lib/${name}.cjs`);
const verbatim = () => lib('verbatim');
const prompts = () => lib('prompts');
const metrics = () => lib('metrics');
const datasetLib = () => lib('dataset');
const openrouter = () => lib('openrouter');
const runner = () => lib('runner');
const csv = () => lib('csv');
const cli = () => require('../scripts/ocr-eval/run.cjs');
const contract = () => require('../src/services/gptVisionExact/contract.js');

jest.setTimeout(120000);

const KEY = 'sk-or-v1-TESTKEY0123456789abcdefTESTKEY';
const MODEL = 'test/model-a';
const GEMINI = 'google/gemini-3.8-flash';

// ---- the five known cases, as neutral invented pages (the failure patterns are the user's; the sentences are not student work) ----
const QUESTION = 'Do you think social media helps or harms friendships?';
const ANSWER = [
  'Social media is a big topic today.',
  'People often compare themselves with others online.',   // "For example," is crossed out in front of this line (case 1)
  'I think they share photos to feel included.',            // case 2: the model read "state"
  'Some friends end up feeling jealousy of the trips.',     // case 3: the model read "jealous"
  'I hope the will agree with this.',                       // case 5: student mistakes that must stay
  'This artical show that friends matter.',
  'This suggest that we should talk more.',
];
const FIXTURE = {
  truth: `${QUESTION}\n${ANSWER.join('\n')}`,
  answer: ANSWER.join('\n'),
  question: QUESTION,
  struck: 'For example,\n',
  mistakes: 'jealousy\tjealous\nthe will\tthey will\nartical show\tarticle shows\nThis suggest\tThis suggests\n',
  assignment: JSON.stringify({ title: 'Social media and friends', instructions: QUESTION }),
};

let dataDir, plainDir, outDir, realFetch;
const sink = () => { const chunks = []; return { write: s => { chunks.push(String(s)); return true; }, text: () => chunks.join('') }; };
const response = (status, body) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const CATALOG = (id = MODEL, params = ['temperature', 'reasoning', 'structured_outputs', 'response_format']) =>
  [{ id, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: params, pricing: { prompt: '0.00000075', completion: '0.00000375' } }];
function makeFetch({ model = MODEL, content, usage = { prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, cost: 0.0026 }, catalog = CATALOG(model) } = {}) {
  const calls = [];
  const fn = jest.fn(async (url, options = {}) => {
    calls.push({ url, method: options.method, body: options.body });
    if (String(url).endsWith('/models')) return response(200, { data: catalog });
    const body = JSON.parse(options.body);
    const text = typeof content === 'function' ? content(body) : content;
    return response(200, { model: body.model, provider: 'Google AI Studio', usage, choices: [{ finish_reason: 'stop', message: { content: text } }] });
  });
  fn.posts = () => calls.filter(c => c.method === 'POST').map(c => JSON.parse(c.body));
  return fn;
}
async function makeJpeg(file) {
  const width = 600, height = 800, pixels = Buffer.alloc(width * height * 3, 220);
  fs.writeFileSync(file, await sharp(pixels, { raw: { width, height, channels: 3 } }).jpeg().toBuffer());
}
async function buildDataset(dir, { sidecars = true } = {}) {
  await makeJpeg(path.join(dir, 'image1.jpeg'));
  fs.writeFileSync(path.join(dir, 'image1.txt'), FIXTURE.truth);
  fs.writeFileSync(path.join(dir, 'image1.mistakes.tsv'), FIXTURE.mistakes);
  if (sidecars) {
    fs.writeFileSync(path.join(dir, 'image1.answer.txt'), FIXTURE.answer);
    fs.writeFileSync(path.join(dir, 'image1.question.txt'), FIXTURE.question);
    fs.writeFileSync(path.join(dir, 'image1.struck.txt'), FIXTURE.struck);
    fs.writeFileSync(path.join(dir, 'image1.assignment.json'), FIXTURE.assignment);
  }
}
const load = (dir = dataDir) => datasetLib().loadDataset(dir);
function run(extra = {}, deps = {}, dir = dataDir) {
  const out = sink();
  const logger = openrouter().createLogger({ secrets: [KEY], stdout: out, stderr: out });
  return runner().runEvaluation({ dataset: load(dir), models: ['fake/perfect'], variants: ['original'], outDir, ...extra },
    { logger, fetchImpl: global.fetch, apiKey: null, ...deps }).then(result => ({ result, log: out.text() }));
}
const live = (extra = {}) => ({ live: true, models: [MODEL], confirm: 1, promptMode: 'verbatim-json', ...extra });
const csvRows = file => csv().parseCsv(fs.readFileSync(file, 'utf8'));
const goodReply = (over = {}) => JSON.stringify({ version: 'verbatim-page-v1', name_present: true, question_lines: [QUESTION], answer_lines: ANSWER,
  struck_through: [{ line: 1, text: 'For example,' }], uncertain: [{ line: 4, word: 'will' }], ...over });

beforeAll(async () => {
  realFetch = global.fetch;
  global.fetch = jest.fn(() => { throw new Error('REAL NETWORK CALL ATTEMPTED IN A TEST'); });
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-data-'));
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-plain-'));
  await buildDataset(dataDir);
  await buildDataset(plainDir, { sidecars: false });
});
afterAll(() => { global.fetch = realFetch; for (const d of [dataDir, plainDir]) fs.rmSync(d, { recursive: true, force: true }); });
beforeEach(() => { outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-out-')); });
afterEach(() => fs.rmSync(outDir, { recursive: true, force: true }));

// ---------------------------------------------------------------------------------------------------------------------
describe('dataset sidecars (answer, question, struck, assignment)', () => {
  test('the four optional files are read for their photo and are not mistaken for ground-truth files', () => {
    const loaded = load();
    expect(loaded.items).toHaveLength(1);
    const item = loaded.items[0];
    expect(item.name).toBe('image1');
    expect(item.groundTruth).toBe(FIXTURE.truth);
    expect(item.answerTruth).toBe(FIXTURE.answer);
    expect(item.questionPhrases).toEqual([QUESTION]);
    expect(item.struckPhrases).toEqual(['For example,']);
    expect(item.assignment).toEqual({ title: 'Social media and friends', instructions: QUESTION });
    expect(loaded.warnings.filter(w => /no matching image/.test(w))).toEqual([]);
  });
  test('without the files the fields are null (unknown), never empty or zero', () => {
    const item = load(plainDir).items[0];
    expect([item.answerTruth, item.questionPhrases, item.struckPhrases, item.assignment]).toEqual([null, null, null, null]);
  });
  test('an empty question or struck file means "checked, none"; comments and blank lines are ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-empty-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.jpeg'), fs.readFileSync(path.join(dataDir, 'image1.jpeg')));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'a.answer.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'a.question.txt'), '');
      fs.writeFileSync(path.join(dir, 'a.struck.txt'), '# nothing crossed out\n\n');
      const item = load(dir).items[0];
      expect(item.questionPhrases).toEqual([]);
      expect(item.struckPhrases).toEqual([]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test.each([
    ['an empty answer file', dir => fs.writeFileSync(path.join(dir, 'a.answer.txt'), '  \n'), /a\.answer\.txt.*empty/],
    ['a question file without an answer file', dir => { fs.rmSync(path.join(dir, 'a.answer.txt')); }, /a\.question\.txt.*needs.*a\.answer\.txt/],
    ['assignment json that is not valid JSON', dir => fs.writeFileSync(path.join(dir, 'a.assignment.json'), '{nope'), /a\.assignment\.json.*not valid JSON/],
    ['assignment json with an unknown key', dir => fs.writeFileSync(path.join(dir, 'a.assignment.json'), '{"colour":"red"}'), /a\.assignment\.json.*colour/],
    ['assignment json with a non-text value', dir => fs.writeFileSync(path.join(dir, 'a.assignment.json'), '{"title":5}'), /a\.assignment\.json.*title.*text/],
  ])('%s stops the run with the file name', (_name, mutate, pattern) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-bad-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.jpeg'), fs.readFileSync(path.join(dataDir, 'image1.jpeg')));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'a.answer.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'a.question.txt'), 'Q words here');
      mutate(dir);
      expect(() => datasetLib().loadDataset(dir)).toThrow(pattern);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('the problem message never repeats the file content', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-secret-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.jpeg'), fs.readFileSync(path.join(dataDir, 'image1.jpeg')));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'a.assignment.json'), '{"title": "PRIVATE-TEXT-123" oops');
      let message = '';
      try { datasetLib().loadDataset(dir); } catch (error) { message = error.message; }
      expect(message).toMatch(/a\.assignment\.json/);
      expect(message).not.toContain('PRIVATE-TEXT-123');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('sidecars without a photo are reported as ignored', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-orphan-'));
    try {
      fs.writeFileSync(path.join(dir, 'a.jpeg'), fs.readFileSync(path.join(dataDir, 'image1.jpeg')));
      fs.writeFileSync(path.join(dir, 'a.txt'), 'Some words here.');
      fs.writeFileSync(path.join(dir, 'ghost.struck.txt'), 'x y');
      expect(load(dir).warnings.join(' ')).toMatch(/ghost\.struck\.txt.*no matching image/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('phrase leakage metric', () => {
  const leak = (phrases, truth, hypothesis) => metrics().phraseLeakage(phrases, truth, hypothesis);
  test('parsePhrases keeps one phrase per line and skips blank lines and # comments', () => {
    expect(metrics().parsePhrases('# note\nFor example,\n\n  because of this  \n')).toEqual(['For example,', 'because of this']);
  });
  test('a phrase present in the output but not in the truth is a leak', () => {
    expect(leak(['For example,'], 'People often compare themselves.', 'For example, people often compare themselves.')).toMatchObject({ phrases: 1, leaked: 1 });
  });
  test('it is count based: the same words legitimately written elsewhere in the answer are not a leak', () => {
    const truth = 'For example, cats sleep. People compare themselves.';
    expect(leak(['For example,'], truth, 'For example, cats sleep. People compare themselves.').leaked).toBe(0);
    expect(leak(['For example,'], truth, 'For example, cats sleep. For example, people compare themselves.').leaked).toBe(1);
  });
  test('case, punctuation and one misread letter in a long word do not hide a leak', () => {
    expect(leak(['for example'], 'x y z', 'FOR EXAMPLE! x y z').leaked).toBe(1);
    expect(leak(['for example'], 'x y z', 'for exemple x y z').leaked).toBe(1);
    expect(leak(['cat'], 'x y z', 'cot x y z').leaked).toBe(0); // short words must match exactly
  });
  test('a longer phrase tolerates one wrong word in five; a different sentence is not a leak', () => {
    const phrase = ['Do you think social media helps or harms friendships?'];
    expect(leak(phrase, 'Other words entirely.', 'Do you think social media help or harms friendships? Other words entirely.').leaked).toBe(1);
    expect(leak(phrase, 'Other words entirely.', 'Do you like parks? Other words entirely.').leaked).toBe(0);
  });
  test('one entirely different word in nine is tolerated (a misread or re-worded word); two are not', () => {
    const phrase = ['Do you think social media helps or harms friendships?'];
    expect(leak(phrase, 'Other words entirely.', 'Do you think social media helps or harms enemies? Other words entirely.').leaked).toBe(1);
    expect(leak(phrase, 'Other words entirely.', 'Do you think parks helps or harms enemies? Other words entirely.').leaked).toBe(0);
    expect(leak(['cat sat'], 'x', 'cat dog x').leaked).toBe(0); // a two-word phrase allows no wrong word
  });
  test('real extra words: only an INSERTED word counts; the same word appearing because another word was read differently does not', () => {
    const real = (phrases, truth, hypothesis) => metrics().realExtraWords(phrases, truth, hypothesis);
    expect(real(['to'], 'she went home', 'she went to home')).toEqual({ phrases: 1, realLeaked: 1 });
    expect(real(['to'], 'she went too home', 'she went to home')).toEqual({ phrases: 1, realLeaked: 0 });
    expect(metrics().phraseLeakage(['to'], 'she went too home', 'she went to home').leaked).toBe(1);   // the old count calls this a leak
    expect(real(['to'], 'a b c', 'a b c')).toEqual({ phrases: 1, realLeaked: 0 });
    expect(real(['for example'], 'people like cats', 'for example people like cats')).toEqual({ phrases: 1, realLeaked: 1 });
    expect(real([], 'a', 'a')).toEqual({ phrases: 0, realLeaked: 0 });
    expect(Object.values(real(['to'], 'x', 'to x')).every(value => typeof value === 'number')).toBe(true);   // counts only, no text
  });
  test('every phrase line is judged on its own', () => {
    const phrases = ['first line of the question', 'another sentence that is entirely different'];
    expect(leak(phrases, 'unrelated', 'first line of the question unrelated')).toMatchObject({ phrases: 2, leaked: 1 });
  });
  test('no phrases means zero phrases and zero leaks, and the result carries no text', () => {
    expect(leak([], 'a', 'a')).toEqual({ phrases: 0, leaked: 0, extraOccurrences: 0 });
    expect(JSON.stringify(leak(['For example,'], 'x', 'For example, x'))).not.toMatch(/example/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('verbatim reply: strict parser and conversion', () => {
  const parse = content => verbatim().parseVerbatim(content);
  test('a valid reply gives separate question, answer and flags; the scored text is question then answer', () => {
    const result = parse(goodReply());
    expect(result.ok).toBe(true);
    const parts = verbatim().verbatimParts(result.value);
    expect(parts.answerText).toBe(ANSWER.join('\n'));
    expect(parts.questionText).toBe(QUESTION);
    expect(parts.text).toBe(`${QUESTION}\n${ANSWER.join('\n')}`);
    expect(parts).toMatchObject({ struckCount: 1, uncertainCount: 1, questionLineCount: 1, namePresent: true });
  });
  test('the evidence built from it passes the production validators; uncertain words and crossed-out text never block or enter it', () => {
    const wire = verbatim().verbatimToWire(parse(goodReply()).value);
    const value = contract().validateWire(wire);
    expect(value.activeTranscript).toBe(ANSWER.join('\n'));
    expect(() => contract().validateCanonical(JSON.stringify(value))).not.toThrow();
    const parsed = JSON.parse(wire);
    expect(parsed.physicalLines[0].segments[0].classification).toBe('PROMPT_OR_INSTRUCTION');
    expect(parsed.uncertainties).toEqual([]);
    expect(wire).not.toContain('For example,');
    expect(prompts().extractTranscript('verbatim-json', goodReply())).toMatchObject({ status: 'ok', validation: 'accepted', answerText: ANSWER.join('\n') });
  });
  test('a reply wrapped in a code fence is read', () => {
    expect(prompts().extractTranscript('verbatim-json', `\`\`\`json\n${goodReply()}\n\`\`\``)).toMatchObject({ status: 'ok', validation: 'accepted' });
  });
  test('the student name is never requested, stored or accepted: only whether one was present', () => {
    expect(Object.keys(verbatim().VERBATIM_SCHEMA.properties)).toEqual(['version', 'name_present', 'question_lines', 'answer_lines', 'struck_through', 'uncertain']);
    expect(parse(goodReply({ name: 'A Student' })).ok).toBe(false);
    expect(parse(goodReply({ name_present: 'yes' })).ok).toBe(false);
  });
  test.each([
    ['not JSON', 'not json at all'],
    ['wrong version', goodReply({ version: 'verbatim-page-v0' })],
    ['an extra key', goodReply({ grade: 5 })],
    ['a missing key', JSON.stringify({ version: 'verbatim-page-v1', name_present: false, question_lines: [], answer_lines: ['x'], struck_through: [] })],
    ['answer_lines not an array', goodReply({ answer_lines: 'one string' })],
    ['a non-string line', goodReply({ answer_lines: ['ok', 5] })],
    ['a line break inside a line', goodReply({ answer_lines: ['first\nsecond'] , uncertain: [], struck_through: [] })],
    ['a line over 2000 characters', goodReply({ answer_lines: ['x'.repeat(2001)], uncertain: [], struck_through: [] })],
    ['more than 300 answer lines', goodReply({ answer_lines: Array.from({ length: 301 }, (_, i) => `l${i}`), uncertain: [], struck_through: [] })],
    ['a struck line out of range', goodReply({ struck_through: [{ line: 99, text: 'x' }] })],
    ['an extra key inside a struck item', goodReply({ struck_through: [{ line: 0, text: 'x', why: 'y' }] })],
  ])('%s is a schema failure, never a partial transcript', (_name, content) => {
    expect(prompts().extractTranscript('verbatim-json', content)).toMatchObject({ status: 'invalid_json', text: '', validation: 'OCR_GPT_SOURCE_SCHEMA' });
  });
  test('an uncertain item that does not match its line is dropped and counted, like in production; the page stays valid', () => {
    const out = prompts().extractTranscript('verbatim-json', goodReply({ uncertain: [{ line: 4, word: 'will' }, { line: 0, word: 'zebra' }, { line: 99, word: 'will' }, 'junk', { line: 1 }] }));
    expect(out).toMatchObject({ status: 'ok', validation: 'accepted', answerText: ANSWER.join('\n'), flags: { uncertainCount: 1, uncertainDropped: 4 } });
    expect(JSON.stringify(out.flags)).not.toContain('zebra');
    expect(prompts().extractTranscript('verbatim-json', goodReply({ uncertain: 'x' }))).toMatchObject({ status: 'invalid_json', validation: 'OCR_GPT_SOURCE_SCHEMA' });
  });
  test('a struck item may point at the question region (-1)', () => {
    expect(parse(goodReply({ struck_through: [{ line: -1, text: 'x' }] })).ok).toBe(true);
  });
  test('an answer with no text is reported as empty, not as a schema failure', () => {
    expect(prompts().extractTranscript('verbatim-json', goodReply({ answer_lines: ['  ', ''], uncertain: [], struck_through: [] })))
      .toMatchObject({ status: 'empty', validation: 'OCR_GPT_SOURCE_EMPTY' });
  });
  test('the schema is closed and uses only widely supported keywords (no bounds that some providers reject)', () => {
    const text = JSON.stringify(verbatim().VERBATIM_SCHEMA);
    expect(text).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|pattern|format|oneOf|anyOf)"/);
    expect(text).not.toMatch(/"type":\[/);
    const closed = node => { if (node && typeof node === 'object') { if (node.type === 'object') { expect(node.additionalProperties).toBe(false); expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort()); } Object.values(node).forEach(closed); } };
    closed(verbatim().VERBATIM_SCHEMA);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('prompt modes verbatim-json and plain-first-excl', () => {
  test('both are available, after the earlier modes (verbatim-json-v2 is the later experiment)', () => {
    expect(prompts().PROMPT_MODES).toEqual(['plain', 'production', 'plain-first', 'production-trim', 'lean-json', 'verbatim-json', 'plain-first-excl', 'verbatim-json-v2']);
  });
  test('verbatim-json: strict schema, one call per page, and the rules the audit asked for', () => {
    const spec = prompts().promptSpec('verbatim-json');
    expect(spec).toMatchObject({ mode: 'verbatim-json', callsPerPage: 1, output: 'json', schemaName: 'ocr_eval_verbatim_page_v1' });
    expect(spec.responseSchema).toBe(verbatim().VERBATIM_SCHEMA);
    for (const needle of ['never grade, edit, proofread or improve', 'Never correct', 'Crossed-out text is deleted', 'struck_through', 'question_lines',
      'answer_lines', 'name_present', 'uncertain', 'letters, not from what would make the sentence sound right']) expect(spec.system).toContain(needle);
  });
  test('the prompt text does not contain the five known failure phrases (the fixtures must stay an honest test)', () => {
    for (const phrase of ['they share', 'they state', 'jealousy', 'jealous', 'For example', 'artical', 'This suggest', 'the will']) {
      expect(prompts().promptSpec('verbatim-json').system).not.toContain(phrase);
    }
  });
  test('verbatim-json sends the stored assignment text as untrusted context, built exactly like production', () => {
    const { reference } = require('../src/services/gptVisionExact.service');
    const item = load().items[0];
    const spec = prompts().promptSpec('verbatim-json');
    const sent = JSON.parse(spec.userTextFor(item));
    expect(sent.assignmentReference).toEqual(reference(item.assignment));
    expect(sent.task).toMatch(/untrusted context only/);
    expect(JSON.parse(spec.userTextFor(load(plainDir).items[0])).assignmentReference).toEqual({});
  });
  test('plain-first-excl: the measured plain-first request, with the copied question excluded by the production code-side rule', () => {
    const spec = prompts().promptSpec('plain-first-excl'), first = prompts().promptSpec('plain-first');
    expect([spec.system, spec.userText, spec.responseSchema]).toEqual([first.system, first.userText, first.responseSchema]);
    const item = load().items[0];
    const reply = `${QUESTION}\n${ANSWER.join('\n')}`;
    const out = prompts().extractTranscript('plain-first-excl', reply, { assignment: item.assignment });
    expect(out).toMatchObject({ status: 'ok', validation: 'accepted', answerText: ANSWER.join('\n'), questionText: QUESTION, text: reply });
    // Without the stored assignment text nothing can be excluded: the question reaches the answer.
    expect(prompts().extractTranscript('plain-first-excl', reply, { assignment: null }).answerText).toBe(reply);
  });
  test('earlier modes keep their meaning: the scored text is the answer text and no question is reported', () => {
    expect(prompts().extractTranscript('plain-first', 'one\ntwo')).toMatchObject({ text: 'one\ntwo', answerText: 'one\ntwo', questionText: '' });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('verbatim-json-v2 (experiment B): crossed-out text is listed BEFORE the answer, with a stronger rule', () => {
  const v2Reply = (over = {}) => JSON.stringify({ version: 'verbatim-page-v2', name_present: true, question_lines: [QUESTION],
    struck_through: [{ text: 'For example,', after_word: 'friends' }], answer_lines: ANSWER, uncertain: [{ line: 4, word: 'will' }], ...over });
  test('the schema puts struck_through before answer_lines, is closed, and keeps the safe keyword subset', () => {
    const schema = verbatim().VERBATIM_V2_SCHEMA;
    expect(Object.keys(schema.properties)).toEqual(['version', 'name_present', 'question_lines', 'struck_through', 'answer_lines', 'uncertain']);
    expect(Object.keys(schema.properties.struck_through.items.properties)).toEqual(['text', 'after_word']);   // no line number: the answer does not exist yet
    expect(schema.properties.version.enum).toEqual(['verbatim-page-v2']);
    expect(JSON.stringify(schema)).not.toMatch(/"(minimum|maximum|minLength|maxLength|minItems|maxItems|pattern|format|oneOf|anyOf)"/);
    const closed = node => { if (node && typeof node === 'object') { if (node.type === 'object') { expect(node.additionalProperties).toBe(false); expect([...node.required].sort()).toEqual(Object.keys(node.properties).sort()); } Object.values(node).forEach(closed); } };
    closed(schema);
  });
  test('the mode is v1 with a stronger crossed-out rule and the new order; everything else is the same request', () => {
    const v1 = prompts().promptSpec('verbatim-json'), v2 = prompts().promptSpec('verbatim-json-v2');
    expect(v2).toMatchObject({ mode: 'verbatim-json-v2', callsPerPage: 1, output: 'json', schemaName: 'ocr_eval_verbatim_page_v2' });
    expect(v2.responseSchema).toBe(verbatim().VERBATIM_V2_SCHEMA);
    expect(v2.system).not.toBe(v1.system);
    expect(v2.system.indexOf('struck_through')).toBeLessThan(v2.system.indexOf('answer_lines'));
    for (const needle of ['BEFORE you write answer_lines', 'must not be copied into answer_lines', 'rewritten', 'after_word']) expect(v2.system).toContain(needle);
    for (const unchanged of ['never grade, edit, proofread or improve', 'Never correct', 'name_present', 'question_lines', 'letters, not from what would make the sentence sound right']) expect(v2.system).toContain(unchanged);
    const item = load().items[0];
    expect(v2.userTextFor(item)).toBe(v1.userTextFor(item));
    expect(v2.sha256).not.toBe(v1.sha256);
  });
  test('the prompt text still holds none of the five known failure phrases', () => {
    for (const phrase of ['they share', 'they state', 'jealousy', 'jealous', 'For example', 'artical', 'This suggest', 'the will']) expect(prompts().promptSpec('verbatim-json-v2').system).not.toContain(phrase);
  });
  test('a valid reply is read exactly like v1: question, answer, flags; crossed-out text never enters the answer', () => {
    const out = prompts().extractTranscript('verbatim-json-v2', v2Reply());
    expect(out).toMatchObject({ status: 'ok', validation: 'accepted', answerText: ANSWER.join('\n'), questionText: QUESTION, text: `${QUESTION}\n${ANSWER.join('\n')}`,
      flags: { struckCount: 1, uncertainCount: 1, uncertainDropped: 0, struckDropped: 0, questionLineCount: 1, namePresent: true } });
  });
  test('crossed-out items are advisory: a malformed one is dropped and counted; uncertain items follow the G5 rule', () => {
    const out = prompts().extractTranscript('verbatim-json-v2', v2Reply({ struck_through: [{ text: 'ok', after_word: '' }, { text: 5, after_word: 'x' }, 'junk', { text: 'a\nb', after_word: '' }, { text: 'x' }],
      uncertain: [{ line: 4, word: 'will' }, { line: 0, word: 'zebra' }] }));
    expect(out).toMatchObject({ status: 'ok', validation: 'accepted', flags: { struckCount: 1, struckDropped: 4, uncertainCount: 1, uncertainDropped: 1 } });
  });
  test.each([
    ['not JSON', 'nope'], ['the v1 version tag', v2Reply({ version: 'verbatim-page-v1' })], ['an extra key', v2Reply({ grade: 1 })], ['a student name field', v2Reply({ name: 'A Student' })],
    ['struck_through not a list', v2Reply({ struck_through: 'x' })], ['uncertain not a list', v2Reply({ uncertain: null })], ['answer_lines not a list', v2Reply({ answer_lines: 'x' })],
    ['a line break inside an answer line', v2Reply({ answer_lines: ['a\nb'], uncertain: [], struck_through: [] })],
  ])('%s is a schema failure with no partial transcript', (_n, content) => {
    expect(prompts().extractTranscript('verbatim-json-v2', content)).toMatchObject({ status: 'invalid_json', text: '', validation: 'OCR_GPT_SOURCE_SCHEMA' });
  });
  test('an empty answer is reported as empty', () => {
    expect(prompts().extractTranscript('verbatim-json-v2', v2Reply({ answer_lines: [' '], uncertain: [], struck_through: [] }))).toMatchObject({ status: 'empty', validation: 'OCR_GPT_SOURCE_EMPTY' });
  });
  test('the request sends the v2 schema and the reasoning setting asked for (experiment C uses medium); a dry run works with the fake models', async () => {
    const fetchImpl = makeFetch({ model: GEMINI, content: v2Reply() });
    const { result } = await run(live({ models: [GEMINI], promptMode: 'verbatim-json-v2', reasoningFor: { [GEMINI]: 'medium' } }), { fetchImpl, apiKey: KEY });
    const [body] = fetchImpl.posts();
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'ocr_eval_verbatim_page_v2', strict: true, schema: verbatim().VERBATIM_V2_SCHEMA } });
    expect(body.reasoning).toEqual({ effort: 'medium' });
    expect(result.rows[0]).toMatchObject({ status: 'ok', validation: 'accepted', struckReported: 1 });
    const dry = (await run({ promptMode: 'verbatim-json-v2', models: ['fake/perfect', 'fake/leaky'] })).result.rows;
    expect(dry[0]).toMatchObject({ status: 'ok', questionLeaked: 0, struckLeaked: 0, struckRealLeaked: 0, answerCerCs: 0 });
    expect(dry[1]).toMatchObject({ status: 'ok', questionLeaked: 1, struckRealLeaked: 1 });
  });
  test('the CLI accepts the new mode', () => {
    expect(cli().parseArgs(['--prompt', 'verbatim-json-v2']).promptMode).toBe('verbatim-json-v2');
  });
});

describe('--only: run the named photos only (cheap probes on the hard page)', () => {
  test('the plan, the calls and the reports cover only the named photos', async () => {
    const fetchImpl = makeFetch({ content: goodReply() });
    const { result, log } = await run(live({ only: ['image1'] }), { fetchImpl, apiKey: KEY });
    expect(log).toMatch(/Plan: 1 photos x 1 variants x 1 models = 1 calls/);
    expect(fetchImpl.posts()).toHaveLength(1);
    expect(result.rows.map(r => r.name)).toEqual(['image1']);
  });
  test('with several photos in the folder, only the named ones are read and paid for; --limit applies after --only', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-verb-three-'));
    try {
      for (const name of ['image1', 'image2', 'image3']) { await makeJpeg(path.join(dir, `${name}.jpeg`)); fs.writeFileSync(path.join(dir, `${name}.txt`), FIXTURE.truth); }
      const one = makeFetch({ content: goodReply() });
      const named = await run(live({ only: ['image2'], confirm: 1 }), { fetchImpl: one, apiKey: KEY }, dir);
      expect(named.log).toMatch(/Plan: 1 photos x 1 variants x 1 models = 1 calls/);
      expect(one.posts()).toHaveLength(1);
      expect(named.result.rows.map(r => r.name)).toEqual(['image2']);
      const everything = await run(live({ confirm: 3 }), { fetchImpl: makeFetch({ content: goodReply() }), apiKey: KEY }, dir);
      expect(everything.result.rows.map(r => r.name)).toEqual(['image1', 'image2', 'image3']);
      const limited = await run(live({ only: ['image2', 'image3'], limit: 1, confirm: 1 }), { fetchImpl: makeFetch({ content: goodReply() }), apiKey: KEY }, dir);
      expect(limited.result.rows.map(r => r.name)).toEqual(['image2']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  test('a photo that is not in the folder is an error before any call', async () => {
    const fetchImpl = makeFetch({ content: goodReply() });
    await expect(run(live({ only: ['image1', 'image99'] }), { fetchImpl, apiKey: KEY })).rejects.toMatchObject({ code: 'BAD_ONLY' });
    expect(fetchImpl.posts()).toHaveLength(0);
  });
  test('the command line parses a list, and --confirm must match the smaller plan', () => {
    expect(cli().parseArgs(['--only', 'image11, image2']).only).toEqual(['image11', 'image2']);
    expect(cli().parseArgs([]).only).toEqual([]);
    expect(() => cli().parseArgs(['--only', 'bad name!'])).toThrow(/--only/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('runner: answer-only scores, leaks, CSV and summary', () => {
  test('a faithful reader that separates the page scores zero everywhere and leaks nothing', async () => {
    const { result } = await run({ promptMode: 'verbatim-json' });
    const row = result.rows[0];
    expect(row).toMatchObject({ status: 'ok', validation: 'accepted', answerCerCs: 0, answerWerCs: 0, questionPhrases: 1, questionLeaked: 0, struckPhrases: 1, struckLeaked: 0, struckRealLeaked: 0, cerCs: 0 });
    const csvRow = csvRows(result.files.csv)[0];
    expect(csvRow).toMatchObject({ answer_cer_case: '0', answer_wer_case: '0', question_phrases: '1', question_leaked: '0', struck_phrases: '1', struck_leaked: '0', struck_real_leaked: '0', calls_per_page: '1' });
  });
  test('a reader that leaks the question and the crossed-out phrase is caught on both metrics', async () => {
    const { result } = await run({ promptMode: 'verbatim-json', models: ['fake/leaky'] });
    expect(result.rows[0]).toMatchObject({ status: 'ok', questionLeaked: 1, struckLeaked: 1, struckRealLeaked: 1 });
    expect(result.rows[0].answerCerCs).toBeGreaterThan(0);
  });
  test('a plain reader without separation leaks the question into the answer; with the code-side rule it does not', async () => {
    const plain = (await run({ promptMode: 'plain-first' })).result.rows[0];
    expect(plain.questionLeaked).toBe(1); // everything is "answer": this is why plain-first alone cannot be the production design
    const excl = (await run({ promptMode: 'plain-first-excl' })).result.rows[0];
    expect(excl).toMatchObject({ status: 'ok', validation: 'accepted', questionLeaked: 0, struckLeaked: 0, answerCerCs: 0, cerCs: 0 });
  });
  test('without sidecars the new columns are empty, never zero, and the old scores are unchanged', async () => {
    const { result } = await run({ promptMode: 'verbatim-json' }, {}, plainDir);
    expect(result.rows[0]).toMatchObject({ status: 'ok', answerCerCs: null, questionPhrases: null, questionLeaked: null, struckPhrases: null, struckLeaked: null });
    const csvRow = csvRows(result.files.csv)[0];
    for (const column of ['answer_cer_case', 'answer_wer_case', 'question_phrases', 'question_leaked', 'struck_phrases', 'struck_leaked']) expect(csvRow[column]).toBe('');
    expect(csvRow.cer_case).not.toBe('');
  });
  test('the reply flags are recorded as counts only', async () => {
    const fetchImpl = makeFetch({ content: goodReply() });
    const { result } = await run(live(), { fetchImpl, apiKey: KEY });
    const csvRow = csvRows(result.files.csv)[0];
    expect(csvRow).toMatchObject({ uncertain_flagged: '1', uncertain_dropped: '0', struck_reported: '1', question_lines_reported: '1', name_present: 'true', validation: 'accepted' });
    expect(fs.readFileSync(result.files.csv, 'utf8')).not.toContain('For example');
    expect(fs.readFileSync(path.join(result.files.runDir, 'summary.md'), 'utf8')).not.toContain('For example');
  });
  test('the summary has an answer-only and leakage section when sidecars are present', async () => {
    const { result } = await run({ promptMode: 'verbatim-json', models: ['fake/perfect', 'fake/leaky'] });
    const summary = fs.readFileSync(path.join(result.files.runDir, 'summary.md'), 'utf8');
    expect(summary).toMatch(/## Answer-only accuracy and leakage/);
    expect(summary).toMatch(/fake\/leaky/);
  });
  test('rescoring a saved run adds the new columns offline', async () => {
    const fetchImpl = makeFetch({ content: goodReply() });
    const first = await run(live({ runId: 'rs-1' }), { fetchImpl, apiKey: KEY });
    const out = sink();
    const logger = openrouter().createLogger({ secrets: [KEY], stdout: out, stderr: out });
    const again = await runner().rescoreRun({ dataset: load(), outDir, runId: 'rs-1', logger });
    expect(fetchImpl.posts()).toHaveLength(1); // no new call
    expect(csvRows(again.files.csv)[0]).toMatchObject({ question_phrases: '1', struck_phrases: '1', uncertain_flagged: '1' });
    expect(first.result.rows[0].status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('live request for the new modes', () => {
  test('verbatim-json sends the strict schema, the assignment reference and the per-model reasoning, with temperature as asked', async () => {
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply() });
    await run(live({ models: [GEMINI], reasoningFor: { [GEMINI]: 'low' } }), { fetchImpl, apiKey: KEY });
    const [body] = fetchImpl.posts();
    expect(body.response_format).toEqual({ type: 'json_schema', json_schema: { name: 'ocr_eval_verbatim_page_v1', strict: true, schema: verbatim().VERBATIM_SCHEMA } });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.temperature).toBe(0);
    expect(body.max_tokens).toBe(16000);
    expect(JSON.parse(body.messages[1].content[0].text).assignmentReference).toEqual({ title: 'Social media and friends', instructions: QUESTION });
    expect(body.messages[0].content).not.toContain(QUESTION);
    const omitted = makeFetch({ model: GEMINI, content: goodReply() });
    await run(live({ models: [GEMINI], reasoningFor: { [GEMINI]: 'low' }, temperature: 'omit' }), { fetchImpl: omitted, apiKey: KEY });
    expect(omitted.posts()[0]).not.toHaveProperty('temperature');
  });
  test('plain-first-excl sends the plain-first request: no schema, no assignment text', async () => {
    const fetchImpl = makeFetch({ content: `${QUESTION}\n${ANSWER.join('\n')}` });
    const { result } = await run(live({ promptMode: 'plain-first-excl' }), { fetchImpl, apiKey: KEY });
    const [body] = fetchImpl.posts();
    expect(body).not.toHaveProperty('response_format');
    expect(JSON.stringify(body.messages)).not.toContain(QUESTION);
    expect(result.rows[0]).toMatchObject({ questionLeaked: 0, validation: 'accepted' });
  });
  test('a model whose catalog entry has no structured output is refused for verbatim-json before any paid call', async () => {
    const fetchImpl = makeFetch({ content: goodReply(), catalog: CATALOG(MODEL, ['temperature', 'reasoning']) });
    await expect(run(live(), { fetchImpl, apiKey: KEY })).rejects.toMatchObject({ code: 'NO_STRUCTURED_OUTPUT' });
    expect(fetchImpl.posts()).toHaveLength(0);
  });
  test('a schema failure is a failed row with a static reason, and the run goes on', async () => {
    const fetchImpl = makeFetch({ content: goodReply({ struck_through: [{ line: 99, text: 'zebra' }] }) });
    const { result } = await run(live(), { fetchImpl, apiKey: KEY });
    expect(result.rows[0]).toMatchObject({ status: 'error', errorCode: 'INVALID_JSON' });
    expect(result.rows[0].errorDetail).toMatch(/struck_through/);
    expect(result.rows[0].errorDetail).not.toContain('zebra');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('provider and tier options', () => {
  const image = { mimeType: 'image/jpeg', bytes: Buffer.from([1, 2, 3]) };
  const build = options => openrouter().buildRequest({ model: GEMINI, prompt: prompts().promptSpec('plain'), image, options }).body.provider;
  test('--provider may list several providers; --ignore-providers excludes endpoints; routing flags stay as before', () => {
    expect(build({ provider: 'google-ai-studio' })).toEqual({ require_parameters: true, allow_fallbacks: false, only: ['google-ai-studio'] });
    expect(build({ provider: 'a, b' }).only).toEqual(['a', 'b']);
    expect(build({ provider: 'google-ai-studio', ignoreProviders: ['google-ai-studio/flex', 'google-ai-studio/priority'] }))
      .toEqual({ require_parameters: true, allow_fallbacks: false, only: ['google-ai-studio'], ignore: ['google-ai-studio/flex', 'google-ai-studio/priority'] });
    expect(build({ sort: 'latency' })).toEqual({ require_parameters: true, allow_fallbacks: false, sort: 'latency' });
    expect(build({})).toEqual({ require_parameters: true, allow_fallbacks: false });
  });
  test('the command line accepts the new flag, rejects odd values, and the plan keeps routing out of --sort', () => {
    expect(cli().parseArgs(['--ignore-providers', 'google-ai-studio/flex,google-ai-studio/priority']).ignoreProviders).toEqual(['google-ai-studio/flex', 'google-ai-studio/priority']);
    expect(cli().parseArgs([]).ignoreProviders).toEqual([]);
    expect(() => cli().parseArgs(['--ignore-providers', 'bad name!'])).toThrow(/--ignore-providers/);
    expect(() => cli().parseArgs(['--prompt', 'verbatim-json', '--provider', 'x', '--sort', 'latency'])).toThrow(/cannot be combined/);
    expect(cli().parseArgs(['--prompt', 'plain-first-excl']).promptMode).toBe('plain-first-excl');
  });
  test('the request sent to the API carries only/ignore, and they are recorded in the run files', async () => {
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply() });
    const { result } = await run(live({ models: [GEMINI], provider: 'google-ai-studio', ignoreProviders: ['google-ai-studio/flex'] }), { fetchImpl, apiKey: KEY });
    expect(fetchImpl.posts()[0].provider).toMatchObject({ only: ['google-ai-studio'], ignore: ['google-ai-studio/flex'] });
    const runJson = JSON.parse(fs.readFileSync(path.join(result.files.runDir, 'run.json'), 'utf8'));
    expect(runJson.ignoreProviders).toEqual(['google-ai-studio/flex']);
    expect(fs.readFileSync(path.join(result.files.runDir, 'summary.md'), 'utf8')).toMatch(/ignored providers: google-ai-studio\/flex/);
  });
  test('changing the routing changes the saved-call fingerprint, so --resume never mixes routings', async () => {
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply() });
    await run(live({ models: [GEMINI], runId: 'fp', provider: 'google-ai-studio' }), { fetchImpl, apiKey: KEY });
    const again = await run(live({ models: [GEMINI], runId: 'fp', resume: true, provider: 'google-ai-studio', ignoreProviders: ['google-ai-studio/flex'] }), { fetchImpl, apiKey: KEY });
    expect(again.result.reusedCalls).toBe(0);
  });
});

describe('tier check: reported cost against the price you expect', () => {
  const GOOD = { prompt_tokens: 2000, completion_tokens: 300 };
  test('a call whose reported cost matches tokens x price is fine', async () => {
    const cost = (2000 * 0.75 + 300 * 3.75) / 1e6;
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply(), usage: { ...GOOD, total_tokens: 2300, cost } });
    const { result } = await run(live({ models: [GEMINI], prices: { [GEMINI]: { inputPerMillion: 0.75, outputPerMillion: 3.75 } } }), { fetchImpl, apiKey: KEY });
    expect(Number(csvRows(result.files.csv)[0].cost_price_ratio)).toBeCloseTo(1, 2);
    expect(fs.readFileSync(path.join(result.files.runDir, 'summary.md'), 'utf8')).not.toMatch(/different pricing tier/);
  });
  test('a cost that is off by more than 15% warns that a different tier may have served the call', async () => {
    const cost = (2000 * 1.35 + 300 * 6.75) / 1e6; // the priority tier
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply(), usage: { ...GOOD, total_tokens: 2300, cost } });
    const { result } = await run(live({ models: [GEMINI], prices: { [GEMINI]: { inputPerMillion: 0.75, outputPerMillion: 3.75 } } }), { fetchImpl, apiKey: KEY });
    expect(Number(csvRows(result.files.csv)[0].cost_price_ratio)).toBeGreaterThan(1.7);
    expect(fs.readFileSync(path.join(result.files.runDir, 'summary.md'), 'utf8')).toMatch(/different pricing tier/);
  });
  test('without --price the ratio is empty and nothing is checked', async () => {
    const fetchImpl = makeFetch({ model: GEMINI, content: goodReply() });
    const { result } = await run(live({ models: [GEMINI] }), { fetchImpl, apiKey: KEY });
    expect(csvRows(result.files.csv)[0].cost_price_ratio).toBe('');
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('regression fixtures: the five known failures', () => {
  const textOf = lines => lines.join('\n');
  const withLine = (index, text) => ANSWER.map((line, i) => (i === index ? text : line));

  test('1. a crossed-out phrase kept as active text is detected; kept in struck_through it is not', () => {
    const kept = textOf(withLine(1, `For example, ${ANSWER[1].charAt(0).toLowerCase()}${ANSWER[1].slice(1)}`));
    expect(metrics().phraseLeakage(['For example,'], FIXTURE.answer, kept)).toMatchObject({ phrases: 1, leaked: 1 });
    const separated = prompts().extractTranscript('verbatim-json', goodReply());
    expect(metrics().phraseLeakage(['For example,'], FIXTURE.answer, separated.answerText).leaked).toBe(0);
  });
  test('2. a wrong word read ("they share" as "they state") is one localized substitution', () => {
    const wrong = textOf(withLine(2, 'I think they state photos to feel included.'));
    const score = metrics().scoreTexts(FIXTURE.answer, wrong);
    expect(score).toMatchObject({ substitutions: 1, deletions: 0, insertions: 0 });
    expect(score.wer).toBeGreaterThan(0);
    const align = metrics().alignTokens(metrics().tokenize(FIXTURE.answer), metrics().tokenize(wrong));
    const sub = align.ops.find(op => op.type === 'sub');
    expect([metrics().tokenize(FIXTURE.answer)[sub.ref], metrics().tokenize(wrong)[sub.hyp]]).toEqual(['share', 'state']);
  });
  test('3. a changed word form ("feeling jealousy" as "feeling jealous") is reported as an over-correction', () => {
    const mistakes = datasetLib().loadDataset(dataDir).items[0].mistakes;
    const changed = textOf(withLine(3, 'Some friends end up feeling jealous of the trips.'));
    const bad = metrics().overCorrection(FIXTURE.truth, `${QUESTION}\n${changed}`, mistakes);
    expect(bad.occurrences.find(o => o.student === 'jealousy')).toMatchObject({ outcome: 'overcorrected', modelText: 'jealous' });
    const good = metrics().overCorrection(FIXTURE.truth, FIXTURE.truth, mistakes);
    expect(good.occurrences.find(o => o.student === 'jealousy')).toMatchObject({ outcome: 'preserved' });
  });
  test('4. the question written at the top never reaches the answer when the reader separates it, or when the code-side rule applies', () => {
    expect(metrics().phraseLeakage([QUESTION], FIXTURE.answer, FIXTURE.truth).leaked).toBe(1); // the failure
    const verbatimOut = prompts().extractTranscript('verbatim-json', goodReply());
    expect(metrics().phraseLeakage([QUESTION], FIXTURE.answer, verbatimOut.answerText).leaked).toBe(0);
    const plainOut = prompts().extractTranscript('plain-first-excl', FIXTURE.truth, { assignment: JSON.parse(FIXTURE.assignment) });
    expect(metrics().phraseLeakage([QUESTION], FIXTURE.answer, plainOut.answerText).leaked).toBe(0);
    // marking only ever sees the active transcript of the evidence
    expect(contract().validateWire(verbatim().verbatimToWire(verbatim().parseVerbatim(goodReply()).value)).activeTranscript).not.toContain('social media helps');
  });
  test('5. student grammar mistakes are preserved by a faithful reader and flagged when a reader corrects them', async () => {
    const faithful = (await run({ promptMode: 'verbatim-json', models: ['fake/perfect'] })).result.rows[0];
    expect(faithful.overcorrection).toMatchObject({ available: true, listed: 4, preserved: 4, overcorrected: 0, overcorrectionRate: 0 });
    const corrected = (await run({ promptMode: 'verbatim-json', models: ['fake/autocorrect'] })).result.rows[0];
    expect(corrected.overcorrection.overcorrected).toBeGreaterThanOrEqual(3);
    expect(corrected.overcorrection.overcorrectionRate).toBeGreaterThan(0.5);
    for (const phrase of ['the will', 'artical show', 'This suggest']) expect(FIXTURE.mistakes).toContain(phrase);
  });
});
