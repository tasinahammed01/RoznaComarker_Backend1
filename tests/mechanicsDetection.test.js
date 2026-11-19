'use strict';

process.env.NODE_ENV = 'test';

const canonical = require('../src/services/correctionCanonical.service');
const semantic = require('../src/services/semanticWritingCorrections.service');
const gateway = require('../src/services/aiGateway.service');
const { fallbackLegend } = require('../src/services/correctionLegendResolver.service');

const legend = semantic.compactSemanticLegend(fallbackLegend(), ['MECHANICS']);
const finding = (symbol, quotedText, suggestedText, occurrence = 0) => ({ category: 'MECHANICS', symbol, quotedText, suggestedText,
  occurrence, confidence: 0.95, message: 'Fix the mechanics.', correctionKind: 'localized', severity: 'low', stylePreference: false });
const validate = (transcript, items) => {
  try { return semantic.validateCorrections(items, { transcript, legend, spans: [], policy: {}, transcriptComplete: true }); }
  catch (error) { return { corrections: [], diagnostics: error.diagnostics }; }
};
const groundingReason = (symbol, transcript, quotedText, suggestedText) => {
  const range = canonical.locateQuote(transcript, quotedText, 0);
  return canonical.correctionGroundingReason({ symbol, quotedText, suggestedText }, transcript, [], range, null);
};

describe('spacing (SPC) findings are not mistaken for no-op corrections', () => {
  test.each([
    ['hi , how are you ?', ' ,', ','],
    ['I like apples,bananas.', ',', ', '],
    ['hi , how are you ?', 'you ?', 'you?'],
    ['I like pears.It was fun.', 'pears.It', 'pears. It']
  ])('%j: SPC %j -> %j is a real edit', (transcript, quotedText, suggestedText) => {
    expect(groundingReason('SPC', transcript, quotedText, suggestedText)).toBeNull();
    const result = validate(transcript, [finding('SPC', quotedText, suggestedText)]);
    expect(result.corrections).toHaveLength(1);
    const start = transcript.indexOf(quotedText);
    expect(result.corrections[0]).toMatchObject({ symbol: 'SPC', category: 'MECHANICS', startChar: start, endChar: start + quotedText.length });
  });

  test.each([
    ['SPC', 'hi, how are you?', 'hi,', 'hi,'],
    ['SPC', 'hi , how are you ?', ' ,', ' ,'],
    ['SPC', 'hi , how are you ?', 'you ?', 'you ?']
  ])('a genuine %s no-op (%j -> %j) is still rejected', (symbol, transcript, quotedText, suggestedText) => {
    expect(groundingReason(symbol, transcript, quotedText, suggestedText)).toBe('NO_OP_CORRECTION');
    expect(validate(transcript, [finding(symbol, quotedText, suggestedText)]).diagnostics.rejectionReasons).toEqual({ NO_OP_CORRECTION: 1 });
  });

  test('every other symbol keeps the whitespace-insensitive no-op rule', () => {
    expect(groundingReason('P', 'hi , how', ' ,', ',')).toBe('NO_OP_CORRECTION');
    expect(groundingReason('CAP', 'my  Friend', 'my  Friend', 'my Friend')).toBe('NO_OP_CORRECTION');
    expect(groundingReason('SP', 'I saw Teh cat', 'Teh', 'teh')).toBe('NO_OP_CORRECTION');
    expect(groundingReason('CAP', 'my Friend went', 'Friend', 'friend')).toBeNull();
  });
});

describe('labelled mechanics benchmark fixture', () => {
  const benchmark = require('./fixtures/mechanicsBenchmark');
  test('has 15 error, 15 correct and 7 tricky sentences plus 8 essays', () => {
    const count = group => benchmark.sentences.filter(item => item.group === group).length;
    expect([count('error'), count('correct'), count('tricky'), benchmark.essays.length]).toEqual([15, 15, 7, 8]);
    expect(new Set([...benchmark.sentences, ...benchmark.essays].map(item => item.id)).size).toBe(45);
  });
  test('every label points at the character it describes', () => {
    for (const item of [...benchmark.sentences, ...benchmark.essays]) for (const { symbol, anchor } of benchmark.anchors(item)) {
      expect(anchor).toBeGreaterThanOrEqual(0);
      expect(item.text[anchor]).toMatch(symbol === 'CAP' ? /\p{L}/u : /[ ,.;:?!]/u);
    }
    for (const item of benchmark.sentences.filter(entry => entry.group !== 'error')) expect(item.expected).toBeUndefined();
  });
});

describe('mechanics checklist in the correction prompt', () => {
  const request = (correctionModel, analysisMode = 'document', categories) => semantic.buildSemanticRequest({
    transcript: 'hi , how are you ?', transcriptHash: 'hash-1', correctionModel, analysisMode, policy: { strictness: 'friendly' },
    ...(categories ? { categories } : {}) });
  const userPrompt = (...args) => request(...args).messages[1].content;

  test.each([...gateway.CORRECTION_MODELS])('%s receives the checklist', (model) => {
    const prompt = userPrompt(model);
    expect(prompt).toMatch(/MECHANICS checklist/u);
    expect(prompt).toMatch(/standalone lowercase "i"/u);
    expect(prompt).toMatch(/lowercase letter that starts a sentence/u);
    expect(prompt).toMatch(/middle of a sentence or in the middle of a word/u);
    expect(prompt).toMatch(/space before , \. ; : \? !/u);
    expect(prompt).toMatch(/missing space after/u);
    expect(prompt).toMatch(/quote the word together with its punctuation \("hi ,"/u);
    expect(prompt).toMatch(/Clear CAP and SPC errors are never trivial refinements/u);
  });

  test('the checklist is also sent in compact recovery and audits, and only when Mechanics is reviewed', () => {
    expect(userPrompt(gateway.GEMINI_CORRECTION_MODEL, 'compact_recovery')).toMatch(/MECHANICS checklist/u);
    expect(userPrompt(gateway.GEMINI_CORRECTION_MODEL, 'zero_result_audit', ['MECHANICS'])).toMatch(/MECHANICS checklist/u);
    expect(userPrompt(gateway.GEMINI_CORRECTION_MODEL, 'document', ['GRAMMAR'])).not.toMatch(/MECHANICS checklist/u);
  });

  test('the prompt versions change with the new instructions; the schema does not', () => {
    expect(semantic.contractVersions(gateway.GEMINI_CORRECTION_MODEL)).toMatchObject({
      promptVersion: 'gemini-corrections-v2-mechanics-checklist', schemaVersion: 'semantic-corrections-v16-compact-explanations' });
    expect(semantic.contractVersions(gateway.DEEPSEEK_CORRECTION_MODEL)).toMatchObject({
      promptVersion: 'deepseek-corrections-v3-mechanics-checklist', schemaVersion: 'semantic-corrections-v16-compact-explanations' });
    expect(semantic.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-v15-mechanics-checklist');
    expect(semantic.SEMANTIC_SCHEMA_VERSION).toBe('semantic-corrections-v15-compact-symbol-map');
  });
});
