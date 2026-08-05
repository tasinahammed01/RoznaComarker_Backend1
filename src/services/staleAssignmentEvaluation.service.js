'use strict';

const crypto = require('crypto');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const canonicalEvaluation = require('./canonicalEvaluation.service');
const correctionCanonical = require('./correctionCanonical.service');
const { CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../utils/ocrTranscriptNormalizer');
const { currentEvaluationSettings } = require('./evaluationSettingsContext.service');
const { buildCanonicalResultState } = require('./canonicalResultState.service');
const logger = require('../utils/logger');

const DEFAULT_CONCURRENCY = 3;

function isReadyForEvaluation(submission) {
  if (submission?.correctionStatus !== 'completed' || submission?.semanticStatus !== 'completed'
    || !submission?.correctionSourceHash || !Array.isArray(submission?.writingCorrections)
    || submission?.correctionVersion !== correctionCanonical.VERSION
    || submission?.correctionTranscriptLayoutVersion !== CANONICAL_TRANSCRIPT_LAYOUT_VERSION) return false;
  const canonical = correctionCanonical.computeCanonicalCorrectionStatistics(submission.writingCorrections);
  const persisted = submission.correctionStatistics?.toObject?.() || submission.correctionStatistics;
  return ['content', 'organization', 'grammar', 'vocabulary', 'mechanics', 'total'].every((key) =>
    Number.isFinite(Number(persisted?.[key])) && Number(persisted[key]) === Number(canonical[key]));
}

async function currentHashes(assignment) {
  return currentEvaluationSettings(assignment);
}

async function classify(assignment) {
  const submissions = await Submission.find({ assignment: assignment._id });
  const ids = submissions.map((submission) => submission._id);
  const feedback = ids.length
    ? await SubmissionFeedback.find({ submissionId: { $in: ids } }).lean()
    : [];
  const feedbackBySubmission = new Map(feedback.map((item) => [String(item.submissionId), item]));
  const hashes = await currentHashes(assignment);
  const result = {
    eligible: [],
    eligibleCount: 0,
    skippedOverrideCount: 0,
    skippedProcessingCount: 0,
    skippedNotReadyCount: 0
  };

  for (const submission of submissions) {
    const savedFeedback = feedbackBySubmission.get(String(submission._id));
    const freshness = buildCanonicalResultState({
      submission,
      feedback: savedFeedback || null,
      currentSettings: hashes
    });
    if (freshness.evaluationFreshness === 'overridden') {
      result.skippedOverrideCount += 1;
      continue;
    }
    if (freshness.evaluationFreshness === 'processing') {
      result.skippedProcessingCount += 1;
      continue;
    }
    if (!freshness.requiresCanonicalReevaluation) continue;
    if (!isReadyForEvaluation(submission)) {
      result.skippedNotReadyCount += 1;
      continue;
    }
    result.eligible.push(submission);
  }
  result.eligibleCount = result.eligible.length;
  return result;
}

async function runBounded(items, concurrency, worker) {
  let index = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

async function summarize(assignment) {
  const classified = await classify(assignment);
  return {
    assignmentId: String(assignment._id),
    eligibleCount: classified.eligibleCount,
    skippedOverrideCount: classified.skippedOverrideCount,
    skippedProcessingCount: classified.skippedProcessingCount,
    skippedNotReadyCount: classified.skippedNotReadyCount
  };
}

async function start(assignment, { concurrency = DEFAULT_CONCURRENCY } = {}) {
  const classified = await classify(assignment);
  const queued = [];
  let skippedProcessingCount = classified.skippedProcessingCount;
  let skippedOverrideCount = classified.skippedOverrideCount;

  for (const submission of classified.eligible) {
    if (await SubmissionFeedback.exists({ submissionId: submission._id, overriddenByTeacher: true })) {
      skippedOverrideCount += 1;
      continue;
    }
    const jobId = crypto.randomUUID();
    const accepted = await Submission.updateOne({
      _id: submission._id,
      correctionStatus: 'completed',
      semanticStatus: 'completed',
      evaluationStatus: { $ne: 'processing' }
    }, { $set: {
      evaluationStatus: 'processing',
      evaluationJobId: jobId,
      evaluationError: null,
      evaluationErrorCode: null
    } });
    if (!accepted.modifiedCount) {
      skippedProcessingCount += 1;
      continue;
    }
    submission.evaluationStatus = 'processing';
    submission.evaluationJobId = jobId;
    queued.push({ submission, jobId });
  }

  if (queued.length) {
    setImmediate(() => runBounded(queued, Math.max(1, Math.min(5, Number(concurrency) || DEFAULT_CONCURRENCY)),
      async ({ submission, jobId }) => {
        try {
          await canonicalEvaluation.generate({ submission, prelockedJobId: jobId, assignment });
        } catch (error) {
          logger.error({
            message: 'Bulk stale evaluation failed',
            assignmentId: String(assignment._id),
            submissionId: String(submission._id),
            error: error?.message || String(error)
          });
        }
      }).catch((error) => logger.error({
        message: 'Bulk stale evaluation worker failed',
        assignmentId: String(assignment._id),
        error: error?.message || String(error)
      })));
  }

  return {
    assignmentId: String(assignment._id),
    eligibleCount: classified.eligibleCount,
    startedCount: queued.length,
    skippedOverrideCount,
    skippedProcessingCount,
    skippedNotReadyCount: classified.skippedNotReadyCount,
    submissionIds: queued.map(({ submission }) => String(submission._id))
  };
}

module.exports = {
  DEFAULT_CONCURRENCY,
  isReadyForEvaluation,
  runBounded,
  summarize,
  start
};
