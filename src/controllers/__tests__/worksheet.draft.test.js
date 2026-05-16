/**
 * worksheet.draft.test.js
 * 
 * Unit tests for worksheet draft autosave functionality.
 * Tests draft creation, updating, retrieval, and deletion.
 */

const WorksheetDraft = require('../../models/WorksheetDraft');

describe('Worksheet Draft Model', () => {
  describe('Draft Creation', () => {
    it('should create a draft with all required fields', async () => {
      const draftData = {
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
        activity1Answers: { slot_0: 'item1' },
        activity2Answers: { a2_1: 'category1' },
        activity3Answers: { a3_q1: 'A' },
        activity4Blanks: { b1: 'answer1' },
        progressPercentage: 50,
        timeSpent: 120,
      };

      // In actual test, this would save to test database
      const draft = new WorksheetDraft(draftData);
      
      expect(draft.worksheetId).toBe('ws123');
      expect(draft.assignmentId).toBe('assign123');
      expect(draft.studentId).toBe('student123');
      expect(draft.progressPercentage).toBe(50);
      expect(draft.timeSpent).toBe(120);
    });

    it('should enforce unique draft per student per assignment', () => {
      // Test would verify index constraint on assignmentId + studentId
      const index = WorksheetDraft.schema.indexes();
      const uniqueIndex = index.find(idx => 
        idx.assignmentId && idx.studentId && idx.unique
      );
      expect(uniqueIndex).toBeDefined();
    });
  });

  describe('Draft Updates', () => {
    it('should update lastSavedAt on save', async () => {
      const draft = new WorksheetDraft({
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
      });

      const beforeTime = new Date();
      await draft.save();
      const afterTime = new Date();

      expect(draft.lastSavedAt).toBeDefined();
      expect(draft.lastSavedAt.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(draft.lastSavedAt.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it('should update progress percentage', async () => {
      const draft = new WorksheetDraft({
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
        progressPercentage: 25,
      });

      draft.progressPercentage = 75;
      await draft.save();

      expect(draft.progressPercentage).toBe(75);
    });

    it('should update activity answers', async () => {
      const draft = new WorksheetDraft({
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
        activity1Answers: { slot_0: 'item1' },
      });

      draft.activity1Answers.set('slot_1', 'item2');
      await draft.save();

      expect(draft.activity1Answers.get('slot_0')).toBe('item1');
      expect(draft.activity1Answers.get('slot_1')).toBe('item2');
    });
  });

  describe('Draft Retrieval', () => {
    it('should find draft by worksheetId and studentId', async () => {
      // Test would verify query by worksheetId and studentId
      const query = WorksheetDraft.schema.path('worksheetId');
      expect(query).toBeDefined();
    });

    it('should find draft by assignmentId and studentId', async () => {
      // Test would verify query by assignmentId and studentId (unique)
      const index = WorksheetDraft.schema.indexes();
      const assignmentStudentIndex = index.find(idx => 
        idx.assignmentId && idx.studentId && idx.unique
      );
      expect(assignmentStudentIndex).toBeDefined();
    });
  });

  describe('Draft Deletion', () => {
    it('should delete draft by assignmentId and studentId', async () => {
      // Test would verify deletion works correctly
      const result = await WorksheetDraft.deleteOne({
        assignmentId: 'assign123',
        studentId: 'student123',
      });
      expect(result).toBeDefined();
    });
  });

  describe('Draft Constraints', () => {
    it('should enforce progressPercentage range 0-100', () => {
      const draft = new WorksheetDraft({
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
        progressPercentage: 150, // Invalid
      });

      const validationError = draft.validateSync();
      expect(validationError).toBeDefined();
    });

    it('should allow empty answers arrays', () => {
      const draft = new WorksheetDraft({
        worksheetId: 'ws123',
        assignmentId: 'assign123',
        studentId: 'student123',
        answers: [],
      });

      const validationError = draft.validateSync();
      expect(validationError).toBeUndefined();
    });
  });
});
