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
    const messages = mockGenerateFeatureJson.mock.calls[0][1];
    const options = mockGenerateFeatureJson.mock.calls[0][2];
    expect(messages[0].content).toContain('JSON object containing a flashcards array');
    expect(messages[1].content).toContain(`Template: ${template === 'qa' ? 'QUESTION AND ANSWER' : template === 'concept' ? 'CONCEPT EXPLANATION' : 'TERM AND DEFINITION'}`);
    expect(options).toMatchObject({ schemaName: 'flashcard_generation' });
    expect(options.responseSchema.required).toEqual(['flashcards']);
    expect(options.validateValue({ flashcards: res.body.data })).toEqual(res.body.data);
  });

  test('short but valid topics reach generation and truly insufficient input does not', async () => {
    mockGenerateFeatureJson.mockResolvedValue({
      value: [{ front: 'Mars', back: 'The fourth planet from the Sun.' }],
      metadata: { model: 'test-model', attemptCount: 1 }
    });
    const validRes = response();
    await flashcardController.generateFlashcards({
      body: { content: 'Mars', template: 'qa', cardCount: 1, language: 'English' }
    }, validRes);
    expect(validRes.statusCode).toBe(200);
    expect(mockGenerateFeatureJson).toHaveBeenCalledTimes(1);

    const invalidRes = response();
    await flashcardController.generateFlashcards({ body: { content: ' x ' } }, invalidRes);
    expect(invalidRes.statusCode).toBe(400);
    expect(invalidRes.body.code).toBe('INSUFFICIENT_FLASHCARD_CONTENT');
    expect(mockGenerateFeatureJson).toHaveBeenCalledTimes(1);
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
