'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const sol = require('../scripts/local-shadow/sol-verbatim.cjs');
const dirs = [];
const temp = () => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'sol-verbatim-')); dirs.push(p); return p; };
const active = text => ({ type: 'ACTIVE_STUDENT_TEXT', text, confidence: 0.9, notes: 'Visible line.' });
const output = lines => ({ activeTranscript: lines.join('\n'), segments: lines.map(active), uncertainSpans: [] });
afterAll(() => { for (const dir of dirs) { for (const file of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, file)); fs.rmdirSync(dir); } });
test.each(['people','People','relize','relizing','got rid off','MiXeD case. no correction','word word','incomplete sentence'])('verbatim value %s is untouched', text => {
  const input = output([text]); const result = sol.validate(JSON.stringify(input)); expect(result.activeTranscript).toBe(text); expect(result).toEqual(input);
});
test('case-sensitive lines and punctuation are preserved byte-for-byte without rewriting', () => {
  const v = output(['people','People','a  gap,?!','relizing got rid off']);
  expect(Buffer.from(sol.validate(JSON.stringify(v)).activeTranscript)).toEqual(Buffer.from(v.activeTranscript));
});
test('deleted and artifact segments stay separate and cannot be concatenated into active output', () => {
  const v = output(['visible line']); v.segments.push({ type: 'CROSSED_OUT_OR_DELETED', text: 'deleted reading', confidence: 0.8, notes: 'Strike.' }, { type: 'NON_STUDENT_ARTIFACT', text: 'camera', confidence: 0.9, notes: 'Brand.' });
  expect(sol.validate(JSON.stringify(v)).activeTranscript).toBe('visible line');
  for (const addition of ['deleted reading','camera']) expect(() => sol.validate(JSON.stringify({ ...v, activeTranscript: v.activeTranscript + '\n' + addition }))).toThrow('SOL_ACTIVE_SEGMENT_MISMATCH');
});
test('unreadable deleted and uncertain text can be null without invented readings', () => {
  const v = output(['readable']); v.segments.push({ type: 'UNCERTAIN', text: null, confidence: 0.1, notes: 'Overwritten.' }, { type: 'CROSSED_OUT_OR_DELETED', text: null, confidence: 0.1, notes: 'Unreadable deletion.' });
  v.uncertainSpans.push({ visibleContext: 'readable', candidateReading: null, reason: 'Ambiguous pixels.' });
  expect(sol.validate(JSON.stringify(v))).toEqual(v);
});
test('schema refuses correction/suggestion fields and invalid confidence', () => {
  expect(() => sol.validate(JSON.stringify({ ...output(['a']), correctedText: 'A' }))).toThrow('SCHEMA');
  const v = output(['a']); v.segments[0].confidence = 2; expect(() => sol.validate(JSON.stringify(v))).toThrow('SEGMENT');
});
test('prompt contains no historical target readings and does not request proofreading', () => {
  for (const s of ['relize','relizing','got rid off','Louise Mallard','preception','Golden001']) expect(sol.PROMPT).not.toContain(s);
  expect(sol.PROMPT).toContain('NOT proofreading');
});
test('durable exclusive reservation blocks another invocation after restart', () => {
  const dir = temp(), source = { sha256: 'a'.repeat(64) }; sol.reserve(dir, 'attempt', source);
  jest.resetModules(); const reloaded = require('../scripts/local-shadow/sol-verbatim.cjs');
  expect(() => reloaded.reserve(dir, 'attempt', source)).toThrow('SOL_ONE_SHOT_ALREADY_CONSUMED');
});
test('standalone request uses unchanged full image, one gateway attempt, no retries or application pipelines', async () => {
  const dir = temp(), v = output(['people','People','relize','relizing','got rid off']);
  const bytes = Buffer.from('original-test-source-bytes');
  const source = { file: '/local/unit-image.jpeg', bytes, mime: 'image/jpeg', sha256: 'a'.repeat(64) };
  const fetchImpl = jest.fn(async (url, opts) => {
    sol.reserve(dir, 'http', source);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions'); expect(opts.redirect).toBe('error');
    return { ok: true, status: 200, headers: {}, text: async () => JSON.stringify({ model: sol.MODEL, choices: [{ message: { content: JSON.stringify(v) } }] }) };
  });
  const attempt = jest.fn(async options => {
    expect(fs.existsSync(path.join(dir, 'attempt.reserved.json'))).toBe(true);
    expect(options.entry).toEqual({ provider: 'openrouter', model: sol.MODEL, fallbackIndex: 0 });
    expect(options.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,' + bytes.toString('base64'));
    await (await options.fetchImpl('https://openrouter.ai/api/v1/chat/completions', { method: 'POST' })).text();
    return { content: JSON.stringify(v), usage: { total_tokens: 12, cost: 0.01 }, finishReason: 'stop' };
  });
  const result = await sol.run({ directory: dir, source, key: 'never-persist-test-key', attempt, fetchImpl, network: { scope: (_p,_k,fn) => fn() } });
  expect(result.state.status).toBe('COMPLETE'); expect(result.state.providerCalls).toBe(1); expect(attempt).toHaveBeenCalledTimes(1); expect(fetchImpl).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(dir, 'activeTranscript.txt'), 'utf8')).toBe(v.activeTranscript);
  for (const name of fs.readdirSync(dir)) expect(fs.readFileSync(path.join(dir,name),'utf8')).not.toContain('never-persist-test-key');
  await expect(sol.run({ directory: dir, source, key: 'key', attempt, fetchImpl, network: { scope: (_p,_k,fn) => fn() } })).rejects.toThrow('ONE_SHOT');
  expect(attempt).toHaveBeenCalledTimes(1);
});
test('provider failure consumes attempt without a retry and stores no raw secret-bearing error', async () => {
  const dir = temp(), source = { file: '/test', bytes: Buffer.from('x'), mime: 'image/jpeg', sha256: 'a'.repeat(64) };
  const attempt = jest.fn(async () => { throw Error('secret credential material'); });
  const result = await sol.run({ directory: dir, source, key: 'secret', attempt, fetchImpl: jest.fn(), network: { scope: (_p,_k,fn) => fn() } });
  expect(result.state.status).toBe('FAILED'); expect(result.state.errorCode).toBe('SOL_REQUEST_FAILED'); expect(attempt).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(dir,'result-metadata.json'),'utf8')).not.toContain('credential material');
});
test('standalone entry imports no correction, evaluation, scoring or publication service', () => {
  const entry = fs.readFileSync(path.resolve(__dirname, '../scripts/runSolVerbatimPage01.cjs'),'utf8');
  const impl = fs.readFileSync(path.resolve(__dirname, '../scripts/local-shadow/sol-verbatim.cjs'),'utf8');
  for (const name of ['canonicalCorrectionsPipeline','canonicalEvaluation','correctionUniqueSource','submissionFeedbackReport','visionOcr.service']) expect(entry + impl).not.toContain(name);
});
