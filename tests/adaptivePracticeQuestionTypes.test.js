'use strict';

const {
  allowedQuestionTypes,
  isCompatibleQuestionType,
  normalizeQuestionType,
  progressionForPercentage
} = require('../src/utils/adaptivePracticeQuestionTypes');

describe('adaptive practice question-type compatibility', () => {
  test.each([
    ['CONTENT', 'open_response'],
    ['ORGANIZATION', 'mcq'], ['ORGANIZATION', 'fill_blank'], ['ORGANIZATION', 'open_response'],
    ['GRAMMAR', 'mcq'], ['GRAMMAR', 'fill_blank'], ['GRAMMAR', 'open_response'],
    ['VOCABULARY', 'mcq'], ['VOCABULARY', 'fill_blank'], ['VOCABULARY', 'open_response'],
    ['MECHANICS', 'mcq'], ['MECHANICS', 'fill_blank'], ['MECHANICS', 'open_response']
  ])('%s supports %s', (skillId, questionType) => {
    expect(isCompatibleQuestionType(skillId, questionType)).toBe(true);
  });

  test('every known skill exposes all compatible interactions without choosing one', () => {
    for (const skillId of ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS']) {
      expect(new Set(allowedQuestionTypes(skillId))).toEqual(new Set(['mcq', 'fill_blank', 'open_response']));
    }
  });

  test.each([
    ['written_response', 'open_response'], ['rewrite', 'open_response'],
    ['multiple_choice', 'mcq'], ['multipleChoice', 'mcq'],
    ['fillInBlank', 'fill_blank'], ['fill_in_blank', 'fill_blank']
  ])('normalizes legacy alias %s', (legacy, canonical) => {
    expect(normalizeQuestionType(legacy)).toBe(canonical);
  });

  test('unknown types fall back safely and progression remains advisory', () => {
    expect(normalizeQuestionType('unknown')).toBe('open_response');
    expect(normalizeQuestionType('unknown', '')).toBe('');
    expect(progressionForPercentage(30)).toMatchObject({ difficulty: 'foundational' });
    expect(progressionForPercentage(60)).toMatchObject({ difficulty: 'developing' });
    expect(progressionForPercentage(68)).toMatchObject({ difficulty: 'proficient' });
  });
});
