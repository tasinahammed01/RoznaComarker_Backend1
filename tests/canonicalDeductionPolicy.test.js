'use strict';

jest.mock('../src/models/CorrectionLegend', () => ({ findOne: jest.fn(() => ({ lean: jest.fn().mockResolvedValue(null) })) }));
const canonical = require('../src/services/correctionCanonical.service');
const { fallbackLegend } = require('../src/services/correctionLegendResolver.service');
const scoring = require('../src/services/rubricLanguageScoring.service');

const text = 'irrelevant irrelevant fragment fragment agree agree formal formal cap cap space space task task';
const spans = text.split(' ').map((word, index, words) => {
  const start = words.slice(0, index).join(' ').length + (index ? 1 : 0);
  return { wordId: `w${index}`, fileId: 'page-1', page: 1, start, end: start + word.length,
    bbox: { x: index, y: 0, w: 1, h: 1 } };
});

function correction(category, symbol, quotedText, occurrence = 0, extra = {}) {
  return canonical.normalizeCorrection({ category, symbol, quotedText, occurrence, message: 'Explain.',
    suggestedText: `${quotedText}-fixed`, confidence: 1, defaultDeduction: 999,
    appliedDeduction: 999, repetitionFactor: 999, ...extra }, text, spans, fallbackLegend(), 'AI');
}

describe('canonical legend deduction policy', () => {
  test.each([
    ['CONTENT', 'REL', 'irrelevant', 2], ['CONTENT', 'TA', 'task', 2],
    ['GRAMMAR', 'FRAG', 'fragment', 1], ['GRAMMAR', 'AGR', 'agree', 0.5],
    ['VOCABULARY', 'FORM', 'formal', 1], ['MECHANICS', 'CAP', 'cap', 0.25],
    ['MECHANICS', 'SPC', 'space', 0.25]
  ])('%s/%s receives its backend legend base deduction', (category, symbol, quote, base) => {
    const item = correction(category, symbol, quote);
    expect(item).toMatchObject({ defaultDeduction: base, appliedDeduction: base,
      repetitionFactor: 1, deductionPolicyVersion: canonical.DEDUCTION_POLICY_VERSION });
  });

  test('AI-supplied deduction fields are ignored and repetitions are bounded', () => {
    const raw = [0, 1].map((occurrence) => correction('GRAMMAR', 'AGR', 'agree', occurrence));
    const later = Array.from({ length: 12 }, (_, index) => ({ ...raw[index % 2], id: `later-${index}`,
      startChar: index * 10, endChar: index * 10 + 5, fileId: 'page-1', page: 1 }));
    const merged = canonical.mergeCanonicalCorrections({ aiCorrections: later }).corrections;
    expect(merged.slice(0, 3).map((item) => item.repetitionFactor)).toEqual([1, 0.75, 0.55]);
    expect(merged.every((item) => item.appliedDeduction >= item.defaultDeduction * 0.25)).toBe(true);
  });

  test('duplicates create no extra deduction while equal errors at different offsets remain', () => {
    const first = correction('GRAMMAR', 'AGR', 'agree', 0);
    const duplicate = { ...first, id: 'duplicate', confidence: 0.9 };
    const second = correction('GRAMMAR', 'AGR', 'agree', 1);
    const merged = canonical.mergeCanonicalCorrections({ aiCorrections: [first, duplicate, second] });
    expect(merged.corrections).toHaveLength(2);
    expect(merged.diagnostics.exactDuplicates).toBe(1);
    expect(merged.corrections.map((item) => item.startChar)).toEqual(expect.arrayContaining([first.startChar, second.startChar]));
    expect(merged.corrections.map((item) => item.appliedDeduction)).toEqual([0.5, 0.375]);
  });

  test('grammar/mechanics deduction is capped and holistic categories are not correction-scored', () => {
    const manyGrammar = Array.from({ length: 100 }, (_, index) => ({ category: 'GRAMMAR', symbol: 'FRAG',
      defaultDeduction: 1, repetitionFactor: 1, appliedDeduction: 1, id: `g${index}` }));
    expect(scoring.scoreGrammar({ corrections: manyGrammar, wordCount: 500 }).score).toBeGreaterThanOrEqual(25 * 0.25);
    expect(scoring.scoreMechanics({ corrections: manyGrammar.map((item) => ({ ...item, category: 'MECHANICS' })), wordCount: 500 }).score)
      .toBeGreaterThanOrEqual(10 * 0.25);
    expect(scoring).not.toHaveProperty('scoreContent');
    expect(scoring).not.toHaveProperty('scoreOrganization');
    expect(scoring).not.toHaveProperty('scoreVocabulary');
  });
});
