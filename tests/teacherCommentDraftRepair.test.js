'use strict';

// Teacher-comment drafts: formatting problems are repaired before the strict check (digits to words, brackets, markup, list or heading
// markers, line breaks, a missing full stop); content problems are still rejected and retried (forbidden words, score-like numbers, too
// short, too long, not JSON, wrong shape). The strict validator stays the final check. Synthetic text only; the provider is a fake fetch.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teacher-comment-repair-test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { validateDraft, repairDraft, strictRuleOf, generateTeacherCommentDraft } = require('../src/services/teacherCommentDraft.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const raw = comment => JSON.stringify({ comment });
const codeOf = text => { try { validateDraft(text); return 'PASS'; } catch (error) { return error.code ?? null; } };
const GOOD = 'You organised your ideas clearly and your opening sets up the topic well. Next, check spelling and spacing in each paragraph, and reread your work aloud before you hand it in.';

describe('teacher comment draft: formatting is repaired', () => {
  it.each([
    ['digits become words', 'You organised your ideas clearly. There were 14 spelling slips and 3 spacing slips, so reread each paragraph before you hand it in.',
      'You organised your ideas clearly. There were fourteen spelling slips and three spacing slips, so reread each paragraph before you hand it in.', ['TEACHER_COMMENT_DIGIT']],
    ['a number starting a sentence is capitalised', '2 paragraphs are well organised. 12 small slips remain, so reread each sentence carefully before you hand it in.',
      'Two paragraphs are well organised. Twelve small slips remain, so reread each sentence carefully before you hand it in.', ['TEACHER_COMMENT_DIGIT']],
    ['ordinals and large numbers', 'Your 2nd paragraph is the strongest part of your writing, and you used over 120 words well, so keep building on that.',
      'Your second paragraph is the strongest part of your writing, and you used over many words well, so keep building on that.', ['TEACHER_COMMENT_DIGIT']],
    ['the reader marker [?]', 'You organised your ideas clearly, but a word like [?] was hard to read, so write each word carefully before you hand it in.',
      'You organised your ideas clearly, but a word like a hard-to-read word was hard to read, so write each word carefully before you hand it in.', ['TEACHER_COMMENT_MARKUP_CHARACTER']],
    ['other brackets keep their words', 'You organised your ideas clearly [especially in the opening] and you should keep reading your work aloud before you hand it in.',
      'You organised your ideas clearly especially in the opening and you should keep reading your work aloud before you hand it in.', ['TEACHER_COMMENT_MARKUP_CHARACTER']],
    ['HTML tags and emphasis marks', 'You organised your ideas <b>clearly</b> and your **opening** sets up the topic well, so keep_reading your work aloud before you hand it in.',
      'You organised your ideas clearly and your opening sets up the topic well, so keep reading your work aloud before you hand it in.', ['TEACHER_COMMENT_MARKUP_CHARACTER']],
    ['a leading bullet', `- ${GOOD}`, GOOD, ['TEACHER_COMMENT_LIST_START']],
    ['a leading number', `1. ${GOOD}`, GOOD, ['TEACHER_COMMENT_LIST_START']],
    ['a missing full stop', GOOD.slice(0, -1), GOOD, ['TEACHER_COMMENT_NO_END_PUNCTUATION']],
    ['a trailing comma', `${GOOD.slice(0, -1)},`, GOOD, ['TEACHER_COMMENT_NO_END_PUNCTUATION']],
    ['line breaks join into one paragraph', 'You organised your ideas clearly and your opening sets up the topic well.\n\nNext, check spelling and spacing in each paragraph, and reread your work aloud before you hand it in.',
      GOOD, ['TEACHER_COMMENT_LINE_BREAK']],
    ['a bullet list with a heading', '## Feedback\n- You organised your ideas clearly and your opening sets up the topic well\n- Next, check spelling and spacing in each paragraph, and reread your work aloud before you hand it in',
      GOOD, ['TEACHER_COMMENT_LINE_BREAK', 'TEACHER_COMMENT_LIST_START', 'TEACHER_COMMENT_NO_END_PUNCTUATION']],
  ])('%s', (_name, input, expected, rules) => {
    expect(repairDraft(input)).toEqual({ text: expected, repairedRules: rules });
    expect(validateDraft(raw(input))).toEqual({ comment: expected });
    expect(strictRuleOf(expected)).toBeNull();
  });

  it('text that needs no repair is returned unchanged, with no repaired rules', () => {
    expect(repairDraft(GOOD)).toEqual({ text: GOOD, repairedRules: [] });
    expect(validateDraft(raw(`  "${GOOD}"  `))).toEqual({ comment: GOOD });
  });

  it('the strict validator is still the final check on the repaired text', () => {
    for (const [code, text] of [['TEACHER_COMMENT_DIGIT', `${GOOD} 7`], ['TEACHER_COMMENT_MARKUP_CHARACTER', `${GOOD} [x]`],
      ['TEACHER_COMMENT_LINE_BREAK', `${GOOD}\nMore.`], ['TEACHER_COMMENT_LIST_START', `- ${GOOD}`], ['TEACHER_COMMENT_NO_END_PUNCTUATION', GOOD.slice(0, -1)],
      ['TEACHER_COMMENT_FORBIDDEN_TERM', `${GOOD} Your score improved.`]]) expect(strictRuleOf(text)).toBe(code);
  });
});

describe('teacher comment draft: content problems are still rejected', () => {
  it.each([
    ['the word score', 'You organised your ideas clearly. To raise your score, reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word scored', 'You scored well on organisation, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word scoring', 'Your scoring on organisation is strong, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word graded', 'This work was graded with care, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word grading', 'The grading shows clear ideas, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word grade-level', 'You used grade-level vocabulary well. Next, reread each paragraph slowly and fix spelling and spacing before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word AI', 'Your essay about AI makes a clear point, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word providers', 'You described the providers clearly, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word database', 'You described the database clearly, and next you should reread each paragraph slowly and fix spelling before you hand it in.', 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['a decimal', 'You reached 61.5 on this task and organised your ideas clearly, so reread each paragraph slowly before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['a percentage', 'You reached 72% on this task and organised your ideas clearly, so reread each paragraph slowly before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['a fraction', 'You reached 8/10 on this task and organised your ideas clearly, so reread each paragraph slowly before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['out of a number', 'You reached seven out of 10 on this task and organised your ideas clearly, so reread each paragraph before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['out of ten in words', 'You reached seven out of ten on this task and organised your ideas clearly, so reread each paragraph before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['a number of marks', 'You earned 90 marks on this task and organised your ideas clearly, so reread each paragraph before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['a number of points', 'You gained 12 points on this task and organised your ideas clearly, so reread each paragraph before you hand it in.', 'TEACHER_COMMENT_SCORE_LIKE_NUMBER'],
    ['too short after repair', '- Good work, keep going', 'TEACHER_COMMENT_TOO_SHORT'],
    ['too long', Array(26).fill('Keep reading your work aloud.').join(' '), 'TEACHER_COMMENT_TOO_LONG'],
  ])('%s -> %s', (_name, text, code) => {
    expect(codeOf(raw(text))).toBe(code);
  });

  it('not JSON and the wrong shape are rejected', () => {
    expect(codeOf('```json\n{"comment":"x"}\n```')).toBe('TEACHER_COMMENT_NOT_JSON');
    expect(codeOf(JSON.stringify({ comment: GOOD, note: 'x' }))).toBe('TEACHER_COMMENT_BAD_SHAPE');
  });

  it('a rejection carries its code and the reply length only', () => {
    const text = raw('You reached 72% on this task and organised your ideas clearly, so reread each paragraph slowly before you hand it in.');
    let error; try { validateDraft(text); } catch (caught) { error = caught; }
    expect(error.responseTextLength).toBe(text.length);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('organised');
  });
});

// Shaped like a two-page handwritten exact-source essay: large counts, the reader's [?] marker and the word "prompt" in stored feedback.
const HANDWRITTEN = {
  rubricScores: { MECHANICS: { score: 9, comment: 'Spacing between words is uneven on page 2 and in the 3rd paragraph.' },
    CONTENT: { score: 15, comment: 'The essay answers the writing prompt with relevant examples.' } },
  detailedFeedback: {
    strengths: [{ explanation: 'You respond to the Prompt clearly.' }],
    areasForImprovement: [{ explanation: '14 distinct issues affected this category. The main recorded patterns are SPC, SP.' },
      { explanation: 'Sentence boundaries are unclear. Evidence: “we went to the [?] and then” Suggested: Split this into 2 sentences.' }],
    actionSteps: [{ action: 'Revise the SPC/SP corrections in the highlighted passages.' }] } };
const MESSY_REPLY = '- You organised your ideas clearly across both pages\n- There were 14 spelling slips, and a word like [?] was hard to read\n- Next, reread each **paragraph** slowly before you hand it in';
const MESSY_REPAIRED = 'You organised your ideas clearly across both pages. There were fourteen spelling slips, and a word like a hard-to-read word was hard to read. Next, reread each paragraph slowly before you hand it in.';
const FORBIDDEN_REPLY = 'You organised your ideas clearly. To raise your score, reread each paragraph slowly and fix spelling before you hand it in.';

const reply = content => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'anthropic/claude-haiku-5.5', choices: [{ finish_reason: 'stop', message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: 60 } }) });
const bodyOf = (provider, index) => JSON.parse(provider.mock.calls[index][1].body);
const roleOf = (provider, index, role) => bodyOf(provider, index).messages.find(m => m.role === role).content;

describe('teacher comment draft: end to end with a fake model', () => {
  let originalKey; let spies; let provider;
  const allLogs = () => JSON.stringify(spies.flatMap(spy => spy.mock.calls));
  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-comment-provider-key';
    spies = ['info', 'warn', 'error', 'metric'].map(level => jest.spyOn(logger, level).mockImplementation(() => {}));
    provider = jest.spyOn(global, 'fetch').mockResolvedValue(reply(raw(MESSY_REPLY)));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('the model reads "task" instead of "prompt"; the system rule still names prompts as off limits', async () => {
    await generateTeacherCommentDraft(HANDWRITTEN, 'sub-1');
    const user = roleOf(provider, 0, 'user');
    expect(user).not.toMatch(/\bprompts?\b/iu);
    expect(user).toContain('the writing task');
    expect(user).toContain('respond to the Task clearly');
    expect(roleOf(provider, 0, 'system')).toMatch(/Do not mention AI, OpenRouter, OCR, JSON, prompts, rubrics, scores, grades/u);
    expect(roleOf(provider, 0, 'system')).toMatch(/Call the writing assignment the task\./u);
  });

  describe('through the route', () => {
    let submission; let token;
    beforeAll(connectInMemoryMongo);
    afterAll(disconnectInMemoryMongo);
    beforeEach(async () => {
      await clearDatabase();
      const teacher = await User.create({ firebaseUid: 'tcr-teacher', email: 'tcr-teacher@example.com', role: 'teacher' });
      const student = await User.create({ firebaseUid: 'tcr-student', email: 'tcr-student@example.com', role: 'student' });
      const classDoc = await Class.create({ name: 'Repair class', teacher: teacher._id, joinCode: 'tcr-code', qrCodeUrl: 'data:,' });
      const assignment = await Assignment.create({ title: 'Repair assignment', writingType: 'essay',
        deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'tcr-token' });
      submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
        status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
        evaluationStatus: 'completed', assessmentStatus: 'complete', correctionSourceHash: 'tcr-source' });
      await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
        teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'tcr-source',
        detailedFeedbackSourceHash: 'tcr-source', teacherComments: 'Keep my saved comment', ...HANDWRITTEN });
      token = signTestJwt({ id: teacher._id.toString(), role: 'teacher' });
    });
    const post = () => request(app).post(`/api/feedback/${submission._id}/teacher-comments/ai-draft`).set('Authorization', `Bearer ${token}`).send({});

    it('two-page handwritten essay: a messy reply (bullets, digits, [?], markup, no full stops) is repaired on the first attempt', async () => {
      const response = await post();
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ comment: MESSY_REPAIRED });
      expect(provider).toHaveBeenCalledTimes(1);
      const repaired = spies[3].mock.calls.map(([entry]) => entry).find(entry => entry?.event === 'teacher_comment_draft_repaired');
      expect(repaired).toEqual({ event: 'teacher_comment_draft_repaired', feature: 'teacher_comment_draft', submissionId: String(submission._id),
        mode: 'standard', attemptCount: 1, repairedRules: ['TEACHER_COMMENT_LINE_BREAK', 'TEACHER_COMMENT_MARKUP_CHARACTER', 'TEACHER_COMMENT_LIST_START',
          'TEACHER_COMMENT_DIGIT', 'TEACHER_COMMENT_NO_END_PUNCTUATION'], commentLength: MESSY_REPAIRED.length });
      expect(allLogs()).not.toContain('spelling slips');
      expect(allLogs()).not.toContain('organised');
    });

    it('a clean reply logs no repair', async () => {
      provider.mockResolvedValue(reply(raw(GOOD)));
      expect((await post()).status).toBe(200);
      expect(spies[3].mock.calls.some(([entry]) => entry?.event === 'teacher_comment_draft_repaired')).toBe(false);
    });

    it('a forbidden word is still rejected and retried with the rule named; twice gives the same 503 as before', async () => {
      provider.mockResolvedValue(reply(raw(FORBIDDEN_REPLY)));
      const response = await post();
      expect(response.status).toBe(503);
      expect(response.body).toEqual({ success: false, code: 'TEACHER_COMMENT_DRAFT_TRY_AGAIN', message: 'Unable to generate a comment right now. Please try again.' });
      expect(provider).toHaveBeenCalledTimes(2);
      expect(roleOf(provider, 1, 'system')).toContain('Your previous reply was rejected because it used a word that is not allowed here');
      const failed = spies[1].mock.calls.map(([entry]) => entry).find(entry => entry?.event === 'teacher_comment_draft_failed');
      expect(failed.validationCodes).toEqual(['TEACHER_COMMENT_FORBIDDEN_TERM', 'TEACHER_COMMENT_FORBIDDEN_TERM']);
      expect(allLogs()).not.toContain('raise your');
    });

    it('a score-like number is rejected, and the retry asks to leave marks out', async () => {
      provider.mockResolvedValueOnce(reply(raw('You reached 72% on this task and organised your ideas clearly, so reread each paragraph slowly before you hand it in.')))
        .mockResolvedValueOnce(reply(raw(GOOD)));
      const response = await post();
      expect(response.status).toBe(200);
      expect(response.body.data).toEqual({ comment: GOOD });
      expect(roleOf(provider, 1, 'system')).toContain('Your previous reply was rejected because it contained a number that looks like a mark or a percentage; leave all marks out.');
    });
  });
});
