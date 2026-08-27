'use strict';

const aiGateway = require('./aiGateway.service');

const NUMBER_WORDS = Object.freeze({ zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10' });

function normalizeAnswer(value) {
  return String(value || '').normalize('NFKC').toLocaleLowerCase()
    .replace(/[’‘]/gu, "'")
    .replace(/[^\p{L}\p{N}'%+./-]+/gu, ' ')
    .trim().replace(/\s+/gu, ' ');
}

function comparableTokens(value) {
  return normalizeAnswer(value).split(' ').filter(Boolean).map((token) => NUMBER_WORDS[token] || token);
}

function harmlessShortVariant(expected, student) {
  const stripArticle = (tokens) => tokens.filter((token, index) => !(index === 0 && ['a', 'an', 'the'].includes(token)));
  const a = stripArticle(comparableTokens(expected));
  const b = stripArticle(comparableTokens(student));
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length !== 1 || b.length !== 1) return false;
  const singular = (word) => word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word;
  return singular(a[0]) === singular(b[0]);
}

function localGrade(expectedAnswer, studentAnswer) {
  const expected = normalizeAnswer(expectedAnswer);
  const student = normalizeAnswer(studentAnswer);
  if (!student) return { resolved: true, correct: false, gradingMethod: 'normalized', reason: 'No answer was provided.' };
  if (expected === student) return { resolved: true, correct: true, gradingMethod: String(expectedAnswer).trim() === String(studentAnswer).trim() ? 'exact' : 'normalized', reason: 'Your answer matches the correct answer.' };
  if (harmlessShortVariant(expected, student)) return { resolved: true, correct: true, gradingMethod: 'normalized', reason: 'Your answer matches the key term.' };
  if (/^(.)\1{2,}$/u.test(student.replace(/\s/gu, '')) || (!/[\p{L}\p{N}]/u.test(student))) {
    return { resolved: true, correct: false, gradingMethod: 'normalized', reason: 'The answer does not provide a meaningful response.' };
  }
  return { resolved: false };
}

const RESPONSE_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    correct: { type: 'boolean' }, confidence: { type: 'number', minimum: 0, maximum: 1 },
    reason: { type: 'string' }, missingKeyPoints: { type: 'array', items: { type: 'string' } }
  },
  required: ['correct', 'confidence', 'reason', 'missingKeyPoints']
};

async function gradeFlashcardAnswer({ question, expectedAnswer, studentAnswer }, options = {}) {
  const local = localGrade(expectedAnswer, studentAnswer);
  if (local.resolved) return { ...local, confidence: 1, model: null, missingKeyPoints: [] };
  const result = await aiGateway.generate({
    feature: 'flashcard_answer_check', responseFormat: 'json', responseSchema: RESPONSE_SCHEMA,
    schemaName: 'flashcard_answer_check', temperature: 0, maxOutputTokens: 300,
    messages: [
      { role: 'system', content: 'Judge educational answer correctness. Accept semantic paraphrases and harmless grammar differences. Reject contradictions, vague related statements, and answers missing the required core fact. Return only the required JSON.' },
      { role: 'user', content: `Question: ${question}\nCanonical answer: ${expectedAnswer}\nStudent answer: ${studentAnswer}\nDo not grade style or spelling unless meaning changes.` }
    ],
    validate: (content) => {
      const parsed = JSON.parse(String(content).replace(/^```json\s*|\s*```$/giu, '').trim());
      if (typeof parsed.correct !== 'boolean' || !Number.isFinite(parsed.confidence)) throw Object.assign(new Error('Invalid grading output.'), { code: 'FLASHCARD_GRADING_INVALID' });
      return parsed;
    },
    ...options
  });
  const confident = result.value.confidence >= 0.8;
  return {
    correct: confident ? result.value.correct : false,
    confidence: result.value.confidence,
    reason: confident ? String(result.value.reason || '').slice(0, 240) : 'Your answer could not be confirmed as correct.',
    missingKeyPoints: Array.isArray(result.value.missingKeyPoints) ? result.value.missingKeyPoints.slice(0, 5) : [],
    gradingMethod: 'semantic_ai', model: result.model, lowConfidence: !confident
  };
}

module.exports = { normalizeAnswer, localGrade, gradeFlashcardAnswer, RESPONSE_SCHEMA };
