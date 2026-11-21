'use strict';

// Every rule of the teacher-comment draft validator has its own validation code, so production logs say which rule
// rejected a draft (with lengths only, never the text). Synthetic comments only; the provider is a fake fetch.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'teacher-comment-validation-test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const { validateDraft, strictRuleOf, generateTeacherCommentDraft } = require('../src/services/teacherCommentDraft.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const GOOD = 'You organised your ideas clearly and your opening sets up the topic well. Next, check spelling and spacing in each paragraph, and reread your work aloud before you hand it in.';
const DIGIT_COMMENT = 'You organised your ideas clearly. There were 14 spelling and spacing issues, so reread each paragraph slowly before you hand it in.';
// A content problem (a forbidden word): still rejected after the repair step.
const REJECTED_COMMENT = 'You organised your ideas clearly. To raise your score, check spelling and spacing in each paragraph before you hand it in.';
const raw = comment => JSON.stringify({ comment });
const codeOf = text => { try { validateDraft(text); return 'PASS'; } catch (error) { return error.code ?? null; } };

describe('teacher comment draft validator: one code per rule', () => {
  it.each([
    ['not JSON', '```json\n{"comment":"x"}\n```', 'TEACHER_COMMENT_NOT_JSON'],
    ['an array', '[]', 'TEACHER_COMMENT_BAD_SHAPE'],
    ['an extra key', JSON.stringify({ comment: GOOD, note: 'x' }), 'TEACHER_COMMENT_BAD_SHAPE'],
    ['comment not a string', JSON.stringify({ comment: 7 }), 'TEACHER_COMMENT_BAD_SHAPE'],
    ['too long', raw(Array(26).fill('Keep reading your work aloud.').join(' ')), 'TEACHER_COMMENT_TOO_LONG'],
    ['too short', raw('Good work, keep going.'), 'TEACHER_COMMENT_TOO_SHORT'],
    ['the word score', raw('You organised your ideas clearly. To raise your score, reread each paragraph slowly and fix spelling before you hand it in.'), 'TEACHER_COMMENT_FORBIDDEN_TERM'],
    ['the word grade', raw('You used grade-level vocabulary well. Next, reread each paragraph slowly and fix spelling and spacing before you hand it in.'), 'TEACHER_COMMENT_FORBIDDEN_TERM'],
  ])('%s -> %s', (_name, text, code) => {
    expect(codeOf(text)).toBe(code);
  });

  // Formatting rules are repaired before the check (teacherCommentDraftRepair.test.js); they keep their codes in the final strict check.
  it.each([
    ['a line break', GOOD.replace('. Next', '.\nNext'), 'TEACHER_COMMENT_LINE_BREAK'],
    ['square brackets', 'You organised your ideas clearly, but a word like [?] was hard to read, so write each word carefully before you hand it in.', 'TEACHER_COMMENT_MARKUP_CHARACTER'],
    ['an underscore', GOOD.replace('spelling', 'spelling_and'), 'TEACHER_COMMENT_MARKUP_CHARACTER'],
    ['a list start', `- ${GOOD}`, 'TEACHER_COMMENT_LIST_START'],
    ['a numbered list start', `1. ${GOOD}`, 'TEACHER_COMMENT_LIST_START'],
    ['a digit', DIGIT_COMMENT, 'TEACHER_COMMENT_DIGIT'],
    ['no final punctuation', GOOD.replace(/\.$/u, ''), 'TEACHER_COMMENT_NO_END_PUNCTUATION'],
  ])('strict check: %s -> %s', (_name, text, code) => {
    expect(strictRuleOf(text)).toBe(code);
  });

  it('a rejection carries the raw reply length, and nothing of its text', () => {
    let error;
    try { validateDraft(raw(REJECTED_COMMENT)); } catch (caught) { error = caught; }
    expect(error.responseTextLength).toBe(raw(REJECTED_COMMENT).length);
    expect(JSON.stringify({ ...error, message: error.message })).not.toContain('spelling and spacing');
  });

  it('still accepts everything it accepted before, unchanged', () => {
    const accepted = [GOOD, 'You organised your ideas clearly. There were fourteen spelling and spacing issues, so reread each paragraph slowly before you hand it in.',
      'You organised your ideas clearly. Revise the SP/SPC corrections in the highlighted passages and reread your work before you hand it in.',
      `"${GOOD}"`, `${GOOD.slice(0, -1)}!`, `${GOOD.slice(0, -1)}?”`];
    for (const text of accepted) expect(codeOf(raw(text))).toBe('PASS');
    expect(validateDraft(raw(`  ${GOOD}  `))).toEqual({ comment: GOOD });
  });
});

describe('teacher comment draft: the rule that fired reaches the logs', () => {
  const reply = content => ({ ok: true, status: 200, headers: { get: () => null },
    text: async () => JSON.stringify({ model: 'anthropic/claude-haiku-5.5', choices: [{ finish_reason: 'stop', message: { content } }],
      usage: { prompt_tokens: 100, completion_tokens: 40 } }) });
  const feedback = { rubricScores: { CONTENT: { score: 17, comment: 'The main idea is clearly explained with relevant examples.' } },
    detailedFeedback: { strengths: [{ explanation: 'You explain the main idea clearly.' }], areasForImprovement: [{ explanation: 'Improve connections between ideas.' }],
      actionSteps: [{ action: 'Add one transition between paragraphs.' }] } };
  const logged = spies => JSON.stringify(spies.flatMap(spy => spy.mock.calls));
  let originalKey; let spies;

  beforeEach(() => {
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-comment-provider-key';
    spies = ['info', 'warn', 'error'].map(level => jest.spyOn(logger, level).mockImplementation(() => {}));
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });

  it('both attempts record TEACHER_COMMENT_FORBIDDEN_TERM and the reply length; no log holds the comment text', async () => {
    jest.spyOn(global, 'fetch').mockResolvedValue(reply(raw(REJECTED_COMMENT)));
    const error = await generateTeacherCommentDraft(feedback, '64b000000000000000000001').catch(caught => caught);
    expect(error.code).toBe('AI_CHAIN_EXHAUSTED');
    expect(error.attempts.map(attempt => attempt.validationCode)).toEqual(['TEACHER_COMMENT_FORBIDDEN_TERM', 'TEACHER_COMMENT_FORBIDDEN_TERM']);
    expect(error.attempts.map(attempt => attempt.responseTextLength)).toEqual([raw(REJECTED_COMMENT).length, raw(REJECTED_COMMENT).length]);
    const failedLogs = spies[1].mock.calls.map(([entry]) => entry).filter(entry => entry?.message === 'AI gateway attempt failed');
    expect(failedLogs.map(entry => entry.validationCode)).toEqual(['TEACHER_COMMENT_FORBIDDEN_TERM', 'TEACHER_COMMENT_FORBIDDEN_TERM']);
    expect(logged(spies)).not.toContain('spelling and spacing');
  });

  describe('through the route', () => {
    let submission; let token;
    beforeAll(connectInMemoryMongo);
    afterAll(disconnectInMemoryMongo);
    beforeEach(async () => {
      await clearDatabase();
      const teacher = await User.create({ firebaseUid: 'tcv-teacher', email: 'tcv-teacher@example.com', role: 'teacher' });
      const student = await User.create({ firebaseUid: 'tcv-student', email: 'tcv-student@example.com', role: 'student' });
      const classDoc = await Class.create({ name: 'Validation class', teacher: teacher._id, joinCode: 'tcv-code', qrCodeUrl: 'data:,' });
      const assignment = await Assignment.create({ title: 'Validation assignment', writingType: 'essay',
        deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'tcv-token' });
      submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
        status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
        evaluationStatus: 'completed', assessmentStatus: 'complete', correctionSourceHash: 'tcv-source' });
      await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
        teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'tcv-source',
        detailedFeedbackSourceHash: 'tcv-source', ...feedback });
      token = signTestJwt({ id: teacher._id.toString(), role: 'teacher' });
    });

    it('the teacher_comment_draft_failed log lists the code and length of every attempt; the answer is unchanged', async () => {
      jest.spyOn(global, 'fetch').mockResolvedValue(reply(raw(REJECTED_COMMENT)));
      const response = await request(app).post(`/api/feedback/${submission._id}/teacher-comments/ai-draft`)
        .set('Authorization', `Bearer ${token}`).send({});
      expect(response.status).toBe(503);
      expect(response.body.code).toBe('TEACHER_COMMENT_DRAFT_TRY_AGAIN');
      const failed = spies[1].mock.calls.map(([entry]) => entry).find(entry => entry?.event === 'teacher_comment_draft_failed');
      expect(failed.validationCodes).toEqual(['TEACHER_COMMENT_FORBIDDEN_TERM', 'TEACHER_COMMENT_FORBIDDEN_TERM']);
      expect(failed.responseTextLengths).toEqual([raw(REJECTED_COMMENT).length, raw(REJECTED_COMMENT).length]);
      expect(logged(spies)).not.toContain('spelling and spacing');
    });
  });
});
