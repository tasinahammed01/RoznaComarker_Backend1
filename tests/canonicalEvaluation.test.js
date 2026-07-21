jest.mock('../src/models/SubmissionFeedback', () => ({}));
jest.mock('../src/models/class.model', () => ({}));
jest.mock('../src/services/writingAssessment.service', () => ({ buildWritingAssessment: jest.fn() }));

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

  test('copies canonical issue counts into every category and preserves score bounds', () => {
    const result = synchronizedRubricScores(scores, stats);
    expect(result.GRAMMAR.issueCount).toBe(9);
    expect(result.VOCABULARY.issueCount).toBe(1);
    expect(result.ORGANIZATION.issueCount).toBe(1);
    expect(result.CONTENT.issueCount).toBe(4);
    expect(result.MECHANICS.issueCount).toBe(6);
    expect(result.MECHANICS.comment).toContain('6 mechanics issues detected');
    for (const item of Object.values(result)) expect(item.score).toBeGreaterThanOrEqual(0);
    expect(Object.values(result).reduce((sum, item) => sum + item.score, 0)).toBe(86.5);
  });

  test('stable rubric hashes ignore timestamps and object key order', () => {
    const a = { title: 'Essay', updatedAt: 'one', rubric: { b: 2, a: 1 } };
    const b = { rubric: { a: 1, b: 2 }, createdAt: 'two', title: 'Essay' };
    expect(hashRubric(a)).toBe(hashRubric(b));
    expect(stable(a)).not.toHaveProperty('updatedAt');
  });
});
