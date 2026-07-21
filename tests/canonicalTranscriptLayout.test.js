const { buildCanonicalPageFromWords, buildCanonicalSubmissionTranscript, normalizeLegacyDisplayText,
  CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { buildCorrectionSourceHash } = require('../src/services/canonicalCorrectionsPipeline.service');

const word = (id, text, x0, y0, paragraphIndex, x1 = x0 + 8, y1 = y0 + 2) => ({
  id, text, paragraphIndex, bbox: { x0, y0, x1, y1 }
});

describe('canonical transcript layout', () => {
  test('joins visual line wraps and isolated words inside one OCR paragraph', () => {
    const result = buildCanonicalPageFromWords([
      { id: '1', text: 'Technology', paragraphIndex: 0 }, { id: '2', text: 'gives', paragraphIndex: 0 },
      { id: '3', text: 'students', paragraphIndex: 0 }, { id: '4', text: 'more', paragraphIndex: 0 }, { id: '5', text: '.', paragraphIndex: 0 }
    ]);
    expect(result.text).toBe('Technology gives students more.');
    expect(result.paragraphs).toHaveLength(1);
  });

  test('requires corroborating geometry before promoting OCR paragraph metadata', () => {
    const result = buildCanonicalPageFromWords([
      word('1', 'First', 10, 10, 0), word('2', 'paragraph.', 20, 10, 0),
      word('3', 'Second', 11, 13, 1), word('4', 'line.', 24, 13, 1),
      word('5', 'New', 10, 19, 2), word('6', 'paragraph.', 20, 19, 2)
    ]);
    expect(result.text).toBe('First paragraph. Second line.\n\nNew paragraph.');
    expect(result.paragraphs.map((p) => result.text.slice(p.startChar, p.endChar)))
      .toEqual(['First paragraph. Second line.', 'New paragraph.']);
  });

  test('repairs the sanitized parking fragment without changing words or mappings', () => {
    const input = [
      word('w1', 'Parking', 10, 10, 1), word('w2', 'gives', 22, 10, 1),
      word('w3', 'more', 10, 13, 2),
      word('w4', 'in', 10, 16, 3), word('w5', 'campus', 15, 16, 3), word('w6', '.', 26, 16, 3, 27, 18)
    ];
    const result = buildCanonicalPageFromWords(input);
    expect(result.text).toBe('Parking gives more in campus.');
    expect(result.paragraphs).toHaveLength(1);
    expect(result.spans.map((span) => result.text.slice(span.start, span.end)))
      .toEqual(input.map((item) => item.text));
    expect(result.spans.map((span) => span.separatorBefore)).toEqual(['', ' ', ' ', ' ', ' ', '']);
  });

  test('sorts shuffled OCR words into deterministic visual reading order', () => {
    const result = buildCanonicalPageFromWords([
      word('3', 'next', 10, 13, 1), word('2', 'world', 20, 10, 0), word('1', 'Hello', 10, 10, 0)
    ]);
    expect(result.text).toBe('Hello world next');
    expect(result.spans.map((span) => span.wordId)).toEqual(['1', '2', '3']);
  });

  test('preserves uploaded file order and ignores duplicate page records', () => {
    const result = buildCanonicalSubmissionTranscript({ files: ['a', 'b'], ocrPages: [
      { fileId: 'b', pageNumber: 1, words: [{ text: 'Second', paragraphIndex: 0 }] },
      { fileId: 'a', pageNumber: 1, words: [{ text: 'First', paragraphIndex: 0 }] },
      { fileId: 'a', pageNumber: 1, words: [{ text: 'Duplicate', paragraphIndex: 0 }] }
    ] });
    expect(result.text).toBe('First Second'); expect(result.pages).toHaveLength(2); expect(result.isComplete).toBe(true);
    expect(result.version).toBe(CANONICAL_TRANSCRIPT_LAYOUT_VERSION);
    expect(result.pages.map((page) => result.text.slice(page.startChar, page.endChar))).toEqual(['First', 'Second']);
    expect(result.wordSpans.map((span) => result.text.slice(span.start, span.end))).toEqual(['First', 'Second']);
    expect(result.wordSpans.map((span) => span.separatorBefore)).toEqual(['', ' ']);
    expect(result.wordSpans.map((span) => `${span.separatorBefore}${result.text.slice(span.start, span.end)}`).join(''))
      .toBe(result.text);
  });

  test('legacy visual line breaks become spaces while blank lines remain paragraphs', () => {
    expect(normalizeLegacyDisplayText('A line\nwrap\n\nNew paragraph')).toBe('A line wrap\n\nNew paragraph');
  });

  test('transcript layout version participates in the correction source hash', () => {
    const input = { transcript: 'Same words.', assignment: { title: 'Essay' } };
    expect(buildCorrectionSourceHash({ ...input, transcriptLayoutVersion: 'old-layout' }))
      .not.toBe(buildCorrectionSourceHash({ ...input, transcriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION }));
  });
});
