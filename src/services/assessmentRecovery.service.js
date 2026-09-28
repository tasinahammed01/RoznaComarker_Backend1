'use strict';

const crypto = require('crypto');
const os = require('os');
const Submission = require('../models/Submission');
const Assignment = require('../models/assignment.model');
const { runOcrAndPersistForFiles } = require('./ocrPipeline.service');
const canonicalCorrections = require('./canonicalCorrectionsPipeline.service');
const canonicalEvaluation = require('./canonicalEvaluation.service');
const logger = require('../utils/logger');

const DEFAULT_INTERVAL_MS = 60 * 1000;
const DEFAULT_LEASE_MS = 30 * 60 * 1000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_MAX_ATTEMPTS = 3;

function numberSetting(name, fallback, minimum, maximum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : fallback;
}

function workerConfig() {
  return {
    intervalMs: numberSetting('ASSESSMENT_RECOVERY_INTERVAL_MS', DEFAULT_INTERVAL_MS, 30000, 60 * 60 * 1000),
    leaseMs: numberSetting('ASSESSMENT_RECOVERY_LEASE_MS', DEFAULT_LEASE_MS, 5 * 60 * 1000, 2 * 60 * 60 * 1000),
    batchSize: numberSetting('ASSESSMENT_RECOVERY_BATCH_SIZE', DEFAULT_BATCH_SIZE, 1, 50),
    maxAttempts: numberSetting('ASSESSMENT_RECOVERY_MAX_ATTEMPTS', DEFAULT_MAX_ATTEMPTS, 1, 10)
  };
}

function ownerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

function leaseAvailable(now) {
  return { $or: [
    { analysisLeaseExpiresAt: { $exists: false } },
    { analysisLeaseExpiresAt: null },
    { analysisLeaseExpiresAt: { $lte: now } }
  ] };
}

function dueWorkQuery(now, maxAttempts, leaseMs = workerConfig().leaseMs) {
  const staleBefore = new Date(now.getTime() - leaseMs);
  return {
    $and: [
      leaseAvailable(now),
      { $or: [{ analysisAttempt: { $exists: false } }, { analysisAttempt: { $lt: maxAttempts } }] },
      { $or: [{ analysisNextRetryAt: { $exists: false } }, { analysisNextRetryAt: null }, { analysisNextRetryAt: { $lte: now } }] },
      { $or: [
        { ocrStatus: 'pending' },
        { ocrStatus: 'completed', correctionStatus: 'pending' },
        { ocrStatus: 'completed', correctionStatus: 'processing', $or: [
          { correctionUpdatedAt: { $exists: false } }, { correctionUpdatedAt: { $lte: staleBefore } }
        ] },
        { ocrStatus: 'completed', semanticStatus: { $in: ['processing', 'retry_wait'] }, updatedAt: { $lte: staleBefore } },
        { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
          evaluationStatus: 'processing', $or: [
            { evaluationUpdatedAt: { $exists: false } }, { evaluationUpdatedAt: { $lte: staleBefore } }
          ] },
        { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
          evaluationStatus: 'completed', assessmentStatus: { $in: ['started', 'processing', 'failed'] } }
      ] }
    ]
  };
}

async function claimSubmission(submissionId, expectedOcrJobId, owner, config = workerConfig()) {
  const now = new Date();
  return Submission.findOneAndUpdate({
    _id: submissionId,
    ...(expectedOcrJobId ? { ocrJobId: expectedOcrJobId } : {}),
    $and: [leaseAvailable(now), { $or: [
      { analysisAttempt: { $exists: false } }, { analysisAttempt: { $lt: config.maxAttempts } }
    ] }]
  }, {
    $set: { analysisLeaseOwner: owner, analysisLeaseExpiresAt: new Date(now.getTime() + config.leaseMs),
      analysisNextRetryAt: null, analysisErrorCode: null },
    $inc: { analysisAttempt: 1 }
  }, { returnDocument: 'after' });
}

async function releaseLease(doc, owner, set = {}) {
  return Submission.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, analysisLeaseOwner: owner }, {
    $set: set,
    $unset: { analysisLeaseOwner: 1, analysisLeaseExpiresAt: 1 }
  });
}

async function runClaimedSubmission(doc, owner, config = workerConfig()) {
  const startedAt = Date.now();
  const context = { submissionId: String(doc._id), ocrJobId: doc.ocrJobId || null,
    leaseOwner: owner, attempt: Number(doc.analysisAttempt || 0) };
  logger.info({ event: 'recovery_claimed', ...context });
  try {
    const ids = Array.isArray(doc.files) && doc.files.length ? doc.files : (doc.file ? [doc.file] : []);
    if (doc.ocrStatus === 'pending') {
      const result = await runOcrAndPersistForFiles({ fileIds: ids, targetDoc: doc, jobId: doc.ocrJobId });
      if (result?.ocrStatus === 'failed') {
        const refreshed = await Submission.findById(doc._id).select('ocrFailures ocrJobId').lean();
        const retryable = refreshed?.ocrFailures?.some(failure => failure?.retryable === true);
        if (retryable && Number(doc.analysisAttempt || 0) < config.maxAttempts) {
          const delayMs = Math.min(5 * 60 * 1000, 15000 * (2 ** Math.max(0, Number(doc.analysisAttempt || 1) - 1)));
          await releaseLease(doc, owner, { ocrStatus: 'pending', analysisNextRetryAt: new Date(Date.now() + delayMs),
            analysisErrorCode: refreshed.ocrFailures.find(failure => failure?.retryable)?.code || 'OCR_PROVIDER_FAILED' });
          logger.warn({ event: 'recovery_retry_scheduled', ...context, delayMs });
          return { status: 'retry_wait' };
        }
      }
      const completed = await Submission.findOne({ _id: doc._id, ocrJobId: doc.ocrJobId,
        ocrStatus: 'completed' }).select('_id').lean();
      if (completed) await require('./autoRubricDesigner.service').autoGenerateRubricDesignerForSubmission({
        submissionId: doc._id, expectedOcrJobId: doc.ocrJobId
      }).catch(() => {});
    } else {
      const assignmentDoc = await Assignment.findById(doc.assignment).lean();
      const assignment = assignmentDoc ? { title: assignmentDoc.title || '',
        description: assignmentDoc.description || assignmentDoc.instructions || '',
        rubric: assignmentDoc.rubric || null, rubrics: assignmentDoc.rubrics || null } : {};
      if (doc.correctionStatus !== 'completed' || doc.semanticStatus !== 'completed') {
        await Submission.updateOne({ _id: doc._id, ocrJobId: doc.ocrJobId, analysisLeaseOwner: owner }, { $set: {
          correctionStatus: 'pending', semanticStatus: 'pending', semanticNextRetryAt: null,
          evaluationStatus: 'pending', evaluationErrorCode: null
        }, $unset: { correctionJobId: 1, evaluationJobId: 1 } });
        const refreshed = await Submission.findById(doc._id);
        await canonicalCorrections.generateAndPersist(refreshed, { assignment });
      } else {
        // canonicalEvaluation has an idempotent recovery path for feedback
        // persisted before a crash and reuses the same assessment run receipt.
        const refreshed = await Submission.findById(doc._id);
        if (refreshed.evaluationStatus === 'processing' && refreshed.evaluationJobId) {
          await canonicalEvaluation.generate({ submission: refreshed, assignment,
            prelockedJobId: refreshed.evaluationJobId, allowDegradedCorrections: false });
        } else {
          await canonicalEvaluation.generate({ submission: refreshed, assignment });
        }
      }
    }
    await releaseLease(doc, owner, { analysisNextRetryAt: null, analysisErrorCode: null });
    logger.info({ event: 'recovery_completed', ...context, durationMs: Date.now() - startedAt });
    return { status: 'completed' };
  } catch (error) {
    const exhausted = Number(doc.analysisAttempt || 0) >= config.maxAttempts;
    const code = String(error?.code || 'ASSESSMENT_RECOVERY_FAILED').slice(0, 100);
    const terminalState = exhausted ? (doc.ocrStatus === 'pending' ? {
      ocrStatus: 'failed', ocrErrorCode: 'ASSESSMENT_RECOVERY_EXHAUSTED',
      ocrError: 'Assessment processing stopped after repeated failures. Please retry the upload.',
      correctionStatus: 'failed', semanticStatus: 'failed', semanticErrorCode: code,
      evaluationStatus: 'blocked', evaluationErrorCode: code, assessmentStatus: 'failed', assessmentErrorCode: code
    } : {
      correctionStatus: doc.correctionStatus === 'completed' ? doc.correctionStatus : 'failed',
      semanticStatus: doc.semanticStatus === 'completed' ? doc.semanticStatus : 'failed', semanticErrorCode: code,
      evaluationStatus: doc.evaluationStatus === 'completed' ? doc.evaluationStatus : 'failed',
      evaluationErrorCode: code, assessmentStatus: 'failed', assessmentErrorCode: code
    }) : {};
    await releaseLease(doc, owner, {
      ...terminalState,
      analysisErrorCode: code,
      analysisNextRetryAt: exhausted ? null : new Date(Date.now() + Math.min(5 * 60 * 1000,
        15000 * (2 ** Math.max(0, Number(doc.analysisAttempt || 1) - 1))))
    });
    logger.error({ event: 'recovery_failed', ...context, errorCode: code,
      exhausted, durationMs: Date.now() - startedAt });
    return { status: exhausted ? 'failed' : 'retry_wait', errorCode: code };
  }
}

async function processSubmission(submissionId, expectedOcrJobId, config = workerConfig()) {
  const owner = ownerId();
  const claimed = await claimSubmission(submissionId, expectedOcrJobId, owner, config);
  if (!claimed) return { status: 'not_claimed' };
  return runClaimedSubmission(claimed, owner, config);
}

function scheduleSubmissionAnalysis(submissionId, expectedOcrJobId) {
  setImmediate(() => processSubmission(submissionId, expectedOcrJobId).catch(error => logger.error({
    event: 'assessment_dispatch_failed', submissionId: String(submissionId),
    errorCode: error?.code || 'ASSESSMENT_DISPATCH_FAILED'
  })));
}

function startAssessmentRecoveryWorker(config = workerConfig()) {
  let running = false;
  const run = async () => {
    if (running) return { claimed: 0 };
    running = true;
    try {
      const candidates = await Submission.find(dueWorkQuery(new Date(), config.maxAttempts, config.leaseMs))
        .sort({ updatedAt: 1 }).limit(config.batchSize).select('_id ocrJobId').lean();
      for (const candidate of candidates) await processSubmission(candidate._id, candidate.ocrJobId, config);
      return { claimed: candidates.length };
    } catch (error) {
      logger.error({ event: 'assessment_recovery_worker_failed', errorCode: error?.code || 'RECOVERY_SCAN_FAILED' });
      return { claimed: 0, failed: true };
    } finally { running = false; }
  };
  const timer = setInterval(() => void run(), config.intervalMs);
  timer.unref?.();
  void run();
  return { run, stop: () => clearInterval(timer) };
}

module.exports = { workerConfig, dueWorkQuery, claimSubmission, runClaimedSubmission,
  processSubmission, scheduleSubmissionAnalysis, startAssessmentRecoveryWorker };
