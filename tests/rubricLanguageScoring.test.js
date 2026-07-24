const { scoreGrammar, scoreMechanics } = require('../src/services/rubricLanguageScoring.service');

const issues = (category, count, symbol = category === 'GRAMMAR' ? 'AGR' : 'P') =>
  Array.from({ length: count }, (_, i) => ({ id: `${category}-${i}`, category, symbol, quotedText: `q${i}`, confidence: 1 }));

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
});
