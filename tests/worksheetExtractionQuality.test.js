'use strict';

const { analyzeSourceRichness, buildExtractionPrompt, parseExtractionResponse,
  convertExtractedToActivities } = require('../src/services/worksheetExtractor.service');

const potatoStyleSource = `Potato Life Cycle 101

Planting and sprout development: Seed potatoes are planted in spring. Shoots emerge from the eyes.
Vegetative growth: Stems, roots, leaves, and side shoots develop above and below the soil.
Stolons: Underground stems called stolons grow outward from the plant.
Tuber initiation: Tiny tubers begin forming at the tips of stolons.
Tuber bulking: Tubers rapidly increase in size and fill with starch.
Flowering: Potato plants may produce flowers while tubers develop underground.
Maturation: A protective skin forms as the plant yellows and dies back.
Potato foods include baked potatoes, fries, mash, and soups.
Potatoes provide carbohydrates, potassium, and vitamin C. They are naturally gluten-free.`;

const question = (id, prompt, type, correct_answer, extra = {}) => ({
  id, prompt, type, correct_answer, topic: id, confidence: 'high', ...extra,
});

describe('worksheet extraction quality policy', () => {
  test('concept-rich short material receives a richer adaptive target', () => {
    const richness = analyzeSourceRichness(potatoStyleSource);
    expect(richness.sizeBand).toBe('short');
    expect(richness.targetItems).toBeGreaterThanOrEqual(10);
    expect(richness.distribution.matching).toBeGreaterThanOrEqual(4);
  });

  test('medium and long source bands remain bounded', () => {
    const medium = analyzeSourceRichness(Array.from({ length: 50 }, (_, i) =>
      `Concept ${i} explains a distinct relationship in the learning material.`).join('\n'));
    const long = analyzeSourceRichness(Array.from({ length: 150 }, (_, i) =>
      `Topic ${i} describes a separate factual process for students to assess.`).join('\n'));
    expect(medium.targetItems).toBeGreaterThanOrEqual(10);
    expect(medium.targetItems).toBeLessThanOrEqual(14);
    expect(long.targetItems).toBeGreaterThanOrEqual(14);
    expect(long.targetItems).toBeLessThanOrEqual(20);
  });

  test('prompt includes coverage, duplication, adaptive count, matching, and difficulty rules', () => {
    const prompt = buildExtractionPrompt(potatoStyleSource, { gradeLevel: '5', difficulty: 'hard' });
    expect(prompt).toContain('Target assessable items');
    expect(prompt).toContain('Cover distinct concepts');
    expect(prompt).toContain('Matching sections should normally contain 4-8 unique pairs');
    expect(prompt).toContain('hard uses source-grounded inference');
  });

  test.each([
    ['malformed word bank source item', question('f1', 'Potatoes grow in spring.', 'fill_blank', 'spring'), 'EXTRACTION_INVALID_FILL_BLANK'],
    ['malformed matching pair', question('m1', 'Maturation', 'matching', 'Maturation'), 'EXTRACTION_INVALID_MATCHING_PAIR'],
    ['malformed MCQ options', question('q1', 'Which stage forms skin?', 'multiple_choice', 'Maturation',
      { options: ['Maturation', 'Maturation', 'Bulking'] }), 'EXTRACTION_INVALID_MCQ_OPTIONS'],
  ])('rejects %s', (_label, badQuestion, code) => {
    const output = { title: 'Potatoes', sections: [{ instruction: 'Answer.', questions: [badQuestion] }] };
    expect(() => parseExtractionResponse(JSON.stringify(output))).toThrow(expect.objectContaining({ code }));
  });

  test('multiple questions and matching pairs convert without a one-item-per-type limit', () => {
    const structure = { title: 'Potatoes', sections: [
      { instruction: 'Choose.', questions: [
        question('mc1', 'Which structure produces tubers?', 'multiple_choice', 'Stolons',
          { options: ['Roots', 'Flowers', 'Stolons', 'Leaves'] }),
        question('mc2', 'When is protective skin formed?', 'multiple_choice', 'Maturation',
          { options: ['Planting', 'Maturation', 'Sprouting', 'Flowering'] }),
      ] },
      { instruction: 'Complete.', questions: [
        question('f1', 'Tubers fill with ______ during bulking.', 'fill_blank', 'starch'),
        question('f2', 'Potatoes are naturally ______-free.', 'fill_blank', 'gluten'),
      ] },
      { instruction: 'Match.', questions: [
        question('m1', 'Sprout development', 'matching', 'Shoots emerge from eyes'),
        question('m2', 'Vegetative growth', 'matching', 'Leaves and roots develop'),
        question('m3', 'Tuber initiation', 'matching', 'Tiny tubers begin forming'),
        question('m4', 'Maturation', 'matching', 'Protective skin forms'),
      ] },
      { instruction: 'Decide.', questions: [
        question('t1', 'Potatoes contain vitamin C.', 'true_false', 'true'),
        question('t2', 'Tubers form on flowers.', 'true_false', 'false'),
      ] },
    ] };
    const parsed = parseExtractionResponse(JSON.stringify(structure));
    const activities = convertExtractedToActivities(parsed);
    expect(activities.find((a) => a.type === 'multipleChoice').data.questions).toHaveLength(2);
    expect(activities.find((a) => a.type === 'fillBlanks').data.sentences).toHaveLength(2);
    expect(activities.find((a) => a.type === 'matching').data.pairs).toHaveLength(4);
    expect(activities.find((a) => a.type === 'trueFalse').data.questions).toHaveLength(2);
    expect(activities.find((a) => a.type === 'fillBlanks').data.wordBank).toEqual(['starch', 'gluten']);
  });
});
