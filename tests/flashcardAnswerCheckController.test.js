'use strict';

const mockGrade = jest.fn();
const mockFindSet = jest.fn();
const mockPersist = jest.fn();
const mockFindAssignment = jest.fn();
const mockMembershipExists = jest.fn();

jest.mock('../src/services/flashcardAnswerGrading.service', () => ({ gradeFlashcardAnswer: mockGrade }));
jest.mock('../src/models/FlashcardSet', () => ({ findById: mockFindSet }));
jest.mock('../src/models/FlashcardAnswerCheck', () => ({ findOneAndUpdate: mockPersist }));
jest.mock('../src/models/assignment.model', () => ({ findOne: mockFindAssignment }));
jest.mock('../src/models/membership.model', () => ({ exists: mockMembershipExists, find: jest.fn() }));

const controller = require('../src/controllers/flashcard.controller');

function chain(value) {
  return { select: () => ({ lean: async () => value }) };
}
function response() {
  return { statusCode: 200, body: null, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}

describe('flashcard answer check controller authority', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindSet.mockReturnValue(chain({ template: 'qa', visibility: 'public', cards: [{ _id: 'card1', front: 'DB question', back: 'DB answer' }] }));
    mockGrade.mockResolvedValue({ correct: false, gradingMethod: 'semantic_ai', confidence: .98, reason: 'Contradicts the fact.', model: 'model' });
    mockPersist.mockResolvedValue({ isCorrect: false, gradingMethod: 'semantic_ai', confidence: .98,
      explanation: 'Contradicts the fact.', correctAnswer: 'DB answer', studentAnswer: 'Wrong', checkedAt: new Date() });
  });

  test('canonical question and answer come from the database and client correctness is ignored', async () => {
    const res = response();
    await controller.gradeAnswer({ params: { id: 'set1', cardId: 'card1' },
      body: { answer: 'Wrong', correctAnswer: 'forged', isCorrect: true }, user: { _id: 'student1' } }, res);
    expect(mockGrade).toHaveBeenCalledWith({ question: 'DB question', expectedAnswer: 'DB answer', studentAnswer: 'Wrong' });
    expect(res.body.data.isCorrect).toBe(false);
    expect(mockPersist.mock.calls[0][1].$setOnInsert.isCorrect).toBe(false);
  });

  test('repeated checks use immutable first-result persistence semantics', async () => {
    const req = { params: { id: 'set1', cardId: 'card1' }, body: { answer: 'Wrong' }, user: { _id: 'student1' } };
    await controller.gradeAnswer(req, response());
    await controller.gradeAnswer(req, response());
    expect(mockPersist).toHaveBeenCalledTimes(2);
    expect(mockPersist.mock.calls[0][1]).toHaveProperty('$setOnInsert');
    expect(mockPersist.mock.calls[0][1]).not.toHaveProperty('$set');
  });

  test('failed grading does not persist or reveal the answer', async () => {
    mockGrade.mockRejectedValue(new Error('provider unavailable'));
    const res = response();
    await controller.gradeAnswer({ params: { id: 'set1', cardId: 'card1' }, body: { answer: 'Attempt' }, user: { _id: 'student1' } }, res);
    expect(res.statusCode).toBe(503);
    expect(res.body.code).toBe('FLASHCARD_ANSWER_CHECK_FAILED');
    expect(res.body.correctAnswer).toBeUndefined();
    expect(mockPersist).not.toHaveBeenCalled();
  });
});
