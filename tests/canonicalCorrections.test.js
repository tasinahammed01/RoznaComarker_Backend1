jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const writing = require('../src/services/writingCorrections.service');
const canonical = require('../src/services/correctionCanonical.service');
const { normalizeOcrWordsFromStored, buildTranscriptAndSpans } = require('../src/services/ocrCorrections.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');

describe('canonical correction primitives', () => {
  test.each([
    ['MORFOLOGIK_RULE_EN_US', 'SP'], ['UPPERCASE_SENTENCE_START', 'CAP'],
    ['SUBJECT_VERB_AGREEMENT', 'AGR'], ['EN_A_VS_AN', 'ART'], ['PREPOSITION_ERROR', 'PREP']
  ])('maps LanguageTool rule %s to %s', (id, symbol) => {
    expect(writing.mapLanguageToolRule({ rule: { id, issueType: 'grammar', category: { id: 'GRAMMAR' } } }).symbol).toBe(symbol);
  });

  test('omits unknown LanguageTool rules', () => {
    expect(writing.mapLanguageToolRule({ rule: { id: 'UNKNOWN_STYLE_RULE', issueType: 'style' } })).toBeNull();
  });

  test('requires an unambiguous quotation unless occurrence is supplied', () => {
    expect(canonical.locateQuote('word then word', 'word')).toBeNull();
    expect(canonical.locateQuote('word then word', 'word', 1)).toEqual({ start: 10, end: 14 });
  });

  test('keeps multi-file word IDs unique and stable', () => {
    const stored = [{ text: 'Hello', page: 1, bbox: { x0: 1, y0: 2, x1: 5, y1: 6 } }];
    expect(normalizeOcrWordsFromStored(stored, { fileId: 'a' })[0].id).toBe('word_a_1_1');
    expect(normalizeOcrWordsFromStored(stored, { fileId: 'b' })[0].id).toBe('word_b_1_1');
    expect(normalizeOcrWordsFromStored(stored, { fileId: 'a' })[0].id).toBe('word_a_1_1');
  });

  test('maps a validated correction to every overlapping OCR box', () => {
    const words = normalizeOcrWordsFromStored([
      { text: 'Bad', page: 1, bbox: { x0: 1, y0: 2, x1: 5, y1: 6 } },
      { text: 'word', page: 1, bbox: { x0: 6, y0: 2, x1: 12, y1: 6 } }
    ], { fileId: 'f' });
    const built = buildTranscriptAndSpans(words);
    const result = canonical.normalizeCorrection({ category: 'VOCABULARY', symbol: 'WC', quotedText: 'Bad word',
      message: 'Use a precise term', suggestedText: 'Precise phrase', confidence: .8 }, built.text, built.spans, writing.defaultLegend(), 'AI');
    expect(result.wordIds).toEqual(['word_f_1_1', 'word_f_1_2']);
    expect(result.bboxList).toHaveLength(2);
  });

  test('rejects invalid symbols and counts genuine zero categories', () => {
    expect(canonical.normalizeCorrection({ category: 'CONTENT', symbol: 'FAKE', quotedText: 'x' }, 'x', [], writing.defaultLegend(), 'AI')).toBeNull();
    expect(canonical.statistics([])).toEqual({ content: 0, organization: 0, grammar: 0, vocabulary: 0, mechanics: 0, total: 0 });
  });

  test('orders all pages by uploaded file order and removes duplicate page records', () => {
    const submission = { files: ['file-a', 'file-b'], ocrPages: [
      { fileId: 'file-b', pageNumber: 1, text: 'Administrative tasks and accessibility.' },
      { fileId: 'file-a', pageNumber: 1, text: 'Opening paragraphs.' },
      { fileId: 'file-b', pageNumber: 1, text: 'duplicate must not appear' }
    ] };
    const result = buildCanonicalSubmissionTranscript(submission);
    expect(result.isComplete).toBe(true);
    expect(result.text).toBe('Opening paragraphs. Administrative tasks and accessibility.');
    expect(result.pages).toHaveLength(2);
  });

  test('does not call a first-file transcript complete when another uploaded file is missing', () => {
    const result = buildCanonicalSubmissionTranscript({ files: ['a', 'b'], ocrPages: [{ fileId: 'a', pageNumber: 1, text: 'Only first image' }] });
    expect(result.text).toBe('Only first image');
    expect(result.isComplete).toBe(false);
  });

  test('retains a valid textual correction when no safe OCR box exists', () => {
    const result = canonical.normalizeCorrection({ category: 'GRAMMAR', symbol: 'AGR', quotedText: 'students learns',
      message: 'Subject and verb do not agree', suggestedText: 'students learn', startChar: 0, endChar: 15, confidence: 1 },
    'students learns', [], writing.defaultLegend(), 'LANGUAGETOOL');
    expect(result).toMatchObject({ wordIds: [], bboxList: [], category: 'GRAMMAR', symbol: 'AGR' });
  });
});
