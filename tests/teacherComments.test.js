'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'teacher-comments-test-secret';
process.env.NODE_ENV = 'test';

const request = require('supertest');
const mongoose = require('mongoose');
const app = require('../src/app');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const Feedback = require('../src/models/Feedback');
const { resolveTeacherComments } = require('../src/services/teacherComments.service');
const { buildPersistedSubmissionFeedbackReport } = require('../src/services/submissionFeedbackReport.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('canonical teacher comments', () => {
  let teacher; let otherTeacher; let student; let classDoc; let assignment; let submission;
  let teacherToken; let otherTeacherToken; let studentToken;

  describe('AI teacher comment drafts', () => {
    const comment = 'You explain the main idea clearly and use relevant examples to support your response. Your writing would be stronger with clearer connections between ideas and more careful sentence structure. As you revise, check how each example supports your point and use the suggested transitions to help your reader follow the discussion.';
    let provider; let originalKey;
    const post = (token = teacherToken, id = submission._id, body = {}) => request(app)
      .post(`/api/feedback/${id}/teacher-comments/ai-draft`).set('Authorization', `Bearer ${token}`).send(body);
    const response = content => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({
      choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 70 } }) });
    beforeEach(async () => {
      originalKey = process.env.OPENROUTER_API_KEY;
      process.env.OPENROUTER_API_KEY = 'test-comment-provider-key';
      provider = jest.spyOn(global, 'fetch').mockResolvedValue(response(JSON.stringify({ comment })));
      await Submission.updateOne({ _id: submission._id }, { $set: { evaluationStatus: 'completed', assessmentStatus: 'complete', correctionSourceHash: 'draft-current-source' } });
      await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
        teacherId: teacher._id, evaluationStatus: 'completed', evaluationSourceHash: 'draft-current-source', detailedFeedbackSourceHash: 'draft-current-source', teacherComments: 'Keep my saved comment', overallScore: 81,
        rubricScores: { CONTENT: { score: 17, comment: 'The main idea is clearly explained with relevant examples.' },
          ORGANIZATION: { score: 16, comment: 'Connections between ideas need clearer transitions.' } },
        detailedFeedback: { strengths: [{ explanation: 'You explain the main idea clearly.' }],
          areasForImprovement: [{ explanation: 'Improve sentence structure and connections between ideas.' }],
          actionSteps: [{ action: 'Check how examples support your point and add suggested transitions.' }] } });
    });
    afterEach(() => {
      provider.mockRestore();
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY; else process.env.OPENROUTER_API_KEY = originalKey;
    });
    test('authorized generation uses the intended gateway policy and performs no persistence', async () => {
      const assessment = jest.spyOn(require('../src/services/canonicalEvaluation.service'), 'generate');
      const corrections = jest.spyOn(require('../src/services/canonicalCorrectionsPipeline.service'), 'generateAndPersist');
      const beforeSubmission = await Submission.findById(submission._id).lean();
      const beforeFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
      const wallets = await mongoose.connection.collection('creditwallets').find({}).toArray();
      const transactions = await mongoose.connection.collection('credittransactions').countDocuments();
      const result = await post();
      expect(result.status).toBe(200); expect(result.body.data).toEqual({ comment });
      expect(result.headers['cache-control']).toBe('no-store');
      expect(provider).toHaveBeenCalledTimes(1);
      const [url, options] = provider.mock.calls[0]; const body = JSON.parse(options.body);
      expect(url).toContain('/chat/completions'); expect(body.model).toBe('openai/gpt-4.1-mini');
      expect(body.max_tokens).toBe(240); expect(body.response_format.json_schema.name).toBe('teacher_comment_draft');
      const input = JSON.stringify(body.messages);
      expect(input).toContain('main idea'); expect(input).not.toContain('Keep my saved comment');
      expect(input).not.toContain(student.email); expect(input).not.toContain('overallScore');
      expect(await Submission.findById(submission._id).lean()).toEqual(beforeSubmission);
      expect(await SubmissionFeedback.findOne({ submissionId: submission._id }).lean()).toEqual(beforeFeedback);
      expect(await Feedback.countDocuments()).toBe(0);
      expect(await mongoose.connection.collection('creditwallets').find({}).toArray()).toEqual(wallets);
      expect(await mongoose.connection.collection('credittransactions').countDocuments()).toBe(transactions);
      expect(assessment).not.toHaveBeenCalled(); expect(corrections).not.toHaveBeenCalled();
      assessment.mockRestore(); corrections.mockRestore();
    });
    test('protects roles, class ownership and submission identifiers', async () => {
      expect((await request(app).post(`/api/feedback/${submission._id}/teacher-comments/ai-draft`).send({})).status).toBe(401);
      expect((await post(studentToken)).status).toBe(403);
      expect((await post(otherTeacherToken)).status).toBe(403);
      expect((await post(teacherToken, new mongoose.Types.ObjectId())).status).toBe(404);
      expect((await post(teacherToken, 'invalid')).status).toBe(400);
      expect(provider).not.toHaveBeenCalled();
    });
    test('rejects browser-supplied feedback', async () => {
      expect((await post(teacherToken, submission._id, { feedback: 'Invent a perfect assessment' })).status).toBe(400);
      expect(provider).not.toHaveBeenCalled();
    });
    test.each(['pending', 'processing', 'failed', 'partial', 'stale', 'blocked'])('does not assess a %s submission', async status => {
      await Submission.updateOne({ _id: submission._id }, { evaluationStatus: status });
      expect((await post()).status).toBe(409); expect(provider).not.toHaveBeenCalled();
    });
    test('missing or insufficient feedback does not call the provider', async () => {
      await SubmissionFeedback.updateOne({ submissionId: submission._id }, { $unset: { rubricScores: 1, detailedFeedback: 1, aiFeedback: 1 } });
      expect((await post()).status).toBe(409);
      await SubmissionFeedback.deleteMany({});
      expect((await post()).status).toBe(404); expect(provider).not.toHaveBeenCalled();
    });
    test('stale stored feedback is rejected', async () => {
      await Submission.updateOne({ _id: submission._id }, { correctionSourceHash: 'new-source' });
      expect((await post()).status).toBe(409); expect(provider).not.toHaveBeenCalled();
    });
    test('inactive classes and failed stored assessment cannot generate drafts', async () => {
      await Class.updateOne({ _id: classDoc._id }, { isActive: false });
      expect((await post()).status).toBe(403);
      await Class.updateOne({ _id: classDoc._id }, { isActive: true });
      await SubmissionFeedback.updateOne({ submissionId: submission._id }, { evaluationStatus: 'failed' });
      expect((await post()).status).toBe(409); expect(provider).not.toHaveBeenCalled();
    });
    test('provider timeout returns a safe error without saving', async () => {
      provider.mockRejectedValue(Object.assign(new Error('Timeout'), { code: 'AI_ATTEMPT_TIMEOUT' }));
      expect((await post()).status).toBe(503); expect(provider).toHaveBeenCalledTimes(2);
      expect((await SubmissionFeedback.findOne({ submissionId: submission._id })).teacherComments).toBe('Keep my saved comment');
    });
    test('invalid output fails safely after bounded gateway retry', async () => {
      provider.mockResolvedValue(response('{"comment":"bad","unexpected":true}'));
      expect((await post()).status).toBe(503); expect(provider).toHaveBeenCalledTimes(2);
      expect((await SubmissionFeedback.findOne({ submissionId: submission._id })).teacherComments).toBe('Keep my saved comment');
    });
    test('provider failure is safe and manual save still works', async () => {
      provider.mockResolvedValue({ ok: false, status: 401, headers: { get: () => null }, text: async () => '{}' });
      const result = await post(); expect(result.status).toBe(503);
      expect(result.body.message).toBe('Unable to generate a comment right now. Please try again.');
      expect((await patch(teacherToken, { teacherComments: 'My own feedback' })).status).toBe(200);
      expect((await SubmissionFeedback.findOne({ submissionId: submission._id })).teacherComments).toBe('My own feedback');
    });
    test('concurrent clicks are bounded independently of other AI routes', async () => {
      let release; let started;
      const called = new Promise(resolve => { started = resolve; });
      provider.mockImplementation(() => { started(); return new Promise(resolve => { release = resolve; }); });
      const first = post().then(result => result);
      await called;
      expect((await post()).status).toBe(429);
      release(response(JSON.stringify({ comment })));
      expect((await first).status).toBe(200); expect(provider).toHaveBeenCalledTimes(1);
    });
    test('draft validation rejects empty, excessive, multi-paragraph and internal output', () => {
      const { validateDraft } = require('../src/services/teacherComments.service');
      for (const value of ['', comment.repeat(5), comment+'\nAnother paragraph.', comment.replace('You', 'OpenRouter')])
        expect(() => validateDraft(JSON.stringify({ comment: value }))).toThrow();
      expect(validateDraft(JSON.stringify({ comment }))).toEqual({ comment });
    });
    test('missing source identity cannot certify current assessment feedback', async () => {
      await Submission.updateOne({ _id: submission._id }, { $unset: { correctionSourceHash: 1 } });
      expect((await post()).status).toBe(409); expect(provider).not.toHaveBeenCalled();
    });
    test('stale detailed prose and legacy overall prose are excluded from the prompt', async () => {
      await SubmissionFeedback.updateOne({ submissionId: submission._id }, { $set: {
        detailedFeedbackSourceHash: 'old-source', 'detailedFeedback.strengths': [{ explanation: 'STALE_DETAIL' }],
        'aiFeedback.overallComments': 'LEGACY_OVERALL' } });
      expect((await post()).status).toBe(200);
      const prompt = provider.mock.calls[0][1].body;
      expect(prompt).not.toContain('STALE_DETAIL'); expect(prompt).not.toContain('LEGACY_OVERALL');
    });
    test('short conservative drafts are allowed and marks, internal language and markup are rejected', () => {
      const { validateDraft, draftSource } = require('../src/services/teacherComments.service');
      const short = 'Please review the feedback provided and focus on the highlighted areas before your next submission.';
      expect(validateDraft(JSON.stringify({ comment: short })).comment).toBe(short);
      for (const bad of [short + ' You earned 90 marks.', short + ' The provider reviewed it.', short + ' ```code```', short + ' **Bold text**.'])
        expect(() => validateDraft(JSON.stringify({ comment: bad }))).toThrow();
      expect(draftSource({ rubricScores: { GRAMMAR: { comment: 'UNSUPPORTED' } }, scoreAuthority: { version: 1, categories: { GRAMMAR: { authoritative: false } } } }).categories).toEqual([]);
    });
    test('sparse current feedback can produce a conservative short draft without saving', async () => {
      await SubmissionFeedback.updateOne({ submissionId: submission._id }, { $unset: { detailedFeedback: 1, rubricScores: 1 } });
      await SubmissionFeedback.updateOne({ submissionId: submission._id }, { $set: { 'rubricScores.ORGANIZATION.comment': 'Use clearer transitions between ideas.' } });
      const short = 'Try using clearer transitions between ideas so your reader can follow each point.';
      provider.mockResolvedValue(response(JSON.stringify({ comment: short })));
      expect((await post()).body.data).toEqual({ comment: short });
      expect((await SubmissionFeedback.findOne({ submissionId: submission._id })).teacherComments).toBe('Keep my saved comment');
    });
  });

  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase();
    teacher = await User.create({ firebaseUid: 'tc-teacher', email: 'tc-teacher@example.com', role: 'teacher' });
    otherTeacher = await User.create({ firebaseUid: 'tc-other', email: 'tc-other@example.com', role: 'teacher' });
    student = await User.create({ firebaseUid: 'tc-student', email: 'tc-student@example.com', role: 'student' });
    classDoc = await Class.create({ name: 'Comment class', teacher: teacher._id, joinCode: 'tc-code', qrCodeUrl: 'data:,' });
    assignment = await Assignment.create({ title: 'Comment assignment', writingType: 'essay',
      deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id, qrToken: 'tc-token' });
    submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date(), isLate: false, ocrStatus: 'completed',
      correctionStatus: 'partial', semanticStatus: 'failed', evaluationStatus: 'failed' });
    teacherToken = signTestJwt({ id: teacher._id, firebaseUid: teacher.firebaseUid, role: 'teacher' });
    otherTeacherToken = signTestJwt({ id: otherTeacher._id, firebaseUid: otherTeacher.firebaseUid, role: 'teacher' });
    studentToken = signTestJwt({ id: student._id, firebaseUid: student.firebaseUid, role: 'student' });
  });

  const patch = (token, body, id = null) => request(app)
    .patch(`/api/feedback/${id || submission._id}/teacher-comments`)
    .set('Authorization', `Bearer ${token}`)
    .send(body);

  test('creates, trims, preserves line breaks, updates, and clears without requiring analysis', async () => {
    const created = await patch(teacherToken, { teacherComments: '  First line\nSecond line  ' });
    expect(created.status).toBe(200);
    expect(created.body.data).toMatchObject({ submissionId: String(submission._id),
      teacherComments: 'First line\nSecond line', teacherCommentsUpdatedBy: String(teacher._id) });
    expect(created.body.data.teacherCommentsUpdatedAt).toBeTruthy();
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);

    expect((await patch(teacherToken, { teacherComments: 'Updated' })).body.data.teacherComments).toBe('Updated');
    expect((await patch(teacherToken, { teacherComments: '' })).body.data.teacherComments).toBe('');
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);
  });

  test('rejects invalid payloads, identities, and authorization', async () => {
    for (const body of [{}, { teacherComments: null }, { teacherComments: 1 }, { teacherComments: [] },
      { teacherComments: {} }, { teacherComments: true }, { teacherComments: 'ok', extra: true },
      { teacherComments: 'x'.repeat(5001) }]) {
      expect((await patch(teacherToken, body)).status).toBe(400);
    }
    expect((await request(app).patch(`/api/feedback/${submission._id}/teacher-comments`).send({ teacherComments: 'x' })).status).toBe(401);
    expect((await patch(studentToken, { teacherComments: 'x' })).status).toBe(403);
    expect((await patch(otherTeacherToken, { teacherComments: 'x' })).status).toBe(403);
    expect((await patch(teacherToken, { teacherComments: 'x' }, 'invalid')).status).toBe(400);
    expect((await patch(teacherToken, { teacherComments: 'x' }, new mongoose.Types.ObjectId())).status).toBe(404);
  });

  test('targeted update preserves all rubric, AI, evaluation, and override fields', async () => {
    const original = await SubmissionFeedback.create({
      submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      rubricScores: { CONTENT: { score: 17, maxScore: 20, comment: 'c' }, ORGANIZATION: { score: 16, maxScore: 20, comment: 'o' },
        GRAMMAR: { score: 21, maxScore: 25, comment: 'g' }, VOCABULARY: { score: 15, maxScore: 20, comment: 'v' },
        MECHANICS: { score: 8, maxScore: 10, comment: 'm' }, PRESENTATION: { score: 4, maxScore: 5, comment: 'p' } },
      overallScore: 81, grade: 'B', correctionStats: { content: 1, grammar: 2, organization: 3, vocabulary: 4, mechanics: 5, total: 15 },
      detailedFeedback: { status: 'completed', strengths: ['s'], areasForImprovement: ['a'], actionSteps: ['n'] },
      aiFeedback: { perCategory: [{ category: 'CONTENT', message: 'ai', score: 4, maxScore: 5 }], overallComments: 'AI content' },
      assessmentVersion: 'assessment-x', evaluationVersion: 'evaluation-x', evaluationSourceHash: 'source-x',
      evaluationRubricSourceHash: 'rubric-x', evaluationStatus: 'failed', evaluationSource: 'provisional',
      evaluationJobId: 'job-x', overriddenByTeacher: false
    });
    const before = original.toObject();
    expect((await patch(teacherToken, { teacherComments: 'Only comment' })).status).toBe(200);
    const after = (await SubmissionFeedback.findById(original._id)).toObject();
    for (const field of ['rubricScores', 'overallScore', 'grade', 'correctionStats', 'detailedFeedback', 'aiFeedback',
      'assessmentVersion', 'evaluationVersion', 'evaluationSourceHash', 'evaluationRubricSourceHash',
      'evaluationStatus', 'evaluationSource', 'evaluationJobId', 'overriddenByTeacher']) {
      expect(after[field]).toEqual(before[field]);
    }
  });

  test('read precedence honors canonical empty and legacy fields without writes', async () => {
    await Feedback.create({ teacher: teacher._id, student: student._id, class: classDoc._id, assignment: assignment._id,
      submission: submission._id, teacherComments: 'Legacy teacher', textFeedback: 'Legacy text' });
    const canonical = await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id,
      studentId: student._id, teacherId: teacher._id, teacherComments: '' });
    const read = await request(app).get(`/api/feedback/${submission._id}`).set('Authorization', `Bearer ${studentToken}`);
    expect(read.status).toBe(200);
    expect(read.body.data.teacherComments).toBe('');
    expect((await SubmissionFeedback.findById(canonical._id)).teacherComments).toBe('');

    expect(resolveTeacherComments({ submissionFeedback: {}, legacyFeedback: { teacherComments: 'Teacher', textFeedback: 'Text' } })).toBe('Teacher');
    expect(resolveTeacherComments({ submissionFeedback: {}, legacyFeedback: { textFeedback: 'Text' } })).toBe('Text');
    expect(resolveTeacherComments({ submissionFeedback: { aiFeedback: { overallComments: 'Old form' } } })).toBe('Old form');
  });

  test('PDF view model uses the identical resolver and performs no persistence', async () => {
    const sf = { teacherComments: 'Canonical PDF comment', evaluationSourceHash: 'old' };
    const legacy = { teacherComments: 'Legacy PDF comment' };
    const source = { _id: submission._id, files: ['f1'], ocrStatus: 'completed', correctionStatus: 'completed',
      correctionSourceHash: 'hash', writingCorrections: [], ocrPages: [{ fileId: 'f1', pageNumber: 1, text: 'Text.', words: [] }] };
    const spy = jest.spyOn(SubmissionFeedback, 'findOneAndUpdate');
    const report = await buildPersistedSubmissionFeedbackReport({ submission: source, submissionFeedback: sf, feedback: legacy });
    expect(report.viewModel.teacherComments).toBe('Canonical PDF comment');
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('concurrent accepted saves retain one unique feedback document', async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, index) => patch(teacherToken, { teacherComments: `comment-${index}` })));
    expect(responses.some((response) => response.status === 200)).toBe(true);
    expect(responses.every((response) => [200, 429].includes(response.status))).toBe(true);
    expect(await SubmissionFeedback.countDocuments({ submissionId: submission._id })).toBe(1);
  });

  test('teacher rubric saving preserves comments and unrelated canonical data', async () => {
    await SubmissionFeedback.create({
      submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id,
      teacherComments: 'Keep this comment', correctionStats: { grammar: 2, total: 2 },
      evaluationSourceHash: 'source-hash', detailedFeedbackSourceHash: 'source-hash',
      rubricScores: { CONTENT: { score: 14, maxScore: 20 }, ORGANIZATION: { score: 11, maxScore: 20 },
        GRAMMAR: { score: 5, maxScore: 25 }, VOCABULARY: { score: 9, maxScore: 20 },
        MECHANICS: { score: 5.5, maxScore: 10 }, PRESENTATION: { score: 4.5, maxScore: 5 } },
      overallScore: 49, grade: 'F', overriddenByTeacher: false
    });
    const rubricScores = { CONTENT: { score: 14, maxScore: 20, comment: 'c' },
      ORGANIZATION: { score: 11, maxScore: 20, comment: 'o' },
      GRAMMAR: { score: 5, maxScore: 25, comment: 'g' },
      VOCABULARY: { score: 9, maxScore: 20, comment: 'v' },
      MECHANICS: { score: 5.5, maxScore: 10, comment: 'm' },
      PRESENTATION: { score: 3.5, maxScore: 5, comment: 'Teacher reviewed handwriting.' } };
    const response = await request(app).put(`/api/feedback/${submission._id}`)
      .set('Authorization', `Bearer ${teacherToken}`)
      .send({ rubricScores, overallScore: 51, detailedFeedback: {}, aiFeedback: { perCategory: [], overallComments: '' },
        rubricDesigner: null });
    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ overallScore: 51, grade: 'F', overriddenByTeacher: true });
    expect(response.body.data).not.toHaveProperty('scoreStatus');
    expect(response.body.data).not.toHaveProperty('presentationReviewStatus');
    const saved = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    expect(saved.rubricScores.PRESENTATION).toMatchObject({ score: 3.5, maxScore: 5,
      comment: 'Teacher reviewed handwriting.' });
    expect(saved).toMatchObject({ overallScore: 51, grade: 'F', teacherComments: 'Keep this comment',
      evaluationSourceHash: 'source-hash', detailedFeedbackSourceHash: 'source-hash' });
    expect(saved.correctionStats).toMatchObject({ grammar: 2, total: 2 });
  });
});
