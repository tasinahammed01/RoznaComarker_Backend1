'use strict';
/**
 * The verbatim-page reply (prompt mode verbatim-json): the model separates what the student wrote into
 *   question_lines   the assignment question the student copied by hand (never graded)
 *   answer_lines     the student's answer, one entry per physical line (the only text that is graded)
 *   struck_through   crossed-out text, kept for audit and never graded      { line, text }
 *   uncertain        low-confidence words with the model's best reading      { line, word }
 *   name_present     whether a student name was written; the name itself is never requested or kept
 *
 * Parsing is strict. Anything that does not fit is a schema failure and gives NO transcript, never a partial one.
 * Uncertain words flag the page for teacher review; they do not reject it. This module calls no model and reads no files.
 */
const contract = require('../../../src/services/gptVisionExact/contract.js');
const { pieces } = require('./candidates.cjs');

const VERBATIM_VERSION = 'verbatim-page-v1';
const MAX_LINE_CHARS = 2000; // the production evidence limit per segment
const MAX_ANSWER_LINES = 300, MAX_QUESTION_LINES = 40, MAX_ITEMS = 300, MAX_WORD_CHARS = 200;

// Only widely supported keywords (type, properties, required, additionalProperties, items, enum): some providers reject
// bounds such as minimum or maxLength in strict mode. The limits above are enforced in code instead.
const closed = properties => ({ type: 'object', additionalProperties: false, required: Object.keys(properties), properties });
const VERBATIM_SCHEMA = closed({
  version: { type: 'string', enum: [VERBATIM_VERSION] },
  name_present: { type: 'boolean' },
  question_lines: { type: 'array', items: { type: 'string' } },
  answer_lines: { type: 'array', items: { type: 'string' } },
  struck_through: { type: 'array', items: closed({ line: { type: 'integer' }, text: { type: 'string' } }) },
  uncertain: { type: 'array', items: closed({ line: { type: 'integer' }, word: { type: 'string' } }) },
});

// v2 (experiment B): crossed-out text is listed BEFORE the answer is written, so the model decides what to leave out first. struck_through
// items therefore carry no line number (the answer does not exist yet) but the word written just before them. Crossed-out items are advisory.
const VERBATIM_V2_VERSION = 'verbatim-page-v2';
const VERBATIM_V2_SCHEMA = closed({
  version: { type: 'string', enum: [VERBATIM_V2_VERSION] },
  name_present: { type: 'boolean' },
  question_lines: { type: 'array', items: { type: 'string' } },
  struck_through: { type: 'array', items: closed({ text: { type: 'string' }, after_word: { type: 'string' } }) },
  answer_lines: { type: 'array', items: { type: 'string' } },
  uncertain: { type: 'array', items: closed({ line: { type: 'integer' }, word: { type: 'string' } }) },
});

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const hasExactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validText = (value, max) => typeof value === 'string' && value.length <= max && !/[\r\n\f\u0000]/u.test(value) && value.isWellFormed();
const coreWord = word => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
const fail = (reason, status = 'invalid_json', code = 'OCR_GPT_SOURCE_SCHEMA') => ({ ok: false, status, code, reason });

/** { ok: true, value } or { ok: false, status, code, reason }. `reason` is a fixed sentence: it never contains page text. */
function parseVerbatim(content) {
  let value;
  try { value = JSON.parse(content); } catch { return fail('The reply is not valid JSON.'); }
  if (!hasExactKeys(value, Object.keys(VERBATIM_SCHEMA.properties))) return fail('The reply does not have exactly the expected fields.');
  if (value.version !== VERBATIM_VERSION) return fail('The reply has the wrong version.');
  if (typeof value.name_present !== 'boolean') return fail('name_present must be true or false.');
  const lines = (list, max) => Array.isArray(list) && list.length <= max && list.every(line => validText(line, MAX_LINE_CHARS));
  if (!lines(value.question_lines, MAX_QUESTION_LINES)) return fail('question_lines must be a short list of single-line text.');
  if (!lines(value.answer_lines, MAX_ANSWER_LINES)) return fail('answer_lines must be a list of single-line text (at most 300 lines).');
  const count = value.answer_lines.length;
  if (!Array.isArray(value.struck_through) || value.struck_through.length > MAX_ITEMS
    || !value.struck_through.every(item => hasExactKeys(item, ['line', 'text']) && Number.isInteger(item.line) && item.line >= -1 && item.line < count && validText(item.text, MAX_LINE_CHARS))) {
    return fail('struck_through has an invalid item or a line number outside the answer.');
  }
  // "uncertain" is advisory: an item that is malformed, points outside the answer or names a word that is not on its line is dropped and
  // counted (same rule as production), never a reason to reject the page. Only a field that is not a list is invalid.
  if (!Array.isArray(value.uncertain) || value.uncertain.length > MAX_ITEMS) return fail('uncertain must be a list.');
  const kept = value.uncertain.filter(item => {
    if (!(hasExactKeys(item, ['line', 'word']) && Number.isInteger(item.line) && item.line >= 0 && item.line < count && validText(item.word, MAX_WORD_CHARS) && item.word.trim() !== '')) return false;
    const wanted = item.word.trim();
    return value.answer_lines[item.line].split(/\s+/u).some(token => token === wanted || (coreWord(token) !== '' && coreWord(token) === coreWord(wanted)));
  });
  if (!value.answer_lines.some(line => line.trim())) return fail('The answer has no text.', 'empty', 'OCR_GPT_SOURCE_EMPTY');
  return { ok: true, value: { ...value, uncertain: kept }, uncertainDropped: value.uncertain.length - kept.length };
}

/** v2 reply: same rules as parseVerbatim, with struck_through items { text, after_word } that are advisory (a malformed one is dropped and counted). */
function parseVerbatimV2(content) {
  let value;
  try { value = JSON.parse(content); } catch { return fail('The reply is not valid JSON.'); }
  if (!hasExactKeys(value, Object.keys(VERBATIM_V2_SCHEMA.properties))) return fail('The reply does not have exactly the expected fields.');
  if (value.version !== VERBATIM_V2_VERSION) return fail('The reply has the wrong version.');
  if (typeof value.name_present !== 'boolean') return fail('name_present must be true or false.');
  const lines = (list, max) => Array.isArray(list) && list.length <= max && list.every(line => validText(line, MAX_LINE_CHARS));
  if (!lines(value.question_lines, MAX_QUESTION_LINES)) return fail('question_lines must be a short list of single-line text.');
  if (!lines(value.answer_lines, MAX_ANSWER_LINES) || value.question_lines.length + value.answer_lines.length > 300) return fail('answer_lines must be a list of single-line text (at most 300 lines).');
  if (!Array.isArray(value.struck_through) || value.struck_through.length > MAX_ITEMS) return fail('struck_through must be a list.');
  if (!Array.isArray(value.uncertain) || value.uncertain.length > MAX_ITEMS) return fail('uncertain must be a list.');
  const struck = value.struck_through.filter(item => hasExactKeys(item, ['text', 'after_word']) && validText(item.text, MAX_LINE_CHARS) && validText(item.after_word, MAX_WORD_CHARS));
  const count = value.answer_lines.length;
  const uncertain = value.uncertain.filter(item => {
    if (!(hasExactKeys(item, ['line', 'word']) && Number.isInteger(item.line) && item.line >= 0 && item.line < count && validText(item.word, MAX_WORD_CHARS) && item.word.trim() !== '')) return false;
    const wanted = item.word.trim();
    return value.answer_lines[item.line].split(/\s+/u).some(token => token === wanted || (coreWord(token) !== '' && coreWord(token) === coreWord(wanted)));
  });
  if (!value.answer_lines.some(line => line.trim())) return fail('The answer has no text.', 'empty', 'OCR_GPT_SOURCE_EMPTY');
  return { ok: true, value: { ...value, struck_through: struck, uncertain }, uncertainDropped: value.uncertain.length - uncertain.length, struckDropped: value.struck_through.length - struck.length };
}

const textLines = lines => lines.map(line => line.trim()).filter(Boolean);

/** What marking would see (answer), what is kept apart (question), the scored full transcription and review flags. */
function verbatimParts(value) {
  const answerLines = textLines(value.answer_lines), questionLines = textLines(value.question_lines);
  return {
    answerText: answerLines.join('\n'), questionText: questionLines.join('\n'), text: [...questionLines, ...answerLines].join('\n'),
    struckCount: value.struck_through.length, uncertainCount: value.uncertain.length, questionLineCount: questionLines.length, namePresent: value.name_present,
  };
}

/**
 * The production "wire" evidence for the same page, so the production validators decide acceptance. Question lines are
 * non-active (PROMPT_OR_INSTRUCTION). Crossed-out and uncertain items are NOT placed in the evidence here: they are
 * reported separately, and uncertain words never block the page.
 */
function verbatimToWire(value) {
  const segments = (lines, classification) => textLines(lines).map(line => ({
    segments: pieces(line).map(text => ({ classification, text, confidence: 1 })) }));
  return JSON.stringify({ version: contract.QWEN_WIRE_VERSION,
    physicalLines: [...segments(value.question_lines, 'PROMPT_OR_INSTRUCTION'), ...segments(value.answer_lines, 'STUDENT_ACTIVE_TEXT')], uncertainties: [] });
}

module.exports = { VERBATIM_VERSION, VERBATIM_SCHEMA, VERBATIM_V2_VERSION, VERBATIM_V2_SCHEMA, parseVerbatim, parseVerbatimV2, verbatimParts, verbatimToWire };
