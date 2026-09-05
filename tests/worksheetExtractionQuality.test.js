'use strict';

const { analyzeSourceRichness, buildExtractionPrompt, parseExtractionResponse,
  convertExtractedToActivities, resolveCanonicalAnswer, buildRepairPrompt } = require('../src/services/worksheetExtractor.service');

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
    expect(prompt).toContain('question ID/number first');
    expect(prompt).toContain('exact option value');
  });

  test.each([
    ['explicit MCQ text', { type: 'multiple_choice', options: ['receive', 'believe', 'ceiling', 'science'], correct_answer: ' BELIEVE. ' }, 'believe'],
    ['MCQ letter', { type: 'multiple_choice', options: ['receive', 'believe', 'ceiling', 'science'], correct_answer: 'B' }, 'believe'],
    ['MCQ numeric index', { type: 'multiple_choice', options: ['receive', 'believe', 'ceiling', 'science'], correct_answer: '2' }, 'believe'],
    ['true alias', { type: 'true_false', correct_answer: 'Yes' }, 'true'],
    ['false boolean', { type: 'true_false', correct_answer: false }, 'false'],
    ['fill blank whitespace', { type: 'fill_blank', correct_answer: ' accommodate ' }, 'accommodate'],
  ])('normalizes %s deterministically', (_label, input, expected) => {
    expect(resolveCanonicalAnswer(input)).toBe(expected);
  });

  test('does not invent an ambiguous or absent answer', () => {
    expect(resolveCanonicalAnswer({ type: 'multiple_choice', options: ['Same!', 'same?', 'Other', 'Last'], correct_answer: 'same' })).toBe('same');
    expect(resolveCanonicalAnswer({ type: 'fill_blank', correct_answer: '' })).toBe('');
  });

  test.each([2, 3, 4, 5])('accepts an extracted MCQ with %i unique source options', (count) => {
    const options = Array.from({ length: count }, (_, index) => `Choice ${index + 1}`);
    const output = { title: 'Source worksheet', sections: [{ instruction: 'Choose.', questions: [
      question('q1', 'Choose the source answer.', 'multiple_choice', options.at(-1), { options })
    ] }] };
    expect(parseExtractionResponse(JSON.stringify(output)).sections[0].questions[0].options).toEqual(options);
  });

  test.each([
    [['Only one'], 'Only one', 'EXTRACTION_INVALID_MCQ_OPTIONS'],
    [['Same!', 'same?', 'Other'], 'Other', 'EXTRACTION_INVALID_MCQ_OPTIONS'],
    [['Alpha', 'Beta', 'Gamma'], 'Missing', 'EXTRACTION_INVALID_MCQ_ANSWER'],
  ])('rejects malformed extracted MCQ options or answer', (options, answer, code) => {
    const output = { title: 'Source worksheet', sections: [{ instruction: 'Choose.', questions: [
      question('q14', 'Choose.', 'multiple_choice', answer, { options })
    ] }] };
    expect(() => parseExtractionResponse(JSON.stringify(output))).toThrow(expect.objectContaining({ code }));
  });

  test('resolves aliases across variable option counts and leaves out-of-range aliases invalid', () => {
    expect(resolveCanonicalAnswer({ type: 'multiple_choice', options: ['a', 'b', 'c'], correct_answer: 'C' })).toBe('c');
    expect(resolveCanonicalAnswer({ type: 'multiple_choice', options: ['a', 'b', 'c', 'd', 'e'], correct_answer: 'E' })).toBe('e');
    expect(resolveCanonicalAnswer({ type: 'multiple_choice', options: ['a', 'b', 'c'], correct_answer: 'E' })).toBe('E');
  });

  test('accepts the source-faithful three-option Q14 without padding', () => {
    const output = { title: 'Spelling', sections: [{ instruction: 'Circle the correct spelling.', questions: [
      question('q14', 'Circle the correct spelling:', 'multiple_choice', 'a',
        { options: ['beginning', 'begining', 'beggining'], confidence: 'high' })
    ] }] };
    const parsed = parseExtractionResponse(JSON.stringify(output));
    expect(parsed.sections[0].questions[0]).toEqual(expect.objectContaining({
      options: ['beginning', 'begining', 'beggining'], correct_answer: 'beginning', confidence: 'high'
    }));
  });

  test('MCQ repair guidance preserves source options rather than padding to four', () => {
    const repair = buildRepairPrompt('{}', { diagnostics: [{ code: 'EXTRACTION_INVALID_MCQ_OPTIONS',
      questionId: 'q14', optionCount: 3, reason: 'duplicate_options' }] });
    expect(repair).toContain('preserve the exact source options');
    expect(repair).toContain('Never pad a source question to four options');
  });

  test.each([
    ['short_answer', 'q9', 'Explain one spelling rule you use to remember when to double a final consonant.', 'Accept any accurate explanation of the doubling rule.'],
    ['essay', 'q15', "Write a sentence using the word 'necessary.'", "Accept any grammatically correct sentence using 'necessary'."],
  ])('preserves numbered %s grading guidance as a high-confidence shortAnswer modelAnswer', (type, id, prompt, guidance) => {
    const parsed = parseExtractionResponse(JSON.stringify({ title: 'Spelling', sections: [{ instruction: 'Respond.', questions: [
      question(id, prompt, type, guidance, { confidence: 'high' })
    ] }] }));
    expect(parsed.sections[0].questions[0]).toEqual(expect.objectContaining({ correct_answer: guidance, confidence: 'high' }));
    const activities = convertExtractedToActivities(parsed);
    expect(activities).toHaveLength(1);
    expect(activities[0].type).toBe('shortAnswer');
    expect(activities[0].data.questions[0].modelAnswer).toBe(guidance);
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
