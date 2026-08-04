const policyService = require('../src/services/teacherEvaluationPolicy.service');
const scoring = require('../src/services/rubricLanguageScoring.service');

const corrections = [
  { category: 'GRAMMAR', symbol: 'AGR', defaultDeduction: 1, repetitionFactor: 1 },
  { category: 'GRAMMAR', symbol: 'AGR', defaultDeduction: 1, repetitionFactor: 1 },
  { category: 'GRAMMAR', symbol: 'T', defaultDeduction: 2, repetitionFactor: 1 }
];

describe('teacher evaluation policy', () => {
  test('balanced policy and checks are the default', () => {
    expect(policyService.normalizeTeacherEvaluationPolicy(null)).toEqual({
      strictness: 'balanced',
      checks: { grammarSpelling: true, coherenceLogic: true, factChecking: false }
    });
  });

  test('changing strictness changes the stable policy hash', () => {
    expect(policyService.evaluationPolicyHash({ strictness: 'friendly' }))
      .not.toBe(policyService.evaluationPolicyHash({ strictness: 'balanced' }));
  });

  test('friendly >= balanced >= strict and scores remain within category maximum', () => {
    const score = (strictness) => scoring.scoreGrammar({ corrections, wordCount: 120, strictness }).score;
    expect(score('friendly')).toBeGreaterThanOrEqual(score('balanced'));
    expect(score('balanced')).toBeGreaterThanOrEqual(score('strict'));
    for (const strictness of ['friendly', 'balanced', 'strict']) {
      expect(score(strictness)).toBeGreaterThanOrEqual(0);
      expect(score(strictness)).toBeLessThanOrEqual(scoring.RUBRIC_MAX.GRAMMAR);
    }
  });

  test('semantic deductions are policy-scaled rather than receiving a flat bonus', () => {
    const evidence = { score: 12, maxScore: 20, comment: 'Grounded assessment.' };
    const friendly = scoring.applySemanticStrictness(evidence, 'friendly').score;
    const balanced = scoring.applySemanticStrictness(evidence, 'balanced').score;
    const strict = scoring.applySemanticStrictness(evidence, 'strict').score;
    expect(friendly).toBeGreaterThanOrEqual(balanced);
    expect(strict).toBeLessThanOrEqual(balanced);
    expect(scoring.applySemanticStrictness({ ...evidence, score: 20 }, 'friendly').score).toBe(20);
  });

  test('disabled grammar and coherence checks remove only their relevant evidence', () => {
    const all = [...corrections, { category: 'MECHANICS', defaultDeduction: 1 },
      { category: 'ORGANIZATION', defaultDeduction: 1 }, { category: 'CONTENT', defaultDeduction: 1 }];
    const filtered = policyService.correctionsAllowedByPolicy(all, {
      checks: { grammarSpelling: false, coherenceLogic: false, factChecking: false }
    });
    expect(filtered.map((item) => item.category)).toEqual(['CONTENT']);
    expect(scoring.scoreGrammar({ corrections, wordCount: 120, enabled: false }).score)
      .toBe(scoring.RUBRIC_MAX.GRAMMAR);
  });
});
