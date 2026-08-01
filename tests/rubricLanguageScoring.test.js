const { scoreGrammar, scoreMechanics, scoringAudit } = require('../src/services/rubricLanguageScoring.service');

const issues = (category, count, symbol = category === 'GRAMMAR' ? 'AGR' : 'P') =>
  Array.from({ length: count }, (_, i) => { const factor = [1, .75, .55][i] ?? Math.max(.25, .55 * Math.pow(.78, i - 2));
    return { id: `${category}-${i}`, category, symbol, quotedText: `q${i}`, confidence: 1,
      defaultDeduction: 1.35, repetitionFactor: factor, appliedDeduction: 1.35 * factor }; });

describe('v2 language rubric scoring', () => {
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
