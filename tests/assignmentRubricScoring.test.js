const rubricService = require('../src/services/assignmentRubric.service');
const { isEvaluationFresh, VERSION } = require('../src/services/canonicalEvaluation.service');

const levels = [
  { title: 'Excellent', score: 100, description: 'Complete, precise, and well supported.' },
  { title: 'Developing', score: 60, description: 'Partially complete with gaps.' }
];
const assignment = {
  title: 'Essay',
  rubrics: {
    totalPoints: 100,
    criteria: [
      { name: 'Evidence', weight: 70, levels },
      { name: 'Reasoning', weight: 30, levels }
    ]
  }
};

describe('assignment rubric scoring', () => {
  test('supports assignment.rubrics and deterministically normalizes positive weights to 100', () => {
    const result = rubricService.normalizeAssignmentRubric(assignment);
    expect(result.status).toBe('valid');
    expect(result.rubric.criteria.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
  });

  test('supports legacy assignment.rubric JSON', () => {
    const result = rubricService.normalizeAssignmentRubric({ title: 'Essay', rubric: JSON.stringify(assignment.rubrics) });
    expect(result).toMatchObject({ status: 'valid', source: 'rubric' });
  });

  test('invalid rubric behavior is explicit and no-rubric behavior remains absent/default', () => {
    expect(rubricService.normalizeAssignmentRubric({ title: 'Essay' }).status).toBe('absent');
    const invalid = rubricService.normalizeAssignmentRubric({
      rubrics: { criteria: [{ name: 'Evidence', weight: 0, levels: [{ title: 'Only', score: 100, description: '' }] }] }
    });
    expect(invalid.status).toBe('invalid');
    expect(invalid.diagnostics.length).toBeGreaterThan(0);
  });

  test('weighted total is backend-calculated and changes when criterion weights change', () => {
    const first = rubricService.normalizeAssignmentRubric(assignment).rubric;
    const assessments = [
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Excellent', comment: 'Strong' },
      { criterionId: 'criterion-2', percentage: 60, levelTitle: 'Developing', comment: 'Developing' }
    ];
    expect(rubricService.calculateCustomRubricScore(first, assessments).overallScore).toBe(88);
    const changed = rubricService.normalizeAssignmentRubric({
      ...assignment, rubrics: { ...assignment.rubrics, criteria: [
        { ...assignment.rubrics.criteria[0], weight: 30 },
        { ...assignment.rubrics.criteria[1], weight: 70 }
      ] }
    }).rubric;
    expect(rubricService.calculateCustomRubricScore(changed, assessments).overallScore).toBe(72);
  });

  test('selected configured levels are authoritative for score percentage and weighted points', () => {
    const rubric = rubricService.normalizeAssignmentRubric(assignment).rubric;
    const result = rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 60, levelTitle: 'Developing', comment: 'Developing' },
      { criterionId: 'criterion-2', percentage: 100, levelTitle: 'Excellent', comment: 'Strong' }
    ]);
    expect(result.criteria[0]).toMatchObject({
      selectedLevel: 'Developing',
      configuredLevelPercentage: 60,
      normalizedWeight: 70,
      weightedPoints: 42,
      percentage: 60
    });
    expect(result.criteria[1]).toMatchObject({
      selectedLevel: 'Excellent',
      configuredLevelPercentage: 100,
      weightedPoints: 30
    });
    expect(result.overallScore).toBe(72);
    expect(result.criteria.reduce((sum, item) => sum + item.weightedPoints, 0)).toBe(result.overallScore);
  });

  test('confirmed five-criterion rubric deterministically calculates 60/100 without double weighting', () => {
    const configuredLevels = [
      { title: 'Excellent', score: 100, description: 'Excellent work.' },
      { title: 'Good', score: 80, description: 'Good work.' },
      { title: 'Satisfactory', score: 60, description: 'Satisfactory work.' },
      { title: 'Needs Improvement', score: 40, description: 'Needs improvement.' }
    ];
    const rubric = rubricService.normalizeAssignmentRubric({
      title: 'Confirmed rubric',
      rubrics: { totalPoints: 100, criteria: [
        { name: 'Content Accuracy and Relevance', weight: 30, levels: configuredLevels },
        { name: 'Organization and Structure', weight: 20, levels: configuredLevels },
        { name: 'Use of Descriptive Language', weight: 15, levels: configuredLevels },
        { name: 'Analysis of Key Factors', weight: 20, levels: configuredLevels },
        { name: 'Grammar, Spelling, and Mechanics', weight: 15, levels: configuredLevels }
      ] }
    }).rubric;
    const result = rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 60, levelTitle: 'Satisfactory' },
      { criterionId: 'criterion-2', percentage: 60, levelTitle: 'Satisfactory' },
      { criterionId: 'criterion-3', percentage: 40, levelTitle: 'Needs Improvement' },
      { criterionId: 'criterion-4', percentage: 60, levelTitle: 'Satisfactory' },
      { criterionId: 'criterion-5', percentage: 80, levelTitle: 'Good' }
    ]);
    expect(result.criteria.map((item) => item.weightedPoints)).toEqual([18, 12, 6, 12, 12]);
    expect(result.overallScore).toBe(60);
  });

  test('rejects an AI percentage inconsistent with the selected configured level', () => {
    const rubric = rubricService.normalizeAssignmentRubric(assignment).rubric;
    expect(() => rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 27, levelTitle: 'Developing' },
      { criterionId: 'criterion-2', percentage: 100, levelTitle: 'Excellent' }
    ])).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_PERCENTAGE_MISMATCH' }));
  });

  test('rejects missing, duplicate, unknown-criterion, and unknown-level assessments explicitly', () => {
    const rubric = rubricService.normalizeAssignmentRubric(assignment).rubric;
    expect(() => rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Excellent' }
    ])).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_ASSESSMENT_INCOMPLETE' }));
    expect(() => rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Excellent' },
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Excellent' }
    ])).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_ASSESSMENT_DUPLICATE' }));
    expect(() => rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Excellent' },
      { criterionId: 'invented', percentage: 100, levelTitle: 'Excellent' }
    ])).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_CRITERION_UNKNOWN' }));
    expect(() => rubricService.calculateCustomRubricScore(rubric, [
      { criterionId: 'criterion-1', percentage: 100, levelTitle: 'Invented' },
      { criterionId: 'criterion-2', percentage: 100, levelTitle: 'Excellent' }
    ])).toThrow(expect.objectContaining({ code: 'CUSTOM_RUBRIC_LEVEL_INVALID' }));
  });

  test('freshness requires unchanged source, rubric, policy, and version', () => {
    const context = { sourceHash: 'source', rubricHash: 'rubric', policyHash: 'balanced' };
    const record = { evaluationSourceHash: 'source', evaluationRubricSourceHash: 'rubric',
      evaluationPolicyHash: 'balanced', evaluationVersion: VERSION, evaluationStatus: 'completed' };
    expect(isEvaluationFresh(record, context)).toBe(true);
    expect(isEvaluationFresh(record, { ...context, policyHash: 'friendly' })).toBe(false);
    expect(isEvaluationFresh(record, { ...context, rubricHash: 'changed-rubric' })).toBe(false);
    expect(isEvaluationFresh(record, { ...context, sourceHash: 'changed-source' })).toBe(false);
    expect(isEvaluationFresh({ ...record, evaluationVersion: 'old-version' }, context)).toBe(false);
    expect(isEvaluationFresh({ ...record, evaluationPolicyHash: undefined }, context)).toBe(false);
  });
});
