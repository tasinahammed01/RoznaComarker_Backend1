const {
  normalizeOcrTranscript,
  buildNormalizedTranscriptFromWords
} = require('../src/utils/ocrTranscriptNormalizer');

describe('normalizeOcrTranscript', () => {
  test.each([
    ['I    am    aboy', 'I am aboy'],
    ['Artificial\t  Intelligence\t is useful.', 'Artificial Intelligence is useful.'],
    ['Hello ,  world !', 'Hello, world!'],
    ['This is a line.     This is another line.', 'This is a line. This is another line.'],
    ['First paragraph text.\n\n\n\nSecond paragraph text.', 'First paragraph text.\n\nSecond paragraph text.'],
    [' one\r\n\r\n\r\ntwo\rthree ', 'one\n\ntwo\nthree'],
    ['আমি   বাংলা ,  লিখি !', 'আমি বাংলা, লিখি!'],
    ['( hello ) [ world ]', '(hello) [world]'],
    ['', ''],
    [null, '']
  ])('normalizes %p safely', (input, expected) => {
    expect(normalizeOcrTranscript(input)).toBe(expected);
  });

  test('does not correct spelling, grammar, capitalization, or wording', () => {
    expect(normalizeOcrTranscript('i    are aboy.')).toBe('i are aboy.');
  });

  test('builds offsets against punctuation-normalized word text', () => {
    const words = [{ text: 'Hello' }, { text: ',' }, { text: 'world' }, { text: '!' }];
    const result = buildNormalizedTranscriptFromWords(words, () => false);
    expect(result.text).toBe('Hello, world!');
    expect(result.spans.map(({ start, end }) => [start, end])).toEqual([[0, 5], [5, 6], [7, 12], [12, 13]]);
  });

  test('preserves a paragraph boundary while building OCR word spans', () => {
    const words = [{ text: 'First', paragraphIndex: 1 }, { text: 'paragraph.', paragraphIndex: 1 }, { text: 'Second', paragraphIndex: 2 }];
    const result = buildNormalizedTranscriptFromWords(words, (previous, current) =>
      previous.paragraphIndex !== current.paragraphIndex ? '\n\n' : false);
    expect(result.text).toBe('First paragraph.\n\nSecond');
    expect(result.spans[2]).toMatchObject({ start: 18, end: 24, separatorBefore: '\n\n' });
  });
});
