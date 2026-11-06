'use strict';
// Task 20: a retry of the CORRECTION STAGE ALONE, after it failed. Not OCR, not the rubric: the score, the detailed feedback and the assessment credit
// stay exactly as the first run left them (no re-score, no second charge). Corrections that arrive appear on the open page through its polling.
//   - automatic: at most ONE per submission, scheduled when a full analysis ends with a retryable correction failure;
//   - manual: the visible "Retry analysis" action (student, guest, teacher), at most MANUAL_LIMIT per submission, rate limited per user by the route.
// Idempotent: every start is one conditional update on the failed state, so a double click, two tabs or a scheduled retry that races a manual one start
// one run. The run writes only if the submission is still in the same failed state (same source hash): a new upload, a teacher regeneration or a
// re-OCR in the meantime wins, and this run's result is dropped.
// The retry state lives in `correctionRetry`, never in correctionStatus/semanticStatus: the recovery sweeper re-runs a FULL analysis for those when they
// look stuck, which would re-score. A retry that dies with its process is treated as finished after STALE_MS and can be started again.
const crypto = require('crypto');
const logger = require('../utils/logger');

const AUTOMATIC_LIMIT = 1;
const MANUAL_LIMIT = 3;
const AUTOMATIC_DELAY_MS = 10 * 1000;
const STALE_MS = 10 * 60 * 1000;
// Retrying cannot help these: a configuration, credential, credit or source problem. Same rule as the in-request retry (semanticCorrectionCoordinator).
const NOT_RETRYABLE = /AUTH|CREDIT|CONFIGURATION|NOT_CONFIGURED|AUTHORITY|FORBIDDEN|PAYMENT|QUOTA_EXCEEDED|UNAUTHORIZED|OCR_PARTIAL|OCR_SOURCE_REVIEW_REQUIRED/;

function retryableCode(code) {
  const value = String(code || '');
  return Boolean(value) && !NOT_RETRYABLE.test(value);
}

/** The failure codes of a correction-stage error: the final one and each provider attempt's. */
function failureCodes(error) {
  return [error?.finalFailureCode, error?.code, ...(error?.attempts || []).map(attempt => attempt?.code)].filter(Boolean).map(String);
}

function retryableFailure(error) {
  const codes = failureCodes(error);
  return codes.length > 0 && codes.every(retryableCode);
}

/** The failed state a retry may start from. Field names match the Submission model. */
function failedStateFilter(submissionId) {
  return { _id: submissionId, ocrStatus: 'completed', semanticStatus: 'failed', correctionStatus: 'partial',
    correctionSourceHash: { $type: 'string' }, evaluationStatus: { $ne: 'processing' } };
}

const notRunning = now => ({ $or: [{ 'correctionRetry.status': { $nin: ['scheduled', 'processing'] } },
  { 'correctionRetry.startedAt': { $lte: new Date(now - STALE_MS) } }] });

/** True while a retry is scheduled or running and not stale. Read by canonicalResultState. */
function active(submission, now = Date.now()) {
  const retry = submission?.correctionRetry;
  if (!retry || !['scheduled', 'processing'].includes(retry.status) || submission.semanticStatus !== 'failed') return false;
  const startedAt = new Date(retry.startedAt).getTime();
  return Number.isFinite(startedAt) && now - startedAt < STALE_MS;
}

// The stored codes that say why the stage failed. semanticErrorCode is often only the wrapper (AI_CHAIN_EXHAUSTED); the cause is in the metrics.
const STORED_CAUSES = ['semanticErrorCode', 'semanticMetrics.finalFailureCode', 'correctionRetry.lastErrorCode'];
const storedCause = (submission, field) => field.split('.').reduce((value, key) => value?.[key], submission);

/** Whether the visible retry action may start one now. Read by canonicalResultState. */
function manualAllowed(submission, now = Date.now()) {
  return submission?.semanticStatus === 'failed' && submission?.correctionStatus === 'partial' && Boolean(submission?.correctionSourceHash)
    && submission?.ocrStatus === 'completed' && submission?.evaluationStatus !== 'processing'
    && STORED_CAUSES.every(field => !storedCause(submission, field) || retryableCode(storedCause(submission, field)))
    && Number(submission?.correctionRetry?.manualCount || 0) < MANUAL_LIMIT && !active(submission, now);
}

function assignmentContext(assignment) {
  return assignment ? { title: assignment.title || '', description: assignment.description || assignment.instructions || '',
    rubric: assignment.rubric || null, rubrics: assignment.rubrics || null } : {};
}

/** Runs a claimed retry: the correction stage only. Never throws. */
async function run(Model, submissionId, jobId, dependencies = {}) {
  const pipeline = dependencies.pipeline || require('./canonicalCorrectionsPipeline.service');
  try {
    const doc = await Model.findById(submissionId);
    if (!doc || doc.correctionRetry?.jobId !== jobId) return { status: 'superseded' };
    const assignment = dependencies.assignment !== undefined ? dependencies.assignment
      : await require('../models/assignment.model').findById(doc.assignment).lean();
    const result = await pipeline.generateAndPersist(doc, { assignment: assignmentContext(assignment), correctionOnly: { jobId } });
    // The pipeline marks completed or failed itself. Anything still "processing" here returned early or was superseded by newer work.
    await Model.updateOne({ _id: submissionId, 'correctionRetry.jobId': jobId, 'correctionRetry.status': 'processing' }, { $set: {
      'correctionRetry.status': 'failed', 'correctionRetry.finishedAt': new Date(),
      'correctionRetry.lastErrorCode': String(result?.errorCode || 'CORRECTION_RETRY_SUPERSEDED').slice(0, 100) } }).catch(() => {});
    return result || { status: 'superseded' };
  } catch (error) {
    const code = String(error?.code || 'CORRECTION_RETRY_FAILED').slice(0, 100);
    logger.warn({ event: 'correction_stage_retry_failed', submissionId: String(submissionId), errorCode: code });
    await Model.updateOne({ _id: submissionId, 'correctionRetry.jobId': jobId }, { $set: {
      'correctionRetry.status': 'failed', 'correctionRetry.finishedAt': new Date(), 'correctionRetry.lastErrorCode': code } }).catch(() => {});
    return { status: 'failed', errorCode: code };
  }
}

/**
 * After a full analysis whose correction stage failed for a retryable reason: one automatic retry, a short delay later. The submission shows as
 * still processing meanwhile (canonicalResultState), so an open page keeps polling and shows the corrections when they arrive.
 */
async function scheduleAutomatic(Model, submissionId, error, { now = Date.now(), delayMs = AUTOMATIC_DELAY_MS, timer = setTimeout, dependencies } = {}) {
  if (!retryableFailure(error)) return { scheduled: false, reason: 'not_retryable' };
  const jobId = crypto.randomUUID();
  let claimed;
  try {
    claimed = await Model.updateOne({ ...failedStateFilter(submissionId), ...notRunning(now),
      'correctionRetry.automaticCount': { $not: { $gte: AUTOMATIC_LIMIT } } }, {
      $set: { 'correctionRetry.jobId': jobId, 'correctionRetry.status': 'scheduled', 'correctionRetry.trigger': 'automatic',
        'correctionRetry.startedAt': new Date(now) },
      $unset: { 'correctionRetry.finishedAt': 1, 'correctionRetry.lastErrorCode': 1 },
      $inc: { 'correctionRetry.automaticCount': 1 } });
  } catch { return { scheduled: false, reason: 'claim_failed' }; }
  if (!claimed?.modifiedCount) return { scheduled: false, reason: 'not_eligible' };
  logger.info({ event: 'correction_stage_retry_scheduled', submissionId: String(submissionId), trigger: 'automatic', delayMs,
    reason: failureCodes(error)[0] || null });
  const handle = timer(async () => {
    const started = await Model.updateOne({ _id: submissionId, 'correctionRetry.jobId': jobId, 'correctionRetry.status': 'scheduled' },
      { $set: { 'correctionRetry.status': 'processing', 'correctionRetry.startedAt': new Date() } }).catch(() => null);
    if (started?.modifiedCount) await run(Model, submissionId, jobId, dependencies);
  }, delayMs);
  handle?.unref?.();
  return { scheduled: true, jobId };
}

/** The visible retry action. Returns { started } or { started: false, code } (the route answers 409). */
async function startManual(Model, submissionId, { now = Date.now(), schedule = setImmediate, dependencies } = {}) {
  const jobId = crypto.randomUUID();
  const claimed = await Model.updateOne({ ...failedStateFilter(submissionId), ...notRunning(now),
    ...Object.fromEntries(STORED_CAUSES.map(field => [field, { $not: NOT_RETRYABLE }])), 'correctionRetry.manualCount': { $not: { $gte: MANUAL_LIMIT } } }, {
    $set: { 'correctionRetry.jobId': jobId, 'correctionRetry.status': 'processing', 'correctionRetry.trigger': 'manual',
      'correctionRetry.startedAt': new Date(now) },
    $unset: { 'correctionRetry.finishedAt': 1, 'correctionRetry.lastErrorCode': 1 },
    $inc: { 'correctionRetry.manualCount': 1 } });
  if (!claimed?.modifiedCount) {
    const doc = await Model.findById(submissionId).select('semanticStatus correctionStatus correctionRetry').lean();
    const code = active(doc, now) ? 'CORRECTION_RETRY_IN_PROGRESS'
      : Number(doc?.correctionRetry?.manualCount || 0) >= MANUAL_LIMIT ? 'CORRECTION_RETRY_LIMIT_REACHED' : 'CORRECTION_RETRY_NOT_AVAILABLE';
    return { started: false, code };
  }
  logger.info({ event: 'correction_stage_retry_started', submissionId: String(submissionId), trigger: 'manual' });
  schedule(() => { run(Model, submissionId, jobId, dependencies); });
  return { started: true, jobId };
}

module.exports = { AUTOMATIC_LIMIT, MANUAL_LIMIT, AUTOMATIC_DELAY_MS, STALE_MS, retryableCode, retryableFailure, active, manualAllowed,
  scheduleAutomatic, startManual, run };
