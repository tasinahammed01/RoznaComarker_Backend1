'use strict';
// Similarity text tools: words with character offsets, quotes, 5-word hashes, winnowing, matched runs, locating provider text, and the
// overall percentage (a union, never a sum). Synthetic text only.
const { tokenize, quoteMask, PAGE_BREAK } = require('../src/services/similarity/normalize');
const { shingleHashes, winnow, matchRuns, fnv1a, K, W } = require('../src/services/similarity/fingerprints');
const { locateFragments, mapForeignSpans } = require('../src/services/similarity/locate');
const { computeView } = require('../src/services/similarity/overall');

const words = n => Array.from({ length: n }, (_, i) => `w${i}`).join(' ');

describe('tokenize', () => {
  test('words with offsets on the original text, lower-cased and NFKC-normalised', () => {
    const text = 'The CAT’s ﬁne-tuned plan, 42 times.';
    const t = tokenize(text);
    expect(t.map(x => x.w)).toEqual(["the", "cat's", 'fine-tuned', 'plan', '42', 'times']);
    for (const x of t) expect(text.slice(x.start, x.end).length).toBe(x.end - x.start);
    expect(text.slice(t[1].start, t[1].end)).toBe('CAT’s');
    expect(text.slice(t[2].start, t[2].end)).toBe('ﬁne-tuned');
  });
  test('counts pages on the page break', () => {
    const t = tokenize(`one two${PAGE_BREAK}three`);
    expect(t.map(x => x.page)).toEqual([0, 0, 1]);
  });
  test('empty or non-string input has no words', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize(null)).toEqual([]);
    expect(tokenize(' ,.;  ')).toEqual([]);
  });
});

describe('quoteMask', () => {
  test('marks words inside curly and straight double quotes; an unclosed quote marks nothing', () => {
    const text = 'a “b c” d "e f" g "h i';
    const t = tokenize(text);
    expect(quoteMask(text, t)).toEqual([false, true, true, false, true, true, false, false, false]);
  });
});

describe('shingles and winnowing', () => {
  test('one hash per word position with a full 5-word sequence; null at the end and across a page break', () => {
    const t = tokenize(`a b c d e f${PAGE_BREAK}g h i j k`);
    const h = shingleHashes(t);
    expect(h).toHaveLength(t.length);
    expect(h[0]).toBe(fnv1a('a b c d e'));
    expect(h[1]).toBe(fnv1a('b c d e f'));
    expect(h.slice(2, 6)).toEqual([null, null, null, null]);  // these would cross the page break
    expect(h[6]).toBe(fnv1a('g h i j k'));
    expect(h.slice(7)).toEqual([null, null, null, null]);
    expect(K).toBe(5);
  });
  test('the hash is a 32-bit unsigned integer and stable', () => {
    expect(fnv1a('a b c d e')).toBe(fnv1a('a b c d e'));
    expect(Number.isInteger(fnv1a('x'))).toBe(true);
    expect(fnv1a('x')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('x')).toBeLessThan(2 ** 32);
  });
  test('winnowing keeps at least one hash of every window of W sequences', () => {
    const h = shingleHashes(tokenize(words(60)));
    const kept = new Set(winnow(h));
    for (let i = 0; i + W <= h.length; i++) {
      const window = h.slice(i, i + W).filter(v => v !== null);
      if (window.length === W) expect(window.some(v => kept.has(v))).toBe(true);
    }
    expect(kept.size).toBeLessThan(h.length);
  });
});

describe('matchRuns', () => {
  const base = words(40);
  const t = tokenize(base);
  const h = shingleHashes(t);
  test('a shared run of 10 words is found exactly', () => {
    const other = shingleHashes(tokenize(`x y z ${t.slice(10, 20).map(x => x.w).join(' ')} q r`));
    expect(matchRuns(h, new Set(other.filter(v => v !== null)), { minWords: 8 })).toEqual([{ wordStart: 10, wordEnd: 20 }]);
  });
  test('a run shorter than the minimum is dropped; exactly the minimum is kept', () => {
    const seven = shingleHashes(tokenize(t.slice(0, 7).map(x => x.w).join(' ')));
    expect(matchRuns(h, new Set(seven.filter(v => v !== null)), { minWords: 8 })).toEqual([]);
    const eight = shingleHashes(tokenize(t.slice(0, 8).map(x => x.w).join(' ')));
    expect(matchRuns(h, new Set(eight.filter(v => v !== null)), { minWords: 8 })).toEqual([{ wordStart: 0, wordEnd: 8 }]);
  });
  test('blocked words (quotes, the brief) are removed before the minimum is applied', () => {
    const shared = new Set(h.slice(0, 16).filter(v => v !== null));
    const blocked = new Array(t.length).fill(false);
    for (let i = 6; i < 12; i++) blocked[i] = true;
    expect(matchRuns(h, shared, { minWords: 6, blocked })).toEqual([{ wordStart: 0, wordEnd: 6 }, { wordStart: 12, wordEnd: 20 }]);
    expect(matchRuns(h, shared, { minWords: 7, blocked })).toEqual([{ wordStart: 12, wordEnd: 20 }]);
  });
  test('nothing shared, nothing found', () => {
    expect(matchRuns(h, new Set(), { minWords: 8 })).toEqual([]);
  });
});

describe('locateFragments (a provider that gives matched text but no positions)', () => {
  const text = `Intro words here. ${words(30)} and the end of it all.`;
  const t = tokenize(text);
  test('finds each fragment, whatever its case and punctuation, and returns character spans', () => {
    const fragment = t.slice(5, 17).map(x => x.w.toUpperCase()).join(', ');
    const spans = locateFragments([fragment, 'text that is nowhere in the essay at all ok'], text, t, { minWords: 8 });
    expect(spans).toEqual([{ wordStart: 5, wordEnd: 17, start: t[5].start, end: t[16].end }]);
  });
  test('fragments separated by an ellipsis are located separately', () => {
    const a = t.slice(3, 12).map(x => x.w).join(' ');
    const b = t.slice(20, 30).map(x => x.w).join(' ');
    const spans = locateFragments([`${a} ... ${b}`], text, t, { minWords: 8 });
    expect(spans.map(s => [s.wordStart, s.wordEnd])).toEqual([[3, 12], [20, 30]]);
  });
});

describe('mapForeignSpans (a provider that gives positions on its own copy of the text)', () => {
  const text = `First page words ${words(20)}${PAGE_BREAK}second page ${words(5)}`;
  const t = tokenize(text);
  test('the same text: positions are used directly and snapped to whole words', () => {
    const start = t[4].start + 1;                       // inside a word
    const spans = mapForeignSpans(text, [{ start, length: t[14].end - start }], text, t, { minWords: 8 });
    expect(spans).toEqual([{ wordStart: 4, wordEnd: 15, start: t[4].start, end: t[14].end }]);
  });
  test('a different copy (spacing changed): the passages are located by their words', () => {
    const foreign = text.replace(PAGE_BREAK, ' ').replace(/ /g, '  ');
    const fStart = foreign.indexOf('w2 ');
    const fEnd = foreign.indexOf('w13') + 3;
    const spans = mapForeignSpans(foreign, [{ start: fStart, length: fEnd - fStart }], text, t, { minWords: 8 });
    const wi = t.findIndex(x => x.w === 'w2');
    expect(spans).toEqual([{ wordStart: wi, wordEnd: wi + 12, start: t[wi].start, end: t[wi + 11].end }]);
  });
  test('positions outside the text are ignored', () => {
    expect(mapForeignSpans(text, [{ start: text.length + 5, length: 10 }, { start: -3, length: 2 }], text, t, { minWords: 1 })).toEqual([]);
  });
});

describe('computeView: the percentages (server-side, recomputed on every read)', () => {
  const text = words(100);
  const t = tokenize(text);
  const span = (a, b) => ({ wordStart: a, wordEnd: b, start: t[a].start, end: t[b - 1].end });
  const src = (sourceId, spans, over = {}) => ({ sourceId, kind: 'web', label: 'Internet source', spans, excluded: false, compared: true, ...over });

  test('overall is the union of matched words, not the sum of the sources', () => {
    const v = computeView([src('s1', [span(0, 20)]), src('s2', [span(10, 30)])], t);
    expect(v.totalWords).toBe(100);
    expect(v.matchedWords).toBe(30);
    expect(v.overallPercent).toBe(30);
    // s1 and s2 both have 20 words: the tie goes to the lower source id; the shared words go to the higher-ranked source
    expect(v.sources.map(s => [s.sourceId, s.rank, s.words, s.percent])).toEqual([['s1', 1, 20, 20], ['s2', 2, 10, 10]]);
  });
  test('the larger source ranks first and takes the shared words', () => {
    const v = computeView([src('s1', [span(0, 10)]), src('s2', [span(5, 40)])], t);
    expect(v.sources.map(s => [s.sourceId, s.rank, s.words])).toEqual([['s2', 1, 35], ['s1', 2, 5]]);
    expect(v.overallPercent).toBe(40);
  });
  test('excluding a source gives its shared words to the next source and lowers the overall at once', () => {
    const v = computeView([src('s1', [span(0, 20)]), src('s2', [span(10, 30)], { excluded: true })], t);
    expect(v.overallPercent).toBe(20);
    expect(v.sources.find(s => s.sourceId === 's2')).toMatchObject({ excluded: true, rank: null, percent: null, words: 0 });
    const v2 = computeView([src('s1', [span(0, 20)], { excluded: true }), src('s2', [span(10, 30)])], t);
    expect(v2.sources.find(s => s.sourceId === 's2')).toMatchObject({ rank: 1, words: 20, percent: 20 });
    expect(v2.overallPercent).toBe(20);
  });
  test('every source excluded: 0%; no words: 0% (never a division by zero)', () => {
    expect(computeView([src('s1', [span(0, 20)], { excluded: true })], t).overallPercent).toBe(0);
    expect(computeView([src('s1', [])], []).overallPercent).toBe(0);
  });
  test('a source found but not compared shows no percentage and no highlight', () => {
    const v = computeView([src('s1', [], { compared: false, approxWords: 12 })], t);
    expect(v.sources[0]).toMatchObject({ sourceId: 's1', compared: false, percent: null, rank: null });
    expect(v.highlights).toEqual([]);
  });
  test('rounding: the overall is rounded from the union (1 of 300 words is 0, shown by the client as under 1%)', () => {
    const t3 = tokenize(words(300));
    const v = computeView([src('s1', [{ wordStart: 0, wordEnd: 1, start: t3[0].start, end: t3[0].end }])], t3);
    expect(v.overallPercent).toBe(0);
    expect(v.matchedWords).toBe(1);
    const half = computeView([src('s1', [{ wordStart: 0, wordEnd: 3, start: 0, end: t3[2].end }])], tokenize(words(200)));
    expect(half.overallPercent).toBe(2); // 1.5 rounds half up
  });
  test('highlights: each word once, coloured by the source it counts for, merged into character ranges', () => {
    const v = computeView([src('s1', [span(0, 20)]), src('s2', [span(10, 30)])], t);
    expect(v.highlights).toEqual([{ start: t[0].start, end: t[19].end, sourceId: 's1' }, { start: t[20].start, end: t[29].end, sourceId: 's2' }]);
  });
  test('a span beyond the text is clipped, never thrown', () => {
    const v = computeView([src('s1', [{ wordStart: 95, wordEnd: 140, start: 0, end: 0 }])], t);
    expect(v.matchedWords).toBe(5);
    expect(v.sources[0].ownWords).toBe(5);
  });
  test('two passages of one source with unmatched words between them stay two highlights', () => {
    const v = computeView([src('s1', [span(0, 10), span(15, 25)])], t);
    expect(v.highlights).toEqual([{ start: t[0].start, end: t[9].end, sourceId: 's1' }, { start: t[15].start, end: t[24].end, sourceId: 's1' }]);
  });
});
