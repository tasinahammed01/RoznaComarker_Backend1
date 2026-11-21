'use strict';
// Speaking assessment (audio + speech-to-text, stage 6). A NEW, additive assessor: its own prompt, schema and versions, writing the standard
// stored result (SubmissionFeedback, Submission.evaluationStatus / evaluationJobId / writingCorrections) so existing readers can be reused.
// The essay pipeline (canonicalEvaluation.service.js) is not used or changed. Imported, never edited: assessmentCompletion,
// assessmentCreditRouter, canonicalDetailedFeedback, assignmentRubric, studentCorrectionView, teacherEvaluation.finalFeedback.
//
// Lifecycle (same fields and rules as essays):
// - When a recording becomes ready it is queued here (AudioRecording.assessmentQueue; the job lease lives on the recording, not on the heavy
//   Submission). The audio worker sweeps the queue: inclusion projection, a limit, no database sort.
// - Not enough speech (fewer than SPEAKING_MIN_WORDS words), mostly non-English or unintelligible speech, or an over-long text: a terminal
//   result with its code, no AI call where it can be decided without one, never charged.
// - Credits: checked through assessmentCreditRouter (the SAME wallet the charge uses: personal, or the institution's for an institution class).
//   No credits: evaluationStatus 'blocked', INSUFFICIENT_ASSESSMENT_CREDITS, like essays.
// - evaluationJobId is the run id; assessmentCompletion.start before the AI call, assessmentCompletion.complete after the result is stored,
//   which charges once (idempotency key assessment:<submissionId>:<runId>). A failed, invalid or not-assessable result is never charged.
// - A crash mid-run: the lease ends, the sweep picks the recording up again and the same run id is reused (no second run, no second charge).
// Logs carry ids, codes and numbers only: never the transcript or the feedback text.
const crypto = require('crypto');
const AudioRecording = require('../../models/AudioRecording');
const Submission = require('../../models/Submission');
const SubmissionFeedback = require('../../models/SubmissionFeedback');
const AssessmentRun = require('../../models/AssessmentRun');
const Assignment = require('../../models/assignment.model');
const User = require('../../models/user.model');
const logger = require('../../utils/logger');
const gateway = require('../aiGateway.service');
const assessmentCompletion = require('../assessmentCompletion.service');
const AssessmentCreditRouter = require('../assessmentCreditRouter.service');
const detailedFeedbackService = require('../canonicalDetailedFeedback.service');
const { calculateCustomRubricScore } = require('../assignmentRubric.service');
const { statistics: correctionStatistics } = require('../correctionCanonical.service');
const { gradeFromOverallScore } = require('../rubricLanguageScoring.service');
const prompt = require('./speakingAssessmentPrompt');
const speakingRubric = require('./speakingRubric');

const ASSESSMENT_VERSION = 'speaking-rubric-v1';
const EVALUATION_VERSION = 'speaking-evaluation-v1';
const SOURCE_VERSION = 'speaking-source-v1';
const SCORING_VERSION = 'speaking-scoring-v1';
const DEFAULT_MIN_WORDS = 30;
const MAX_ASSESSED_CHARS = 24000;            // > 7 min at a very fast 250 words/min; never truncated
const MAX_ATTEMPTS = 2;                      // the first try plus one retry after a provider/network failure
const RETRY_DELAY_MS = 60000;
const LEASE_MS = 10 * 60 * 1000;
const LINK_WAIT_MS = 30000;
const LINK_GIVE_UP_MS = 10 * 60 * 1000;
const SWEEP_CAP = 10;
const MAX_OUTPUT_TOKENS = 3000;
const NOT_RETRYABLE = new Set(['AI_OUTPUT_VALIDATION_FAILED', 'AI_CHAIN_NOT_CONFIGURED', 'AI_ASSESSMENT_AUTHORITY_INVALID']);
const TERMINAL_MESSAGES = Object.freeze({
  SPEAKING_NOT_ENOUGH_SPEECH: 'There was not enough speech in this recording to assess it.',
  SPEAKING_NOT_ENGLISH: 'This recording could not be assessed because it is mostly not in English.',
  SPEAKING_UNINTELLIGIBLE: 'This recording could not be assessed because too little of it could be understood.',
  SPEAKING_TRANSCRIPT_TOO_LONG: 'This recording is too long to assess.'
});
const NOT_CHARGEABLE = new Set(Object.keys(TERMINAL_MESSAGES));

const DEFAULT_OFF_TOPIC_CAP = 50;
const TASK_CRITERION_ID = 'speaking-task';
/**
 * SPEAKING_OFF_TOPIC_SCORE_CAP: whole number 0..100, default 50. When the assessor reports the answer as off topic, and the rubric has the task
 * criterion (the default speaking rubric and its copies), the overall score is capped there. A rubric without that criterion is never capped.
 * Deterministic and after the model: the prompt is unchanged, and the essay rubric code is used as is (its levels and points stay).
 */
function offTopicScoreCap(env = process.env) {
  const raw = String(env.SPEAKING_OFF_TOPIC_SCORE_CAP ?? '').trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 0 && value <= 100 ? value : DEFAULT_OFF_TOPIC_CAP;
}

/** SPEAKING_MIN_WORDS: whole number 5..200, default 30 (about 15 to 20 seconds of speech; fewer words cannot show organisation or range). */
function minWords(env = process.env) {
  const raw = String(env.SPEAKING_MIN_WORDS ?? '').trim();
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(value) && value >= 5 && value <= 200 ? value : DEFAULT_MIN_WORDS;
}
const countWords = text => (String(text).match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
/** Share of words written in a non-Latin script (the provider transcribes English only; other languages come out as other scripts or noise). */
function nonLatinShare(text) {
  const words = String(text).match(/[\p{L}][\p{L}'’-]*/gu) || [];
  if (!words.length) return 0;
  return words.filter(word => /[^\p{Script=Latin}'’-]/u.test(word)).length / words.length;
}
const sha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const log = fields => logger.metric(fields);
// The gateway ends with AI_CHAIN_EXHAUSTED and puts the cause of the last attempt in finalFailureCode (for example AI_OUTPUT_VALIDATION_FAILED).
const failureCode = error => String(error?.finalFailureCode || error?.code || 'SPEAKING_ASSESSMENT_FAILED');
const safeCode = error => failureCode(error).replace(/[^A-Z0-9_]/gi, '').slice(0, 64) || 'SPEAKING_ASSESSMENT_FAILED';

// ---- Queue -------------------------------------------------------------------------------------------------------------------------------
/** Queues the assessment of a ready recording (called by the transcription worker, the retry endpoint and tests). */
async function enqueueAssessment(recordingId, { now = () => new Date() } = {}) {
  const at = now();
  const queued = await AudioRecording.updateOne({ _id: recordingId, status: 'ready' },
    { $set: { assessmentQueue: true, assessmentNextAttemptAt: at, assessmentAttempts: 0, assessmentLeaseUntil: null } });
  // A finished result is never reset by queuing again (only a retry of a failed or blocked one, or a new recording, changes the state).
  if (queued.modifiedCount) await Submission.updateOne({ audioRecording: recordingId, sourceKind: 'audio', evaluationStatus: { $nin: ['processing', 'completed', 'partial'] } },
    { $set: { evaluationStatus: 'pending', evaluationErrorCode: null, evaluationError: null } });
  return { queued: queued.modifiedCount === 1 };
}

const due = at => ({ assessmentQueue: true, assessmentAttempts: { $lt: MAX_ATTEMPTS },
  $and: [{ $or: [{ assessmentNextAttemptAt: null }, { assessmentNextAttemptAt: { $lte: at } }] },
    { $or: [{ assessmentLeaseUntil: null }, { assessmentLeaseUntil: { $lte: at } }] }] });

async function claimAssessment(id, at) {
  return AudioRecording.findOneAndUpdate({ _id: id, ...due(at) },
    { $set: { assessmentLeaseUntil: new Date(at.getTime() + LEASE_MS), assessmentAttemptKey: crypto.randomUUID() }, $inc: { assessmentAttempts: 1 } },
    { returnDocument: 'after' }).select('+assessmentLeaseUntil +assessmentAttemptKey +derived').lean();
}

/** The sweep's query: due work as an inclusion projection with a limit (one more than the cap). No sort. */
function assessmentSweepQuery(at) {
  return { filter: due(at), projection: { _id: 1, assessmentNextAttemptAt: 1, createdAt: 1 }, limit: SWEEP_CAP + 1 };
}

/** One sweep: due assessments oldest first (sorted in Node), one at a time. Exhausted work is failed first. */
async function sweepAssessments(options = {}) {
  const { now = () => new Date() } = options;
  const at = now();
  const exhausted = await AudioRecording.find({ assessmentQueue: true, assessmentAttempts: { $gte: MAX_ATTEMPTS },
    $or: [{ assessmentLeaseUntil: null }, { assessmentLeaseUntil: { $lte: at } }] }).select({ _id: 1 }).limit(SWEEP_CAP).lean();
  for (const doc of exhausted) await failExhausted(doc._id, at);
  const { filter, projection, limit } = assessmentSweepQuery(at);
  const found = await AudioRecording.find(filter).select(projection).limit(limit).lean();
  const order = doc => (doc.assessmentNextAttemptAt || doc.createdAt || at).getTime();
  const batch = found.sort((a, b) => order(a) - order(b) || String(a._id).localeCompare(String(b._id))).slice(0, SWEEP_CAP);
  log({ event: 'speaking_assessment_sweep', found: batch.length, capped: found.length > SWEEP_CAP, exhausted: exhausted.length });
  let processed = 0;
  for (const doc of batch) if ((await runSpeakingAssessment(doc._id, options)).status !== 'skipped') processed++;
  return { found: batch.length, processed, exhausted: exhausted.length };
}

async function failExhausted(recordingId, at) {
  const done = await AudioRecording.updateOne({ _id: recordingId, assessmentQueue: true }, { $set: { assessmentLeaseUntil: null, assessmentNextAttemptAt: null },
    $unset: { assessmentQueue: 1 } });
  if (!done.modifiedCount) return;
  const submission = await Submission.findOne({ audioRecording: recordingId, sourceKind: 'audio' }).select('_id evaluationJobId').lean();
  if (submission) await markFailed(submission._id, recordingId, submission.evaluationJobId, 'SPEAKING_ASSESSMENT_ATTEMPTS_EXHAUSTED', at);
}

async function markFailed(submissionId, recordingId, runId, code, at = new Date()) {
  await Submission.updateOne({ _id: submissionId, audioRecording: recordingId }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: code,
    evaluationError: null, ...(runId ? { assessmentStatus: 'failed', assessmentErrorCode: code } : {}) }, $unset: { assessmentCompletedAt: 1 } });
  if (runId) {
    await AssessmentRun.updateOne({ runId, status: { $ne: 'complete' } }, { $set: { status: 'failed', failedAt: at, errorCode: code } });
    await SubmissionFeedback.updateOne({ submissionId, evaluationJobId: runId, evaluationStatus: { $ne: 'completed' } },
      { $set: { evaluationStatus: 'failed', evaluationErrorCode: code } });
  }
}

// ---- One run -----------------------------------------------------------------------------------------------------------------------------
/**
 * One assessment attempt for one recording. Returns { status } among completed, not_assessable, blocked, failed, queued (retry scheduled),
 * waiting (not linked to its submission yet), discarded (replaced or removed meanwhile), superseded or skipped. Never throws for AI failures.
 */
async function runSpeakingAssessment(recordingId, { now = () => new Date(), env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const at = now();
  const claimed = await claimAssessment(recordingId, at);
  if (!claimed) return { status: 'skipped' };
  const mine = { _id: claimed._id, assessmentAttemptKey: claimed.assessmentAttemptKey };
  const finish = () => AudioRecording.updateOne(mine, { $set: { assessmentLeaseUntil: null, assessmentNextAttemptAt: null }, $unset: { assessmentQueue: 1 } });
  const later = (ms, giveBack) => AudioRecording.updateOne(mine, { $set: { assessmentLeaseUntil: null, assessmentNextAttemptAt: new Date(at.getTime() + ms) },
    ...(giveBack ? { $inc: { assessmentAttempts: -1 } } : {}) });
  const context = { recordingId: String(claimed._id), attempt: claimed.assessmentAttempts };

  if (!claimed.submissionId) {
    if (at.getTime() - new Date(claimed.createdAt).getTime() > LINK_GIVE_UP_MS) { await finish(); return { status: 'discarded' }; }
    await later(LINK_WAIT_MS, true);
    return { status: 'waiting' };
  }
  const submission = await Submission.findOne({ _id: claimed.submissionId, sourceKind: 'audio' }).select('+audioRecording');
  if (!submission || String(submission.audioRecording) !== String(claimed._id)) { await finish(); log({ event: 'speaking_assessment_discarded', ...context }); return { status: 'discarded' }; }
  const submissionId = submission._id;
  Object.assign(context, { submissionId: String(submissionId) });
  const current = { _id: submissionId, audioRecording: claimed._id };
  const assignment = await Assignment.findOne({ _id: submission.assignment, resourceType: 'speaking' }).select('_id title instructions teacher class speaking').lean();
  if (!assignment) { await finish(); return { status: 'discarded' }; }

  const terminal = async (code, runId = null) => {
    await Submission.updateOne(current, { $set: { evaluationStatus: 'failed', evaluationErrorCode: code, evaluationError: TERMINAL_MESSAGES[code] || null,
      ...(runId ? { assessmentStatus: 'failed', assessmentErrorCode: code } : {}) } });
    if (runId) {
      await AssessmentRun.updateOne({ runId, status: { $ne: 'complete' } }, { $set: { status: 'failed', failedAt: now(), errorCode: code } });
      await SubmissionFeedback.updateOne({ submissionId, evaluationJobId: runId }, { $set: { evaluationStatus: 'failed', evaluationErrorCode: code } });
    }
    await finish();
    log({ event: 'speaking_assessment_not_assessable', ...context, code, charged: false });
    return { status: 'not_assessable', code };
  };

  // Decided without AI.
  const assessedText = String(claimed.derived?.assessorText || '').trim();
  const fluency = claimed.derived?.fluency || null;
  const wordCount = countWords(assessedText);
  if (wordCount < minWords(env)) return terminal('SPEAKING_NOT_ENOUGH_SPEECH');
  if (nonLatinShare(assessedText) > 0.3) return terminal('SPEAKING_NOT_ENGLISH');
  if (assessedText.length > MAX_ASSESSED_CHARS) return terminal('SPEAKING_TRANSCRIPT_TOO_LONG');

  const rubric = await speakingRubric.resolveSpeakingRubric(assignment);
  if (rubric.status !== 'valid') { await Submission.updateOne(current, { $set: { evaluationStatus: 'failed', evaluationErrorCode: 'SPEAKING_RUBRIC_INVALID' } }); await finish();
    return { status: 'failed', code: 'SPEAKING_RUBRIC_INVALID' }; }
  const input = prompt.buildInput({ assignment, rubric: rubric.rubric, assessedText, fluency, durationSeconds: claimed.durationSeconds, wordCount });
  const sourceHash = sha({ v: SOURCE_VERSION, assessedText, fluency: input.fluency, task: input.task, recording: input.recording });
  const teacherId = assignment.teacher;
  const teacher = await User.findById(teacherId).select('role').lean();
  const accountingEnabled = teacher?.role === 'teacher';

  // Already assessed with exactly this input and rubric: only finish the accounting (idempotent).
  const existing = await SubmissionFeedback.findOne({ submissionId }).select('evaluationStatus evaluationSourceHash evaluationRubricSourceHash evaluationVersion evaluationJobId').lean();
  if (existing?.evaluationStatus === 'completed' && existing.evaluationSourceHash === sourceHash && existing.evaluationRubricSourceHash === rubric.rubricHash
    && existing.evaluationVersion === EVALUATION_VERSION && submission.evaluationStatus === 'completed') {
    if (accountingEnabled && existing.evaluationJobId) await assessmentCompletion.complete({ runId: existing.evaluationJobId, teacherId, submissionId, sourceHash }).catch(() => {});
    await finish();
    return { status: 'completed', reused: true };
  }

  // Credits: the same wallet the charge will use.
  if (accountingEnabled) {
    let credit;
    try { credit = await AssessmentCreditRouter.canRunAssessment({ teacherUserId: teacherId, submissionId, assignmentId: assignment._id }); }
    catch (error) { await Submission.updateOne(current, { $set: { evaluationStatus: 'failed', evaluationErrorCode: safeCode(error) } }); await finish(); return { status: 'failed', code: safeCode(error) }; }
    if (!credit.allowed) {
      await Submission.updateOne(current, { $set: { evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS',
        evaluationError: 'You have used all your Assessment Credits for this billing cycle.' } });
      await finish();
      log({ event: 'speaking_assessment_blocked', ...context, code: 'INSUFFICIENT_ASSESSMENT_CREDITS', charged: false });
      return { status: 'blocked', code: 'INSUFFICIENT_ASSESSMENT_CREDITS' };
    }
  }

  // The run: a crashed run of this recording keeps its id.
  const runId = submission.evaluationStatus === 'processing' && submission.evaluationJobId ? submission.evaluationJobId : crypto.randomUUID();
  const locked = await Submission.updateOne({ ...current, $or: [{ evaluationStatus: { $ne: 'processing' } }, { evaluationJobId: runId }] },
    { $set: { evaluationStatus: 'processing', evaluationJobId: runId, evaluationError: null, evaluationErrorCode: null } });
  if (!locked.matchedCount) { await finish(); return { status: 'superseded' }; }
  Object.assign(context, { runId });
  if (accountingEnabled) await assessmentCompletion.start({ runId, submission, teacherId, sourceHash });
  // A guest's recording (stage 10) has no student: its feedback is a guest's, as for essay guests.
  await SubmissionFeedback.findOneAndUpdate({ submissionId }, { $set: { submissionId, classId: submission.class, studentId: submission.student,
    submissionMode: submission.submissionMode === 'guest' ? 'guest' : 'registered', teacherId, evaluationJobId: runId } }, { upsert: true, runValidators: true, setDefaultsOnInsert: true });

  let result;
  try {
    result = await gateway.generate({ feature: prompt.FEATURE, config: gateway.getAssessmentAIConfig(env), env, fetchImpl, messages: prompt.messagesFor(input),
      maxOutputTokens: MAX_OUTPUT_TOKENS, temperature: 0, responseFormat: 'json', responseSchema: prompt.responseSchema(rubric.rubric), schemaName: prompt.FEATURE,
      metadata: { submissionId: String(submissionId), jobId: runId, purpose: prompt.FEATURE },
      validate: raw => prompt.validateOutput(raw, { rubric: rubric.rubric, input }) });
  } catch (error) {
    const code = safeCode(error);
    const retry = !NOT_RETRYABLE.has(failureCode(error)) && claimed.assessmentAttempts < MAX_ATTEMPTS;
    if (retry) { await later(RETRY_DELAY_MS, false); log({ event: 'speaking_assessment_retry_scheduled', ...context, code }); return { status: 'queued', code }; }
    await markFailed(submissionId, claimed._id, runId, code, now());
    await finish();
    log({ event: 'speaking_assessment_failed', ...context, code, charged: false });
    return { status: 'failed', code };
  }

  const value = result.value;
  if (!value.assessable) return terminal(value.reason === 'not_english' ? 'SPEAKING_NOT_ENGLISH' : 'SPEAKING_UNINTELLIGIBLE', runId);

  try {
    const scored = calculateCustomRubricScore(rubric.rubric, value.criteria);
    const cap = offTopicScoreCap(env);
    const capApplies = value.relevance === 'off_topic' && rubric.rubric.criteria.some(c => c.id === TASK_CRITERION_ID) && scored.overallScore > cap;
    const offTopicCap = capApplies ? { applied: true, cap, uncappedScore: scored.overallScore } : { applied: false };
    // The stored custom-rubric result keeps every level and point; only its total follows the cap, so every reader sees one score.
    const custom = capApplies ? { ...scored, overallScore: cap } : scored;
    const legend = require('../correctionLegendResolver.service').fallbackLegend();
    const labels = new Map(legend.groups.flatMap(group => (group.symbols || []).map(item => [item.symbol, item.label])));
    const corrections = value.corrections.map((item, index) => ({ id: `speaking-${sourceHash.slice(0, 12)}-${index + 1}`, ...item,
      symbolLabel: labels.get(item.symbol) || item.symbol, source: 'speaking_assessment' }));
    const stats = correctionStatistics(corrections);
    const rubricScores = speakingRubric.builtInScores(custom, stats);
    const overallScore = custom.overallScore;
    const detailedBase = detailedFeedbackService.buildDeterministicDetailedFeedback({ corrections, statistics: stats, categoryScores: rubricScores, sourceHash,
      transcript: assessedText });
    if (!detailedFeedbackService.validateDetailedFeedback(detailedBase, { corrections, statistics: stats, categoryScores: rubricScores, sourceHash, transcript: assessedText })) {
      throw Object.assign(new Error('detailed feedback invalid'), { code: 'DETAILED_FEEDBACK_INVALID' });
    }
    const detailedFeedback = { ...detailedBase, speaking: { summary: value.summary, strengths: value.strengths, improvements: value.improvements } };
    const usage = result.usage || {};
    const saved = await SubmissionFeedback.findOneAndUpdate({ submissionId, evaluationJobId: runId, overriddenByTeacher: { $ne: true } }, { $set: {
      assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION, evaluationSourceHash: sourceHash, evaluationRubricSourceHash: rubric.rubricHash,
      evaluationSource: 'ai', evaluationStatus: 'completed', evaluationProvider: result.provider, evaluationModel: result.model, evaluationErrorCode: null,
      evaluationAttempts: result.attempts || [], correctionStats: stats, rubricScores, customRubricScores: custom, sourceRubric: rubric.rubric, overallScore,
      grade: gradeFromOverallScore(overallScore), maxOverallScore: 100,
      aiFeedback: { perCategory: custom.criteria.map(c => ({ category: c.title, message: c.comment, score: c.weightedPoints, maxScore: c.normalizedWeight,
        scoreOutOf5: Math.round(c.configuredLevelPercentage / 20 * 10) / 10 })), overallComments: value.summary },
      scoringAudit: { version: SCORING_VERSION, overallMethod: 'custom_rubric_weighted_total', rubricSource: rubric.source, notApplicable: [...speakingRubric.NOT_APPLICABLE],
        builtInDerivation: 'speaking_default_criteria', promptVersion: prompt.PROMPT_VERSION, schemaVersion: prompt.SCHEMA_VERSION, relevance: value.relevance,
        wordCount, minWords: minWords(env), droppedCorrections: value.droppedCorrections, offTopicCap,
        usage: { inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, costUsd: typeof usage.cost === 'number' ? usage.cost : null } },
      detailedFeedback, detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: detailedFeedbackService.VERSION
    }, $unset: { evaluationPolicyHash: 1, evaluationPolicy: 1, evaluationBuiltInContextHash: 1, analysisInputHash: 1 } }, { new: true, runValidators: true });
    if (!saved) { await finish(); return { status: 'superseded' }; }
    const stored = await Submission.updateOne({ ...current, evaluationJobId: runId, evaluationStatus: 'processing' }, { $set: {
      writingCorrections: corrections, correctionStatistics: stats, evaluationStatus: 'completed', evaluationSourceHash: sourceHash,
      evaluationRubricSourceHash: rubric.rubricHash, evaluationVersion: EVALUATION_VERSION, evaluationProvider: result.provider, evaluationModel: result.model,
      evaluationUpdatedAt: now(), evaluationError: null, evaluationErrorCode: null } });
    if (stored.modifiedCount !== 1) { await finish(); return { status: 'superseded' }; }
    // The charge. If it fails (for example credits ran out meanwhile), the stored result stays; assessmentCompletion marks the run failed,
    // exactly as for essays, and a later retry of the same run charges once.
    let charged = false;
    if (accountingEnabled) {
      try { await assessmentCompletion.complete({ runId, teacherId, submissionId, sourceHash }); charged = true; }
      catch (error) { log({ event: 'speaking_assessment_charge_failed', ...context, code: safeCode(error) }); }
    }
    await finish();
    log({ event: 'speaking_assessment_completed', ...context, overallScore, corrections: corrections.length, droppedCorrections: value.droppedCorrections,
      inputTokens: usage.prompt_tokens ?? null, outputTokens: usage.completion_tokens ?? null, costUsd: typeof usage.cost === 'number' ? usage.cost : null, charged });
    return { status: 'completed', overallScore };
  } catch (error) {
    const code = safeCode(error);
    await markFailed(submissionId, claimed._id, runId, code, now());
    await finish();
    log({ event: 'speaking_assessment_failed', ...context, code, charged: false });
    return { status: 'failed', code };
  }
}

// ---- Teacher retry -----------------------------------------------------------------------------------------------------------------------
const RETRYABLE_STATES = new Set(['failed', 'blocked']);
/** The owning teacher queues a failed or blocked assessment again (not one that cannot be assessed). Throws { statusCode, code }. */
async function retryAssessment({ context, now = () => new Date() }) {
  const { submission, recording } = context;
  const fail = (statusCode, code, message) => Object.assign(new Error(message), { statusCode, code });
  if (!recording || recording.status !== 'ready') throw fail(409, 'ASSESSMENT_NOT_RETRYABLE', 'The recording is not ready to assess.');
  const state = await Submission.findById(submission._id).select('evaluationStatus evaluationErrorCode').lean();
  if (!RETRYABLE_STATES.has(state?.evaluationStatus) || NOT_CHARGEABLE.has(state?.evaluationErrorCode)) {
    throw fail(409, 'ASSESSMENT_NOT_RETRYABLE', 'Only a failed or blocked assessment can be retried.');
  }
  await enqueueAssessment(recording._id, { now });
  require('./processing').kickAudioWorker();
}

module.exports = { ASSESSMENT_VERSION, EVALUATION_VERSION, SOURCE_VERSION, SCORING_VERSION, DEFAULT_MIN_WORDS, MAX_ATTEMPTS, MAX_ASSESSED_CHARS, SWEEP_CAP,
  TERMINAL_MESSAGES, NOT_CHARGEABLE, DEFAULT_OFF_TOPIC_CAP, offTopicScoreCap, minWords, countWords, nonLatinShare, enqueueAssessment, assessmentSweepQuery, sweepAssessments, runSpeakingAssessment,
  retryAssessment };
