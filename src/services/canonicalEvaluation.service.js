const crypto = require('crypto');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const Class = require('../models/class.model');
const { computeCanonicalCorrectionStatistics } = require('./correctionCanonical.service');
const detailedFeedbackService = require('./canonicalDetailedFeedback.service');
const semanticRubricAssessment = require('./semanticRubricAssessment.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION, normalizedTranscript, countWords,
  scoreGrammar, scoreMechanics, scorePresentation, gradeFromOverallScore } = require('./rubricLanguageScoring.service');

const VERSION = EVALUATION_VERSION;
const stable = (value) => value == null ? null : Array.isArray(value) ? value.map(stable) : typeof value === 'object'
  ? Object.keys(value).sort().reduce((out, key) => { if (!['createdAt', 'updatedAt', '__v', '_id'].includes(key)) out[key] = stable(value[key]); return out; }, {}) : value;
const hashRubric = (assignment) => crypto.createHash('sha256').update(JSON.stringify(stable({
  rubric: assignment?.rubric || assignment?.rubrics || null,
  title: assignment?.title || '', instructions: assignment?.instructions || assignment?.description || ''
}))).digest('hex');

function synchronizedRubricScores(scores, stats) {
  const map = { CONTENT: 'content', ORGANIZATION: 'organization', GRAMMAR: 'grammar', VOCABULARY: 'vocabulary', MECHANICS: 'mechanics' };
  const result = {};
  for (const [key, item] of Object.entries(scores || {})) {
    const count = map[key] ? Number(stats[map[key]] || 0) : 0;
    const maxScore = Number(item.maxScore) || 0;
    const score = Math.max(0, Math.min(maxScore, Number(item.score) || 0));
    result[key] = { ...item, score, maxScore, issueCount: key === 'PRESENTATION' ? 0 : count, comment: String(item.comment || '').trim() };
  }
  return result;
}

function hasValidRubricScores(scores) {
  const required = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS', 'PRESENTATION'];
  return Boolean(scores && required.every((key) => Number.isFinite(Number(scores[key]?.score))
    && Number.isFinite(Number(scores[key]?.maxScore)) && Number(scores[key].maxScore) > 0));
}

function supersededEvaluationError() {
  const error = new Error('Canonical evaluation job was superseded');
  error.code = 'ANALYSIS_JOB_SUPERSEDED';
  return error;
}

async function generate({ submission, assignment, prelockedJobId = null }) {
  const sourceHash = submission.correctionSourceHash;
  if (!sourceHash || submission.correctionStatus !== 'completed') return { status: 'superseded' };
  const rubricHash = hashRubric(assignment);
  const stats = computeCanonicalCorrectionStatistics(submission.writingCorrections || []);
  const persistedFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
  if (persistedFeedback?.overriddenByTeacher) return {
    status: 'reused', sourceHash, provider: persistedFeedback.evaluationProvider || null,
    model: persistedFeedback.evaluationModel || null, overallScore: Number(persistedFeedback.overallScore), errorCode: null
  };
  const recoverableDetailed = persistedFeedback?.evaluationSourceHash === sourceHash
    && persistedFeedback?.evaluationRubricSourceHash === rubricHash
    && persistedFeedback?.assessmentVersion === ASSESSMENT_VERSION
    && persistedFeedback?.evaluationVersion === VERSION
    && persistedFeedback?.detailedFeedbackSourceHash === sourceHash
    && persistedFeedback?.detailedFeedbackVersion === detailedFeedbackService.VERSION
    && hasValidRubricScores(persistedFeedback?.rubricScores)
    && detailedFeedbackService.validateDetailedFeedback(persistedFeedback.detailedFeedback, {
      corrections: submission.writingCorrections || [], statistics: stats,
      categoryScores: persistedFeedback.rubricScores, sourceHash
    });
  if (submission.evaluationStatus === 'processing' && submission.evaluationJobId && recoverableDetailed
    && persistedFeedback?.evaluationJobId === submission.evaluationJobId && !persistedFeedback?.overriddenByTeacher) {
    const recovered = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: submission.evaluationJobId }, { $set: {
      evaluationStatus: 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationUpdatedAt: new Date(), evaluationError: null
    }});
    if (recovered.modifiedCount !== 1) return { status: 'superseded', sourceHash };
    return { status: 'reused', sourceHash, rubricHash, stats, provider: persistedFeedback.evaluationProvider || null,
      model: persistedFeedback.evaluationModel || null, overallScore: Number(persistedFeedback.overallScore), recovered: true,
      timings: { detailedFeedbackMs: 0 } };
  }
  const existingCurrent = submission.evaluationSourceHash === sourceHash
    && submission.evaluationRubricSourceHash === rubricHash
    && submission.evaluationVersion === VERSION
    && ['completed', 'partial'].includes(submission.evaluationStatus);
  if (existingCurrent) {
    const existingFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    const validDetailed = existingFeedback?.assessmentVersion === ASSESSMENT_VERSION
      && existingFeedback?.evaluationVersion === VERSION
      && existingFeedback?.evaluationRubricSourceHash === rubricHash
      && existingFeedback?.detailedFeedbackVersion === detailedFeedbackService.VERSION
      && detailedFeedbackService.validateDetailedFeedback(existingFeedback.detailedFeedback, {
        corrections: submission.writingCorrections || [], statistics: stats,
        categoryScores: existingFeedback.rubricScores || {}, sourceHash
      });
    if (existingFeedback?.overriddenByTeacher || validDetailed) return {
      status: 'reused', sourceHash, provider: existingFeedback.evaluationProvider || null,
      model: existingFeedback.evaluationModel || null, overallScore: Number(existingFeedback.overallScore), errorCode: null
    };
  }
  const jobId = prelockedJobId || crypto.randomUUID();
  if (!prelockedJobId) {
    const locked = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash, evaluationStatus: { $ne: 'processing' } },
      { $set: { evaluationStatus: 'processing', evaluationJobId: jobId, evaluationError: null, evaluationErrorCode: null } });
    if (!locked.modifiedCount) return { status: 'superseded', sourceHash };
  } else {
    const ownsLock = await submission.constructor.exists({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: jobId });
    if (!ownsLock) return { status: 'superseded', sourceHash };
  }
  let feedbackPersisted = false;
  try {
    const classDoc = await Class.findById(submission.class).select('teacher').lean();
    await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id }, { $set: {
      submissionId: submission._id, classId: submission.class, studentId: submission.student,
      teacherId: classDoc?.teacher, evaluationJobId: jobId
    }}, { upsert: true, runValidators: true });
    if (JSON.stringify(stats) !== JSON.stringify(submission.correctionStatistics?.toObject?.() || submission.correctionStatistics || {}))
      await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash }, { $set: { correctionStatistics: stats } });
    const transcript = normalizedTranscript(submission);
    const wordCount = countWords(transcript);
    const corrections = submission.writingCorrections || [];
    console.info('[canonical-evaluation] semantic rubric assessment started', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats });
    const semantic = await semanticRubricAssessment.assess({ transcript, sourceHash, assignment,
      corrections, statistics: stats, pageManifest: submission.ocrPages || [],
      transcriptComplete: submission.ocrStatus === 'completed' && Boolean(transcript.trim()) });
    console.info('[canonical-evaluation] semantic rubric assessment completed', { submissionId: String(submission._id),
      provider: semantic.provider, model: semantic.model, sourceHashMatch: semantic.sourceHash === sourceHash,
      categoryScores: Object.fromEntries(Object.entries(semantic.categories).map(([key, value]) => [key, value.score])),
      duration: semantic.metrics?.semanticRubricAssessmentMs });
    const rubricScores = synchronizedRubricScores({
      CONTENT: semantic.categories.CONTENT,
      ORGANIZATION: semantic.categories.ORGANIZATION,
      VOCABULARY: semantic.categories.VOCABULARY,
      GRAMMAR: scoreGrammar({ corrections, wordCount }),
      MECHANICS: scoreMechanics({ corrections, wordCount }),
      PRESENTATION: scorePresentation(submission)
    }, stats);
    if (!hasValidRubricScores(rubricScores)) throw new Error('Canonical assessment is missing required rubric categories');
    const overallScore = Object.values(rubricScores).reduce((sum, item) => sum + item.score, 0);
    const grade = gradeFromOverallScore(overallScore);
    const detailedFeedbackStartedAt = Date.now();
    const detailedFeedback = detailedFeedbackService.buildDeterministicDetailedFeedback({ corrections,
      statistics: stats, categoryScores: rubricScores, sourceHash, semanticAssessment: semantic });
    const detailedFeedbackMs = Date.now() - detailedFeedbackStartedAt;
    const existing = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    const jobStillCurrent = await submission.constructor.exists({ _id: submission._id, correctionSourceHash: sourceHash, evaluationJobId: jobId });
    if (!jobStillCurrent) return { status: 'superseded', sourceHash };
    let savedFeedback = existing;
    if (!existing?.overriddenByTeacher) savedFeedback = await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id,
      evaluationJobId: jobId, overriddenByTeacher: { $ne: true } }, { $set: {
      submissionId: submission._id, classId: submission.class, studentId: submission.student, teacherId: classDoc?.teacher,
      assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: VERSION, evaluationSourceHash: sourceHash,
      evaluationRubricSourceHash: rubricHash, evaluationSource: 'ai', evaluationStatus: semantic.status,
      evaluationProvider: semantic.provider, evaluationModel: semantic.model, evaluationErrorCode: null, correctionStats: stats,
      evaluationAttempts: semantic.metrics?.attempts || [],
      evaluationDiagnostics: semantic.diagnostics || { commentNormalizations: [] },
      rubricScores, overallScore, grade,
      detailedFeedback, detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: detailedFeedbackService.VERSION
    }}, { new: true, runValidators: true });
    if (!savedFeedback) throw supersededEvaluationError();
    feedbackPersisted = true;
    const completed = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: jobId }, { $set: {
      evaluationStatus: semantic.status === 'partial' ? 'partial' : 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationProvider: semantic.provider, evaluationModel: semantic.model,
      evaluationAttempts: semantic.metrics?.attempts || [],
      evaluationDiagnostics: semantic.diagnostics || { commentNormalizations: [] },
      evaluationUpdatedAt: new Date(), evaluationError: null, evaluationErrorCode: null
    }});
    if (completed.modifiedCount !== 1) throw supersededEvaluationError();
    console.info('[canonical-evaluation] canonical evaluation persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats, categoryScores: Object.fromEntries(Object.entries(rubricScores).map(([key, value]) => [key, value.score])),
      overallScore });
    console.info('[canonical-evaluation] detailed feedback persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, duration: detailedFeedbackMs });
    return { status: semantic.status === 'partial' ? 'partial' : 'completed', sourceHash, rubricHash, stats,
      provider: semantic.provider, model: semantic.model, overallScore, errorCode: null,
      categoryScores: rubricScores, attempts: semantic.metrics?.attempts || [], timings: { detailedFeedbackMs } };
  } catch (error) {
    if (error?.code === 'ANALYSIS_JOB_SUPERSEDED') return { status: 'superseded', sourceHash };
    // A valid feedback write followed by an interrupted status update is
    // intentionally left recoverable by the idempotent path above.
    if (feedbackPersisted) return { status: 'superseded', sourceHash };
    const attempts = Array.isArray(error?.attempts) ? error.attempts : [];
    const lastAttempt = attempts[attempts.length - 1] || {};
    const errorCode = error?.code || 'SEMANTIC_RUBRIC_FAILED';
    console.warn('[canonical-evaluation] semantic rubric assessment failed', {
      submissionId: String(submission._id), provider: error?.provider || lastAttempt.provider || null,
      model: error?.model || lastAttempt.model || null,
      attempt: lastAttempt.attemptNumber || null, fallbackIndex: Number.isInteger(lastAttempt.fallbackIndex)
        ? lastAttempt.fallbackIndex : null,
      httpStatus: Number(lastAttempt.httpStatus || error?.httpStatus || error?.status) || null,
      finishReason: lastAttempt.finishReason || error?.finishReason || null,
      candidateCount: Number.isFinite(lastAttempt.candidateCount) ? lastAttempt.candidateCount
        : Number.isFinite(error?.candidateCount) ? error.candidateCount : null,
      hasContent: typeof error?.hasContent === 'boolean' ? error.hasContent : null,
      hasText: typeof error?.hasText === 'boolean' ? error.hasText : null,
      contentType: error?.contentType || null, responseTextLength: Number.isFinite(error?.responseTextLength)
        ? error.responseTextLength : null,
      markdownFenceDetected: error?.markdownFenceDetected === true,
      validationCode: lastAttempt.validationCode || error?.validationCode || null,
      validationStage: lastAttempt.validationStage || error?.validationStage || null,
      jsonPath: lastAttempt.jsonPath || error?.jsonPath || null,
      validationIssues: Array.isArray(error?.validationIssues) ? error.validationIssues : [],
      requestId: error?.requestId || null, durationMs: Number(error?.durationMs) || null,
      tokenUsage: error?.usage ? {
        promptTokens: Number(error.usage.prompt_tokens) || null,
        completionTokens: Number(error.usage.completion_tokens) || null,
        totalTokens: Number(error.usage.total_tokens) || null
      } : null,
      errorCode, attemptCount: attempts.length
    });
    await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id, evaluationJobId: jobId, overriddenByTeacher: { $ne: true } },
      { $set: { assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: VERSION,
        evaluationSource: 'provisional', evaluationStatus: 'failed', evaluationErrorCode: errorCode,
        evaluationProvider: lastAttempt.provider || submission.evaluationProvider || null,
        evaluationModel: lastAttempt.model || submission.evaluationModel || null,
        evaluationAttempts: attempts, evaluationDiagnostics: { terminalValidation: {
          provider: lastAttempt.provider || null, model: lastAttempt.model || null,
          attemptNumber: lastAttempt.attemptNumber || null,
          fallbackIndex: Number.isInteger(lastAttempt.fallbackIndex) ? lastAttempt.fallbackIndex : null,
          validationCode: lastAttempt.validationCode || null, validationStage: lastAttempt.validationStage || null,
          jsonPath: lastAttempt.jsonPath || null, httpStatus: lastAttempt.httpStatus || null,
          durationMs: lastAttempt.durationMs || null, finishReason: lastAttempt.finishReason || null
        } }, correctionStats: stats },
      $unset: { evaluationSourceHash: 1, evaluationRubricSourceHash: 1, rubricScores: 1, overallScore: 1, grade: 1,
        detailedFeedback: 1, detailedFeedbackSourceHash: 1, detailedFeedbackVersion: 1 } }, { runValidators: true });
    await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash, evaluationJobId: jobId },
      { $set: { evaluationStatus: 'failed', evaluationError: `Canonical semantic rubric evaluation failed (${errorCode})`,
        evaluationErrorCode: errorCode, evaluationProvider: lastAttempt.provider || null, evaluationModel: lastAttempt.model || null,
        evaluationAttempts: attempts, evaluationDiagnostics: { terminalValidation: {
          provider: lastAttempt.provider || null, model: lastAttempt.model || null,
          attemptNumber: lastAttempt.attemptNumber || null,
          fallbackIndex: Number.isInteger(lastAttempt.fallbackIndex) ? lastAttempt.fallbackIndex : null,
          validationCode: lastAttempt.validationCode || null, validationStage: lastAttempt.validationStage || null,
          jsonPath: lastAttempt.jsonPath || null, httpStatus: lastAttempt.httpStatus || null,
          durationMs: lastAttempt.durationMs || null, finishReason: lastAttempt.finishReason || null
        } }, evaluationUpdatedAt: new Date() },
      $unset: { evaluationSourceHash: 1, evaluationRubricSourceHash: 1 } });
    return { status: 'failed', sourceHash, provider: lastAttempt.provider || null, model: lastAttempt.model || null,
      overallScore: null, errorCode, attempts };
  }
}

module.exports = { VERSION, stable, hashRubric, synchronizedRubricScores, hasValidRubricScores, generate };
