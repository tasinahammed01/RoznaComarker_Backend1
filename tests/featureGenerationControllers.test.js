'use strict';

const mockGenerateFeatureJson = jest.fn();
const mockGlobalChatCompletion = jest.fn();
jest.mock('../src/services/featureGemini.service', () => ({
  ...jest.requireActual('../src/services/featureGemini.service'),
  generateFeatureJson: mockGenerateFeatureJson
}));
jest.mock('../src/services/aiGeneration.service', () => ({
  generateChatCompletion: mockGlobalChatCompletion
}));

const flashcardController = require('../src/controllers/flashcard.controller');
const worksheetController = require('../src/controllers/worksheet.controller');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; }
  };
}

describe('dedicated feature generation controllers', () => {
  beforeEach(() => {
    mockGenerateFeatureJson.mockReset();
    mockGlobalChatCompletion.mockReset();
  });

  test.each(['term-def', 'qa', 'concept'])('flashcard %s request and response contracts are unchanged', async (template) => {
    mockGenerateFeatureJson.mockResolvedValue({
      value: [
        { front: 'Evaporation', back: 'Liquid water changes into vapor.' },
        { front: 'Condensation', back: 'Water vapor changes into liquid.' }
      ],
      metadata: { provider: 'google', model: 'gemini-3.6-flash' }
    });
    const res = response();
    await flashcardController.generateFlashcards({
      body: { content: 'Water cycle', template, cardCount: 2, language: 'English', addImage: false }
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ success: true, data: [
      { front: 'Evaporation', back: 'Liquid water changes into vapor.' },
      { front: 'Condensation', back: 'Water vapor changes into liquid.' }
    ] });
    expect(mockGenerateFeatureJson).toHaveBeenCalledTimes(1);
    expect(mockGenerateFeatureJson.mock.calls[0][0]).toBe('flashcard');
  });

  test('worksheet request and response contracts remain unchanged and never use global AI generation', async () => {
    mockGenerateFeatureJson.mockResolvedValue({
      value: {
        title: 'Water Cycle', description: 'Practice the water cycle.', subject: 'Science',
        tags: ['water'], estimatedMinutes: 5,
        activities: [{
          type: 'multipleChoice', title: 'Choose', instructions: 'Choose an answer.', order: 1,
          data: { questions: [{ id: 'mc-1', text: 'What forms clouds?', options: ['Condensation', 'Evaporation'], correctAnswer: 'Condensation' }] }
        }]
      },
      metadata: { provider: 'google', model: 'gemini-3.6-flash' }
    });
    const res = response();
    await worksheetController.generateWorksheet({
      body: { inputType: 'topic', content: 'Water cycle', language: 'English',
        difficulty: 'easy', activityTypes: ['multipleChoice'] }
    }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      worksheet: { title: 'Water Cycle', subject: 'Science',
        activities: [{ type: 'multipleChoice' }] },
      sourceContent: 'Water cycle'
    });
    expect(mockGenerateFeatureJson).toHaveBeenCalledTimes(1);
    expect(mockGenerateFeatureJson.mock.calls[0][0]).toBe('worksheet');
    expect(mockGlobalChatCompletion).not.toHaveBeenCalled();
  });

  test.each([
    ['GEMINI_NOT_CONFIGURED', 503],
    ['GEMINI_TIMEOUT', 504],
    ['GEMINI_RATE_LIMITED', 429],
    ['GEMINI_RESPONSE_INVALID', 502]
  ])('flashcard maps %s safely without changing its error envelope', async (code, status) => {
    mockGenerateFeatureJson.mockRejectedValue(Object.assign(new Error('private upstream detail'), { code }));
    const res = response();
    await flashcardController.generateFlashcards({
      body: { content: 'Water cycle', template: 'term-def', cardCount: 2, language: 'English' }
    }, res);
    expect(res.statusCode).toBe(status);
    expect(res.body.success).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('private upstream detail');
  });
});
