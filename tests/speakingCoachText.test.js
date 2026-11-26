'use strict';
// Speaking Coach student-facing text (services/speakingCoach/coachText.js): simple, short English with no scores, grades, levels or process
// words. Formatting is repaired first (the teacher comment draft's repairDraft: digits to words, markup, list markers, line breaks, final full
// stop); then the strict check. Content problems (a score-like number, a forbidden word, a rubric level title) are rejected, never repaired.
process.env.NODE_ENV = 'test';
const { checkCoachText } = require('../src/services/speakingCoach/coachText');

const ok = (value, options) => checkCoachText(value, options).text;
const code = (value, options) => { try { checkCoachText(value, options); return null; } catch (error) { return error.code; } };

describe('repaired, then accepted', () => {
  test.each([
    ['You used 3 linking words this time.', 'You used three linking words this time.'],
    ['- Speak a little more slowly', 'Speak a little more slowly.'],
    ['Try **because** to join ideas.', 'Try because to join ideas.'],
    ['Nice work.\nKeep going.', 'Nice work. Keep going.']
  ])('%j -> %j', (input, expected) => expect(ok(input)).toBe(expected));
});

describe('rejected', () => {
  test.each([
    ['You got 75% on this task.', 'COACH_TEXT_SCORE_LIKE_NUMBER'],
    ['That is 3/4 of the way there.', 'COACH_TEXT_SCORE_LIKE_NUMBER'],
    ['Your score went up a lot.', 'COACH_TEXT_FORBIDDEN_TERM'],
    ['Your grade will not change.', 'COACH_TEXT_FORBIDDEN_TERM'],
    ['The AI noticed fewer pauses.', 'COACH_TEXT_FORBIDDEN_TERM'],
    ['You reached the next level.', 'COACH_TEXT_FORBIDDEN_WORD'],
    ['You passed this task.', 'COACH_TEXT_FORBIDDEN_WORD'],
    ['Your pronunciation was clearer.', 'COACH_TEXT_FORBIDDEN_WORD'],
    ['The transcript shows fewer pauses.', 'COACH_TEXT_FORBIDDEN_WORD'],
    ['Watch your spelling.', 'COACH_TEXT_FORBIDDEN_WORD'],
    ['', 'COACH_TEXT_EMPTY'],
    [42, 'COACH_TEXT_EMPTY'],
    ['Go.', 'COACH_TEXT_TOO_SHORT']
  ])('%j -> %s', (input, expected) => expect(code(input)).toBe(expected));

  test('a rubric level title, as a whole word in any case', () => {
    const forbiddenWords = ['Excellent', 'Good', 'Developing', 'Beginning'];
    expect(code('That was good work on linking ideas.', { forbiddenWords })).toBe('COACH_TEXT_LEVEL_TITLE');
    expect(code('Your answer is still developing.', { forbiddenWords })).toBe('COACH_TEXT_LEVEL_TITLE');
    expect(code('Great work on linking your ideas.', { forbiddenWords })).toBeNull();
    expect(code('Goodness, that was a clear answer.', { forbiddenWords })).toBeNull();
  });

  test('too long overall, or a sentence longer than twenty-five words', () => {
    expect(code('a'.repeat(30) + ' word.', { max: 20 })).toBe('COACH_TEXT_TOO_LONG');
    expect(code(`${Array(26).fill('word').join(' ')}.`)).toBe('COACH_TEXT_SENTENCE_TOO_LONG');
    expect(code(`${Array(25).fill('word').join(' ')}.`)).toBeNull();
  });
});
