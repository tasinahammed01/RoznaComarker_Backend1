'use strict';

process.env.NODE_ENV = 'test';

const logger = require('../src/utils/logger');
const semantic = require('../src/services/semanticWritingCorrections.service');
const { fallbackLegend } = require('../src/services/correctionLegendResolver.service');

const legend = semantic.compactSemanticLegend(fallbackLegend(), ['MECHANICS']);
const finding = (symbol, quotedText, suggestedText, extra = {}) => ({ category: 'MECHANICS', symbol, quotedText, suggestedText, occurrence: 0,
  confidence: 0.95, message: 'Fix it.', correctionKind: 'localized', severity: 'low', stylePreference: false, ...extra });
const spansFor = text => [...text.matchAll(/\S+/gu)].map((m, i) => ({ start: m.index, end: m.index + m[0].length, wordId: `w${i}`,
  fileId: 'f', page: 1, bbox: null, word: { text: m[0] } }));
const validate = (transcript, items, sourceKind) => {
  try { return semantic.validateCorrections(items, { transcript, legend, spans: spansFor(transcript), policy: {}, transcriptComplete: true,
    ...(sourceKind ? { sourceKind } : {}) }); }
  catch (error) { return { corrections: [], diagnostics: error.diagnostics, error }; }
};
beforeEach(() => { jest.spyOn(logger, 'warn').mockImplementation(() => {}); jest.spyOn(logger, 'info').mockImplementation(() => {}); });
afterEach(() => jest.restoreAllMocks());

const essay = 'Kids these days , want more. They feel less happy a bout what they have .We know relation ships matter alot.';

describe('exact-source essays: a gap between letters inside a word is handwriting, not a spacing error', () => {
  test.each([
    ['a bout', 'about'],
    ['relation ships', 'relationships'],
    ['a bout what', 'about what']
  ])('SPC %j -> %j is rejected as HANDWRITING_LETTER_GAP', (quote, fix) => {
    const result = validate(essay, [finding('SPC', quote, fix)], 'exact_source');
    expect(result.error).toBeUndefined();
    expect(result.corrections).toEqual([]);
    expect(result.diagnostics.rejectionReasons).toEqual({ HANDWRITING_LETTER_GAP: 1 });
  });

  test.each([
    ['SPC', 'days ,', 'days,'],
    ['SPC', 'have .We', 'have. We'],
    ['SPC', 'alot', 'a lot'],
    ['CAP', 'Kids', 'kids']
  ])('%s %j -> %j still flags', (symbol, quote, fix) => {
    const text = symbol === 'CAP' ? 'We saw how Kids these days want more.' : essay;
    const result = validate(text, [finding(symbol, quote, fix)], 'exact_source');
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ symbol, quotedText: quote });
  });

  test.each([
    ['They like relation ships , and more.', 'relation ships ,', 'relationships,'],
    ['We ran a bout. Then we slept.', 'a bout. Then', 'about.Then']
  ])('a quote mixing a letter gap with a space next to punctuation still flags: %j', (text, quote, fix) => {
    const result = validate(text, [finding('SPC', quote, fix)], 'exact_source');
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ symbol: 'SPC', quotedText: quote });
  });

  test('punctuation spacing next to a letter gap is still flagged', () => {
    const text = 'I like apples,bananas and pears.';
    expect(validate(text, [finding('SPC', 'apples,bananas', 'apples, bananas')], 'exact_source').corrections).toHaveLength(1);
  });

  test('only SPC is affected: the same letter-gap edit under another symbol is unchanged', () => {
    const result = validate(essay, [finding('P', 'a bout', 'about')], 'exact_source');
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ symbol: 'P', quotedText: 'a bout' });
  });

  test('a reply whose only findings are letter gaps is zero findings, not a failed reply', () => {
    const result = validate(essay, [finding('SPC', 'a bout', 'about'), finding('SPC', 'relation ships', 'relationships')], 'exact_source');
    expect(result.error).toBeUndefined();
    expect(result.corrections).toEqual([]);
    expect(result.diagnostics.allFindingsRejected).toEqual({ benign: true, reasons: { HANDWRITING_LETTER_GAP: 2 } });
  });

  test('a letter gap mixed with a structural rejection still fails as before', () => {
    const result = validate(essay, [finding('SPC', 'a bout', 'about'), finding('SPC', 'not in text', 'x')], 'exact_source');
    expect(result.error).toMatchObject({ code: 'SEMANTIC_SCHEMA_INVALID' });
  });
});

describe('without sourceKind (typed text, benchmarks, older callers) nothing changes', () => {
  test.each([[undefined], ['unknown']])('sourceKind %p: "a bout" -> "about" is still accepted', (sourceKind) => {
    const result = validate(essay, [finding('SPC', 'a bout', 'about')], sourceKind);
    expect(result.corrections).toHaveLength(1);
    expect(result.corrections[0]).toMatchObject({ symbol: 'SPC', quotedText: 'a bout' });
  });
});

describe('the pipeline marks exact-source essays and the analysis passes it to the validator', () => {
  test('canonicalCorrectionsPipeline derives sourceKind from sourceFidelityMode', () => {
    const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
    expect(pipeline.correctionSourceKind({ sourceFidelityMode: 'gpt_vision_exact' })).toBe('exact_source');
    expect(pipeline.correctionSourceKind({ sourceFidelityMode: 'astra_verified' })).toBe('exact_source');
    expect(pipeline.correctionSourceKind({ sourceFidelityMode: 'astra_human_confirm' })).toBe('exact_source');
    expect(pipeline.correctionSourceKind({})).toBeUndefined();
    expect(pipeline.correctionSourceKind({ sourceFidelityMode: 'legacy' })).toBeUndefined();
  });

  test('end to end through the coordinator: exact-source drops the letter gap, no sourceKind keeps it', async () => {
    const wire = require('../src/services/compactCorrectionWire.service');
    const coordinator = require('../src/services/semanticCorrectionCoordinator.service');
    const { reviewPayload, finding: reviewFinding } = require('./helpers/astraAssessmentFixtures.cjs');
    const model = 'google/gemini-3.8-flash';
    const env = { OPENROUTER_API_KEY: 'mock-only', CORRECTION_DETECTION_MODEL: model, ASSESSMENT_AI_PRIMARY_RETRIES: '0' };
    const text = 'They feel less happy a bout what they have.';
    const payload = () => { const v = reviewPayload('synthetic', undefined, [reviewFinding('MECHANICS', 'SPC', 'a bout', { suggestedText: 'about' }),
      reviewFinding('MECHANICS', 'SPC', 'have.', { suggestedText: 'have .', confidence: 0.5 })]);
      return { reviewContract: wire.EXPLANATION_VERSION, transcriptHash: 'synthetic', categories: Object.fromEntries(Object.entries(v.categories).map(([k, r]) => [k,
        { reviewed: true, reviewedSymbols: Object.fromEntries(r.reviewedSymbols.map(s => [s, true])),
          corrections: r.corrections.map(item => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'stylePreference'))) }])) }; };
    const response = () => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ model,
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(payload()) } }], usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }) });
    const run = sourceKind => coordinator.analyze({ transcript: text, transcriptHash: 'synthetic', transcriptComplete: true, spans: spansFor(text),
      deadlineAt: Date.now() + 120000, submissionId: 'gap-test', ...(sourceKind ? { sourceKind } : {}) }, { env, fetchImpl: jest.fn(async () => response()) });
    const exact = await run('exact_source');
    expect(exact.corrections).toEqual([]);
    expect(exact.diagnostics.allFindingsRejected).toEqual({ benign: true, reasons: { HANDWRITING_LETTER_GAP: 1, LOW_CONFIDENCE: 1 } });
    const typed = await run();
    expect(typed.corrections.map(c => c.quotedText)).toEqual(['a bout']);
  });
});
