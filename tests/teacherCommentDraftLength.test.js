'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'teacher-comment-length-test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const logger = require('../src/utils/logger');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const service = require('../src/services/teacherCommentDraft.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

const comment = 'You explain the main idea clearly and use relevant examples to support your response. Your writing would be stronger with clearer connections between ideas and more careful sentence structure. As you revise, check how each example supports your point and use the suggested transitions to help your reader follow the discussion.';
const shortComment = 'You explain the main idea clearly. Next, add clearer transitions so your reader can follow each point.';
// About 135 words: complete, well-formed, but longer than the product allows.
const longComment = Array.from({ length: 15 }, () => 'You explain the main idea clearly with good examples.').join(' ');
// What production saw: the model hit the cap mid-sentence (finish_reason "length").
const truncatedRaw = JSON.stringify({ comment }).slice(0, 180);

const reply = (content, finishReason = 'stop', completionTokens = 70) => ({ ok: true, status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ model: 'anthropic/claude-haiku-5.5',
    choices: [{ finish_reason: finishReason, message: { content } }],
    usage: { prompt_tokens: 100, completion_tokens: completionTokens } }) });
const truncated = () => reply(truncatedRaw, 'length', 240);
const bodyOf = (provider, index) => JSON.parse(provider.mock.calls[index][1].body);
const systemOf = (provider, index) => bodyOf(provider, index).messages.find(m => m.role === 'system').content;

describe('teacher comment draft length handling', () => {
  let teacher; let student; let classDoc; let assignment; let submission; let token; let provider; let originalKey;
  const post = () => request(app).post(`/api/feedback/${submission._id}/teacher-comments/ai-draft`)
    .set('Authorization', `Bearer ${token}`).send({});
  const feedbackDoc = () => SubmissionFeedback.findOne({ submissionId: submission._id }).lean();

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'test-comment-provider-key';
    provider = jest.spyOn(global, 'fetch').mockResolvedValue(reply(JSON.stringify({ comment })));
    teacher = await User.create({ firebaseUid: 'tcl-teacher', email: 'tcl-teacher@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'tcl-student', email: 'tcl-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Length class', teacher: teacher._id, joinCode: 'tcl-code', qrCodeUrl: 'data:,' });
    assignment = await Assignment.create({ title: 'Length assignment', writingType: 'essay',
      deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'tcl-token' });
    submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed', correctionStatus: 'completed',
      evaluationStatus: 'completed', assessmentStatus: 'complete', correctionSourceHash: 'len-source' });
    await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
      teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'len-source',
      detailedFeedbackSourceHash: 'len-source', teacherComments: 'Keep my saved comment',
      rubricScores: { CONTENT: { score: 17, comment: 'The main idea is clearly explained with relevant examples.' } },
      detailedFeedback: { strengths: [{ explanation: 'You explain the main idea clearly.' }],
        areasForImprovement: [{ explanation: 'Improve connections between ideas.' }],
        actionSteps: [{ action: 'Add suggested transitions.' }] } });
    token = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
  });
  afterEach(() => {
    provider.mockRestore();
    if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
  });

  test('the output cap leaves room for the longest allowed comment and the timeout covers it', async () => {
    const limits = service.TEACHER_COMMENT_DRAFT_LIMITS;
    expect(limits).toMatchObject({ maxOutputTokens: 900, compactMaxOutputTokens: 600,
      attemptTimeoutMs: 20000, compactAttemptTimeoutMs: 15000, totalBudgetMs: 45000 });
    expect((await post()).status).toBe(200);
    expect(provider).toHaveBeenCalledTimes(1);
    expect(bodyOf(provider, 0).max_tokens).toBe(900);
  });

  test('the prompt states a length target and a hard limit inside the validator limit', async () => {
    await post();
    const system = systemOf(provider, 0);
    expect(system).toMatch(/aim for 60-90 words/iu);
    expect(system).toMatch(/hard limit: at most 110 words and 700 characters/iu);
    expect(system).not.toMatch(/60-120 words/u);
  });

  test('a truncated reply triggers one shorter retry and the shorter draft succeeds', async () => {
    provider.mockResolvedValueOnce(truncated()).mockResolvedValueOnce(reply(JSON.stringify({ comment: shortComment })));
    const result = await post();
    expect(result.status).toBe(200);
    expect(result.body.data).toEqual({ comment: shortComment });
    expect(provider).toHaveBeenCalledTimes(2);
    expect(bodyOf(provider, 0).max_tokens).toBe(900);
    expect(bodyOf(provider, 1).max_tokens).toBe(600);
    expect(systemOf(provider, 1)).toMatch(/hard limit: at most 70 words and 450 characters/iu);
    expect((await feedbackDoc()).teacherComments).toBe('Keep my saved comment');
  });

  test('a complete but too-long draft also gets the shorter retry after the normal same-prompt retry', async () => {
    provider.mockResolvedValueOnce(reply(JSON.stringify({ comment: longComment })))
      .mockResolvedValueOnce(reply(JSON.stringify({ comment: longComment })))
      .mockResolvedValueOnce(reply(JSON.stringify({ comment: shortComment })));
    const result = await post();
    expect(result.status).toBe(200); expect(result.body.data).toEqual({ comment: shortComment });
    expect(provider).toHaveBeenCalledTimes(3);
    expect(bodyOf(provider, 2).max_tokens).toBe(600);
  });

  test('truncation on both attempts fails cleanly with the persistent message and no half sentence', async () => {
    provider.mockImplementation(async () => truncated());
    const result = await post();
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('TEACHER_COMMENT_DRAFT_NOT_POSSIBLE');
    expect(result.body.message).toBe('A comment could not be drafted for this submission. Please write the comment yourself.');
    expect(JSON.stringify(result.body)).not.toMatch(/anthropic|claude|haiku|openrouter|truncat/iu);
    expect(result.body.data).toBeUndefined();
    expect(provider).toHaveBeenCalledTimes(2);
    expect((await feedbackDoc()).teacherComments).toBe('Keep my saved comment');
  });

  test('the shorter retry is a single attempt even when its reply is unusable', async () => {
    provider.mockResolvedValueOnce(truncated()).mockResolvedValue(reply('{"comment":"bad","unexpected":true}'));
    const result = await post();
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('TEACHER_COMMENT_DRAFT_TRY_AGAIN');
    expect(provider).toHaveBeenCalledTimes(2);
  });

  test('a transient failure keeps the try-again message and does not use the shorter retry', async () => {
    provider.mockRejectedValue(Object.assign(new Error('Timeout'), { code: 'AI_ATTEMPT_TIMEOUT' }));
    const result = await post();
    expect(result.status).toBe(503);
    expect(result.body.code).toBe('TEACHER_COMMENT_DRAFT_TRY_AGAIN');
    expect(result.body.message).toBe('Unable to generate a comment right now. Please try again.');
    expect(provider).toHaveBeenCalledTimes(2);
    for (const index of [0, 1]) expect(bodyOf(provider, index).max_tokens).toBe(900);
  });

  test('no credit is charged on failure, on success, or across repeated clicks', async () => {
    const wallets = () => mongoose.connection.collection('creditwallets').find({}).toArray();
    const transactions = () => mongoose.connection.collection('credittransactions').countDocuments();
    const beforeWallets = await wallets(); const beforeTransactions = await transactions();
    provider.mockImplementation(async () => truncated());
    for (let click = 0; click < 3; click += 1) expect((await post()).status).toBe(503);
    provider.mockImplementation(async () => reply(JSON.stringify({ comment })));
    expect((await post()).status).toBe(200);
    expect(await wallets()).toEqual(beforeWallets);
    expect(await transactions()).toBe(beforeTransactions);
  });

  test('success logs finishReason and output tokens for length monitoring', async () => {
    const info = jest.spyOn(logger, 'info');
    provider.mockResolvedValueOnce(truncated()).mockResolvedValueOnce(reply(JSON.stringify({ comment: shortComment }), 'stop', 41));
    expect((await post()).status).toBe(200);
    const entry = info.mock.calls.map(([value]) => value).find(value => value?.event === 'teacher_comment_draft_generated');
    info.mockRestore();
    expect(entry).toMatchObject({ feature: 'teacher_comment_draft', submissionId: String(submission._id),
      mode: 'compact', compactRetry: true, finishReason: 'stop', outputTokens: 41, maxOutputTokens: 600,
      commentLength: shortComment.length });
  });

  test('the validator marks an over-long draft so the service can ask for a shorter one', () => {
    let error;
    try { service.validateDraft(JSON.stringify({ comment: longComment })); } catch (caught) { error = caught; }
    expect(error).toBeDefined(); expect(error.code).toBe('TEACHER_COMMENT_TOO_LONG');
    let other;
    try { service.validateDraft(JSON.stringify({ comment: 'Too short.' })); } catch (caught) { other = caught; }
    expect(other).toBeDefined(); expect(other.code).not.toBe('TEACHER_COMMENT_TOO_LONG');
  });

  test('the new validator gives the same verdict as the base validator on every non-length case', () => {
    const base = require('../src/services/teacherComments.service').validateDraft;
    const shortOk = 'Please review the feedback provided and focus on the highlighted areas before your next submission.';
    const cases = ['', comment, shortComment, shortOk, comment + '\nAnother paragraph.', comment.replace('You', 'OpenRouter'),
      shortOk + " You earned 90 marks.", shortOk + " The provider reviewed it.", shortOk + " ```code```", shortOk + " **Bold text**.",
      "Too short.", "This sentence has no ending punctuation but enough words to pass the count"];
    const verdict = (fn, value) => { try { return fn(JSON.stringify({ comment: value })); } catch { return "rejected"; } };
    for (const value of cases) expect(verdict(service.validateDraft, value)).toEqual(verdict(base, value));
    expect(verdict(base, longComment)).toBe("rejected"); expect(verdict(service.validateDraft, longComment)).toBe("rejected");
  });
});
