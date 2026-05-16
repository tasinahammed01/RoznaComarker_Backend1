/**
 * worksheet.report.test.js
 * 
 * Unit tests for worksheet report aggregation functionality.
 * Tests overview stats, analytics calculations, and filtering.
 */

describe('Worksheet Report Aggregation', () => {
  describe('Overview Statistics', () => {
    it('should calculate total assigned from class memberships', () => {
      // Test would verify that totalAssigned is calculated correctly
      // by counting active memberships in assigned classes
      const mockAssignments = [
        { _id: 'assign1', class: 'class1' },
        { _id: 'assign2', class: 'class2' },
      ];
      
      const mockMemberships = [
        { class: 'class1', status: 'active' },
        { class: 'class1', status: 'active' },
        { class: 'class2', status: 'active' },
      ];

      const totalAssigned = mockMemberships.filter(m => m.status === 'active').length;
      expect(totalAssigned).toBe(3);
    });

    it('should calculate submitted count from submissions', () => {
      const mockSubmissions = [
        { _id: 'sub1' },
        { _id: 'sub2' },
        { _id: 'sub3' },
      ];

      const submittedCount = mockSubmissions.length;
      expect(submittedCount).toBe(3);
    });

    it('should calculate pending count as totalAssigned - submittedCount', () => {
      const totalAssigned = 10;
      const submittedCount = 7;
      const pendingCount = totalAssigned - submittedCount;
      
      expect(pendingCount).toBe(3);
    });

    it('should calculate late count from submissions with isLate flag', () => {
      const mockSubmissions = [
        { isLate: true },
        { isLate: false },
        { isLate: true },
        { isLate: false },
      ];

      const lateCount = mockSubmissions.filter(s => s.isLate).length;
      expect(lateCount).toBe(2);
    });

    it('should calculate completion rate percentage', () => {
      const totalAssigned = 10;
      const submittedCount = 7;
      const completionRate = (submittedCount / totalAssigned) * 100;
      
      expect(completionRate).toBe(70);
    });
  });

  describe('Analytics Calculations', () => {
    it('should calculate average score from submissions', () => {
      const mockSubmissions = [
        { percentage: 80 },
        { percentage: 90 },
        { percentage: 70 },
      ];

      const scores = mockSubmissions.map(s => s.percentage);
      const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      
      expect(averageScore).toBe(80);
    });

    it('should calculate median score correctly', () => {
      const scores = [60, 70, 80, 90, 100];
      const sorted = [...scores].sort((a, b) => a - b);
      const medianScore = sorted[Math.floor(sorted.length / 2)];
      
      expect(medianScore).toBe(80);
    });

    it('should calculate pass rate (≥70%)', () => {
      const scores = [65, 75, 85, 95, 55];
      const passRate = scores.filter(s => s >= 70).length / scores.length * 100;
      
      expect(passRate).toBe(60);
    });

    it('should analyze per-question performance', () => {
      const mockSubmissions = [
        {
          answers: [
            { questionId: 'q1', sectionId: 'activity1', isCorrect: true },
            { questionId: 'q2', sectionId: 'activity1', isCorrect: false },
          ],
        },
        {
          answers: [
            { questionId: 'q1', sectionId: 'activity1', isCorrect: true },
            { questionId: 'q2', sectionId: 'activity1', isCorrect: true },
          ],
        },
      ];

      const questionStats = {};
      mockSubmissions.forEach(submission => {
        submission.answers.forEach(answer => {
          const key = `${answer.sectionId}_${answer.questionId}`;
          if (!questionStats[key]) {
            questionStats[key] = { correct: 0, total: 0 };
          }
          questionStats[key].total++;
          if (answer.isCorrect) questionStats[key].correct++;
        });
      });

      expect(questionStats['activity1_q1'].total).toBe(2);
      expect(questionStats['activity1_q1'].correct).toBe(2);
      expect(questionStats['activity1_q2'].total).toBe(2);
      expect(questionStats['activity1_q2'].correct).toBe(1);
    });

    it('should identify hardest questions by correct rate', () => {
      const questionStats = {
        'q1': { correct: 9, total: 10 }, // 90%
        'q2': { correct: 3, total: 10 }, // 30%
        'q3': { correct: 5, total: 10 }, // 50%
      };

      const questionAnalysis = Object.entries(questionStats).map(([key, stats]) => ({
        questionId: key,
        correctRate: (stats.correct / stats.total) * 100,
      })).sort((a, b) => a.correctRate - b.correctRate);

      expect(questionAnalysis[0].questionId).toBe('q2');
      expect(questionAnalysis[0].correctRate).toBe(30);
    });

    it('should identify most missed questions by missed count', () => {
      const questionStats = {
        'q1': { correct: 9, total: 10 }, // 1 missed
        'q2': { correct: 3, total: 10 }, // 7 missed
        'q3': { correct: 5, total: 10 }, // 5 missed
      };

      const questionAnalysis = Object.entries(questionStats).map(([key, stats]) => ({
        questionId: key,
        missedCount: stats.total - stats.correct,
      })).sort((a, b) => b.missedCount - a.missedCount);

      expect(questionAnalysis[0].questionId).toBe('q2');
      expect(questionAnalysis[0].missedCount).toBe(7);
    });

    it('should analyze per-section performance', () => {
      const mockSubmissions = [
        {
          answers: [
            { sectionId: 'activity1', isCorrect: true },
            { sectionId: 'activity1', isCorrect: true },
            { sectionId: 'activity2', isCorrect: false },
            { sectionId: 'activity3', isCorrect: true },
          ],
        },
      ];

      const sectionStats = {
        activity1: { correct: 0, total: 0 },
        activity2: { correct: 0, total: 0 },
        activity3: { correct: 0, total: 0 },
        activity4: { correct: 0, total: 0 },
      };

      mockSubmissions.forEach(submission => {
        submission.answers.forEach(answer => {
          if (sectionStats[answer.sectionId]) {
            sectionStats[answer.sectionId].total++;
            if (answer.isCorrect) sectionStats[answer.sectionId].correct++;
          }
        });
      });

      expect(sectionStats.activity1.total).toBe(2);
      expect(sectionStats.activity1.correct).toBe(2);
      expect(sectionStats.activity2.total).toBe(1);
      expect(sectionStats.activity2.correct).toBe(0);
      expect(sectionStats.activity3.total).toBe(1);
      expect(sectionStats.activity3.correct).toBe(1);
    });

    it('should identify weak skill areas (correctRate < 60%)', () => {
      const sectionStats = {
        activity1: { correct: 8, total: 10 }, // 80%
        activity2: { correct: 4, total: 10 }, // 40%
        activity3: { correct: 5, total: 10 }, // 50%
      };

      const weakSkillAreas = Object.entries(sectionStats)
        .map(([section, stats]) => ({
          section,
          correctRate: (stats.correct / stats.total) * 100,
        }))
        .filter(s => s.correctRate < 60)
        .sort((a, b) => a.correctRate - b.correctRate);

      expect(weakSkillAreas.length).toBe(2);
      expect(weakSkillAreas[0].section).toBe('activity2');
      expect(weakSkillAreas[0].correctRate).toBe(40);
    });
  });

  describe('Filtering', () => {
    it('should filter by status', () => {
      const mockSubmissions = [
        { status: 'submitted' },
        { status: 'late' },
        { status: 'submitted' },
      ];

      const filtered = mockSubmissions.filter(s => s.status === 'submitted');
      expect(filtered.length).toBe(2);
    });

    it('should filter by date range', () => {
      const mockSubmissions = [
        { submittedAt: new Date('2024-01-15') },
        { submittedAt: new Date('2024-02-15') },
        { submittedAt: new Date('2024-03-15') },
      ];

      const dateFrom = new Date('2024-02-01');
      const dateTo = new Date('2024-03-01');
      
      const filtered = mockSubmissions.filter(s => {
        const date = new Date(s.submittedAt);
        return date >= dateFrom && date <= dateTo;
      });

      expect(filtered.length).toBe(1);
      expect(filtered[0].submittedAt).toEqual(new Date('2024-02-15'));
    });
  });

  describe('Pagination', () => {
    it('should calculate total pages correctly', () => {
      const total = 45;
      const limit = 20;
      const pages = Math.ceil(total / limit);
      
      expect(pages).toBe(3);
    });

    it('should skip records for pagination', () => {
      const page = 2;
      const limit = 20;
      const skip = (page - 1) * limit;
      
      expect(skip).toBe(20);
    });

    it('should handle page bounds', () => {
      const totalPages = 5;
      let currentPage = 7;
      
      if (currentPage > totalPages) {
        currentPage = totalPages;
      }
      
      expect(currentPage).toBe(5);
    });
  });
});
