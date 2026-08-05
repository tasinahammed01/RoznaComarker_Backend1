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

  test('uses the v2 policy thresholds while leaving strict unchanged', () => {
    expect(policyService.SCORING_POLICY_VERSION).toBe('teacher-evaluation-policy-v2');
    expect(scoring.STRICTNESS_THRESHOLDS).toEqual({
      friendly: { multiplier: 0.60, lowImpactTolerance: 2.0, maxDeductionRatio: 0.35 },
      balanced: { multiplier: 0.80, lowImpactTolerance: 1.0, maxDeductionRatio: 0.50 },
      strict: { multiplier: 1.15, lowImpactTolerance: 0, maxDeductionRatio: 0.78 }
    });
  });

  test.each([
    ['friendly', 24, 9],
    ['balanced', 22.5, 7.5],
    ['strict', 20.5, 5.5]
  ])('calculates exact Grammar and Mechanics scores in %s mode', (strictness, grammar, mechanics) => {
    expect(scoring.scoreGrammar({ corrections, wordCount: 120, strictness }).score).toBe(grammar);
    const mechanicsCorrections = corrections.map((item) => ({ ...item, category: 'MECHANICS' }));
    expect(scoring.scoreMechanics({ corrections: mechanicsCorrections, wordCount: 120, strictness }).score)
      .toBe(mechanics);
  });

  test.each([
    ['CONTENT', 'friendly', 15],
    ['CONTENT', 'balanced', 13],
    ['CONTENT', 'strict', 10.5],
    ['ORGANIZATION', 'friendly', 15],
    ['ORGANIZATION', 'balanced', 13],
    ['ORGANIZATION', 'strict', 10.5],
    ['VOCABULARY', 'friendly', 15],
    ['VOCABULARY', 'balanced', 13],
    ['VOCABULARY', 'strict', 10.5]
  ])('calculates exact %s score in %s mode', (category, strictness, expectedScore) => {
    const result = scoring.applySemanticStrictness({
      category, score: 12, maxScore: 20, comment: 'Grounded assessment.'
    }, strictness);
    expect(result).toMatchObject({ category, score: expectedScore, maxScore: 20 });
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
