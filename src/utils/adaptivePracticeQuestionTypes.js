'use strict';

const CANONICAL_QUESTION_TYPES = Object.freeze(['open_response', 'mcq', 'fill_blank']);

const QUESTION_TYPE_ALIASES = Object.freeze({
  open_response: 'open_response',
  written_response: 'open_response',
  writtenResponse: 'open_response',
  rewrite: 'open_response',
  mcq: 'mcq',
  multiple_choice: 'mcq',
  multipleChoice: 'mcq',
  fill_blank: 'fill_blank',
  fillInBlank: 'fill_blank',
  fill_in_blank: 'fill_blank'
});

const SKILL_QUESTION_TYPES = Object.freeze({
  CONTENT: Object.freeze(['open_response', 'mcq', 'fill_blank']),
  ORGANIZATION: Object.freeze(['mcq', 'fill_blank', 'open_response']),
  VOCABULARY: Object.freeze(['fill_blank', 'mcq', 'open_response']),
  GRAMMAR: Object.freeze(['fill_blank', 'mcq', 'open_response']),
  MECHANICS: Object.freeze(['mcq', 'fill_blank', 'open_response'])
});

function normalizeQuestionType(value, fallback = 'open_response') {
  return QUESTION_TYPE_ALIASES[String(value || '').trim()] || fallback;
}

function allowedQuestionTypes(skillId) {
  return SKILL_QUESTION_TYPES[String(skillId)] || Object.freeze(['open_response']);
}

function isCompatibleQuestionType(skillId, questionType) {
  return allowedQuestionTypes(skillId).includes(normalizeQuestionType(questionType, ''));
}

function progressionForPercentage(percentage) {
  const score = Number(percentage);
  if (!Number.isFinite(score) || score < 50) {
    return { difficulty: 'foundational', stage: 'recognize-or-complete' };
  }
  if (score < 65) return { difficulty: 'developing', stage: 'complete-or-produce' };
  return { difficulty: 'proficient', stage: 'produce' };
}

module.exports = {
  CANONICAL_QUESTION_TYPES,
  QUESTION_TYPE_ALIASES,
  SKILL_QUESTION_TYPES,
  normalizeQuestionType,
  allowedQuestionTypes,
  isCompatibleQuestionType,
  progressionForPercentage
};
