const { scoreGrammar, scoreMechanics, scoringAudit } = require('../src/services/rubricLanguageScoring.service');

const issues = (category, count, symbol = category === 'GRAMMAR' ? 'AGR' : 'P') =>
  Array.from({ length: count }, (_, i) => { const factor = [1, .75, .55][i] ?? Math.max(.25, .55 * Math.pow(.78, i - 2));
    return { id: `${category}-${i}`, category, symbol, quotedText: `q${i}`, confidence: 1,
      defaultDeduction: 1.35, repetitionFactor: factor, appliedDeduction: 1.35 * factor }; });

describe('v2 language rubric scoring', () => {
  const spelling = (id, ocrSuspect = false) => ({
    id, category: 'MECHANICS', symbol: 'SP', suggestedText: 'correct',
    defaultDeduction: 0.5, repetitionFactor: 1, appliedDeduction: 0.5, ocrSuspect
  });

  test('trusted spelling affects Mechanics while an OCR-suspect spelling remains score-neutral', () => {
    const trusted = scoreMechanics({ corrections: [spelling('trusted')], wordCount: 200 });
    const suspect = scoreMechanics({ corrections: [spelling('suspect', true)], wordCount: 200 });
    expect(trusted.score).toBeLessThan(10);
    expect(suspect.score).toBe(10);
    const audit = scoringAudit({ corrections: [spelling('suspect', true)],
      category: 'MECHANICS', maxScore: 10, wordCount: 200 });
    expect(audit).toMatchObject({
      totalIssueCount: 1, countedIssueCount: 0, ignoredIssueCount: 1,
      ignoredReasons: { OCR_SUSPECT: 1 }, finalScore: 10,
      ignoredCorrectionIds: ['suspect']
    });
  });

  test('mixed trusted and OCR-suspect corrections count only trusted corrections', () => {
    const corrections = [spelling('trusted-1'), spelling('suspect-1', true), spelling('trusted-2')];
    const audit = scoringAudit({ corrections, category: 'MECHANICS', maxScore: 10, wordCount: 200 });
    expect(audit).toMatchObject({
      totalIssueCount: 3, countedIssueCount: 2, ignoredIssueCount: 1,
      correctionIds: ['trusted-1', 'trusted-2'], ignoredCorrectionIds: ['suspect-1']
    });
    expect(audit.finalScore).toBe(scoreMechanics({ corrections, wordCount: 200 }).score);
  });

  test('17 Mechanics corrections with 7 OCR-suspect score only the 10 trusted issues', () => {
    const corrections = Array.from({ length: 17 }, (_, index) => ({
      ...spelling(`sp-${index}`, index >= 10),
      suggestedText: `correct-${index}`
    }));
    const audit = scoringAudit({ corrections, category: 'MECHANICS', maxScore: 10,
      wordCount: 300, strictness: 'balanced' });
    expect(audit).toMatchObject({
      totalIssueCount: 17, countedIssueCount: 10, ignoredIssueCount: 7,
      basePenalty: 5, repetitionAdjustedPenalty: 5, finalScore: 6
    });
    expect(audit.cappedDeduction).toBeCloseTo(4.14, 10);
    expect(audit.unroundedScore).toBeCloseTo(5.86, 10);
  });

  test('OCR-neutral scoring remains monotonic across teacher strictness and bounded by category maximum', () => {
    const corrections = [spelling('trusted'), spelling('suspect', true)];
    const scores = ['friendly', 'balanced', 'strict'].map((strictness) =>
      scoreMechanics({ corrections, wordCount: 200, strictness }).score);
    expect(scores[0]).toBeGreaterThanOrEqual(scores[1]);
    expect(scores[1]).toBeGreaterThanOrEqual(scores[2]);
    for (const score of scores) expect(score).toBeGreaterThanOrEqual(0);
    for (const score of scores) expect(score).toBeLessThanOrEqual(10);
  });

  test('more errors never produce a higher score for equal word count', () => {
    const low = scoreGrammar({ corrections: issues('GRAMMAR', 2), wordCount: 500 });
    const high = scoreGrammar({ corrections: issues('GRAMMAR', 12), wordCount: 500 });
    expect(high.score).toBeLessThanOrEqual(low.score);
  });

  test('nonzero language issues cannot receive unconditional perfect scores', () => {
    expect(scoreGrammar({ corrections: issues('GRAMMAR', 1), wordCount: 946 }).score).toBeLessThan(25);
    expect(scoreMechanics({ corrections: issues('MECHANICS', 1), wordCount: 946 }).score).toBeLessThan(10);
  });

  test('grammar comment with 12 issues is not no-errors wording', () => {
    const result = scoreGrammar({ corrections: issues('GRAMMAR', 12), wordCount: 946 });
    expect(result.comment).toContain('12 grammar issues detected');
    expect(result.comment).not.toMatch(/no errors/i);
  });

  test('mechanics comment with 20 issues is not very-few-errors wording', () => {
    const result = scoreMechanics({ corrections: issues('MECHANICS', 20), wordCount: 946 });
    expect(result.comment).toContain('20 mechanics issues detected');
    expect(result.comment).not.toMatch(/very few errors/i);
  });

  test('same-symbol repeated patterns receive diminishing but nonzero penalties', () => {
    const repeated = issues('GRAMMAR', 15, 'AGR');
    const audit = scoringAudit({ corrections: repeated, category: 'GRAMMAR', maxScore: 25, wordCount: 600 });
    expect(audit.groups).toHaveLength(1);
    expect(audit.weightedPenalty).toBeGreaterThan(1.35 * 3);
    expect(audit.weightedPenalty).toBeLessThan(1.35 * 15);
  });

  test('same symbol corrections are grouped by pattern in AI-only pipeline', () => {
    // In AI-only pipeline, corrections are grouped by symbol, not by rule ID
    const corrections = issues('GRAMMAR', 15, 'AGR');
    const audit = scoringAudit({ corrections, category: 'GRAMMAR', maxScore: 25, wordCount: 600 });
    expect(audit.groups).toHaveLength(1);
    expect(audit.groups[0].symbol).toBe('AGR');
    expect(audit.groups[0].count).toBe(15);
  });

  test('accepted provider confidence does not change score deductions', () => {
    const low = issues('GRAMMAR', 4).map((item) => ({ ...item, confidence: 0.85 }));
    const high = issues('GRAMMAR', 4).map((item) => ({ ...item, confidence: 1 }));
    expect(scoreGrammar({ corrections: low, wordCount: 500 }))
      .toEqual(scoreGrammar({ corrections: high, wordCount: 500 }));
  });
});
