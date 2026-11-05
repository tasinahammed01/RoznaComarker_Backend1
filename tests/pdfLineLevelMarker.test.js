'use strict';
// The PDF uses the website's generated rules, so a correction whose word has no box is marked by its line there too. Synthetic words only.
const { websiteAnnotationPresentation } = require('../src/pdf/websiteAnnotationPresentation');

const word = (line, index, y) => ({ id: `w${line}_${index}`, text: `word${line}x${index}`, bbox: y === null ? null : { x: 20 + index * 10, y: y - 2, w: 8, h: 4 }, separatorBefore: line && !index ? '\n' : index ? ' ' : '' });
const WORDS = [10, 15, 20, null, 30].flatMap((y, line) => [word(line, 0, y), word(line, 1, null)]);
const correction = (id, wordId, renderTarget = { version: 1, source: 'none', wordIds: [], anchors: [], boxes: [], textRanges: [{ start: 0, end: 4 }] }, symbol = 'FRAG') => ({ id, symbol, category: 'GRAMMAR', page: 1, wordIds: [wordId],
  quotedText: WORDS.find(w => w.id === wordId).text, renderTarget });
const present = corrections => websiteAnnotationPresentation({ fileId: 'f', pageNumber: 1, imageWidth: 1000, imageHeight: 1000, annotationWords: WORDS, corrections });

describe('line-level markers in the PDF', () => {
  test('a one-word error on a proven line: nothing drawn, and it stays in the notes', () => {
    const result = present([correction('c0', 'w1_1', undefined, 'SP')]);
    expect(result.strokes).toEqual([]);
    expect(result.unmapped.map(item => item.id)).toEqual(['c0']);
  });
  test('a checked sentence correction on a proven line gets a line-level bracket and stays in the groups', () => {
    const result = present([correction('c1', 'w1_1')]);
    expect(result.unmapped).toEqual([]);
    expect(result.groups.map(group => group.correctionIds)).toEqual([['c1']]);
    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0]).toMatchObject({ lineLevel: true, semantic: true, top: 13, height: 4 });
  });
  test('a line without a box: nothing is drawn and the correction stays in the notes', () => {
    const result = present([correction('c2', 'w3_1')]);
    expect(result.strokes).toEqual([]);
    expect(result.unmapped.map(item => item.id)).toEqual(['c2']);
  });
  test('without the server\'s text check: nothing is drawn', () => {
    const result = present([correction('c3', 'w1_1', { version: 1, source: 'none', wordIds: [], anchors: [], boxes: [] })]);
    expect(result.strokes).toEqual([]);
    expect(result.unmapped.map(item => item.id)).toEqual(['c3']);
  });
  test('a boxed word stays a word-level underline', () => {
    const result = present([correction('c4', 'w1_0', { version: 1, source: 'wordIds', wordIds: ['w1_0'], anchors: [], boxes: [WORDS.find(w => w.id === 'w1_0').bbox] })]);
    expect(result.strokes).toHaveLength(1);
    expect(result.strokes[0].semantic).toBe(false);
    expect(result.strokes[0].lineLevel).toBeUndefined();
  });
});
