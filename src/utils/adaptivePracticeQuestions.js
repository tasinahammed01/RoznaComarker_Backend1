'use strict';

const LEGACY_QUESTION_ID = 'legacy-q1';

const QUESTION_FIELDS = Object.freeze([
  'questionId', 'questionType', 'task', 'tip', 'checklist', 'modelAnswer', 'options',
  'correctOptionId', 'acceptedAnswers', 'caseSensitive', 'explanation'
]);

function plain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value;
}

function normalizePractice(activity) {
  const source = plain(activity) || {};
  const canonical = Array.isArray(source.questions) && source.questions.length
    ? source.questions.map((question) => ({ ...plain(question) }))
    : [{ questionId: LEGACY_QUESTION_ID, questionType: source.questionType || 'open_response', ...Object.fromEntries(QUESTION_FIELDS
      .filter((field) => field !== 'questionId' && source[field] !== undefined)
      .map((field) => [field, source[field]])) }];
  return { ...source, questions: canonical };
}

function questionAttemptKey(activityId, questionId, legacy = false) {
  return legacy ? String(activityId) : `${String(activityId)}::${String(questionId)}`;
}

function resolvePracticeQuestion(activity, questionId) {
  const practice = normalizePractice(activity);
  const legacy = !(Array.isArray(plain(activity)?.questions) && plain(activity).questions.length);
  const requested = String(questionId || '').trim();
  const question = requested
    ? practice.questions.find((item) => String(item.questionId) === requested)
    : practice.questions.length === 1 ? practice.questions[0] : null;
  return question ? { practice, question, legacy,
    attemptActivityId: questionAttemptKey(practice.activityId, question.questionId, legacy) } : null;
}

module.exports = { LEGACY_QUESTION_ID, QUESTION_FIELDS, normalizePractice, questionAttemptKey, resolvePracticeQuestion };
