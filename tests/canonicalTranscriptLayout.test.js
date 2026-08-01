const { buildCanonicalPageFromWords, buildCanonicalSubmissionTranscript, normalizeLegacyDisplayText,
  CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { buildCorrectionSourceHash } = require('../src/services/canonicalCorrectionsPipeline.service');

const word = (id, text, x0, y0, paragraphIndex, x1 = x0 + 8, y1 = y0 + 2) => ({
  id, text, paragraphIndex, bbox: { x0, y0, x1, y1 }
});

describe('canonical transcript layout', () => {
  test('explicit upload and page indexes override reverse OCR completion order', () => {
    const submission = {
      files: ['continuation-file', 'introduction-file'],
      fileOrder: [{ fileId: 'introduction-file', order: 0 }, { fileId: 'continuation-file', order: 1 }],
      ocrPages: [
        { fileId: 'continuation-file', fileOrder: 1, pageNumber: 1, pageIndex: 0,
          words: [{ id: 'c', text: 'However', bbox: { x0: 0, y0: 0, x1: 10, y1: 2 } }] },
        { fileId: 'introduction-file', fileOrder: 0, pageNumber: 1, pageIndex: 0,
          words: [{ id: 'i', text: 'Introduction', bbox: { x0: 0, y0: 0, x1: 10, y1: 2 } }] }
      ]
    };
    const result = buildCanonicalSubmissionTranscript(submission);
    expect(result.pages.map((page) => page.fileId)).toEqual(['introduction-file', 'continuation-file']);
    expect(result.text).toBe('Introduction However');
  });

  test('legacy retry deterministically preserves Submission.files order', () => {
    const submission = { files: ['second-result', 'first-result'], ocrPages: [
      { fileId: 'first-result', pageNumber: 1, text: 'first completion' },
      { fileId: 'second-result', pageNumber: 1, text: 'second completion' }
    ] };
    const first = buildCanonicalSubmissionTranscript(submission);
    const retry = buildCanonicalSubmissionTranscript({ ...submission, ocrPages: [...submission.ocrPages].reverse() });
    expect(first.pages.map((page) => page.fileId)).toEqual(['second-result', 'first-result']);
    expect(retry.text).toBe(first.text);
  });

  test('correction source hash is ordered and stable across retry', () => {
    const pageA = { fileId: 'a', fileOrder: 0, pageIndex: 0, pageNumber: 1, text: 'Introduction page' };
    const pageB = { fileId: 'b', fileOrder: 1, pageIndex: 0, pageNumber: 1, text: 'Continuation page' };
    const forward = buildCorrectionSourceHash({ transcript: 'Introduction page Continuation page', pages: [pageA, pageB] });
    const retry = buildCorrectionSourceHash({ transcript: 'Introduction page Continuation page', pages: [{ ...pageA }, { ...pageB }] });
    const reversed = buildCorrectionSourceHash({ transcript: 'Introduction page Continuation page', pages: [
      { ...pageB, fileOrder: 0 }, { ...pageA, fileOrder: 1 }
    ] });
    expect(forward).toBe(retry);
    expect(forward).not.toBe(reversed);
  });
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

  test('does not let a tall OCR box bridge neighboring handwritten lines', () => {
    const input = [
      word('a1', 'cars', 10, 10, 0, 18, 12), word('a2', 'gives', 21, 10, 0, 30, 12),
      word('bridge', 'without', 10, 13, 1, 22, 17), word('b2', 'pay', 25, 14, 1, 30, 16),
      word('b3', 'more', 33, 14, 1, 40, 16), word('b4', 'money', 43, 14, 1, 52, 16),
      word('c1', 'However', 10, 19, 2, 22, 21), word('c2', ',', 22, 19, 2, 23, 21),
      word('c3', 'students', 26, 19, 2, 38, 21), word('c4', 'learn.', 41, 19, 2, 50, 21)
    ];
    const result = buildCanonicalPageFromWords(input);
    expect(result.text).toBe('cars gives without pay more money However, students learn.');
    expect(result.text).not.toContain('cars. gives');
    expect(result.spans.map((span) => span.wordId)).toEqual(input.map((item) => item.id));
    expect(result.spans.map((span) => span.bbox)).toEqual(input.map((item) => item.bbox));
    expect(result.spans.find((span) => span.wordId === 'bridge').word.ocrLayoutSuspicious).toBe(true);
  });

  test('preserves the audited learner-English phrase order in one canonical fixture', () => {
    const lines = [
      ['there', 'are', 'a', 'big', 'problem'],
      ['every', 'student', 'cames'],
      ['Taking', 'a', 'taxis', 'is'],
      ['than', 'taken', 'private', 'cars'],
      ['cars', 'gives'],
      ['without', 'pay', 'more', 'money']
    ];
    const words = lines.flatMap((line, lineIndex) => line.map((text, wordIndex) =>
      word(`${lineIndex}-${wordIndex}`, text, 10 + wordIndex * 12, 10 + lineIndex * 4, lineIndex,
        18 + wordIndex * 12, 12 + lineIndex * 4)));
    const result = buildCanonicalPageFromWords(words);
    expect(result.text).toBe(lines.map((line) => line.join(' ')).join(' '));
    for (const line of lines) expect(result.text).toContain(line.join(' '));
  });

  test('removes repeated detached right-margin binding glyphs without leaving separator gaps', () => {
    const result = buildCanonicalPageFromWords([
      word('w1', 'Students', 10, 10, 0, 23, 12), word('w2', 'learn', 26, 10, 0, 34, 12),
      word('ring1', 'D', 95, 10, 9, 97, 12), word('ring2', 'D', 95, 14, 10, 97, 16),
      word('w3', 'through', 10, 14, 1, 21, 16), word('w4', 'practice.', 24, 14, 1, 38, 16),
      word('ring3', 'B', 95, 18, 11, 97, 20), word('ring4', '#', 96, 22, 12, 98, 24),
      word('w5', 'Revision', 10, 18, 2, 22, 20), word('w6', 'helps.', 25, 18, 2, 34, 20)
    ]);
    expect(result.text).toBe('Students learn through practice. Revision helps.');
    expect(result.text).not.toMatch(/\b[DB]\b|#/u);
    expect(result.text).not.toContain('\n\n');
    expect(result.spans.map((span) => span.wordId)).toEqual(['w1', 'w2', 'w3', 'w4', 'w5', 'w6']);
  });

  test('preserves legitimate single letters in the writing column and a lone grade at the edge', () => {
    const result = buildCanonicalPageFromWords([
      word('w1', 'Plan', 10, 10, 0), word('w2', 'B', 22, 10, 0, 24, 12), word('w3', 'is', 27, 10, 0),
      word('w4', 'clear.', 36, 10, 0), word('grade', 'D', 95, 30, 4, 97, 32)
    ]);
    expect(result.text).toContain('Plan B is clear.');
    expect(result.spans.map((span) => span.wordId)).toContain('grade');
  });

  test('uses a real blank-line-sized geometric gap for paragraphs but ordinary wraps remain spaces', () => {
    const result = buildCanonicalPageFromWords([
      word('w1', 'First', 10, 10, 0), word('w2', 'line', 20, 10, 0),
      word('w3', 'wraps.', 10, 13, 1),
      word('w4', 'New', 10, 24, 2), word('w5', 'paragraph.', 20, 24, 2)
    ]);
    expect(result.text).toBe('First line wraps.\n\nNew paragraph.');
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
    expect(new Set(result.wordSpans.map((span) => span.wordId)).size).toBe(2);
    expect(result.wordSpans.map((span) => span.wordId)).toEqual(['word_a_1_1', 'word_b_1_1']);
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
