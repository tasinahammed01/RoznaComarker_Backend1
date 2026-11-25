'use strict';
// Speaking Coach: reading and starting a practice session for one speaking submission.
// - Owner only: the student who owns it, or the guest holding its link (submissionAccessContext). Anyone else, and anything that is not a
//   speaking submission: 404 (it reveals nothing).
// - Only once the graded result is ready; the result read is the one the student sees (teacherEvaluation.finalFeedback) and the corrections
//   come from the one student builder (buildStudentCorrectionView).
// - One session per submission, owner and assessed source (sourceFingerprint); a second start returns it. The settings are copied in.
// - Tasks: areas.planTasks decides type, area and targets; the AI only words them (prompt.js) and templates take over on any failure.
// - Practice never writes the Submission, SubmissionFeedback, AssessmentRun or credits (D2: no credit is charged).
// Logs carry ids, codes and numbers only.
const crypto = require('crypto');
const Submission = require('../../models/Submission');
const SubmissionFeedback = require('../../models/SubmissionFeedback');
const Assignment = require('../../models/assignment.model');
const AudioRecording = require('../../models/AudioRecording');
const SpeakingPracticeSession = require('../../models/SpeakingPracticeSession');
const accessContext = require('../submissionAccessContext.service');
const { finalFeedback } = require('../teacherEvaluation.service');
const { buildStudentCorrectionView } = require('../studentCorrectionView.service');
const logger = require('../../utils/logger');
const { readSettings } = require('./policy');
const areas = require('./areas');
const { buildTasks } = require('./tasks');
const prompt = require('./prompt');
const { retryLine } = require('./coachText');

const SOURCE_VERSION = 'speaking-coach-source-v1';
const STALE_GENERATING_MS = 2 * 60 * 1000;
const WORDING_TIMEOUT_MS = 30000;

class CoachError extends Error {
  constructor(statusCode, code, message) { super(message); this.statusCode = statusCode; this.code = code; }
}
const notFound = () => new CoachError(404, 'NOT_FOUND', 'Not found.');
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeCode = error => String(error?.validationCode || error?.finalFailureCode || error?.code || 'COACH_GENERATION_FAILED').replace(/[^A-Z0-9_]/gi, '').slice(0, 64);
const READY = ['completed', 'partial'];
const STATE_OF = Object.freeze({ generating: 'generating', ready: 'ready', completed: 'completed', capped: 'capped', failed: 'failed' });

/** The owned speaking submission and its stored result (when ready). Throws 404 for anyone but the owner. */
async function loadSource(submissionId, actor) {
  if (!/^[a-f\d]{24}$/i.test(String(submissionId || ''))) throw notFound();
  const submission = await Submission.findOne({ _id: submissionId, sourceKind: 'audio' })
    .select('_id assignment class student submissionMode evaluationStatus writingCorrections correctionStatistics +audioRecording').lean();
  if (!submission || !accessContext.ownsSubmission(submission, actor)) throw notFound();
  const assignment = await Assignment.findOne({ _id: submission.assignment, resourceType: 'speaking' }).select('_id title instructions teacher class').lean();
  if (!assignment) throw notFound();
  const stored = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
  if (!READY.includes(submission.evaluationStatus) || !stored || !READY.includes(stored.evaluationStatus)) return { submission, assignment, ready: false };
  const criteria = areas.snapshotFromFeedback(finalFeedback(stored, submission));
  if (!criteria) return { submission, assignment, ready: false };
  const recording = submission.audioRecording ? await AudioRecording.findById(submission.audioRecording).select('_id +derived').lean() : null;
  const fluency = recording?.derived?.fluency?.available ? recording.derived.fluency : null;
  const corrections = buildStudentCorrectionView(submission, { overlay: null }).corrections || [];
  const sourceFingerprint = sha({ v: SOURCE_VERSION, feedbackId: String(stored._id), evaluationSourceHash: stored.evaluationSourceHash || '',
    rubricHash: stored.evaluationRubricSourceHash || '', criteria: criteria.map(c => [c.criterionId, c.levelTitle, c.levelPercent]) });
  return { submission, assignment, ready: true, stored, criteria, fluency, corrections, sourceFingerprint };
}

const sessionKey = (source, actor) => ({ submissionId: source.submission._id, ...accessContext.ownerFields(actor), sourceFingerprint: source.sourceFingerprint });
const isStale = session => session?.status === 'generating' && Date.now() - new Date(session.updatedAt).getTime() > STALE_GENERATING_MS;

/** { state, session (lean or null), source }. States: unavailable, no_practice_needed, idle, generating, ready, completed, capped, failed. */
async function getSession(submissionId, actor, { env = process.env } = {}) {
  const source = await loadSource(submissionId, actor);
  if (!source.ready) return { state: 'unavailable', session: null, source };
  const session = await SpeakingPracticeSession.findOne(sessionKey(source, actor)).lean();
  if (session) return { state: STATE_OF[session.status] || 'failed', session, source };
  const { settings } = readSettings(env);
  return { state: areas.weakAreas(source.criteria, settings.passPercent).length ? 'idle' : 'no_practice_needed', session: null, source };
}

/** The AI wording for the planned tasks, checked; throws on any failure (the caller falls back to templates). */
async function wordTasks({ source, plan, settings, env, fetchImpl }) {
  const gateway = require('../aiGateway.service');
  const taskIds = plan.map(item => item.taskId);
  const forbiddenWords = prompt.forbiddenTitles(source.criteria);
  const input = prompt.generationInput({ assignment: source.assignment, plan, criteria: source.criteria, fluency: source.fluency, corrections: source.corrections });
  const messages = prompt.generationMessages(input);
  const system = messages[0].content;
  let brokenRule = null;
  const validate = raw => {
    try { return prompt.validateGeneration(raw, { taskIds, forbiddenWords }); } catch (error) { brokenRule = error?.code || null; throw error; }
  };
  const onAttempt = ({ attemptNumber }) => {
    const line = attemptNumber > 1 ? retryLine(brokenRule) : '';
    messages[0].content = line ? `${system}\n${line}` : system;
    brokenRule = null;
  };
  const base = gateway.getAssessmentAIConfig(env);
  const result = await gateway.generate({ feature: prompt.GENERATION_FEATURE, env, fetchImpl, messages, onAttempt, validate,
    config: { ...base, attemptTimeoutMs: Math.min(base.attemptTimeoutMs || WORDING_TIMEOUT_MS, WORDING_TIMEOUT_MS), primaryRetries: 1, fallbackRetries: 0 },
    maxOutputTokens: settings.maxOutputTokens, temperature: 0.2, responseFormat: 'json', responseSchema: prompt.generationSchema(taskIds),
    schemaName: prompt.GENERATION_FEATURE, retryableSameModelCodes: ['AI_OUTPUT_VALIDATION_FAILED'],
    metadata: { submissionId: String(source.submission._id), purpose: prompt.GENERATION_FEATURE } });
  return { texts: result.value, provider: result.provider, model: result.model, usage: result.usage || {} };
}

/** A guest must send the current practice notice version (stored with the time); a student sends nothing. Returns the notice to store, or null. */
function acceptedNotice(actor, noticeVersion, now) {
  if (!accessContext.isGuest(actor)) return null;
  const { SPEAKING_COACH_NOTICE_VERSION } = require('../../config/speakingGuestNotice');
  if (noticeVersion !== SPEAKING_COACH_NOTICE_VERSION) throw new CoachError(400, 'COACH_NOTICE_REQUIRED', 'Read the practice notice and agree to it before you start.');
  return { version: SPEAKING_COACH_NOTICE_VERSION, acceptedAt: now() };
}

/**
 * Starts (or returns) the session. Returns { state, session }. Throws 404 (not the owner), 409 COACH_RESULT_NOT_READY, or for a guest 400
 * COACH_NOTICE_REQUIRED (noticeVersion is not the current practice notice). A guest's acceptance is stored, and refreshed when the version changed.
 */
async function startSession(submissionId, actor, { env = process.env, fetchImpl = globalThis.fetch, now = () => new Date(), noticeVersion } = {}) {
  const source = await loadSource(submissionId, actor);
  if (!source.ready) throw new CoachError(409, 'COACH_RESULT_NOT_READY', 'Practice opens once your result is ready.');
  const guestNotice = acceptedNotice(actor, noticeVersion, now);
  const key = sessionKey(source, actor);
  const existing = await SpeakingPracticeSession.findOne(key).lean();
  if (existing && existing.status !== 'failed' && !isStale(existing)) {
    if (guestNotice && existing.guestNotice?.version !== guestNotice.version) {
      await SpeakingPracticeSession.updateOne({ _id: existing._id }, { $set: { guestNotice }, $inc: { revision: 1 } });
      existing.guestNotice = guestNotice;
    }
    return { state: STATE_OF[existing.status], session: existing };
  }
  const { settings } = readSettings(env);
  const weak = areas.weakAreas(source.criteria, settings.passPercent);
  if (!weak.length) return { state: 'no_practice_needed', session: null };
  const plan = areas.planTasks(weak, { vocabTargets: areas.vocabTargets(source.corrections), passPercent: settings.passPercent })
    .map((item, index) => ({ ...item, taskId: `t${index + 1}` }));

  const startedAt = now();
  let session;
  try {
    session = await SpeakingPracticeSession.findOneAndUpdate(
      { ...key, $or: [{ status: 'failed' }, { status: 'generating', updatedAt: { $lt: new Date(Date.now() - STALE_GENERATING_MS) } }] },
      { $set: { status: 'generating', assignmentId: source.assignment._id, tasks: [], currentTaskId: null, 'generation.startedAt': startedAt,
        ...(guestNotice ? { guestNotice } : {}) },
        $setOnInsert: { settings: { passPercent: settings.passPercent, attemptCap: settings.maxAttemptsPerSubmission },
          sourceSnapshot: { feedbackId: source.stored._id, feedbackUpdatedAt: source.stored.updatedAt || null, criteria: source.criteria, fluency: source.fluency } } },
      { returnDocument: 'after', upsert: !existing, setDefaultsOnInsert: true });
  } catch (error) {
    if (error?.code !== 11000) throw error;
    const winner = await SpeakingPracticeSession.findOne(key).lean();
    return { state: STATE_OF[winner?.status] || 'generating', session: winner };
  }
  if (!session) {
    const current = await SpeakingPracticeSession.findOne(key).lean();
    return { state: STATE_OF[current?.status] || 'generating', session: current };
  }

  let worded = null;
  let errorCode = null;
  try { worded = await wordTasks({ source, plan, settings, env, fetchImpl }); } catch (error) { errorCode = safeCode(error); }
  const doc = await SpeakingPracticeSession.findById(session._id);
  doc.tasks = buildTasks(plan, { assignmentTitle: source.assignment.title, maxSeconds: settings.maxRecordingSeconds, texts: worded?.texts || {} });
  doc.currentTaskId = doc.tasks[0].taskId;
  doc.status = 'ready';
  doc.generation = { source: worded ? 'ai' : 'template', provider: worded?.provider, model: worded?.model, promptVersion: prompt.GENERATION_PROMPT_VERSION,
    startedAt, completedAt: now(), errorCode: errorCode || undefined, metrics: { inputTokens: worded?.usage?.prompt_tokens ?? null,
      outputTokens: worded?.usage?.completion_tokens ?? null, costUsd: typeof worded?.usage?.cost === 'number' ? worded.usage.cost : null } };
  doc.revision += 1;
  await doc.save();
  logger.metric({ event: 'speaking_coach_session_started', submissionId: String(source.submission._id), sessionId: String(doc._id),
    guest: accessContext.isGuest(actor), taskCount: doc.tasks.length, taskTypes: doc.tasks.map(t => t.type), source: doc.generation.source,
    errorCode, ...doc.generation.metrics });
  return { state: 'ready', session: doc.toObject() };
}

module.exports = { CoachError, loadSource, getSession, startSession, SOURCE_VERSION, STALE_GENERATING_MS };
