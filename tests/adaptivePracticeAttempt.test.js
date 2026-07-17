'use strict';

const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../src/models/AdaptivePracticeAttempt');
const aiGeneration = require('../src/services/aiGeneration.service');
const service = require('../src/services/adaptivePracticeAttempt.service');

const checklist = ['Connect the ideas clearly.', 'Use precise vocabulary.'];
function result(overrides = {}) {
  return JSON.stringify({ taskFulfillment: 24, targetSkillApplication: 39, checklistCompletion: 16, summary: 'The revision addresses the task clearly.', strength: 'The relationship between ideas is explicit.', nextImprovement: 'Choose one more precise academic verb.', checklist: checklist.map((item) => ({ item, met: true, feedback: 'This criterion is present.' })), suggestedRevision: 'However, the technology supports learning by making complex ideas accessible.', ...overrides });
}
async function seed() {
  const studentId = new mongoose.Types.ObjectId();
  const submissionId = new mongoose.Types.ObjectId();
  const activityId = 'activity-1';
  const session = await AdaptivePracticeSession.create({
    submissionId, studentId, assignmentId: new mongoose.Types.ObjectId(), status: 'ready', sourceFingerprint: 'source',
    sourceSnapshot: { transcriptFingerprint: 'transcript', feedbackId: new mongoose.Types.ObjectId(), feedbackUpdatedAt: new Date(), skills: [{ id: 'ORGANIZATION', category: 'Coherence & Flow', earnedPoints: 10, maximumPoints: 20, percentage: 50, status: 'needs-practice' }] },
    targetSkills: ['ORGANIZATION'], activities: [{ activityId, skillId: 'ORGANIZATION', category: 'Coherence & Flow', title: 'Connect ideas', description: 'Improve flow.', evidence: 'Ideas are separate.', task: 'Join the ideas clearly.', tip: 'Use a transition.', checklist, modelAnswer: 'However, the ideas connect.', difficulty: 'developing' }]
  });
  return { studentId, submissionId, session, activityId };
}

describe('adaptive practice attempts', () => {
  beforeAll(connectInMemoryMongo);
  afterAll(disconnectInMemoryMongo);
  beforeEach(async () => { await clearDatabase(); jest.restoreAllMocks(); });

  it('builds stable response fingerprints and changes them for response or identity changes', () => {
    const base = { sessionId: 's', activityId: 'a', studentId: 'u', response: '  A useful response.\r\n' };
    expect(service.responseFingerprint(base)).toBe(service.responseFingerprint({ ...base, response: 'A useful response.' }));
    expect(service.responseFingerprint(base)).not.toBe(service.responseFingerprint({ ...base, response: 'A changed response.' }));
    expect(service.responseFingerprint(base)).not.toBe(service.responseFingerprint({ ...base, activityId: 'b' }));
  });

  it('assigns the 50-point criterion to the named target skill rather than generic writing quality', async () => {
    const { session, activityId } = await seed();
    const activity = session.activities.find((item) => item.activityId === activityId);
    const messages = service.buildCheckMessages(activity, 'A sufficiently meaningful response.');
    expect(messages[0].content).toContain('targetSkillApplication 0-50');
    expect(messages[0].content).toContain('Coherence & Flow');
    expect(messages[0].content).toContain('not generic writing quality');
    expect(messages[0].content).toContain('taskFulfillment 0-30');
    expect(messages[0].content).toContain('checklistCompletion 0-20');
  });

  it('rejects empty, trivial, and oversized responses before calling AI', async () => {
    const { session, studentId, activityId } = await seed();
    const spy = jest.spyOn(aiGeneration, 'generateChatCompletion');
    await expect(service.checkResponse(session._id, activityId, studentId, { response: '....' })).rejects.toMatchObject({ code: 'INVALID_PRACTICE_RESPONSE' });
    await expect(service.checkResponse(session._id, activityId, studentId, { response: 'x'.repeat(5001) })).rejects.toMatchObject({ code: 'INVALID_PRACTICE_RESPONSE' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('checks, scores, persists, and restores progress without changing the session', async () => {
    const { session, studentId, activityId } = await seed();
    const before = session.toObject();
    jest.spyOn(aiGeneration, 'generateChatCompletion').mockResolvedValue(result());
    const checked = await service.checkResponse(session._id, activityId, studentId, { response: 'However, these ideas now connect more clearly.' });
    expect(checked.attempt.result.score).toBe(79);
    expect(checked.attempt.result.passed).toBe(true);
    expect(checked.progress).toMatchObject({ improvedActivities: 1, percentage: 100 });
    const after = await AdaptivePracticeSession.findById(session._id).lean();
    expect(after.activities).toEqual(expect.arrayContaining([expect.objectContaining({ task: before.activities[0].task })]));
    expect(after.sourceSnapshot).toEqual(expect.objectContaining({ transcriptFingerprint: 'transcript' }));
  });

  it('reuses an identical response and makes only one AI call', async () => {
    const { session, studentId, activityId } = await seed();
    const spy = jest.spyOn(aiGeneration, 'generateChatCompletion').mockResolvedValue(result());
    const body = { response: 'However, these ideas now connect more clearly.' };
    const first = await service.checkResponse(session._id, activityId, studentId, body);
    const second = await service.checkResponse(session._id, activityId, studentId, body);
    expect(String(second.attempt._id)).toBe(String(first.attempt._id));
    expect(second.reused).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await AdaptivePracticeAttempt.countDocuments()).toBe(1);
  });

  it('coalesces concurrent identical checks into one attempt and AI call', async () => {
    const { session, studentId, activityId } = await seed();
    let release; const gate = new Promise((resolve) => { release = resolve; });
    const spy = jest.spyOn(aiGeneration, 'generateChatCompletion').mockImplementation(async () => { await gate; return result(); });
    const body = { response: 'However, these ideas now connect more clearly.' };
    const first = service.checkResponse(session._id, activityId, studentId, body);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = service.checkResponse(session._id, activityId, studentId, body);
    release(); await Promise.all([first, second]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(await AdaptivePracticeAttempt.countDocuments()).toBe(1);
  });

  it('creates sequential attempts for changed responses and keeps the best score', async () => {
    const { session, studentId, activityId } = await seed();
    jest.spyOn(aiGeneration, 'generateChatCompletion').mockResolvedValueOnce(result({ taskFulfillment: 15, targetSkillApplication: 25, checklistCompletion: 10 })).mockResolvedValueOnce(result());
    await service.checkResponse(session._id, activityId, studentId, { response: 'This first revision connects the ideas somewhat.' });
    const second = await service.checkResponse(session._id, activityId, studentId, { response: 'However, this stronger revision connects the ideas clearly.' });
    expect(second.attempt.attemptNumber).toBe(2);
    expect(second.progress.activities[0]).toMatchObject({ attemptCount: 2, bestScore: 79, latestScore: 79 });
  });

  it('retries malformed provider output once and validates checklist order', async () => {
    const { session, studentId, activityId } = await seed();
    const spy = jest.spyOn(aiGeneration, 'generateChatCompletion').mockResolvedValueOnce('{bad').mockResolvedValueOnce(result());
    const checked = await service.checkResponse(session._id, activityId, studentId, { response: 'However, these ideas now connect more clearly.' });
    expect(checked.state).toBe('ready'); expect(spy).toHaveBeenCalledTimes(2);
    expect(() => service.validateCheckResult(result({ checklist: [...checklist].reverse().map((item) => ({ item, met: true, feedback: 'Present.' })) }), session.activities[0])).toThrow(expect.objectContaining({ code: 'INVALID_CHECK_RESPONSE' }));
  });

  it('contains provider failures, requires explicit retry, and hides raw errors', async () => {
    const { session, studentId, activityId } = await seed();
    const spy = jest.spyOn(aiGeneration, 'generateChatCompletion').mockRejectedValueOnce(new Error('secret provider detail')).mockResolvedValueOnce(result());
    const body = { response: 'However, these ideas now connect more clearly.' };
    await expect(service.checkResponse(session._id, activityId, studentId, body)).rejects.toMatchObject({ message: 'Your response could not be checked. Please try again.' });
    const failed = await service.checkResponse(session._id, activityId, studentId, body);
    expect(failed.state).toBe('failed'); expect(spy).toHaveBeenCalledTimes(1);
    const retried = await service.checkResponse(session._id, activityId, studentId, { ...body, retry: true });
    expect(retried.state).toBe('ready'); expect(spy).toHaveBeenCalledTimes(2);
  });

  it('enforces ownership for checks and history', async () => {
    const { session, activityId } = await seed();
    const other = new mongoose.Types.ObjectId();
    await expect(service.checkResponse(session._id, activityId, other, { response: 'A sufficiently meaningful response.' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(service.listAttempts(session._id, other, activityId)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
