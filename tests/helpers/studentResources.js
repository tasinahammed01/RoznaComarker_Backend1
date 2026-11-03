'use strict';
// Student-visible resources the annotation fixture does not have: a worksheet and a flashcard set, each assigned to the class and each created
// by the fixture teacher, a worksheet submission and draft, a flashcard submission and progress, a public share link, and a ready adaptive practice
// session. Every one of them carries the teacher's id where the real schema does (createdBy, ownerId), so a scan for that id means something.
// Used by tests/studentTeacherIdentity.test.js. Synthetic text only.
const mongoose = require('mongoose');

const id = hex => new mongoose.Types.ObjectId(hex.padStart(24, '0'));
const RESOURCE_IDS = { worksheet: id('c0a1'), flashcards: id('c0a2'), worksheetAssignment: id('d0a1'), flashcardAssignment: id('d0a2'),
  adaptiveSession: id('ad01'), worksheetSubmission: id('c0b1'), flashcardSubmission: id('c0b2') };
const SHARE_TOKEN = 'fixture-share-token-0001';
const SECRETS = { worksheetSource: 'TEACHER-SOURCE-CONTENT', modelAnswer: 'MODEL-ANSWER-KEY' };

async function seedStudentResources(fixture) {
  const Worksheet = require('../../src/models/Worksheet');
  const WorksheetSubmission = require('../../src/models/WorksheetSubmission');
  const WorksheetDraft = require('../../src/models/WorksheetDraft');
  const FlashcardSet = require('../../src/models/FlashcardSet');
  const FlashcardSubmission = require('../../src/models/FlashcardSubmission');
  const StudentFlashcardProgress = require('../../src/models/StudentFlashcardProgress');
  const Assignment = require('../../src/models/assignment.model');
  const AdaptivePracticeSession = require('../../src/models/AdaptivePracticeSession');
  const AdaptivePracticeAttempt = require('../../src/models/AdaptivePracticeAttempt');
  const SubmissionFeedback = require('../../src/models/SubmissionFeedback');
  const { IDS } = fixture, teacher = fixture.teacher._id, student = fixture.student._id;

  const worksheet = await Worksheet.create({ _id: RESOURCE_IDS.worksheet, title: 'Fixture worksheet', description: 'A worksheet.', createdBy: teacher,
    assignmentDeadline: new Date('2099-01-01T00:00:00.000Z'), isPublished: true, shareToken: 'worksheet-share-0001', sourceContent: SECRETS.worksheetSource,
    answerKey: { q1: 'A', modelAnswer: SECRETS.modelAnswer },
    activities: [{ type: 'multiple-choice', title: 'Choose', instructions: 'Pick one.', order: 0,
      data: { questions: [{ id: 'q1', question: 'Which?', options: ['A', 'B'], correctAnswer: 'A', modelAnswer: SECRETS.modelAnswer }] } }] });
  const worksheetAssignment = await Assignment.create({ _id: RESOURCE_IDS.worksheetAssignment, title: 'Worksheet task', class: IDS.class, teacher,
    resourceType: 'worksheet', resourceId: String(worksheet._id), qrToken: 'fixture-worksheet-qr', instructions: 'Do it.' });
  await WorksheetSubmission.create({ _id: RESOURCE_IDS.worksheetSubmission, worksheetId: worksheet._id, assignmentId: worksheetAssignment._id, studentId: student,
    answers: [], score: 1, totalPoints: 1 });
  await WorksheetDraft.create({ worksheetId: worksheet._id, assignmentId: worksheetAssignment._id, studentId: student });

  const flashcards = await FlashcardSet.create({ _id: RESOURCE_IDS.flashcards, title: 'Fixture cards', description: 'Cards.', ownerId: teacher, visibility: 'private',
    assignedClasses: [IDS.class], shareToken: SHARE_TOKEN, isPublic: true, cards: [{ front: 'cat', back: 'a small animal', order: 0 }, { front: 'dog', back: 'another', order: 1 }] });
  const flashcardAssignment = await Assignment.create({ _id: RESOURCE_IDS.flashcardAssignment, title: 'Cards task', class: IDS.class, teacher,
    resourceType: 'flashcard', resourceId: String(flashcards._id), qrToken: 'fixture-flashcard-qr', instructions: 'Study.' });
  await FlashcardSubmission.create({ _id: RESOURCE_IDS.flashcardSubmission, flashcardSetId: flashcards._id, userId: student, assignmentId: flashcardAssignment._id,
    totalCards: 2, score: 50 });
  await StudentFlashcardProgress.create({ studentId: student, flashcardSetId: flashcards._id, assignmentId: flashcardAssignment._id, classId: IDS.class, totalCards: 2 });

  // A ready practice session for the registered submission, reachable through the real GET: its source is what the service itself computes.
  await SubmissionFeedback.collection.updateOne({ submissionId: IDS.registered }, { $set: { 'rubricScores.GRAMMAR.score': 5 } });
  const submission = await require('../../src/models/Submission').findById(IDS.registered).lean();
  await SubmissionFeedback.collection.updateOne({ submissionId: IDS.registered }, { $set: { evaluationSourceHash: submission.correctionSourceHash } });
  const practice = require('../../src/services/adaptivePractice.service');
  const source = await practice.loadOwnedSource(IDS.registered, student);
  const session = await AdaptivePracticeSession.create({ _id: RESOURCE_IDS.adaptiveSession, submissionId: IDS.registered, studentId: student, assignmentId: IDS.assignment,
    status: 'ready', sourceFingerprint: source.sourceFingerprint, sourceSnapshot: { transcriptFingerprint: source.transcriptFingerprint, feedbackId: source.feedback._id,
      feedbackUpdatedAt: source.feedback.updatedAt, skills: source.assessedSkills, sourceEvaluation: source.sourceEvaluation },
    targetSkills: ['GRAMMAR'], generation: { provider: 'fixture-provider', model: 'fixture-model', promptVersion: 'fixture-prompt', metrics: { totalTokens: 123 }, errorMessage: '' },
    activities: [{ activityId: 'activity-1', skillId: 'GRAMMAR', category: 'Grammar', title: 'Practice', description: 'Fix it.', evidence: 'goes', difficulty: 'foundational',
      questions: [{ questionId: 'q1', questionType: 'mcq', task: 'Choose.', tip: 'Think.', checklist: ['One'], modelAnswer: 'go',
        options: [{ id: 'A', text: 'go' }, { id: 'B', text: 'goes' }], correctOptionId: 'A', acceptedAnswers: [], caseSensitive: false }] }] });
  // One checked attempt, as the checker stores it: its result, and who checked it with what. The model answer is revealed to the student after an attempt.
  await AdaptivePracticeAttempt.create({ sessionId: session._id, submissionId: IDS.registered, studentId: student, activityId: 'activity-1::q1', practiceId: 'activity-1', questionId: 'q1', status: 'ready', attemptNumber: 1,
    responseFingerprint: 'fixture-attempt', response: 'B', result: { score: 40, passed: false, summary: 'Try again.', modelAnswer: 'go' },
    checking: { provider: 'fixture-provider', model: 'fixture-model', promptVersion: 'fixture-prompt', startedAt: new Date(), completedAt: new Date() } });
  // The guest's own practice session, the same way (its owner is the submission, not a user).
  await SubmissionFeedback.collection.updateOne({ submissionId: IDS.guest }, { $set: { 'rubricScores.GRAMMAR.score': 5 } });
  const guestDoc = await require('../../src/models/Submission').findById(IDS.guest).lean();
  await SubmissionFeedback.collection.updateOne({ submissionId: IDS.guest }, { $set: { evaluationSourceHash: guestDoc.correctionSourceHash } });
  const guestSource = await practice.loadOwnedSource(IDS.guest, require('../../src/services/submissionAccessContext.service').guestContext(guestDoc));
  const guestSession = await AdaptivePracticeSession.create({ submissionId: IDS.guest, guestSubmissionId: IDS.guest, assignmentId: IDS.assignment, status: 'ready',
    sourceFingerprint: guestSource.sourceFingerprint, sourceSnapshot: { transcriptFingerprint: guestSource.transcriptFingerprint, feedbackId: guestSource.feedback._id,
      feedbackUpdatedAt: guestSource.feedback.updatedAt, skills: guestSource.assessedSkills, sourceEvaluation: guestSource.sourceEvaluation },
    targetSkills: ['GRAMMAR'], generation: { provider: 'fixture-provider', model: 'fixture-model', promptVersion: 'fixture-prompt' },
    activities: [{ activityId: 'activity-1', skillId: 'GRAMMAR', category: 'Grammar', title: 'Practice', description: 'Fix it.', evidence: 'goes', difficulty: 'foundational',
      questions: [{ questionId: 'q1', questionType: 'mcq', task: 'Choose.', tip: 'Think.', checklist: ['One'], modelAnswer: 'go',
        options: [{ id: 'A', text: 'go' }, { id: 'B', text: 'goes' }], correctOptionId: 'A', acceptedAnswers: [], caseSensitive: false }] }] });
  await seedInternalFields(fixture);
  return { worksheet, flashcards, worksheetAssignment, flashcardAssignment, session, guestSession, shareToken: SHARE_TOKEN };
}

/**
 * The internal fields a real pipeline run leaves on a submission and its feedback: providers, models, prompt versions, lease and retry state,
 * attempt logs and diagnostics. The annotation fixture has none of them, so without this a scan could not see them leave.
 */
async function seedInternalFields(fixture) {
  const Submission = require('../../src/models/Submission');
  const SubmissionFeedback = require('../../src/models/SubmissionFeedback');
  const attempts = [{ provider: 'fixture-provider', model: 'fixture-model', code: 'OK', durationMs: 120, totalTokens: 900 }];
  for (const submissionId of [fixture.IDS.registered, fixture.IDS.guest]) {
    await Submission.collection.updateOne({ _id: submissionId }, { $set: {
      semanticProvider: 'fixture-provider', semanticModel: 'fixture-model', semanticPromptVersion: 'fixture-prompt-v1', semanticSourceKey: 'fixture-source-key',
      semanticAttempt: 1, semanticMaxAttempts: 3, semanticErrorCode: null, correctionLegendSource: 'DATABASE', correctionLegendVersion: 'legend-v1', correctionLegendContentHash: 'legend-hash',
      deductionPolicyVersion: 'deduction-v1', analysisLeaseOwner: 'worker-fixture', analysisLeaseExpiresAt: new Date('2099-01-01T00:00:00.000Z'), analysisAttempt: 1,
      analysisErrorCode: null, languageToolStatus: 'completed', languageToolSourceHash: 'lt-hash', evaluationJobId: 'job-eval-fixture', evaluationProvider: 'fixture-provider',
      evaluationModel: 'fixture-model', evaluationAttempts: attempts, evaluationDiagnostics: { assessmentModel: 'fixture-model', promptTokens: 700 }, evaluationError: null,
      sourceHumanReviewId: 'review-fixture', ocrJobId: 'job-ocr-fixture', assessmentRunId: 'run-fixture' } });
    await SubmissionFeedback.collection.updateOne({ submissionId }, { $set: { evaluationJobId: 'job-eval-fixture', evaluationProvider: 'fixture-provider', evaluationModel: 'fixture-model',
      evaluationAttempts: attempts, evaluationPolicy: { strictness: 'balanced', scoringPolicyVersion: 'p1' }, evaluationBuiltInContextHash: 'context-hash',
      evaluationDiagnostics: { assessmentModel: 'fixture-model', promptTokens: 700 } } });
  }
}

module.exports = { seedStudentResources, seedInternalFields, RESOURCE_IDS, SHARE_TOKEN, SECRETS };
