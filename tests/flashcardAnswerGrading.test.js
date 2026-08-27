'use strict';

const mockGenerate = jest.fn();
jest.mock('../src/services/aiGateway.service', () => ({ generate: mockGenerate }));
const { normalizeAnswer, localGrade, gradeFlashcardAnswer } = require('../src/services/flashcardAnswerGrading.service');

describe('authoritative flashcard answer grading', () => {
  beforeEach(() => mockGenerate.mockReset());

  test('exact answer is accepted without AI', async () => {
    expect(await gradeFlashcardAnswer({ question: 'Where?', expectedAnswer: 'Chloroplast', studentAnswer: 'Chloroplast' }))
      .toMatchObject({ correct: true, gradingMethod: 'exact' });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test.each([
    ['CHLOROPLAST', 'normalized'],
    ['Chloroplast!', 'normalized'],
    ['The chloroplast', 'normalized'],
    ['chloroplasts', 'normalized'],
    ['six', 'normalized']
  ])('safe normalized equivalent %s is accepted locally', async (studentAnswer, gradingMethod) => {
    const expectedAnswer = studentAnswer === 'six' ? '6' : 'chloroplast';
    expect(await gradeFlashcardAnswer({ question: 'Question', expectedAnswer, studentAnswer }))
      .toMatchObject({ correct: true, gradingMethod });
    expect(mockGenerate).not.toHaveBeenCalled();
  });

  test('normalization preserves meaningful numbers and units', () => {
    expect(normalizeAnswer('  6.5 mg / L! ')).toBe('6.5 mg / l');
  });

  test('semantic paraphrase uses AI and accepts a confident equivalent', async () => {
    mockGenerate.mockResolvedValue({ value: { correct: true, confidence: .94,
      reason: 'The same core meaning is expressed.', missingKeyPoints: [] }, model: 'openai/gpt-4.1-mini' });
    const result = await gradeFlashcardAnswer({ question: 'What is photosynthesis?',
      expectedAnswer: 'Photosynthesis converts light energy into chemical energy.',
      studentAnswer: 'Plants use sunlight and turn it into stored chemical energy.' });
    expect(result).toMatchObject({ correct: true, gradingMethod: 'semantic_ai', confidence: .94 });
    expect(mockGenerate).toHaveBeenCalledTimes(1);
  });

  test.each([
    ['They mainly produce flowers.', .98],
    ['They help the plant grow.', .9],
    ['It happens in the roots.', .99]
  ])('wrong, vague, or contradictory answer remains incorrect: %s', async (studentAnswer, confidence) => {
    mockGenerate.mockResolvedValue({ value: { correct: false, confidence,
      reason: 'The required fact is missing or contradicted.', missingKeyPoints: ['core fact'] }, model: 'openai/gpt-4.1-mini' });
    expect(await gradeFlashcardAnswer({ question: 'Question', expectedAnswer: 'Stolons help produce tubers.', studentAnswer }))
      .toMatchObject({ correct: false, gradingMethod: 'semantic_ai' });
  });

  test('low-confidence positive AI result is conservatively incorrect', async () => {
    mockGenerate.mockResolvedValue({ value: { correct: true, confidence: .6, reason: 'Unclear.', missingKeyPoints: [] }, model: 'model' });
    expect(await gradeFlashcardAnswer({ question: 'Q', expectedAnswer: 'A complete fact', studentAnswer: 'Maybe related' }))
      .toMatchObject({ correct: false, lowConfidence: true });
  });

  test('nonsense is rejected without AI', () => {
    expect(localGrade('chloroplast', '!!!!!')).toMatchObject({ resolved: true, correct: false });
    expect(mockGenerate).not.toHaveBeenCalled();
  });
});
