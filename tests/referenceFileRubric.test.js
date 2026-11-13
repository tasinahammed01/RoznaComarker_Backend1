'use strict';
// Rubric detection (deterministic) and conversion to the app's rubric format (AI parser mocked; never a real AI call).
const { detectRubric } = require('../src/services/referenceFiles/rubricDetect');
const { convertTextToRubric, weightsFor } = require('../src/services/referenceFiles/rubricConvert');
const { validateAssignmentRubricInput } = require('../src/services/assignmentRubric.service');

const RUBRIC_TEXT = `Persuasive Essay Rubric
Criteria | Excellent (4 points) | Proficient (3 points) | Developing (2 points) | Beginning (1 point)
Thesis | Clear, arguable thesis | Clear thesis | Vague thesis | No thesis
Evidence | Strong evidence from two sources | Some evidence | Little evidence | No evidence
Organization | Logical paragraphs | Mostly logical | Some order | No order`;

describe('detectRubric', () => {
  test('a rubric table is detected with high confidence', () => {
    const result = detectRubric(RUBRIC_TEXT);
    expect(result).toEqual(expect.objectContaining({ looksLikeRubric: true, confidence: 'high', version: 'reference-rubric-detect-v1' }));
    expect(result.signals).toEqual(expect.arrayContaining(['RUBRIC_WORD', 'CRITERIA_HEADING', 'LEVEL_NAMES', 'POINT_VALUES', 'TABLE_STRUCTURE']));
  });
  test('a marking scheme without the word rubric is still detected', () => {
    const text = 'Marking criteria\nBand descriptors\nExcellent: 18-20 marks\nGood: 14-17 marks\nSatisfactory: 10-13 marks\nLimited: 0-9 marks';
    expect(detectRubric(text)).toEqual(expect.objectContaining({ looksLikeRubric: true }));
  });
  test('ordinary course material is not a rubric', () => {
    const outline = 'Unit 3 outline. This term we read two short stories and write a persuasive essay about public transport. '
      + 'Week one: reading. Week two: planning the argument and finding evidence. Week three: drafting and peer feedback. '
      + 'The final essay is due in week four. Please bring your notebook to every lesson.';
    expect(detectRubric(outline)).toEqual(expect.objectContaining({ looksLikeRubric: false, confidence: 'low' }));
    expect(detectRubric('')).toEqual(expect.objectContaining({ looksLikeRubric: false, score: 0, signals: [] }));
  });
  test('one passing mention of "rubric" is not enough', () => {
    expect(detectRubric('The essay will be marked with the usual rubric. Write about your favourite place in town and why it matters to you.').looksLikeRubric).toBe(false);
  });
  test('signals are codes only, never text from the file', () => {
    expect(JSON.stringify(detectRubric(RUBRIC_TEXT))).not.toMatch(/Thesis|Evidence|Persuasive/u);
  });
});

describe('convertTextToRubric', () => {
  const parsed = { title: 'Persuasive Essay Rubric', levels: [{ name: 'Beginning', score: 1 }, { name: 'Developing', score: 2 }, { name: 'Proficient', score: 3 }, { name: 'Excellent', score: 4 }],
    criteria: [{ title: 'Thesis', descriptions: ['No thesis', 'Vague', 'Clear', 'Clear and arguable'] },
      { title: 'Evidence', descriptions: ['None', 'Little', 'Some', 'Strong'] }, { title: 'Organization', descriptions: ['None', 'Some', 'Mostly', 'Logical'] }] };

  test('valid parser output becomes a designer rubric that passes the editor validation; weights set equally and noted', async () => {
    const parse = jest.fn().mockResolvedValue(parsed);
    const { rubricDesigner, notes } = await convertTextToRubric(RUBRIC_TEXT, { parse });
    expect(parse).toHaveBeenCalledWith({ text: RUBRIC_TEXT });
    expect(validateAssignmentRubricInput(rubricDesigner, true)).toEqual([]);
    expect(rubricDesigner).toEqual(expect.objectContaining({ title: 'Persuasive Essay Rubric', totalPoints: 100 }));
    expect(rubricDesigner.criteria.map(c => c.weight)).toEqual([34, 33, 33]);
    expect(rubricDesigner.levels.map(l => l.maxPoints)).toEqual([1, 2, 3, 4]);
    expect(notes).toEqual(['WEIGHTS_SET_EQUALLY']);
  });
  test('weights that already add up to 100 are kept', async () => {
    const parse = jest.fn().mockResolvedValue({ ...parsed, criteria: parsed.criteria.map((c, i) => ({ ...c, weight: [50, 30, 20][i] })) });
    const result = await convertTextToRubric('x', { parse });
    expect(result.rubricDesigner.criteria.map(c => c.weight)).toEqual([50, 30, 20]);
    expect(result.notes).toEqual([]);
  });
  test('output that fails the rubric rules is refused with the reasons (empty cells, duplicate names)', async () => {
    const bad = { ...parsed, criteria: [{ title: 'Thesis', descriptions: ['a', '', 'c', 'd'] }, { title: 'thesis', descriptions: ['a', 'b', 'c', 'd'] }] };
    const error = await convertTextToRubric('x', { parse: jest.fn().mockResolvedValue(bad) }).then(() => null, e => e);
    expect(error).toEqual(expect.objectContaining({ code: 'REFERENCE_RUBRIC_CONVERSION_FAILED',
      message: 'This file could not be turned into a rubric. It is still used as background material for marking.' }));
    expect(error.issues).toEqual(expect.arrayContaining(['Every performance level requires a description.', 'Criterion names must be non-empty and unique.']));
  });
  test('no structure at all, or a parser refusal, is a conversion failure; an AI outage is "unavailable"', async () => {
    await expect(convertTextToRubric('x', { parse: jest.fn().mockResolvedValue({ title: 'x', levels: [], criteria: [] }) }))
      .rejects.toEqual(expect.objectContaining({ code: 'REFERENCE_RUBRIC_CONVERSION_FAILED' }));
    await expect(convertTextToRubric('x', { parse: jest.fn().mockRejectedValue(Object.assign(new Error('bad json'), { statusCode: 422 })) }))
      .rejects.toEqual(expect.objectContaining({ code: 'REFERENCE_RUBRIC_CONVERSION_FAILED' }));
    await expect(convertTextToRubric('x', { parse: jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { statusCode: 502 })) }))
      .rejects.toEqual(expect.objectContaining({ code: 'REFERENCE_RUBRIC_AI_UNAVAILABLE' }));
  });
  test('equal weights are whole numbers adding up to exactly 100', () => {
    for (const n of [1, 2, 3, 6, 7, 9]) {
      const { weights } = weightsFor(Array.from({ length: n }, () => ({})));
      expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
      expect(weights.every(Number.isInteger)).toBe(true);
    }
  });
});
