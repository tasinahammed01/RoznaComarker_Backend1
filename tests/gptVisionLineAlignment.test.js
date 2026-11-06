'use strict';
// The line pass of the geometry alignment. Synthetic words and boxes only. A wrong box is worse than none, so most of this is about what must stay unbound.
const { alignGeometry } = require('../src/services/gptVisionExact/alignment');
const { similarity, alignWords, positionalPairs } = require('../src/services/gptVisionExact/lineAlignment');

const identity = { fileId: 'f', pageNumber: 1 };
/** Provider words: one array of texts per written line, at fixed places. */
function provider(lines) {
  return { words: lines.flatMap((line, y) => line.map((text, x) => ({ id: `g${y}_${x}`, text, bbox: { x0: 50 + x * 110, y0: 100 + y * 70, x1: 150 + x * 110, y1: 150 + y * 70 } }))) };
}
const boxOf = (result, position) => result.words[position].geometryWordId;
const align = (text, lines) => alignGeometry(text, provider(lines), identity);

describe('similarity', () => {
  test('a misspelling is the same word; another word is not', () => {
    expect(similarity('change', 'chany')).toBeGreaterThan(0);
    expect(similarity('see', 'sort')).toBe(0);
    expect(similarity('people', 'people')).toBe(1);
  });
  test('short words must be equal', () => {
    expect(similarity('in', 'is')).toBe(0);
    expect(similarity('a', 'i')).toBe(0);
  });
});

describe('alignWords and positionalPairs', () => {
  test('keeps the order and finds the best pairing', () => {
    expect(alignWords(['the', 'way', 'people'], ['the', 'wag', 'peole']).map(([a, b]) => [a, b])).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
  test('a word between two neighbours takes the one place between them, only when the counts agree', () => {
    expect(positionalPairs([[0, 0, 1], [2, 2, 1]], 3, 3)).toEqual([[1, 1]]);
    expect(positionalPairs([[0, 0, 1], [2, 3, 1]], 3, 4)).toEqual([]);
  });
  test('one anchor is not enough to place anything by position', () => {
    expect(positionalPairs([[0, 0, 1]], 2, 2)).toEqual([]);
  });
});

describe('alignGeometry', () => {
  test('a word that repeats on the page gets the box of its own line', () => {
    const result = align('the cat sat\nthe dog ran\nthe owl flew', [['the', 'cat', 'sat'], ['the', 'dog', 'ran'], ['the', 'owl', 'flew']]);
    expect([boxOf(result, 0), boxOf(result, 3), boxOf(result, 6)]).toEqual(['g0_0', 'g1_0', 'g2_0']);
    expect(result.coverage).toBe(1);
  });
  test('a misread word lands on its box when its neighbours are matched', () => {
    const result = align('I think media can chany the way', [['I', 'think', 'media', 'can', 'change', 'the', 'way']]);
    expect(boxOf(result, 4)).toBe('g0_4');
  });
  test('a word read completely differently still lands by position between matched neighbours', () => {
    const result = align('please open xqzv door today', [['please', 'open', 'wmkp', 'door', 'today']]);
    expect(boxOf(result, 2)).toBe('g0_2');
  });
  test('when the provider split a word, the counts differ and the words between stay without a box', () => {
    const result = align('please open cupboard door today', [['please', 'open', 'wmk', 'pqz', 'door', 'today']]);
    expect(result.words[2].bbox).toBeNull();
    expect(boxOf(result, 3)).toBe('g0_4');
  });
  test('a line the reader has and the provider does not stays without boxes, and later lines still pair', () => {
    const result = align('alpha beta gamma\nnothing here matches anything\ndelta epsilon zeta', [['alpha', 'beta', 'gamma'], ['delta', 'epsilon', 'zeta']]);
    expect(result.words.slice(3, 7).filter(word => word.bbox)).toEqual([]);
    expect(boxOf(result, 7)).toBe('g1_0');
  });
  test('a line the provider has and the reader does not is skipped, never given to the next reader line', () => {
    const result = align('alpha beta gamma\ndelta epsilon zeta', [['alpha', 'beta', 'gamma'], ['crossed', 'out', 'words'], ['delta', 'epsilon', 'zeta']]);
    expect(boxOf(result, 3)).toBe('g2_0');
    expect(result.words.map(word => word.geometryWordId)).not.toContain('g1_0');
  });
  test('words on a line that agrees with nothing are not placed by position', () => {
    const result = align('alpha beta gamma\nqqqq rrrr ssss\ndelta epsilon zeta', [['alpha', 'beta', 'gamma'], ['wwww', 'xxxx', 'yyyy'], ['delta', 'epsilon', 'zeta']]);
    expect(result.words.slice(3, 6).filter(word => word.bbox)).toEqual([]);
  });
  test('the same line twice on the page, read once: which one is unknown, so neither gives a box', () => {
    const result = align('the same phrase', [['the', 'same', 'phrase'], ['the', 'same', 'phrase']]);
    expect(result.words.filter(word => word.bbox)).toEqual([]);
  });
  test('read twice and written once: neither reader line takes the box', () => {
    const result = align('the same phrase\nthe same phrase', [['the', 'same', 'phrase']]);
    expect(result.words.filter(word => word.bbox)).toEqual([]);
  });
  test('the same line twice, read twice: each pairs with its own', () => {
    const result = align('the same phrase\nthe same phrase', [['the', 'same', 'phrase'], ['the', 'same', 'phrase']]);
    expect([boxOf(result, 0), boxOf(result, 3)]).toEqual(['g0_0', 'g1_0']);
  });
  test('one provider box is never given to two words', () => {
    const result = align('the the the cat\nsat on mat here', [['the', 'cat'], ['sat', 'on', 'mat', 'here']]);
    const ids = result.words.map(word => word.geometryWordId).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
  test('lines keep their order: a later reader line cannot pair with an earlier provider line', () => {
    const result = align('delta epsilon zeta\nalpha beta gamma', [['alpha', 'beta', 'gamma'], ['delta', 'epsilon', 'zeta']]);
    const bound = result.words.filter(word => word.bbox).map(word => Number(word.geometryWordId[1]));
    expect([...bound].sort((a, b) => a - b)).toEqual(bound);
  });
  test('no provider words: nothing is bound and the outcome is unchanged', () => {
    expect(alignGeometry('alpha beta', null, identity)).toMatchObject({ coverage: 0, diagnostics: { safeOutcomeCode: 'GEOMETRY_UNAVAILABLE', mappedTokenCount: 0 } });
    expect(alignGeometry('alpha beta', { words: [] }, identity)).toMatchObject({ coverage: 0, diagnostics: { safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', mappedTokenCount: 0 } });
  });
  test('the diagnostics count what the line pass bound; no word gains a new field', () => {
    const result = align('the cat sat\nthe dog ran\nthe owl flew', [['the', 'cat', 'sat'], ['the', 'dog', 'ran'], ['the', 'owl', 'flew']]);
    expect(result.diagnostics).toMatchObject({ strategy: 'gpt-monotonic-partial-geometry-v3', mappedTokenCount: 9, unmappedTokenCount: 0 });
    expect(result.diagnostics.lineBoundTokenCount).toBeGreaterThan(0);
    expect(Object.keys(result.words[0]).sort()).toEqual(['bbox', 'fileId', 'geometryWordId', 'id', 'page', 'separatorBefore', 'sourceEnd', 'sourceStart', 'text']);
  });
});

describe('third pass: pages whose lines the layout could not separate', () => {
  const { bindInBands } = require('../src/services/gptVisionExact/lineAlignment');
  const key = value => value.toLowerCase().replace(/[^a-z0-9]/g, '') || value;
  const token = (text, y, line = false) => ({ text, separatorBefore: line ? '\n' : ' ', bbox: y === null ? null : { x: 10, y, w: 5, h: 2 }, geometryWordId: y === null ? null : `t${text}` });
  const word = (id, text, x, y) => ({ id, text, bbox: { x, y, w: 5, h: 2 } });

  test('a word takes a nearly identical unused word between the placed lines around it', () => {
    const tokens = [token('above', 10), token('strict', null, true), token('limits', null), token('below', 30, true)];
    expect(bindInBands(tokens, [word('a', 'strict', 10, 20), word('b', 'limits', 20, 20)], key)).toBe(2);
    expect(tokens.slice(1, 3).map(t => t.geometryWordId)).toEqual(['a', 'b']);
  });
  test('nothing outside the band', () => {
    const tokens = [token('above', 10), token('strict', null, true), token('below', 30, true)];
    expect(bindInBands(tokens, [word('a', 'strict', 10, 40)], key)).toBe(0);
  });
  test('two equal candidates in the band: neither', () => {
    const tokens = [token('above', 10), token('strict', null, true), token('below', 30, true)];
    expect(bindInBands(tokens, [word('a', 'strict', 10, 18), word('b', 'strict', 30, 22)], key)).toBe(0);
    expect(tokens[1].bbox).toBeNull();
  });
  test('a word that reads differently is not placed: position does not count here', () => {
    const tokens = [token('above', 10), token('strict', null, true), token('below', 30, true)];
    expect(bindInBands(tokens, [word('a', 'wholly', 10, 20)], key)).toBe(0);
  });
  test('no placed line on the page: no band, nothing happens', () => {
    const tokens = [token('strict', null), token('limits', null)];
    expect(bindInBands(tokens, [word('a', 'strict', 10, 20)], key)).toBe(0);
  });
});

describe('possible missed lines', () => {
  const lines = texts => provider(texts);
  const missed = (text, written, options) => alignGeometry(text, lines(written), identity, options).diagnostics.possibleMissedLineCount;
  test('a written line the reader does not have is counted', () => {
    expect(missed('alpha beta gamma delta\nzeta eta theta iota', [['alpha', 'beta', 'gamma', 'delta'], ['kappa', 'lambda', 'sigma', 'omega'], ['zeta', 'eta', 'theta', 'iota']])).toBe(1);
  });
  test('words scattered over other lines do not cover it', () => {
    expect(missed('alpha beta one two\ngamma delta three four', [['alpha', 'gamma', 'kappa', 'lambda', 'sigma'], ['alpha', 'beta', 'one', 'two'], ['gamma', 'delta', 'three', 'four']])).toBe(1);
  });
  test('a copied question or crossed-out text set aside by the reader is not missed', () => {
    const written = [['kappa', 'lambda', 'sigma', 'omega'], ['zeta', 'eta', 'theta', 'iota']];
    expect(missed('zeta eta theta iota', written, { excludedTexts: ['kappa lambda sigma omega'] })).toBe(0);
    expect(missed('zeta eta theta iota', written)).toBe(1);
  });
  test('short lines are ignored: usually a name, a date or a note', () => {
    expect(missed('zeta eta theta iota', [['Saeed', 'Date'], ['zeta', 'eta', 'theta', 'iota']])).toBe(0);
  });
  test('punctuation the provider counts as words does not lower the score', () => {
    expect(missed('way people see negatively', [['way', 'people', '.', ',', ';', 'see', 'negatively', '.']])).toBe(0);
  });
  test('a word the provider also saw without a box stays without one; its neighbours still bind', () => {
    const page = provider([['alpha', 'beta', 'gamma', 'delta'], ['zeta', 'common', 'theta', 'iota']]);
    page.words.push({ id: 'gx', text: 'common', bbox: null, page: 1 });
    const result = alignGeometry('alpha beta gamma delta\nzeta common theta iota', page, identity);
    expect(boxOf(result, 5)).toBeFalsy();
    expect(result.words[5].bbox).toBeNull();
    expect(boxOf(result, 4)).toBe('g1_0');
    expect(boxOf(result, 6)).toBe('g1_2');
  });
  test('it never changes the text', () => {
    const result = alignGeometry('zeta eta theta iota', lines([['kappa', 'lambda', 'sigma', 'omega'], ['zeta', 'eta', 'theta', 'iota']]), identity);
    expect(result.words.map(w => w.text).join(' ')).toBe('zeta eta theta iota');
  });
});
