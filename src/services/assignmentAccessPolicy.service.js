'use strict';

const { normalizePractice, questionAttemptKey } = require('../utils/adaptivePracticeQuestions');

const MARK_KEYS = new Set([
  'score',
  'scoreOutOf5',
  'overallScore',
  'grade',
  'percentage',
  'earnedPoints',
  'weightedPoints',
  'configuredLevelPercentage',
  'selectedLevel'
]);

function showMarksToStudent(assignment) {
  return !assignment || assignment.showMarksToStudent !== false;
}

function redactMarkFields(value) {
  if (Array.isArray(value)) return value.map(redactMarkFields);
  if (!value || typeof value !== 'object') return value;

  // Preserve ObjectIds, Dates, Buffers, and other serializable class values.
  // Recursing into them would turn identifiers into implementation details.
  if (
    value instanceof Date ||
    Buffer.isBuffer(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return value;
  }

  const redacted = {};
  for (const [key, nested] of Object.entries(value)) {
    if (MARK_KEYS.has(key) || key === 'overriddenScores') continue;
    redacted[key] = redactMarkFields(nested);
  }
  return redacted;
}

function redactStudentMarks(payload) {
  const redacted = {
    ...redactMarkFields(payload),
    marksVisible: false
  };
  redacted.previousEvaluation = null;
  return redacted;
}

function sanitizeAdaptiveSession(session, marksVisible, revealedQuestionKeys = []) {
  if (!session) return session;
  const safe = session && typeof session.toObject === 'function' ? session.toObject() : { ...session };
  const revealed = new Set(Array.from(revealedQuestionKeys || [], String));
  safe.activities = Array.isArray(safe.activities) ? safe.activities.map((activity) => {
    const normalized = normalizePractice(activity);
    const legacy = !(Array.isArray(activity.questions) && activity.questions.length);
    const publicActivity = { ...normalized };
    delete publicActivity.correctOptionId;
    delete publicActivity.acceptedAnswers;
    delete publicActivity.modelAnswer;
    publicActivity.questions = normalized.questions.map((question) => {
      const publicQuestion = { ...question };
      delete publicQuestion.correctOptionId;
      delete publicQuestion.acceptedAnswers;
      if (!revealed.has(questionAttemptKey(activity.activityId, question.questionId, legacy))) delete publicQuestion.modelAnswer;
      return publicQuestion;
    });
    // Temporary response-only bridge for older frontends; canonical persistence is never duplicated.
    const first = publicActivity.questions[0];
    for (const field of ['questionType', 'task', 'tip', 'checklist', 'options', 'caseSensitive']) {
      if (publicActivity[field] === undefined && first?.[field] !== undefined) publicActivity[field] = first[field];
    }
    if (first?.modelAnswer !== undefined && publicActivity.modelAnswer === undefined) publicActivity.modelAnswer = first.modelAnswer;
    return publicActivity;
  }) : [];
  if (!marksVisible && safe.sourceSnapshot) {
    safe.sourceSnapshot = {
      transcriptFingerprint: safe.sourceSnapshot.transcriptFingerprint,
      feedbackId: safe.sourceSnapshot.feedbackId,
      feedbackUpdatedAt: safe.sourceSnapshot.feedbackUpdatedAt
    };
  }
  return safe;
}

module.exports = {
  showMarksToStudent,
  redactStudentMarks,
  sanitizeAdaptiveSession
};
