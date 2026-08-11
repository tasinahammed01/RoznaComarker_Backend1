const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const mongoose = require('mongoose');
const {
  showMarksToStudent,
  redactStudentMarks,
  sanitizeAdaptiveSession
} = require('../src/services/assignmentAccessPolicy.service');

describe('Phase 2 access policy units', () => {
  test('assignment defaults preserve historical behavior', () => {
    const assignment = new Assignment();
    expect(assignment.showMarksToStudent).toBe(true);
    expect(assignment.allowResubmission).toBe(false);
    expect(assignment.requireAdaptiveBeforeResubmission).toBe(false);
    expect(showMarksToStudent(undefined)).toBe(true);
    expect(showMarksToStudent({})).toBe(true);
    expect(showMarksToStudent({ showMarksToStudent: false })).toBe(false);
  });

  test('canonical one-submission index remains unique', () => {
    expect(Submission.schema.indexes()).toEqual(expect.arrayContaining([
      [{ student: 1, assignment: 1 }, expect.objectContaining({ unique: true })]
    ]));
  });

  test('redacts nested marks without removing written feedback or correction counts', () => {
    const submissionId = new mongoose.Types.ObjectId();
    const createdAt = new Date('2026-08-10T00:00:00.000Z');
    const redacted = redactStudentMarks({
      _id: submissionId,
      createdAt,
      overallScore: 84,
      grade: 'B',
      teacherComments: 'Keep revising.',
      correctionStatistics: { grammar: 2 },
      rubricScores: { CONTENT: { score: 17, maxScore: 20, comment: 'Clear ideas.' } },
      aiFeedback: { perCategory: [{ scoreOutOf5: 4, message: 'Use stronger evidence.' }] },
      previousEvaluation: { overallScore: 72 }
    });
    expect(redacted).toMatchObject({
      _id: submissionId,
      createdAt,
      marksVisible: false,
      teacherComments: 'Keep revising.',
      correctionStatistics: { grammar: 2 },
      rubricScores: { CONTENT: { maxScore: 20, comment: 'Clear ideas.' } },
      aiFeedback: { perCategory: [{ message: 'Use stronger evidence.' }] },
      previousEvaluation: null
    });
    expect(redacted.overallScore).toBeUndefined();
    expect(redacted.rubricScores.CONTENT.score).toBeUndefined();
  });

  test('removes adaptive source marks while retaining generated activities', () => {
    const session = sanitizeAdaptiveSession({
      sourceSnapshot: { transcriptFingerprint: 'hash', feedbackId: 'feedback', feedbackUpdatedAt: 'now',
        skills: [{ id: 'CONTENT', earnedPoints: 10, maximumPoints: 20, percentage: 50 }] },
      activities: [{ activityId: 'a1', title: 'Revise evidence' }]
    }, false);
    expect(session.sourceSnapshot.skills).toBeUndefined();
    expect(session.activities).toHaveLength(1);
  });

  test('redacts adaptive answer keys and unrevealed model answers from student sessions', () => {
    const session = sanitizeAdaptiveSession({ activities: [
      { activityId: 'mcq', questionType: 'mcq', options: [{ id: 'A', text: 'One' }], correctOptionId: 'A', modelAnswer: 'One' },
      { activityId: 'blank', questionType: 'fill_blank', acceptedAnswers: ['answer'], modelAnswer: 'answer' },
      { activityId: 'open', modelAnswer: 'Safe after attempt' }
    ] }, true, ['open']);
    expect(session.activities[0]).toEqual(expect.objectContaining({ options: [{ id: 'A', text: 'One' }] }));
    expect(session.activities[0].correctOptionId).toBeUndefined();
    expect(session.activities[1].acceptedAnswers).toBeUndefined();
    expect(session.activities[0].modelAnswer).toBeUndefined();
    expect(session.activities[2].modelAnswer).toBe('Safe after attempt');
  });
});
