'use strict';

process.env.NODE_ENV = 'test';

const canonical = require('../src/services/correctionCanonical.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const gateway = require('../src/services/aiGateway.service');
const { fallbackLegend } = require('../src/services/correctionLegendResolver.service');

// Where a quote lands: the text from that point, so a wrong place is easy to read in a failure.
const at = (text, quote, occurrence) => { const range = canonical.locateQuote(text, quote, occurrence); return range && { start: range.start, end: range.end }; };
const nth = (text, needle, n = 0) => { let index = -1; for (let i = 0; i <= n; i += 1) index = text.indexOf(needle, index + 1); return index; };
const range = (start, quote) => ({ start, end: start + quote.length });

describe('a single-word quote counts whole-word occurrences when the raw text also contains it inside other words', () => {
  test.each([
    ['I was tired. then i slept.', 'i', 0, ' i ', 1],
    ['I sat with him and i left.', 'i', 0, ' i ', 1],
    ['we went home and we slept.', 'we', 1, ' we ', 1],
    ['my Grandfather gave the book to me.', 'the', 0, ' the ', 1],
    ['It is late and I know it.', 'I', 0, ' I ', 1],
    ['élan and él', 'él', 0, ' él', 1],
    ['In 2027 and 27 years', '27', 0, ' 27 ', 1]
  ])('%j: %j #%i is the standalone word', (text, quote, occurrence, needle, offset) => {
    expect(at(text, quote, occurrence)).toEqual(range(text.indexOf(needle) + offset, quote));
  });

  test('the same word several times in one sentence, including the start and the end of the text', () => {
    const text = 'i think i can win it and so will i';
    expect(at(text, 'i', 0)).toEqual(range(0, 'i'));
    expect(at(text, 'i', 1)).toEqual(range(8, 'i'));
    expect(at(text, 'i', 2)).toEqual(range(text.length - 1, 'i'));
  });

  test('punctuation, apostrophes and hyphens are word boundaries', () => {
    const text = 'Then i, with my friend, saw it and so did i.';
    expect(at(text, 'i', 0)).toEqual(range(5, 'i'));
    expect(at(text, 'i', 1)).toEqual(range(text.length - 2, 'i'));
    const contraction = "i think i'm right";
    expect(at(contraction, 'i', 1)).toEqual(range(8, 'i'));
    expect(at(contraction, "i'm", 0)).toEqual(range(8, "i'm"));
    const hyphen = 'a well-known writer is well liked';
    expect(at(hyphen, 'well', 1)).toEqual(range(nth(hyphen, 'well', 1), 'well'));
  });
});

describe('everything else keeps the current behaviour', () => {
  test.each([
    ['multi-word quote', 'I sat with him and i left.', 'i left', 0],
    ['multi-word quote whose first raw match starts inside a word', 'an ego home and go home', 'go home', 0],
    ['punctuation quote', 'hi , how are you ?', ' ,', 0],
    ['quote with a leading space', 'with i and i', ' i', 1],
    ['fragment inside a word (mid-word capital)', 'My brother iS tall.', 'S', 0],
    ['spelling fragment', 'I recieve it and recieved it.', 'ie', 1],
    ['every raw match is already a whole word', 'i went and i came', 'i', 1],
    ['no whole-word match exists', 'the naïve girl and her naïveté', 'naïve', 1],
    ['whole-word occurrence out of range', 'with i and with it', 'i', 2],
    ['unicode fragment', 'Straße und Maße', 'aße', 1]
  ])('%s', (_label, text, quote, occurrence) => {
    const starts = []; for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) starts.push(i);
    const expected = starts[occurrence] != null ? range(starts[occurrence], quote) : starts.length === 1 ? range(starts[0], quote) : null;
    expect(at(text, quote, occurrence)).toEqual(expected);
  });

  test('a missing quote or occurrence still fails as before', () => {
    expect(at('I sat with him.', 'you', 0)).toBeNull();
    expect(at('with i and i', 'i', 5)).toBeNull();
    expect(at('', 'i', 0)).toBeNull();
  });
});

describe('validation and grounding use the whole-word place', () => {
  const legend = semantic.compactSemanticLegend(fallbackLegend(), ['MECHANICS']);
  const finding = (symbol, quotedText, suggestedText, occurrence = 0) => ({ category: 'MECHANICS', symbol, quotedText, suggestedText,
    occurrence, confidence: 0.95, message: 'Fix it.', correctionKind: 'localized', severity: 'low', stylePreference: false });
  const spansFor = text => [...text.matchAll(/\S+/gu)].map((m, i) => ({ start: m.index, end: m.index + m[0].length, wordId: `w${i}`,
    fileId: 'f', page: 1, bbox: null, word: { text: m[0] } }));

  test('a lowercase "i" is marked on the word i, not inside "tired"', () => {
    const text = 'I was tired. then i slept.';
    const result = semantic.validateCorrections([finding('CAP', 'i', 'I')], { transcript: text, legend, spans: spansFor(text), policy: {}, transcriptComplete: true });
    expect(result.corrections[0]).toMatchObject({ startChar: 18, endChar: 19, wordIds: ['w4'] });
  });

  test('a whole-word spelling claim still has to be the whole token', () => {
    const text = 'I recieve it and recieved it.';
    const result = semantic.validateCorrections([finding('SP', 'recieve', 'receive', 0)], { transcript: text, legend, spans: spansFor(text), policy: {}, transcriptComplete: true });
    expect(result.corrections[0]).toMatchObject({ startChar: 2, endChar: 9 });
  });
});

describe('the prompt states the whole-word occurrence rule', () => {
  const prompt = model => semantic.buildSemanticRequest({ transcript: 'i went', transcriptHash: 'h', correctionModel: model }).messages[1].content;
  test.each([...gateway.CORRECTION_MODELS])('%s', model => {
    expect(prompt(model)).toMatch(/single whole word, count only whole-word matches/u);
  });
  test('versions', () => {
    expect(semantic.contractVersions(gateway.GEMINI_CORRECTION_MODEL).promptVersion).toBe('gemini-corrections-v3-whole-word-occurrence');
    expect(semantic.contractVersions(gateway.DEEPSEEK_CORRECTION_MODEL).promptVersion).toBe('deepseek-corrections-v4-whole-word-occurrence');
    expect(semantic.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-v16-whole-word-occurrence');
  });
});
