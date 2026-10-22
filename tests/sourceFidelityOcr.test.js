'use strict';
const fs = require('fs');
const path = require('path');
const { sha, validate, compare, schema, PROMPT, config, readPage } = require('../src/services/sourceFidelityOcr.service');
const segment = (text, type = 'ACTIVE_STUDENT_TEXT') => ({ type, text, confidence: 0.9, notes: '' });
const reading = text => ({ activeTranscript: text, segments: text.split('\n').map(t => segment(t)), uncertainSpans: [] });
const env = { OCR_ASTRA_MODEL: 'openai/gpt-6-astra', OCR_FABLE_MODEL: 'anthropic/claude-fable-5.1', OPENROUTER_API_KEY: 'mock-secret' };
const geometry = { fullText: 'Correct English', words: [{ text: 'sence', bbox: { x: 1, y: 1, w: 5, h: 5 } }], pages: [{ words: [] }] };
const run = (a, b, overrides = {}) => readPage({ bytes: Buffer.from([255,216,255,0]), mimeType: 'image/jpeg',
  identity: { width: 100, height: 100, sourceSha256: 'a'.repeat(64) }, google: async () => geometry,
  isCurrentJob: async () => true, env, reader: jest.fn(async ({ role }) => ({ value: role === 'astra' ? a : b,
    returnedModel: role === 'astra' ? env.OCR_ASTRA_MODEL : env.OCR_FABLE_MODEL })), persistEvidence: async () => {}, ...overrides });
test('application prompt preserves benchmark bytes and both reader identity', () => {
  expect(sha(PROMPT)).toBe('9e41486cde8d8a6177124a43ee587af8acee72547040701f0b0825b4eac987e6');
  expect(PROMPT).toBe(fs.readFileSync(path.join(__dirname, '../scripts/ocr-benchmark/strict-forensic-prompt.txt'), 'utf8'));
});
test('configuration requires exact models and credentials', () => {
  expect(config(env).astra).toBe(env.OCR_ASTRA_MODEL);
  for (const field of Object.keys(env)) expect(() => config({ ...env, [field]: '' })).toThrow();
  expect(() => config({ ...env, OCR_ASTRA_MODEL: 'substitute' })).toThrow();
});
test.each(['sence', 'Shape', 'Social', 'free,free', '  sence  \nSocial ,free\n'])('literal content survives without cleanup: %s', async text => {
  const value = reading(text); expect(validate(JSON.stringify(value))).toEqual(value);
  const result = await run(value, value); expect(result.fullText).toBe(text);
  expect(result.source.sourceFidelityStatus).toBe('MODEL_AGREED');
  expect(result.source.sourceTextSha256).toBe(sha(text));
});
test.each([['sence','sense'],['Shape','shape'],['Social','social'],['free,free','free, free'],['x.','x!'],['x','x y']])('disagreement %s versus %s fails closed', async (a,b) => {
  const result = await run(reading(a),reading(b));
  expect(result.fullText).toBe(a); expect(result.source.sourceFidelityStatus).toBe('OCR_UNCERTAIN');
  expect(compare(a,b).length).toBeGreaterThan(0);
});
test('same prompt/image/schema/budget to independent readers; no answer contamination', async () => {
  const reader = jest.fn(async () => ({ value: reading('sence') }));
  await run(reading('x'), reading('x'), { reader });
  const [a,b] = reader.mock.calls.map(c=>c[0]);
  for (const key of ['bytes','prompt','schema','maxCompletionTokens']) expect(a[key]).toEqual(b[key]);
  expect(sha(a.bytes)).toBe(sha(b.bytes)); expect(sha(a.prompt)).toBe(sha(b.prompt));
  expect(a.schema).toBe(schema); expect(a).not.toHaveProperty('transcript');
});
test('deleted text is excluded; classification conflict and uncertainty block agreement', async () => {
  const a=reading('sence'); a.segments.push(segment(null,'CROSSED_OUT_OR_DELETED'));
  expect((await run(a,a)).fullText).toBe('sence');
  expect((await run(a,reading('sence'))).source.sourceFidelityStatus).toBe('OCR_UNCERTAIN');
  a.uncertainSpans.push({ visibleContext:'?',candidateReading:null,reason:'overlap' });
  expect((await run(a,a)).source.sourceFidelityStatus).toBe('OCR_UNCERTAIN');
});
test('inconsistent/malformed schemas are rejected, never repaired', () => {
  expect(()=>validate('{')).toThrow(); expect(()=>validate(JSON.stringify({...reading('a'),activeTranscript:'b'}))).toThrow();
  expect(()=>validate(JSON.stringify(reading('\ud800')))).toThrow();
  const unicode='“sence”—Social\u00a0free';expect(validate(JSON.stringify(reading(unicode))).activeTranscript).toBe(unicode);
});
test.each(['astra','fable','google'])('%s failure fails closed without retry', async failed => {
  const reader=jest.fn(async ({role})=>{if(role===failed)throw Error('private upstream body');return {value:reading('sence')};});
  const result=await run(null,null,{reader,google:async()=>{if(failed==='google')throw Error('layout');return geometry;}});
  expect(result.source.sourceFidelityStatus).toBe(failed==='astra'?'PROVIDER_FAILED':'OCR_UNCERTAIN');
  expect(reader).toHaveBeenCalledTimes(2);
});
test('stale job discards all late evidence', async () => {
  let checks=0; const persistEvidence=jest.fn();
  await expect(run(reading('x'),reading('x'),{isCurrentJob:async()=>++checks===1,persistEvidence})).rejects.toMatchObject({code:'OCR_JOB_SUPERSEDED'});
  expect(persistEvidence).not.toHaveBeenCalled();
});
test('source reader concurrency stays bounded across simultaneous submissions',async()=>{
  let active=0,peak=0;
  const reader=async()=>{active++;peak=Math.max(peak,active);await new Promise(resolve=>setImmediate(resolve));active--;return {value:reading('sence')};};
  await Promise.all(Array.from({length:8},()=>run(null,null,{reader})));
  expect(peak).toBeLessThanOrEqual(4);expect(active).toBe(0);
});
module.exports={reading};
