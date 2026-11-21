'use strict';

const scoring = require('../src/services/rubricLanguageScoring.service');
const { mergeCanonicalCorrections } = require('../src/services/correctionCanonical.service');

// Findings shaped like merged canonical corrections: distinct fixes, so each repetition factor is 1.
const finding = (symbol, i, extra = {}) => ({ id: `${symbol}-${i}`, category: 'MECHANICS', symbol, quotedText: `w${i} ,`,
  suggestedText: `${symbol.toLowerCase()}-fix-${i}`, defaultDeduction: symbol === 'SP' || symbol === 'P' ? 0.5 : 0.25,
  repetitionFactor: 1, appliedDeduction: symbol === 'SP' || symbol === 'P' ? 0.5 : 0.25, ...extra });
const many = (symbol, count) => Array.from({ length: count }, (_, i) => finding(symbol, i));
const scores = (corrections, exactSource) => ['friendly', 'balanced', 'strict']
  .map(strictness => scoring.scoreMechanics({ corrections, wordCount: 250, strictness, exactSource }).score);

describe('exact-source spacing penalty cap', () => {
  test('the audit version is bumped and the cap is 1.5', () => {
    expect(scoring.SCORING_AUDIT_VERSION).toBe('canonical-scoring-audit-v2');
    expect(scoring.EXACT_SOURCE_SPACING_PENALTY_CAP).toBe(1.5);
  });

  test('20 SPC + 3 CAP: capped on exact-source essays, unchanged otherwise (simulation table row 1)', () => {
    const corrections = [...many('SPC', 20), ...many('CAP', 3)];
    expect(scores(corrections, true)).toEqual([9.5, 9, 7.5]);
    expect(scores(corrections, false)).toEqual([8, 6, 3.5]);
    expect(scores(corrections, undefined)).toEqual([8, 6, 3.5]);
  });

  test('simulation rows 2 to 4 with the 1.5 cap', () => {
    expect(scores([...many('SPC', 20), ...many('CAP', 3), ...many('SP', 5)], true)).toEqual([8.5, 7, 4.5]);
    expect(scores([...many('SPC', 20), ...many('CAP', 3), ...many('SP', 10)], true)).toEqual([7, 5, 2]);
    expect(scores(many('SPC', 6), true)).toEqual([9.5, 9.5, 8.5]);
  });

  test('a spacing penalty at or below the cap is not changed', () => {
    for (const n of [1, 2, 6]) {
      expect(scoring.scoreFromWeightedIssues({ corrections: many('SPC', n), category: 'MECHANICS', maxScore: 10, wordCount: 250,
        strictness: 'strict', exactSource: true })).toEqual(scoring.scoreFromWeightedIssues({ corrections: many('SPC', n),
        category: 'MECHANICS', maxScore: 10, wordCount: 250, strictness: 'strict' }));
    }
    expect(scoring.weightedIssuePenalty(many('SPC', 6), 'MECHANICS', { exactSource: true })).toBe(1.5);
    expect(scoring.weightedIssuePenalty(many('SPC', 7), 'MECHANICS', { exactSource: true })).toBe(1.5);
    expect(scoring.weightedIssuePenalty(many('SPC', 7), 'MECHANICS')).toBe(1.75);
  });

  test('CAP and other symbols are never capped', () => {
    expect(scoring.weightedIssuePenalty(many('CAP', 20), 'MECHANICS', { exactSource: true })).toBe(5);
    expect(scores(many('CAP', 20), true)).toEqual(scores(many('CAP', 20), false));
    expect(scores(many('SP', 10), true)).toEqual(scores(many('SP', 10), false));
  });

  test('the cap applies to the penalty after repetition factors, before tolerance and multiplier', () => {
    const repeated = mergeCanonicalCorrections({ aiCorrections: Array.from({ length: 20 }, (_, i) => ({ id: `r${i}`,
      category: 'MECHANICS', symbol: 'SPC', quotedText: 'a ,', suggestedText: 'a,', startChar: i * 10, endChar: i * 10 + 3,
      message: 'm', confidence: 1, defaultDeduction: 0.25 })) }).corrections;
    expect(repeated.map(c => c.repetitionFactor).slice(0, 3)).toEqual([1, 0.75, 0.55]);
    const raw = scoring.weightedIssuePenalty(repeated, 'MECHANICS');
    expect(raw).toBeGreaterThan(1.5);
    expect(scoring.weightedIssuePenalty(repeated, 'MECHANICS', { exactSource: true })).toBe(1.5);
    const strict = scoring.scoreFromWeightedIssues({ corrections: repeated, category: 'MECHANICS', maxScore: 10, wordCount: 250,
      strictness: 'strict', exactSource: true });
    expect(strict.cappedDeduction).toBeCloseTo(1.5 * 1.15, 10);
  });

  test('OCR-suspect spacing findings stay ignored and do not use up the cap', () => {
    const corrections = [...many('SPC', 8).map(c => ({ ...c, id: `suspect-${c.id}`, ocrSuspectForScoring: true })), ...many('SPC', 2)];
    expect(scoring.weightedIssuePenalty(corrections, 'MECHANICS', { exactSource: true })).toBe(0.5);
    expect(scoring.scoringAudit({ corrections, category: 'MECHANICS', maxScore: 10, wordCount: 250, exactSource: true }).spacingPenaltyCap)
      .toEqual({ cap: 1.5, rawPenalty: 0.5, cappedPenalty: 0.5 });
  });

  test('GRAMMAR is untouched even if a stray SPC symbol is in that category', () => {
    const stray = many('SPC', 20).map(c => ({ ...c, category: 'GRAMMAR' }));
    expect(scoring.weightedIssuePenalty(stray, 'GRAMMAR', { exactSource: true })).toBe(5);
  });

  test('the audit records the raw and capped spacing penalty and agrees with the score', () => {
    const corrections = [...many('SPC', 20), ...many('CAP', 3)];
    for (const strictness of ['friendly', 'balanced', 'strict']) {
      const audit = scoring.scoringAudit({ corrections, category: 'MECHANICS', maxScore: 10, wordCount: 250, strictness, exactSource: true });
      expect(audit.finalScore).toBe(scoring.scoreMechanics({ corrections, wordCount: 250, strictness, exactSource: true }).score);
      expect(audit).toMatchObject({ repetitionAdjustedPenalty: 5.75, weightedPenalty: 2.25,
        spacingPenaltyCap: { cap: 1.5, rawPenalty: 5, cappedPenalty: 1.5 } });
    }
    const typed = scoring.scoringAudit({ corrections, category: 'MECHANICS', maxScore: 10, wordCount: 250 });
    expect(typed).not.toHaveProperty('spacingPenaltyCap');
    expect(typed.weightedPenalty).toBe(typed.repetitionAdjustedPenalty);
    const grammar = scoring.scoringAudit({ corrections, category: 'GRAMMAR', maxScore: 25, wordCount: 250, exactSource: true });
    expect(grammar).not.toHaveProperty('spacingPenaltyCap');
  });
});
