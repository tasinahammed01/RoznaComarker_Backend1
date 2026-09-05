'use strict';

jest.mock('../src/services/aiGeneration.service', () => ({ generateChatCompletion: jest.fn() }));
const { generateChatCompletion } = require('../src/services/aiGeneration.service');
const { gradeSubjectiveAnswer } = require('../src/services/worksheetScoring.service');

describe('worksheet subjective grading guidance', () => {
  test('passes source grading guidance to the subjective grader', async () => {
    generateChatCompletion.mockResolvedValue(JSON.stringify({ result: 'correct', feedback: 'The response accurately states the rule.' }));
    const result = await gradeSubjectiveAnswer({ text: 'Explain a doubling rule.',
      modelAnswer: 'Accept any accurate explanation of the doubling rule.' },
    'Double the final consonant before adding -ing.', 'spelling');
    expect(result).toEqual(expect.objectContaining({ result: 'correct', score: 1 }));
    expect(generateChatCompletion.mock.calls[0][0][1].content).toContain('Reference answer / grading guidance: Accept any accurate explanation');
  });

  test('AI failure never grants full credit for empty guidance or substring matching guidance prose', async () => {
    generateChatCompletion.mockRejectedValue(new Error('unavailable'));
    await expect(gradeSubjectiveAnswer({ text: 'Write a sentence.', modelAnswer: '' }, 'Necessary work matters.', 'spelling'))
      .resolves.toEqual(expect.objectContaining({ result: 'incorrect', score: 0 }));
    await expect(gradeSubjectiveAnswer({ text: 'Write a sentence.', modelAnswer: 'Accept any grammatically correct sentence.' },
      'This is a grammatically correct sentence.', 'spelling'))
      .resolves.toEqual(expect.objectContaining({ result: 'incorrect', score: 0 }));
  });
});
