'use strict';

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const mockProgressFind = jest.fn();
const mockProgressUpdate = jest.fn();
const mockSetFind = jest.fn();
const mockChecksFind = jest.fn();

jest.mock('../src/models/StudentFlashcardProgress', () => ({
  findOne: mockProgressFind, findOneAndUpdate: mockProgressUpdate, exists: jest.fn().mockResolvedValue(true),
}));
jest.mock('../src/models/FlashcardSet', () => ({ findById: mockSetFind }));
jest.mock('../src/models/FlashcardAnswerCheck', () => ({ find: mockChecksFind }));
jest.mock('../src/models/assignment.model', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/membership.model', () => ({ findOne: jest.fn() }));
jest.mock('../src/models/user.model', () => ({}));

const controller = require('../src/controllers/flashcardProgress.controller');
const oid = () => new mongoose.Types.ObjectId();
const lean = value => ({ lean: jest.fn().mockResolvedValue(value) });
const response = () => ({ statusCode: 200, body: null, status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; } });

describe('flashcard progress resume contract', () => {
  let studentId; let setId; let cards;
  beforeEach(() => {
    jest.clearAllMocks();
    studentId = oid(); setId = oid(); cards = [oid(), oid(), oid()];
    mockSetFind.mockReturnValue(lean({ visibility: 'public', template: 'qa', cards: cards.map(_id => ({ _id })) }));
    mockChecksFind.mockReturnValue(lean([]));
  });

  test('GET returns completed card identities, current card identity, and revision', async () => {
    mockProgressFind.mockReturnValue(lean({ status: 'in_progress', cardProgress: [{ cardId: cards[0], completedAt: new Date() }],
      currentCardId: cards[1], lastCardIndex: 1, revision: 7, cardsViewed: [0], completedCards: 1, totalCards: 3 }));
    const res = response();
    await controller.getProgress({ params: { setId: String(setId) }, query: {}, user: { _id: studentId } }, res);
    expect(String(res.body.data.cardProgress[0].cardId)).toBe(String(cards[0]));
    expect(String(res.body.data.currentCardId)).toBe(String(cards[1]));
    expect(res.body.data.revision).toBe(7);
  });

  test('first GET with no progress returns a safe 200 not-started response', async () => {
    mockProgressFind.mockReturnValue(lean(null));
    const res = response();
    await controller.getProgress({ params: { setId: String(setId) }, query: {}, body: {}, user: { _id: studentId } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.status).toBe('not_started');
    expect(res.body.data.cardProgress).toEqual([]);
    expect(res.body.data.revision).toBe(0);
  });

  test('invalid set ID returns a structured field error', async () => {
    const res = response();
    await controller.getProgress({ params: { setId: 'not-an-id' }, query: {}, body: {}, user: { _id: studentId } }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ code: 'INVALID_PROGRESS_PAYLOAD', field: 'setId' }));
  });

  test('route and controller use the same setId parameter name', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/routes/flashcard.routes.js'), 'utf8');
    expect(source).toContain("router.get('/:setId/progress'");
    expect(source).toContain("router.patch('/:setId/progress'");
    expect(source).toContain("router.delete('/:setId/progress'");
  });

  test('PATCH persists the supplied canonical next currentCardId', async () => {
    mockProgressFind.mockResolvedValue({ revision: 2, status: 'in_progress' });
    mockProgressUpdate.mockResolvedValue({ _id: oid(), status: 'in_progress', revision: 3, completedCards: 1,
      totalCards: 3, currentCardId: cards[1] });
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 1, cardsViewed: [0], currentCardId: String(cards[1]), expectedRevision: 2,
      cardProgress: [{ cardId: String(cards[0]), completedAt: new Date() }], totalCards: 3,
    } }, res);
    expect(String(mockProgressUpdate.mock.calls[0][1].$set.currentCardId)).toBe(String(cards[1]));
  });

  test('two checked cards PATCH then GET as canonical card 3 resume state', async () => {
    mockProgressFind.mockResolvedValue({ revision: 2, status: 'in_progress' });
    mockChecksFind.mockReturnValue(lean([
      { cardId: cards[0], studentAnswer: 'wrong 1', isCorrect: false, gradingMethod: 'exact', checkedAt: new Date() },
      { cardId: cards[1], studentAnswer: 'wrong 2', isCorrect: false, gradingMethod: 'exact', checkedAt: new Date() },
    ]));
    mockProgressUpdate.mockImplementation(async (_query, update) => ({ _id: oid(), revision: 3,
      status: 'in_progress', totalCards: 3, completedCards: update.$set.completedCards,
      currentCardId: update.$set.currentCardId, cardProgress: update.$set.cardProgress,
      cardsViewed: update.$set.cardsViewed }));
    const patchRes = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 2, cardsViewed: [0, 1], currentCardId: String(cards[2]), expectedRevision: 2,
      cardProgress: [
        { cardId: String(cards[0]), studentAnswer: 'wrong 1' },
        { cardId: String(cards[1]), studentAnswer: 'wrong 2' },
      ], totalCards: 3,
    } }, patchRes);

    expect(patchRes.statusCode).toBe(200);
    const persisted = mockProgressUpdate.mock.calls[0][1].$set;
    expect(persisted.cardProgress).toEqual([
      expect.objectContaining({ cardId: String(cards[0]), isChecked: true, isCorrect: false }),
      expect.objectContaining({ cardId: String(cards[1]), isChecked: true, isCorrect: false }),
    ]);
    expect(persisted.completedCards).toBe(2);
    expect(String(persisted.currentCardId)).toBe(String(cards[2]));

    mockProgressFind.mockReturnValue(lean({ ...persisted, status: 'in_progress', revision: 3 }));
    const getRes = response();
    await controller.getProgress({ params: { setId: String(setId) }, query: {}, body: {},
      user: { _id: studentId } }, getRes);
    expect(getRes.statusCode).toBe(200);
    expect(String(getRes.body.data.currentCardId)).toBe(String(cards[2]));
    expect(getRes.body.data.cardProgress.map(item => ({ cardId: String(item.cardId),
      isChecked: item.isChecked, isCorrect: item.isCorrect }))).toEqual([
      { cardId: String(cards[0]), isChecked: true, isCorrect: false },
      { cardId: String(cards[1]), isChecked: true, isCorrect: false },
    ]);
  });

  test('term-def ratings are normalized by card ID and resume at card 3', async () => {
    mockSetFind.mockReturnValue(lean({ visibility: 'public', template: 'term-def', cards: cards.map(_id => ({ _id })) }));
    mockProgressFind.mockResolvedValue({ revision: 1, status: 'in_progress', cardProgress: [] });
    mockProgressUpdate.mockImplementation(async (_query, update) => ({ _id: oid(), revision: 2, ...update.$set }));
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 2, cardsViewed: [0, 1], currentCardId: String(cards[2]), expectedRevision: 1,
      cardResults: { [String(cards[0])]: 'knew', [String(cards[1])]: 'didnt_know' },
      cardProgress: [{ cardId: String(cards[0]), selfRating: 'knew' },
        { cardId: String(cards[1]), selfRating: 'didnt_know' }], totalCards: 999,
    } }, res);
    const persisted = mockProgressUpdate.mock.calls[0][1].$set;
    expect(res.statusCode).toBe(200);
    expect(persisted.totalCards).toBe(3);
    expect(persisted.completedCards).toBe(2);
    expect(persisted.cardsViewed).toEqual([0, 1]);
    expect(String(persisted.currentCardId)).toBe(String(cards[2]));
    expect(Object.fromEntries(persisted.cardResults)).toEqual({
      [String(cards[0])]: 'knew', [String(cards[1])]: 'didnt_know',
    });
    expect(persisted.cardProgress.map(item => item.selfRating)).toEqual(['knew', 'didnt_know']);
  });

  test('legacy index ratings normalize to canonical card IDs and clamp indexes', async () => {
    mockSetFind.mockReturnValue(lean({ visibility: 'public', template: 'concept', cards: cards.map(_id => ({ _id })) }));
    mockProgressFind.mockResolvedValue({ revision: 2, status: 'in_progress', cardProgress: [] });
    mockProgressUpdate.mockImplementation(async (_query, update) => ({ _id: oid(), revision: 3, ...update.$set }));
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 99, cardsViewed: [0, 0, 1, 99], currentCardId: String(cards[2]), expectedRevision: 2,
      cardResults: { 0: 'knew', 1: 'didnt_know', 99: 'knew', invalid: 'forged' }, totalCards: 3,
    } }, res);
    const persisted = mockProgressUpdate.mock.calls[0][1].$set;
    expect(persisted.lastCardIndex).toBe(2);
    expect(persisted.completedCards).toBe(2);
    expect(Object.fromEntries(persisted.cardResults)).toEqual({
      [String(cards[0])]: 'knew', [String(cards[1])]: 'didnt_know',
    });
  });

  test('final self-rating completes exactly at total and clears currentCardId', async () => {
    mockSetFind.mockReturnValue(lean({ visibility: 'public', template: 'term-def', cards: cards.map(_id => ({ _id })) }));
    mockProgressFind.mockResolvedValue({ revision: 4, status: 'in_progress', cardProgress: [] });
    mockProgressUpdate.mockImplementation(async (_query, update) => ({ _id: oid(), revision: 5, ...update.$set }));
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 2, cardsViewed: [0, 1, 2], currentCardId: null, expectedRevision: 4,
      cardProgress: cards.map((cardId, index) => ({ cardId: String(cardId),
        selfRating: index === 1 ? 'didnt_know' : 'knew' })), totalCards: 3,
    } }, res);
    const persisted = mockProgressUpdate.mock.calls[0][1].$set;
    expect(persisted.completedCards).toBe(3);
    expect(persisted.status).toBe('completed');
    expect(persisted.currentCardId).toBeNull();
  });

  test('first PATCH creates revision one without requiring an existing revision', async () => {
    mockProgressFind.mockResolvedValue(null);
    mockProgressUpdate.mockResolvedValue({ _id: oid(), status: 'in_progress', revision: 1, completedCards: 0,
      totalCards: 3, currentCardId: cards[0] });
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 0, cardsViewed: [], currentCardId: String(cards[0]), expectedRevision: 0,
      cardProgress: [], totalCards: 3,
    } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.revision).toBe(1);
    expect(mockProgressUpdate.mock.calls[0][2].upsert).toBe(true);
  });

  test('PATCH rejects a stale optimistic revision', async () => {
    mockProgressFind.mockResolvedValue({ revision: 4, status: 'in_progress' });
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 0, cardsViewed: [], currentCardId: String(cards[0]), expectedRevision: 3,
    } }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PROGRESS_VERSION_CONFLICT');
    expect(mockProgressUpdate).not.toHaveBeenCalled();
  });

  test('PATCH returns the safe structured save failure contract', async () => {
    mockProgressFind.mockResolvedValue({ revision: 2, status: 'in_progress', cardProgress: [] });
    mockProgressUpdate.mockRejectedValue(Object.assign(new Error('internal database detail'), {
      name: 'ValidationError', errors: { currentCardId: { name: 'CastError', message: 'private detail', kind: 'ObjectId' } }
    }));
    const res = response();
    await controller.saveProgress({ params: { setId: String(setId) }, user: { _id: studentId }, body: {
      lastCardIndex: 2, cardsViewed: [0, 1], currentCardId: String(cards[2]), expectedRevision: 2,
      cardProgress: []
    } }, res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, code: 'FLASHCARD_PROGRESS_SAVE_FAILED',
      message: 'Unable to save flashcard progress.' });
    expect(JSON.stringify(res.body)).not.toContain('private detail');
  });
});
