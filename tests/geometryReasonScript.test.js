'use strict';
// scripts/geometry-reason.js: replays the geometry step for ONE image and prints which condition withheld the boxes.
// Counts and codes only: no word text. Google is injected here; the real script makes one paid Vision call, and only with --yes-call-google.
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const script = () => require('../scripts/geometry-reason.js');

const W = 1000, H = 1400, SECRET = 'PRIVATEWORD';
function rng(seed) { let s = seed; return () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; }; }
// Google words for a page: percentage boxes -> pixel vertices, the shape documentTextDetection returns.
function words(seed, { lines, perLine, pitch, height, jitter, heightVar }) {
  const rnd = rng(seed), out = [];
  for (let l = 0; l < lines; l++) for (let k = 0; k < perLine; k++) {
    const x = 3 + k * (92 / perLine), h = height * (1 + (rnd() - .5) * 2 * heightVar), y = 6 + l * pitch + (rnd() - .5) * 2 * jitter, w = 7;
    const px = v => Math.round(v), X = x * W / 100, Y = y * H / 100, X2 = (x + w) * W / 100, Y2 = (y + h) * H / 100;
    out.push({ symbols: [...`${SECRET}${out.length}`].map(text => ({ text })), boundingBox: { vertices: [{ x: px(X), y: px(Y) }, { x: px(X2), y: px(Y) }, { x: px(X2), y: px(Y2) }, { x: px(X), y: px(Y2) }] } });
  }
  return out;
}
const response = (wordList, { width = W, height = H } = {}) => [{ fullTextAnnotation: { text: SECRET, pages: [{ width, height, blocks: [{ paragraphs: [{ words: wordList }] }] }] } }];
const client = result => ({ documentTextDetection: jest.fn(async () => result) });
const SPACED = { lines: 10, perLine: 7, pitch: 6, height: 3.6, jitter: 0.2, heightVar: 0.1 };
const TIGHT = { lines: 10, perLine: 7, pitch: 2.9, height: 2.8, jitter: 1.4, heightVar: 0.5 };   // seed 12 makes the line clusters overlap
let bytes, file;
beforeAll(async () => {
  bytes = await sharp({ create: { width: W, height: H, channels: 3, background: '#fff' } }).jpeg().toBuffer();
  file = path.join(os.tmpdir(), `geometry-reason-${process.pid}.jpg`); fs.writeFileSync(file, bytes);
});
afterAll(() => fs.rmSync(file, { force: true }));

describe('analyze: which condition fires', () => {
  test('a well-spaced page is ordered: boxes would be produced', async () => {
    const out = await script().analyze({ bytes, client: client(response(words(7, SPACED))) });
    expect(out).toMatchObject({ wouldProduce: 'GEOMETRY_ORDERED', image: { width: W, height: H }, google: { dimensionsMatch: true, words: 70, wordsWithValidBox: 70 },
      layout: { degraded: false, reason: null, lineCount: 10, unresolvedWordCount: 0 } });
  });
  test('tight or uneven line spacing withholds everything with OVERLAPPING_LINE_CLUSTERS, and says why in plain fields', async () => {
    const out = await script().analyze({ bytes, client: client(response(words(12, TIGHT))) });
    expect(out.wouldProduce).toBe('GEOMETRY_LAYOUT_WITHHELD');
    expect(out.layout).toMatchObject({ degraded: true, reason: 'OVERLAPPING_LINE_CLUSTERS', detectedWordCount: 70 });
    expect(out.layout.medianWordHeightPercent).toBeGreaterThan(0);
    expect(out.layout.lineCount).toBeGreaterThan(0);
  });
  test('Google finding no usable words is its own reason', async () => {
    const out = await script().analyze({ bytes, client: client(response([])) });
    expect(out.wouldProduce).toBe('GEOMETRY_LAYOUT_WITHHELD');
    expect(out).toMatchObject({ google: { words: 0, wordsWithValidBox: 0, dimensionsMatch: true }, layout: { degraded: true, reason: 'MISSING_GEOMETRY_UNRESOLVED' } });
  });
  test('a Google page size that differs from the image is a different outcome, not a withheld layout', async () => {
    const out = await script().analyze({ bytes, client: client(response(words(7, SPACED), { width: W + 40, height: H })) });
    expect(out.wouldProduce).toBe('GEOMETRY_DIMENSIONS_MISMATCH');
    expect(out.google).toMatchObject({ pageWidth: W + 40, pageHeight: H, dimensionsMatch: false });
  });
  test('a response without any page is reported as such (it also counts as a size mismatch)', async () => {
    const out = await script().analyze({ bytes, client: client([{ fullTextAnnotation: null }]) });
    expect(out).toMatchObject({ wouldProduce: 'GEOMETRY_DIMENSIONS_MISMATCH', google: { pages: 0, words: 0, dimensionsMatch: false } });
  });
});

describe('what is printed', () => {
  test('only whitelisted keys, numbers, booleans and codes: never a word, a character of text or a file name', async () => {
    const out = await script().analyze({ bytes, client: client(response(words(12, TIGHT))) });
    const text = JSON.stringify(out);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain('PRIVATE');
    expect(Object.keys(out).sort()).toEqual(['google', 'image', 'layout', 'wouldProduce']);
    const walk = (value, trail = '') => {
      if (value && typeof value === 'object') return Object.entries(value).forEach(([k, v]) => walk(v, `${trail}.${k}`));
      expect(['number', 'boolean', 'string'].includes(typeof value) || value === null).toBe(true);
      if (typeof value === 'string') expect(value).toMatch(/^[A-Z][A-Z_]{0,59}$/);                 // codes only
    };
    walk(out);
  });
});

describe('command line', () => {
  const io = (extra = {}) => { const out = [], err = []; return { out, err, stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, createClient: jest.fn(() => client(response(words(7, SPACED)))), ...extra }; };
  test('it never calls Google without the explicit flag, and says what the call costs', async () => {
    const o = io();
    expect(await script().main([file], o)).toBe(2);
    expect(o.createClient).not.toHaveBeenCalled();
    expect(o.err.join('')).toMatch(/--yes-call-google/);
    expect(o.err.join('')).toMatch(/paid/i);
  });
  test('with the flag it makes exactly one Google call and prints the result as JSON', async () => {
    const o = io(), c = client(response(words(7, SPACED)));
    o.createClient = jest.fn(() => c);
    expect(await script().main([file, '--yes-call-google'], o)).toBe(0);
    expect(c.documentTextDetection).toHaveBeenCalledTimes(1);
    expect(JSON.parse(o.out.join('')).wouldProduce).toBe('GEOMETRY_ORDERED');
  });
  test.each([[[]], [['--yes-call-google']], [[file, 'extra', '--yes-call-google']], [[path.join(os.tmpdir(), 'does-not-exist.jpg'), '--yes-call-google']]])('bad usage %j is refused before any Google call', async argv => {
    const o = io();
    expect(await script().main(argv, o)).toBe(2);
    expect(o.createClient).not.toHaveBeenCalled();
  });
  test('errors print the error name only: never the message, a path or credentials', async () => {
    const o = io({ createClient: () => ({ documentTextDetection: async () => { throw Object.assign(new Error('PERMISSION key=SECRETKEY file C:\\keys\\vision.json'), { name: 'GoogleApiError' }); } }) });
    expect(await script().main([file, '--yes-call-google'], o)).toBe(1);
    expect(o.err.join('')).toMatch(/GoogleApiError/);
    expect(o.err.join('')).not.toMatch(/SECRETKEY|keys|vision\.json|PERMISSION/);
  });
});
