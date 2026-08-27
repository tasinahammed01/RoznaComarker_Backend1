'use strict';

const mongoose = require('mongoose');
const StudentFlashcardProgress = require('../src/models/StudentFlashcardProgress');
const WorksheetDraft = require('../src/models/WorksheetDraft');

const id = () => new mongoose.Types.ObjectId();

describe('persistent activity progress schemas', () => {
  test('flashcard progress has the explicit lifecycle states', () => {
    expect(StudentFlashcardProgress.schema.path('status').enumValues)
      .toEqual(['not_started', 'in_progress', 'completed']);
  });

  test('flashcard progress stores identity-based resume and optimistic revision fields', () => {
    const progress = new StudentFlashcardProgress({ studentId: id(), flashcardSetId: id(), totalCards: 2,
      currentCardId: id(), revision: 4, cardProgress: [{ cardId: id(), studentAnswer: 'partial' }] });
    expect(progress.currentCardId).toBeTruthy();
    expect(progress.cardProgress[0].studentAnswer).toBe('partial');
    expect(progress.cardProgress[0].isChecked).toBe(false);
    expect(progress.revision).toBe(4);
  });

  test('checked flashcard result preserves authoritative grading metadata', () => {
    const progress = new StudentFlashcardProgress({ studentId: id(), flashcardSetId: id(), totalCards: 1,
      cardProgress: [{ cardId: id(), studentAnswer: 'answer', isChecked: true, isCorrect: true,
        gradingMethod: 'semantic_ai', checkedAt: new Date(), completedAt: new Date() }] });
    expect(progress.cardProgress[0].isCorrect).toBe(true);
    expect(progress.cardProgress[0].gradingMethod).toBe('semantic_ai');
  });

  test('self-rated progress stores rating without claiming a Q&A check', () => {
    const progress = new StudentFlashcardProgress({ studentId: id(), flashcardSetId: id(), totalCards: 1,
      template: 'term-def', cardProgress: [{ cardId: id(), selfRating: 'didnt_know',
        isChecked: false, completedAt: new Date() }] });
    expect(progress.cardProgress[0].selfRating).toBe('didnt_know');
    expect(progress.cardProgress[0].isChecked).toBe(false);
  });

  test('completed flashcard progress accepts no active current card', async () => {
    const cardId = id();
    const progress = new StudentFlashcardProgress({ studentId: id(), flashcardSetId: id(), totalCards: 1,
      completedCards: 1, status: 'completed', currentCardId: null, template: 'term-def',
      cardProgress: [{ cardId, selfRating: 'knew', completedAt: new Date() }] });
    await expect(progress.validate()).resolves.toBeUndefined();
    expect(progress.currentCardId).toBeNull();
  });

  test('flashcard progress has canonical unique indexes', () => {
    const indexes = StudentFlashcardProgress.schema.indexes();
    expect(indexes.some(([keys, options]) => keys.studentId === 1 && keys.flashcardSetId === 1 && options.unique)).toBe(true);
  });

  test('worksheet draft is in-progress only and versioned', () => {
    const draft = new WorksheetDraft({ worksheetId: id(), assignmentId: id(), studentId: id(), revision: 2 });
    expect(draft.status).toBe('in_progress');
    expect(draft.revision).toBe(2);
    expect(WorksheetDraft.schema.path('status').enumValues).toEqual(['in_progress']);
  });

  test('worksheet draft restores partial text exactly', () => {
    const draft = new WorksheetDraft({ worksheetId: id(), assignmentId: id(), studentId: id(),
      activity4Blanks: { blank_1: 'photosyn' } });
    expect(draft.activity4Blanks.get('blank_1')).toBe('photosyn');
  });

  test('worksheet draft covers matching, true-false, labels, and sequences', () => {
    const draft = new WorksheetDraft({ worksheetId: id(), assignmentId: id(), studentId: id(),
      activity5Matches: { pair_1: 'choice_2' }, activity6Answers: { q_1: false },
      activity7Labels: { label_1: 'cell' }, activity8Sequences: { seq_1: ['a', 'b'] } });
    expect(draft.activity5Matches.get('pair_1')).toBe('choice_2');
    expect(draft.activity6Answers.get('q_1')).toBe(false);
    expect(draft.activity7Labels.get('label_1')).toBe('cell');
    expect(draft.activity8Sequences.get('seq_1')).toEqual(['a', 'b']);
  });

  test('worksheet progress stores question identity and active elapsed time', () => {
    const draft = new WorksheetDraft({ worksheetId: id(), assignmentId: id(), studentId: id(),
      currentQuestionId: 'q-8', currentQuestionIndex: 7, timeSpent: 91 });
    expect(draft.currentQuestionId).toBe('q-8');
    expect(draft.currentQuestionIndex).toBe(7);
    expect(draft.timeSpent).toBe(91);
  });

  test('worksheet has one canonical draft per student and assignment', () => {
    expect(WorksheetDraft.schema.indexes().some(([keys, options]) =>
      keys.assignmentId === 1 && keys.studentId === 1 && options.unique)).toBe(true);
  });

  test('invalid worksheet progress percentage is rejected', () => {
    const draft = new WorksheetDraft({ worksheetId: id(), assignmentId: id(), studentId: id(), progressPercentage: 101 });
    expect(draft.validateSync()?.errors.progressPercentage).toBeDefined();
  });
});
