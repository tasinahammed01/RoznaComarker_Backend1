'use strict';
// Unit tests of the text-span anchor algorithm (src/services/annotationAnchor.service.js). Synthetic text only.
const anchors = require('../src/services/annotationAnchor.service');

/** A one-page canonical transcript of space-separated words, the shape buildCanonicalSubmissionTranscript returns. */
function transcript(words, { fileId = 'f1', page = 1, prefix = '' } = {}) {
  const text = prefix + words.join(' ');
  const wordSpans = []; let at = prefix.length;
  words.forEach((w, i) => { wordSpans.push({ wordId: `w${i}`, fileId, page, start: at, end: at + w.length }); at += w.length + 1; });
  return { text, wordSpans, pages: [{ fileId, pageNumber: page, startChar: 0, endChar: text.length }] };
}
const spanOf = (t, word, occurrence = 0) => { const s = t.wordSpans.filter(w => t.text.slice(w.start, w.end) === word)[occurrence];
  return { fileId: s.fileId, page: s.page, startChar: s.start, endChar: s.end }; };

describe('capture', () => {
  test('records the quote and up to 32 characters of same-page context on each side', () => {
    const t = transcript(['I', 'goes', 'to', 'the', 'park']);
    const a = anchors.capture(spanOf(t, 'goes'), t, 'h1');
    expect(a).toEqual({ fileId: 'f1', page: 1, startChar: 2, endChar: 6, quotedText: 'goes', before: 'I ', after: ' to the park', sourceHash: 'h1' });
    const long = transcript(Array.from({ length: 30 }, (_, i) => `w${i}`));
    const b = anchors.capture(spanOf(long, 'w15'), long, 'h');
    expect(b.before).toHaveLength(anchors.CONTEXT_CHARS);
    expect(b.after).toHaveLength(anchors.CONTEXT_CHARS);
  });
});

describe('locate', () => {
  const t = transcript(['I', 'goes', 'to', 'the', 'park', 'and', 'she', 'goes', 'home']);
  test('same evidence hash and an unchanged slice: the stored span (fast path)', () => {
    const a = anchors.capture(spanOf(t, 'goes', 1), t, 'h1');
    expect(anchors.locate(a, t, 'h1')).toEqual({ span: { fileId: 'f1', page: 1, startChar: a.startChar, endChar: a.endChar } });
  });
  test('text shifted by an OCR change: the unique quote is found at its new offset', () => {
    const a = anchors.capture(spanOf(t, 'park'), t, 'h1');
    const moved = transcript(['Today', 'I', 'goes', 'to', 'the', 'park', 'and', 'she', 'goes', 'home']);
    expect(anchors.locate(a, moved, 'h2').span).toEqual(spanOf(moved, 'park'));
  });
  test('a repeated quote is resolved by its context', () => {
    const second = anchors.capture(spanOf(t, 'goes', 1), t, 'h1');
    const moved = transcript(['Today', 'I', 'goes', 'to', 'the', 'park', 'and', 'she', 'goes', 'home']);
    expect(anchors.locate(second, moved, 'h2').span).toEqual(spanOf(moved, 'goes', 1));
    const first = anchors.capture(spanOf(t, 'goes', 0), t, 'h1');
    expect(anchors.locate(first, moved, 'h2').span).toEqual(spanOf(moved, 'goes', 0));
  });
  test('a repeated quote with equal or too little context is AMBIGUOUS and lists every candidate', () => {
    const noContext = { fileId: 'f1', page: 1, startChar: 2, endChar: 6, quotedText: 'goes', before: '', after: '', sourceHash: 'old' };
    const r = anchors.locate(noContext, t, 'h2');
    expect(r.orphan).toBe('AMBIGUOUS');
    expect(r.candidates).toEqual([spanOf(t, 'goes', 0), spanOf(t, 'goes', 1)]);
    // Both occurrences share the stored context equally ("x " before, " y" after): a tie is never guessed.
    const same = transcript(['x', 'goes', 'y', 'x', 'goes', 'y']);
    const tie = { fileId: 'f1', page: 1, startChar: 2, endChar: 6, quotedText: 'goes', before: 'x ', after: ' y', sourceHash: 'old' };
    expect(anchors.locate(tie, same, 'h2').orphan).toBe('AMBIGUOUS');
    // Longer captured context does tell them apart.
    expect(anchors.locate({ ...anchors.capture(spanOf(same, 'goes', 1), same, 'h1'), sourceHash: 'old' }, same, 'h2').span).toEqual(spanOf(same, 'goes', 1));
  });
  test('the quote no longer present: TEXT_NOT_FOUND; the page gone: PAGE_NOT_FOUND', () => {
    const a = anchors.capture(spanOf(t, 'park'), t, 'h1');
    expect(anchors.locate(a, transcript(['I', 'went', 'home']), 'h2')).toEqual({ orphan: 'TEXT_NOT_FOUND', candidates: [] });
    expect(anchors.locate(a, transcript(['park'], { fileId: 'f2' }), 'h2')).toEqual({ orphan: 'PAGE_NOT_FOUND', candidates: [] });
  });
  test('only whole words match: a quote inside a longer word is not found', () => {
    const a = { fileId: 'f1', page: 1, startChar: 0, endChar: 2, quotedText: 'go', before: '', after: '', sourceHash: 'old' };
    expect(anchors.locate(a, transcript(['going', 'gone']), 'h2').orphan).toBe('TEXT_NOT_FOUND');
  });
  test('a multi-word quote relocates as one span', () => {
    const start = t.text.indexOf('the park');
    const a = anchors.capture({ fileId: 'f1', page: 1, startChar: start, endChar: start + 8 }, t, 'h1');
    expect(a.quotedText).toBe('the park');
    const moved = transcript(['We', 'saw', 'I', 'goes', 'to', 'the', 'park']);
    expect(anchors.locate(a, moved, 'h2').span).toEqual({ fileId: 'f1', page: 1, startChar: moved.text.indexOf('the park'), endChar: moved.text.length });
  });
  test('an empty or missing anchor never matches anything', () => {
    expect(anchors.locate(null, t, 'h').orphan).toBe('TEXT_NOT_FOUND');
    expect(anchors.locate({ quotedText: '' }, t, 'h').orphan).toBe('TEXT_NOT_FOUND');
  });
});

describe('overlap and matching threshold', () => {
  const s = (startChar, endChar, extra = {}) => ({ fileId: 'f1', page: 1, startChar, endChar, ...extra });
  test('IoU and containment', () => {
    expect(anchors.overlap(s(0, 10), s(5, 15))).toEqual({ overlap: 5, iou: 5 / 15, contains: false });
    expect(anchors.overlap(s(0, 10), s(2, 4)).contains).toBe(true);
    expect(anchors.overlap(s(0, 4), s(4, 8)).overlap).toBe(0);
    expect(anchors.overlap(s(0, 4), s(0, 4, { page: 2 })).overlap).toBe(0);
    expect(anchors.overlap(s(0, 4), s(0, 4, { fileId: 'f2' })).overlap).toBe(0);
  });
  test(`match = IoU >= ${anchors.IOU_THRESHOLD} or containment`, () => {
    expect(anchors.matches(s(0, 10), s(0, 10))).toBe(true);
    expect(anchors.matches(s(0, 10), s(5, 15))).toBe(false);          // IoU 0.33
    expect(anchors.matches(s(0, 10), s(2, 12))).toBe(true);           // IoU 0.67
    expect(anchors.matches(s(0, 9), s(3, 12))).toBe(true);            // IoU exactly 0.5
    expect(anchors.matches(s(36, 37), s(36, 43))).toBe(true);         // "a" inside "a apple"
    expect(anchors.matches(s(0, 4), s(5, 9))).toBe(false);
  });
  test('wordIdsFor returns the canonical words a span covers', () => {
    const t = transcript(['I', 'goes', 'to']);
    expect(anchors.wordIdsFor(t, { fileId: 'f1', page: 1, startChar: 2, endChar: 9 })).toEqual(['w1', 'w2']);
  });
});
