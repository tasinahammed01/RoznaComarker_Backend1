'use strict';
// Speaking Coach: every piece of text a student or guest reads (task wording, tips, what improved, what to work on, the next tip). Simple, short
// English, never a score, grade, level or anything about the process. The teacher comment draft's ideas, reused as is:
//   1. content problems are rejected before anything is changed (a score-like number: a mark written as words would still be a mark);
//   2. formatting is repaired deterministically (repairDraft: digits to words, markup, list markers, line breaks, a final full stop);
//   3. the strict check runs on the repaired text (strictRuleOf), then the coach's own rules: forbidden words, the rubric's level titles,
//      length, and sentence length.
// A rejection carries a code only (COACH_TEXT_*), never the text.
const { repairDraft, strictRuleOf } = require('../teacherCommentDraft.service');

const SCORE_LIKE_NUMBER = /\d\s*(?:%|percent\b|marks?\b|points?\b|pts\b)|\d[.,]\d|\d\s*\/\s*\d|\bout of\s+(?:\d+|ten|twenty|fifty|one hundred|a hundred|hundred)\b/iu;
// Words a student must never read in practice feedback: levels, pass or fail, marks, and what speech-to-text text cannot judge.
const FORBIDDEN_WORDS = /\b(?:levels?|percent(?:age)?s?|pass(?:es|ed|ing)?|fail(?:s|ed|ing|ure)?|marks?|marked|points?|pronunci\w*|accents?|intonation|spell\w*|punctuat\w*|capitali[sz]\w*|transcri\w*|speech-to-text|recording quality|machine)\b/iu;
const MAX_SENTENCE_WORDS = 25;
const MIN_WORDS = 2;

const rejected = code => Object.assign(new Error(code), { code });
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const coachCode = code => String(code || 'COACH_TEXT_INVALID').replace(/^TEACHER_COMMENT_/u, 'COACH_TEXT_');

/**
 * The checked text, or a rejection { code }. options: max (characters, default 240), forbiddenWords (the rubric's level titles: rejected as
 * whole words in any case). Returns { text, repairedRules }.
 */
function checkCoachText(value, { max = 240, forbiddenWords = [] } = {}) {
  if (typeof value !== 'string' || !value.trim()) throw rejected('COACH_TEXT_EMPTY');
  const original = value.trim();
  if (SCORE_LIKE_NUMBER.test(original)) throw rejected('COACH_TEXT_SCORE_LIKE_NUMBER');
  const { text, repairedRules } = repairDraft(original);
  if (text.length > max) throw rejected('COACH_TEXT_TOO_LONG');
  if (text.split(/\s+/u).filter(Boolean).length < MIN_WORDS) throw rejected('COACH_TEXT_TOO_SHORT');
  const broken = strictRuleOf(text);
  if (broken) throw rejected(coachCode(broken));
  if (FORBIDDEN_WORDS.test(text)) throw rejected('COACH_TEXT_FORBIDDEN_WORD');
  const titles = forbiddenWords.map(word => String(word || '').trim()).filter(Boolean);
  if (titles.some(title => new RegExp(`(?<![\\p{L}\\p{N}])${escape(title)}(?![\\p{L}\\p{N}])`, 'iu').test(text))) throw rejected('COACH_TEXT_LEVEL_TITLE');
  if (text.split(/(?<=[.!?])\s+/u).some(sentence => sentence.split(/\s+/u).filter(Boolean).length > MAX_SENTENCE_WORDS)) {
    throw rejected('COACH_TEXT_SENTENCE_TOO_LONG');
  }
  return { text, repairedRules };
}

/** The rule a retry names (never the rejected text). */
const RETRY_REASONS = Object.freeze({
  COACH_TEXT_SCORE_LIKE_NUMBER: 'it contained a number that looks like a mark or a percentage; leave all marks out.',
  COACH_TEXT_FORBIDDEN_TERM: 'it used a word that is not allowed; never mention scores, grades, rubrics, AI or the process.',
  COACH_TEXT_FORBIDDEN_WORD: 'it used a word that is not allowed; never mention levels, passing, failing, marks, pronunciation, accent, spelling or transcripts.',
  COACH_TEXT_LEVEL_TITLE: 'it used one of the rubric level names; describe the speaking in other words.',
  COACH_TEXT_TOO_LONG: 'a text was too long; keep every text short.',
  COACH_TEXT_SENTENCE_TOO_LONG: 'a sentence was too long; use short sentences.',
  COACH_TEXT_TOO_SHORT: 'a text was too short; write a full short sentence.',
  COACH_TEXT_EMPTY: 'a text was empty.'
});
const retryLine = code => (RETRY_REASONS[code] ? `Your previous reply was rejected because ${RETRY_REASONS[code]}` : '');

module.exports = { checkCoachText, retryLine, FORBIDDEN_WORDS, MAX_SENTENCE_WORDS };
