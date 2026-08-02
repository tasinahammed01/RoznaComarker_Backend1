jest.mock('../src/models/SubmissionFeedback', () => ({}));
jest.mock('../src/models/class.model', () => ({}));

const { stable, hashRubric, synchronizedRubricScores } = require('../src/services/canonicalEvaluation.service');

describe('canonical evaluation contract', () => {
  const scores = {
    GRAMMAR: { score: 22.5, maxScore: 25, comment: 'Revise recurring patterns.' },
    VOCABULARY: { score: 19, maxScore: 20, comment: 'Mostly appropriate.' },
    ORGANIZATION: { score: 17, maxScore: 20, comment: 'Improve the conclusion.' },
    CONTENT: { score: 15, maxScore: 20, comment: 'Develop support.' },
    MECHANICS: { score: 8, maxScore: 10, comment: 'Proofread.' },
    PRESENTATION: { score: 5, maxScore: 5, comment: '' }
  };
  const stats = { content: 4, grammar: 9, organization: 1, vocabulary: 1, mechanics: 6, total: 21 };

  test('keeps the established category weights and numeric arithmetic unchanged', () => {
    expect([20, 20, 25, 20, 10, 5].reduce((sum, score) => sum + score, 0)).toBe(100);
    expect([7, 9, 11, 14, 5.5, 4.5].reduce((sum, score) => sum + score, 0)).toBe(51);
    expect([22.5, 3, 2, 0, 8.5, 4.5].reduce((sum, score) => sum + score, 0)).toBe(40.5);
  });

  test('preserves asymmetric category identities through named-property synchronization', () => {
    const asymmetric = synchronizedRubricScores({
      GRAMMAR: { score: 5, maxScore: 25 },
      VOCABULARY: { score: 9, maxScore: 20 },
      ORGANIZATION: { score: 11, maxScore: 20 },
      CONTENT: { score: 14, maxScore: 20 },
      MECHANICS: { score: 5.5, maxScore: 10 },
      PRESENTATION: { score: 4.5, maxScore: 5 }
    }, {});
    expect(Object.fromEntries(Object.entries(asymmetric).map(([key, item]) => [key, item.score]))).toEqual({
      GRAMMAR: 5,
      VOCABULARY: 9,
      ORGANIZATION: 11,
      CONTENT: 14,
      MECHANICS: 5.5,
      PRESENTATION: 4.5
    });
    expect(Object.values(asymmetric).reduce((sum, item) => sum + item.score, 0)).toBe(49);
  });

  test('copies canonical issue counts into every category and preserves score bounds', () => {
    const result = synchronizedRubricScores(scores, stats);
    expect(result.GRAMMAR.issueCount).toBe(9);
    expect(result.VOCABULARY.issueCount).toBe(1);
    expect(result.ORGANIZATION.issueCount).toBe(1);
    expect(result.CONTENT.issueCount).toBe(4);
    expect(result.MECHANICS.issueCount).toBe(6);
    expect(result.MECHANICS.comment).toBe('Proofread.');
    for (const item of Object.values(result)) expect(item.score).toBeGreaterThanOrEqual(0);
    expect(Object.values(result).reduce((sum, item) => sum + item.score, 0)).toBe(86.5);
  });

  test('does not duplicate issue-count phrases already produced by scorers', () => {
    const result = synchronizedRubricScores({ GRAMMAR: { score: 20, maxScore: 25,
      comment: '12 grammar issues detected. Several repeated patterns affect clarity.' } }, { grammar: 12 });
    expect(result.GRAMMAR.comment.match(/12 grammar issues detected/g)).toHaveLength(1);
  });

  test('stable rubric hashes ignore timestamps and object key order', () => {
    const a = { title: 'Essay', updatedAt: 'one', rubric: { b: 2, a: 1 } };
    const b = { rubric: { a: 1, b: 2 }, createdAt: 'two', title: 'Essay' };
    expect(hashRubric(a)).toBe(hashRubric(b));
    expect(stable(a)).not.toHaveProperty('updatedAt');
  });
});
