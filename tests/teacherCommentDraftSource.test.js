'use strict';

// What the teacher-comment draft model is asked: numerals and unreadable-word markers from the stored feedback are
// rewritten before the model sees them, the prompt asks for numbers as words, and the retry names the rule the first
// reply broke (never its text). Synthetic feedback only; the provider is a fake fetch, so no model is called.
process.env.NODE_ENV = 'test';

const logger = require('../src/utils/logger');
const { generateTeacherCommentDraft } = require('../src/services/teacherCommentDraft.service');

const GOOD = 'You organised your ideas clearly and your opening sets up the topic well. Next, check spelling and spacing in each paragraph, and reread your work aloud before you hand it in.';
const DIGIT_COMMENT = 'You organised your ideas clearly. There were 14 spelling and spacing issues, so reread each paragraph slowly before you hand it in.';
const BRACKET_COMMENT = 'You organised your ideas clearly, but a word like [?] was hard to read, so write each word carefully before you hand it in.';
const SCORE_COMMENT = 'You organised your ideas clearly. To raise your score, reread each paragraph slowly and fix spelling before you hand it in.';
const raw = comment => JSON.stringify({ comment });

// Shaped like a two-page handwritten exact-source essay: large issue counts and the reader's [?] marker in quoted evidence.
const HANDWRITTEN = {
  rubricScores: { MECHANICS: { score: 9, comment: 'Spacing between words is uneven on page 2 and in the 3rd paragraph.' },
    CONTENT: { score: 15, comment: 'The main idea is clear and supported with examples.' } },
  detailedFeedback: {
    strengths: [{ explanation: 'You explain the main idea clearly.' }],
    areasForImprovement: [
      { explanation: '14 distinct issues affected this category. The main recorded patterns are SPC, SP.' },
      { explanation: 'Sentence boundaries are unclear. Evidence: “we went to the [?] and then” Suggested: Split this into 2 sentences.' },
      { explanation: '123 distinct issues affected this category. Ratio 1.5 and 3/4 of lines.' }],
    actionSteps: [{ action: 'Revise the SPC/SP corrections in the highlighted passages.' }] } };
const SHORT_TYPED = {
  rubricScores: { CONTENT: { score: 17, comment: 'The main idea is clearly explained with relevant examples.' } },
  detailedFeedback: { strengths: [{ explanation: 'You explain the main idea clearly.' }],
    areasForImprovement: [{ explanation: '2 distinct issues affected this category. The main recorded pattern is GR.' }],
    actionSteps: [{ action: 'Revise the GR corrections in the highlighted passages.' }] } };

const reply = content => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'anthropic/claude-haiku-5.5', choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 40 } }) });
const unavailable = () => ({ ok: false, status: 503, headers: { get: () => null }, text: async () => JSON.stringify({ error: { message: 'busy' } }) });
const bodyOf = (provider, index) => JSON.parse(provider.mock.calls[index][1].body);
const roleOf = (provider, index, role) => bodyOf(provider, index).messages.find(m => m.role === role).content;
const RETRY_START = 'Your previous reply was rejected because';

describe('teacher comment draft: what the model is asked', () => {
  let originalKey; let provider;
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-comment-provider-key';
    ['info', 'warn', 'error'].forEach(level => jest.spyOn(logger, level).mockImplementation(() => {}));
    provider = jest.spyOn(global, 'fetch').mockResolvedValue(reply(raw(GOOD)));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('a two-page handwritten source reaches the model with numbers as words and no [?] marker', async () => {
    await expect(generateTeacherCommentDraft(HANDWRITTEN, 'sub-1')).resolves.toEqual({ comment: GOOD });
    const user = roleOf(provider, 0, 'user');
    expect(user).not.toMatch(/\d/u);
    expect(user).not.toContain('[?]');
    for (const text of ['fourteen distinct issues', 'an unreadable word', 'into two sentences', 'on page two', 'the third paragraph', 'many distinct issues', 'Ratio several and several of lines', 'SPC/SP'])
      expect(user).toContain(text);
  });

  it('a short typed source is cleaned the same way', async () => {
    await generateTeacherCommentDraft(SHORT_TYPED, 'sub-2');
    const user = roleOf(provider, 0, 'user');
    expect(user).not.toMatch(/\d/u);
    expect(user).toContain('two distinct issues');
  });

  it('the prompt asks for numbers as words and no brackets, codes or markers; the first attempt has no retry line', async () => {
    await generateTeacherCommentDraft(SHORT_TYPED, 'sub-3');
    const system = roleOf(provider, 0, 'system');
    expect(system).toMatch(/write any numbers as words, never as numerals/iu);
    expect(system).toMatch(/no square brackets, symbols, correction codes or unreadable-word markers/iu);
    expect(system).not.toContain(RETRY_START);
    expect(system).toMatch(/aim for 60-90 words/iu);
  });

  it.each([
    ['digits', DIGIT_COMMENT, 'Your previous reply was rejected because it contained digits; write numbers as words.'],
    ['brackets', BRACKET_COMMENT, 'Your previous reply was rejected because it contained symbols such as brackets, asterisks or underscores; use plain sentences only.'],
    ['a forbidden word', SCORE_COMMENT, 'Your previous reply was rejected because it used a word that is not allowed here; describe the work without mentioning scores, grades, rubrics, AI or the process.'],
  ])('after a reply with %s, the retry names that rule and never repeats the rejected text', async (_name, rejectedComment, line) => {
    provider.mockResolvedValueOnce(reply(raw(rejectedComment))).mockResolvedValueOnce(reply(raw(GOOD)));
    await expect(generateTeacherCommentDraft(HANDWRITTEN, 'sub-4')).resolves.toEqual({ comment: GOOD });
    expect(provider).toHaveBeenCalledTimes(2);
    const retrySystem = roleOf(provider, 1, 'system');
    expect(retrySystem.endsWith(` ${line}`)).toBe(true);
    expect(retrySystem.split(RETRY_START)).toHaveLength(2);
    expect(roleOf(provider, 0, 'system')).not.toContain(RETRY_START);
    expect(roleOf(provider, 1, 'user')).toBe(roleOf(provider, 0, 'user'));
    expect(JSON.stringify(bodyOf(provider, 1))).not.toContain(rejectedComment.slice(0, 40));
  });

  it('a retry after a provider error (no rule broken) has no retry line', async () => {
    provider.mockResolvedValueOnce(unavailable()).mockResolvedValueOnce(reply(raw(GOOD)));
    await expect(generateTeacherCommentDraft(SHORT_TYPED, 'sub-5')).resolves.toEqual({ comment: GOOD });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(roleOf(provider, 1, 'system')).toBe(roleOf(provider, 0, 'system'));
  });

  it('two rejected replies still end in the same clean failure (no third attempt)', async () => {
    provider.mockResolvedValue(reply(raw(DIGIT_COMMENT)));
    const error = await generateTeacherCommentDraft(SHORT_TYPED, 'sub-6').catch(caught => caught);
    expect(error.code).toBe('AI_CHAIN_EXHAUSTED');
    expect(provider).toHaveBeenCalledTimes(2);
  });
});
