'use strict';

const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const FlashcardSet = require('../src/models/FlashcardSet');
const StudentFlashcardProgress = require('../src/models/StudentFlashcardProgress');
const FlashcardAnswerCheck = require('../src/models/FlashcardAnswerCheck');
const controller = require('../src/controllers/flashcardProgress.controller');

const response = () => ({
  statusCode: 200,
  body: null,
  status(code) { this.statusCode = code; return this; },
  json(body) { this.body = body; return this; }
});

describe('flashcard completed progress persistence', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(clearDatabase);

  async function createSet(template = 'term-def') {
    return FlashcardSet.create({
      title: 'Completion regression',
      ownerId: new mongoose.Types.ObjectId(),
      visibility: 'public',
      template,
      cards: Array.from({ length: 5 }, (_, index) => ({
        front: `Card ${index + 1}`,
        back: `Answer ${index + 1}`,
        template
      }))
    });
  }

  function requestFor(set, studentId, body) {
    return { params: { setId: String(set._id) }, user: { _id: studentId }, body };
  }

  test('term/concept 5 of 5 persists completed state with no active card', async () => {
    const studentId = new mongoose.Types.ObjectId();
    const set = await createSet();
    await StudentFlashcardProgress.create({
      studentId,
      flashcardSetId: set._id,
      assignmentId: null,
      template: 'term-def',
      totalCards: 5,
      revision: 4,
      status: 'in_progress',
      currentCardId: set.cards[4]._id,
      cardProgress: set.cards.slice(0, 4).map((card) => ({ cardId: card._id, selfRating: 'knew' }))
    });

    const res = response();
    await controller.saveProgress(requestFor(set, studentId, {
        lastCardIndex: 4,
        cardsViewed: [0, 1, 2, 3, 4],
        currentCardId: null,
        expectedRevision: 4,
        cardProgress: set.cards.map((card, index) => ({
          cardId: String(card._id),
          selfRating: index === 4 ? 'didnt_know' : 'knew'
        }))
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toMatchObject({ status: 'completed', completedCards: 5, totalCards: 5, revision: 5 });
    const persisted = await StudentFlashcardProgress.findOne({ studentId, flashcardSetId: set._id }).lean();
    expect(persisted.currentCardId).toBeNull();
    expect(persisted.completedAt).toBeTruthy();
    expect(persisted.cardProgress).toHaveLength(5);
  });

  test('stale completion revision returns 409 and preserves the persisted document', async () => {
    const studentId = new mongoose.Types.ObjectId();
    const set = await createSet('concept');
    await StudentFlashcardProgress.create({
      studentId, flashcardSetId: set._id, assignmentId: null, template: 'concept',
      totalCards: 5, revision: 7, currentCardId: set.cards[4]._id,
      cardProgress: set.cards.slice(0, 4).map((card) => ({ cardId: card._id, selfRating: 'knew' }))
    });
    const res = response();
    await controller.saveProgress(requestFor(set, studentId, {
      lastCardIndex: 4, cardsViewed: [0, 1, 2, 3, 4], currentCardId: null, expectedRevision: 6,
      cardProgress: set.cards.map((card) => ({ cardId: String(card._id), selfRating: 'knew' }))
    }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('PROGRESS_VERSION_CONFLICT');
    const persisted = await StudentFlashcardProgress.findOne({ studentId, flashcardSetId: set._id }).lean();
    expect(persisted.revision).toBe(7);
    expect(persisted.status).toBe('in_progress');
  });

  test('completed GET remains completed and a duplicate completion callback is idempotent', async () => {
    const studentId = new mongoose.Types.ObjectId();
    const set = await createSet();
    const completed = await StudentFlashcardProgress.create({
      studentId, flashcardSetId: set._id, assignmentId: null, template: 'term-def', totalCards: 5,
      revision: 5, currentCardId: null,
      cardProgress: set.cards.map((card) => ({ cardId: card._id, selfRating: 'knew' }))
    });
    const duplicateRes = response();
    await controller.saveProgress(requestFor(set, studentId, {
      lastCardIndex: 4, cardsViewed: [0, 1, 2, 3, 4], currentCardId: null, expectedRevision: 5,
      cardProgress: set.cards.map((card) => ({ cardId: String(card._id), selfRating: 'knew' }))
    }), duplicateRes);
    expect(duplicateRes.statusCode).toBe(200);
    expect(duplicateRes.body.data.status).toBe('completed');
    expect(duplicateRes.body.data.revision).toBe(5);
    expect(await StudentFlashcardProgress.countDocuments({ studentId, flashcardSetId: set._id })).toBe(1);

    const getRes = response();
    await controller.getProgress({ params: { setId: String(set._id) }, query: {}, body: {}, user: { _id: studentId } }, getRes);
    expect(getRes.body.data).toMatchObject({ status: 'completed', completedCards: 5, revision: 5 });
    expect(getRes.body.data.currentCardId).toBeNull();
    expect(String(completed._id)).toBe(String(duplicateRes.body.data._id));
  });

  test('legacy progress with no revision field accepts expectedRevision zero and migrates atomically', async () => {
    const studentId = new mongoose.Types.ObjectId();
    const set = await createSet();
    const progress = await StudentFlashcardProgress.create({
      studentId, flashcardSetId: set._id, assignmentId: null, template: 'term-def', totalCards: 5,
      currentCardId: set.cards[0]._id
    });
    await StudentFlashcardProgress.collection.updateOne({ _id: progress._id }, { $unset: { revision: '' } });
    const res = response();
    await controller.saveProgress(requestFor(set, studentId, {
      lastCardIndex: 1, cardsViewed: [0], currentCardId: String(set.cards[1]._id), expectedRevision: 0,
      cardProgress: [{ cardId: String(set.cards[0]._id), selfRating: 'knew' }]
    }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.revision).toBe(1);
  });

  test('Q&A completion is derived from all authoritative answer checks and remains preserved', async () => {
    const studentId = new mongoose.Types.ObjectId();
    const set = await createSet('qa');
    await FlashcardAnswerCheck.insertMany(set.cards.map((card, index) => ({
      flashcardSetId: set._id,
      cardId: card._id,
      userId: studentId,
      assignmentId: null,
      studentAnswer: `Student ${index + 1}`,
      correctAnswer: card.back,
      isCorrect: index % 2 === 0,
      gradingMethod: 'exact'
    })));
    const saveRes = response();
    await controller.saveProgress(requestFor(set, studentId, {
      lastCardIndex: 4, cardsViewed: [0, 1, 2, 3, 4], currentCardId: null, expectedRevision: 0,
      cardProgress: set.cards.map((card) => ({ cardId: String(card._id), studentAnswer: 'client value ignored' }))
    }), saveRes);
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.body.data).toMatchObject({ status: 'completed', completedCards: 5, revision: 1 });

    const reopenRes = response();
    await controller.getProgress({ params: { setId: String(set._id) }, query: {}, body: {}, user: { _id: studentId } }, reopenRes);
    expect(reopenRes.body.data.status).toBe('completed');
    expect(reopenRes.body.data.cardProgress).toHaveLength(5);
    expect(reopenRes.body.data.cardProgress.every((item) => item.isChecked === true)).toBe(true);
    expect(await StudentFlashcardProgress.countDocuments({ studentId, flashcardSetId: set._id })).toBe(1);
  });
});
