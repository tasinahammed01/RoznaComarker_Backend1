/**
 * worksheetScoring.service.test.js
 * 
 * Unit tests for the authoritative worksheet scoring engine.
 * Tests all activity types (A1, A2, A3, A4) including edge cases.
 */

const { gradeWorksheetAnswers, buildCanonicalAnswerSheet } = require('../worksheetScoring.service');

describe('Worksheet Scoring Service', () => {
  describe('gradeWorksheetAnswers', () => {
    it('should score Activity 1 correctly based on correctOrder', () => {
      const worksheet = {
        activity1: {
          items: [
            { id: 'a1_1', correctOrder: 1 },
            { id: 'a1_2', correctOrder: 2 },
            { id: 'a1_3', correctOrder: 3 },
          ],
        },
        activity2: null,
        activity3: null,
        activity4: null,
      };

      const answers = [
        { questionId: 'slot_0', sectionId: 'activity1', studentAnswer: 'a1_1' },
        { questionId: 'slot_1', sectionId: 'activity1', studentAnswer: 'a1_2' },
        { questionId: 'slot_2', sectionId: 'activity1', studentAnswer: 'a1_3' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity1PointsEarned).toBe(3);
      expect(result.totals.activity1Total).toBe(3);
      expect(result.gradedAnswers[0].isCorrect).toBe(true);
      expect(result.gradedAnswers[1].isCorrect).toBe(true);
      expect(result.gradedAnswers[2].isCorrect).toBe(true);
    });

    it('should score Activity 1 with incorrect order', () => {
      const worksheet = {
        activity1: {
          items: [
            { id: 'a1_1', correctOrder: 1 },
            { id: 'a1_2', correctOrder: 2 },
            { id: 'a1_3', correctOrder: 3 },
          ],
        },
        activity2: null,
        activity3: null,
        activity4: null,
      };

      const answers = [
        { questionId: 'slot_0', sectionId: 'activity1', studentAnswer: 'a1_2' },
        { questionId: 'slot_1', sectionId: 'activity1', studentAnswer: 'a1_1' },
        { questionId: 'slot_2', sectionId: 'activity1', studentAnswer: 'a1_3' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity1PointsEarned).toBe(1);
      expect(result.totals.activity1Total).toBe(3);
    });

    it('should score Activity 2 with correct categories (case-insensitive)', () => {
      const worksheet = {
        activity1: null,
        activity2: {
          items: [
            { id: 'a2_1', correctCategory: 'Mammal' },
            { id: 'a2_2', correctCategory: 'Bird' },
            { id: 'a2_3', correctCategory: 'Reptile' },
          ],
        },
        activity3: null,
        activity4: null,
      };

      const answers = [
        { questionId: 'a2_1', sectionId: 'activity2', studentAnswer: 'mammal' },
        { questionId: 'a2_2', sectionId: 'activity2', studentAnswer: 'BIRD' },
        { questionId: 'a2_3', sectionId: 'activity2', studentAnswer: 'Reptile' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity2PointsEarned).toBe(3);
      expect(result.totals.activity2Total).toBe(3);
    });

    it('should score Activity 2 with incorrect categories', () => {
      const worksheet = {
        activity1: null,
        activity2: {
          items: [
            { id: 'a2_1', correctCategory: 'Mammal' },
            { id: 'a2_2', correctCategory: 'Bird' },
          ],
        },
        activity3: null,
        activity4: null,
      };

      const answers = [
        { questionId: 'a2_1', sectionId: 'activity2', studentAnswer: 'Bird' },
        { questionId: 'a2_2', sectionId: 'activity2', studentAnswer: 'Mammal' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity2PointsEarned).toBe(0);
      expect(result.totals.activity2Total).toBe(2);
    });

    it('should score Activity 3 MCQ correctly', () => {
      const worksheet = {
        activity1: null,
        activity2: null,
        activity3: {
          questions: [
            { id: 'a3_q1', correctAnswer: 'A' },
            { id: 'a3_q2', correctAnswer: 'B' },
          ],
        },
        activity4: null,
      };

      const answers = [
        { questionId: 'a3_q1', sectionId: 'activity3', studentAnswer: 'A' },
        { questionId: 'a3_q2', sectionId: 'activity3', studentAnswer: 'B' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity3PointsEarned).toBe(2);
      expect(result.totals.activity3Total).toBe(2);
    });

    it('should score Activity 4 fill-in-blanks per blank (case-insensitive)', () => {
      const worksheet = {
        activity1: null,
        activity2: null,
        activity3: null,
        activity4: {
          sentences: [
            {
              id: 'a4_s1',
              parts: [
                { type: 'text', value: 'The ' },
                { type: 'blank', blankId: 'b1', correctAnswer: 'cat' },
                { type: 'text', value: ' is ' },
                { type: 'blank', blankId: 'b2', correctAnswer: 'black' },
              ],
            },
          ],
        },
      };

      const answers = [
        { questionId: 'b1', sectionId: 'activity4', studentAnswer: 'Cat' },
        { questionId: 'b2', sectionId: 'activity4', studentAnswer: 'BLACK' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity4PointsEarned).toBe(2);
      expect(result.totals.activity4Total).toBe(2);
    });

    it('should score Activity 4 with incorrect answers', () => {
      const worksheet = {
        activity1: null,
        activity2: null,
        activity3: null,
        activity4: {
          sentences: [
            {
              id: 'a4_s1',
              parts: [
                { type: 'text', value: 'The ' },
                { type: 'blank', blankId: 'b1', correctAnswer: 'cat' },
              ],
            },
          ],
        },
      };

      const answers = [
        { questionId: 'b1', sectionId: 'activity4', studentAnswer: 'dog' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity4PointsEarned).toBe(0);
      expect(result.totals.activity4Total).toBe(1);
    });

    it('should calculate total percentage correctly', () => {
      const worksheet = {
        activity1: { items: [{ id: 'a1_1', correctOrder: 1 }] },
        activity2: { items: [{ id: 'a2_1', correctCategory: 'A' }] },
        activity3: { questions: [{ id: 'a3_q1', correctAnswer: 'A' }] },
        activity4: {
          sentences: [{ parts: [{ type: 'blank', blankId: 'b1', correctAnswer: 'cat' }] }],
        },
      };

      const answers = [
        { questionId: 'slot_0', sectionId: 'activity1', studentAnswer: 'a1_1' },
        { questionId: 'a2_1', sectionId: 'activity2', studentAnswer: 'A' },
        { questionId: 'a3_q1', sectionId: 'activity3', studentAnswer: 'A' },
        { questionId: 'b1', sectionId: 'activity4', studentAnswer: 'cat' },
      ];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.totalPointsEarned).toBe(4);
      expect(result.totals.totalPointsPossible).toBe(4);
      expect(result.totals.percentage).toBe(100);
    });

    it('should handle missing worksheet sections gracefully', () => {
      const worksheet = {
        activity1: null,
        activity2: null,
        activity3: null,
        activity4: null,
      };

      const answers = [];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.totalPointsEarned).toBe(0);
      expect(result.totals.totalPointsPossible).toBe(0);
      expect(result.totals.percentage).toBe(0);
    });

    it('should handle empty answers array', () => {
      const worksheet = {
        activity1: { items: [{ id: 'a1_1', correctOrder: 1 }] },
        activity2: null,
        activity3: null,
        activity4: null,
      };

      const answers = [];

      const result = gradeWorksheetAnswers({ worksheet, answers });

      expect(result.totals.activity1PointsEarned).toBe(0);
      expect(result.totals.activity1Total).toBe(1);
    });
  });

  describe('buildCanonicalAnswerSheet', () => {
    it('should build canonical answer sheet for all activities', () => {
      const worksheet = {
        activity1: {
          items: [{ id: 'a1_1', correctOrder: 1 }],
        },
        activity2: {
          items: [{ id: 'a2_1', correctCategory: 'A' }],
        },
        activity3: {
          questions: [{ id: 'a3_q1', correctAnswer: 'B' }],
        },
        activity4: {
          sentences: [{ parts: [{ type: 'blank', blankId: 'b1', correctAnswer: 'cat' }] }],
        },
      };

      const answersBySection = {
        activity1: [{ questionId: 'slot_0', studentAnswer: 'a1_1' }],
        activity2: [{ questionId: 'a2_1', studentAnswer: 'A' }],
        activity3: [{ questionId: 'a3_q1', studentAnswer: 'B' }],
        activity4: [{ questionId: 'b1', studentAnswer: 'cat' }],
      };

      const result = buildCanonicalAnswerSheet({ worksheet, answersBySection });

      expect(result).toBeDefined();
      expect(result.activity1).toBeDefined();
      expect(result.activity2).toBeDefined();
      expect(result.activity3).toBeDefined();
      expect(result.activity4).toBeDefined();
    });
  });
});
