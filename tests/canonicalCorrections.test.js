jest.mock('../src/services/languageTool.service', () => ({ checkTextWithLanguageTool: jest.fn() }));
jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));

const writing = require('../src/services/writingCorrections.service');
const { checkTextWithLanguageTool } = require('../src/services/languageTool.service');
const canonical = require('../src/services/correctionCanonical.service');
const { normalizeOcrWordsFromStored, buildTranscriptAndSpans } = require('../src/services/ocrCorrections.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const realRuleMetadata = require('./fixtures/languageToolRuleMetadata');

describe('canonical correction primitives', () => {
  test.each([
    ['MORFOLOGIK_RULE_EN_US', 'SP'], ['UPPERCASE_SENTENCE_START', 'CAP'],
    ['SUBJECT_VERB_AGREEMENT', 'AGR'], ['EN_A_VS_AN', 'ART'], ['PREPOSITION_ERROR', 'PREP']
  ])('maps LanguageTool rule %s to %s', (id, symbol) => {
    expect(writing.mapLanguageToolRule({ rule: { id, issueType: 'grammar', category: { id: 'GRAMMAR' } } }).symbol).toBe(symbol);
  });

  test('omits unknown LanguageTool rules', () => {
    expect(writing.mapLanguageToolRule({ rule: { id: 'UNKNOWN_STYLE_RULE', issueType: 'style' } }))
      .toMatchObject({ accepted: false, reason: 'UNSUPPORTED_LANGUAGETOOL_RULE' });
  });

  test.each(realRuleMetadata)('classifies captured metadata: $name', ({ rule, expected }) => {
    expect(writing.mapLanguageToolRule({ rule })).toMatchObject({
      accepted: true, category: expected[0], symbol: expected[1]
    });
  });

  test('exact rule mapping wins over misleading misspelling issueType', () => {
    expect(writing.mapLanguageToolRule({ rule: {
      id: 'EN_UPPER_CASE_NGRAM', category: { id: 'TYPOS' }, issueType: 'misspelling'
    } })).toMatchObject({ category: 'MECHANICS', symbol: 'CAP', reason: 'EXACT_RULE_OVERRIDE' });
  });

  test('unknown grammar rule is explicitly rejected instead of defaulting to mechanics', () => {
    expect(writing.mapLanguageToolRule({ rule: {
      id: 'NEW_UNKNOWN_GRAMMAR_RULE', category: { id: 'GRAMMAR' }, issueType: 'grammar'
    } })).toMatchObject({ accepted: false, reason: 'UNSUPPORTED_LANGUAGETOOL_RULE' });
  });

  test('safe diagnostics expose accepted/dropped aggregates without student text', () => {
    const privateText = 'Private student sentence';
    const diagnostics = writing.languageToolDiagnostics(privateText, { matches: [
      { offset: 0, length: 7, rule: { id: 'EN_UPPER_CASE_NGRAM', category: { id: 'CASING' }, issueType: 'misspelling' } },
      { offset: 8, length: 7, rule: { id: 'UNKNOWN_GRAMMAR', category: { id: 'GRAMMAR' }, issueType: 'grammar' } }
    ] }, writing.defaultLegend());
    expect(diagnostics).toMatchObject({
      rawMatches: 2, accepted: 1, dropped: 1,
      byFinalClassification: { 'MECHANICS/CAP': 1 },
      dropReasons: { UNSUPPORTED_LANGUAGETOOL_RULE: 1 },
      droppedGrammarRuleIds: ['UNKNOWN_GRAMMAR']
    });
    expect(JSON.stringify(diagnostics)).not.toContain(privateText);
  });

  test('check preserves classifier provenance and returns safe aggregate counts', async () => {
    checkTextWithLanguageTool.mockResolvedValueOnce({ matches: [{
      offset: 12, length: 4, message: 'Use lowercase here.', replacements: [{ value: 'show' }],
      rule: { id: 'EN_UPPER_CASE_NGRAM', category: { id: 'CASING', name: 'Capitalization' }, issueType: 'misspelling' }
    }] });
    const result = await writing.check({ text: 'The results Show improvement.', language: 'en-US' });
    expect(result.issues[0]).toMatchObject({
      groupKey: 'MECHANICS', symbol: 'CAP', classificationReason: 'EXACT_RULE_OVERRIDE',
      languageToolRuleId: 'EN_UPPER_CASE_NGRAM', languageToolCategoryId: 'CASING',
      languageToolMappingVersion: writing.LANGUAGE_TOOL_MAPPING_VERSION
    });
    expect(result.diagnostics).toMatchObject({
      rawMatches: 1, accepted: 1, dropped: 0, byFinalClassification: { 'MECHANICS/CAP': 1 }
    });
  });

  test.each([
    ['PUNCTUATION_RULE', 'PUNCTUATION', 'uncategorized', 'MECHANICS', 'P'],
    ['WHITESPACE_RULE', 'TYPOGRAPHY', 'typographical', 'MECHANICS', 'SPC'],
    ['TENSE_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'T'],
    ['ARTICLE_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'ART'],
    ['PREPOSITION_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'PREP'],
    ['WORD_ORDER_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'WO'],
    ['SENTENCE_FRAGMENT_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'FRAG'],
    ['COMMA_SPLICE_ERROR', 'GRAMMAR', 'grammar', 'GRAMMAR', 'RO'],
    ['COLLOCATION_RULE', 'COLLOCATIONS', 'style', 'VOCABULARY', 'COL'],
    ['INFORMALITY', 'STYLE', 'style', 'VOCABULARY', 'FORM'],
    ['REPEAT_RULE', 'REDUNDANCY', 'duplication', 'VOCABULARY', 'REP']
  ])('applies reviewed taxonomy policy for %s', (id, categoryId, issueType, category, symbol) => {
    const decision = writing.mapLanguageToolRule({ rule: { id, category: { id: categoryId }, issueType } });
    expect(decision).toMatchObject({ accepted: true, category, symbol });
    expect(writing.mapLanguageToolRule({ rule: { id, category: { id: categoryId }, issueType } })).toEqual(decision);
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
