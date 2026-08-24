const crypto = require('crypto');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const Class = require('../models/class.model');
const User = require('../models/user.model');
const { computeCanonicalCorrectionStatistics } = require('./correctionCanonical.service');
const detailedFeedbackService = require('./canonicalDetailedFeedback.service');
const semanticRubricAssessment = require('./semanticRubricAssessment.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION, normalizedTranscript, countWords,
  scoreGrammar, scoreMechanics, scorePresentation, applySemanticStrictness,
  gradeFromOverallScore, scoringAudit, SCORING_AUDIT_VERSION, RUBRIC_MAX } = require('./rubricLanguageScoring.service');
const { SCORING_POLICY_VERSION, normalizeTeacherEvaluationPolicy, evaluationPolicyHash,
  correctionsAllowedByPolicy } = require('./teacherEvaluationPolicy.service');
const { normalizeAssignmentRubric, hashNormalizedRubric, calculateCustomRubricScore } =
  require('./assignmentRubric.service');

const VERSION = EVALUATION_VERSION;
const stable = (value) => value == null ? null : Array.isArray(value) ? value.map(stable) : typeof value === 'object'
  ? Object.keys(value).sort().reduce((out, key) => { if (!['createdAt', 'updatedAt', '__v', '_id'].includes(key)) out[key] = stable(value[key]); return out; }, {}) : value;
const hashRubric = (assignment) => crypto.createHash('sha256').update(JSON.stringify(stable({
  rubric: assignment?.rubric || assignment?.rubrics || null,
  title: assignment?.title || '', instructions: assignment?.instructions || assignment?.description || ''
}))).digest('hex');
const hashBuiltInContext = (assignment) => crypto.createHash('sha256').update(JSON.stringify(stable({
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

function isEvaluationFresh(record, { sourceHash, rubricHash, policyHash }) {
  return Boolean(record
    && record.evaluationSourceHash === sourceHash
    && record.evaluationRubricSourceHash === rubricHash
    && record.evaluationPolicyHash === policyHash
    && record.evaluationVersion === VERSION
    && ['completed', 'partial'].includes(record.evaluationStatus));
}

function supersededEvaluationError() {
  const error = new Error('Canonical evaluation job was superseded');
  error.code = 'ANALYSIS_JOB_SUPERSEDED';
  return error;
}

async function generate({ submission, assignment, prelockedJobId = null }) {
  const sourceHash = submission.correctionSourceHash;
  if (!sourceHash || submission.correctionStatus !== 'completed') return { status: 'superseded' };
  const classDoc = await Class.findById(submission.class).select('teacher').lean();
  const teacher = classDoc?.teacher ? await User.findById(classDoc.teacher).select('aiConfig').lean() : null;
  const policy = normalizeTeacherEvaluationPolicy(teacher);
  const policyHash = evaluationPolicyHash(policy);
  const customRubricResult = normalizeAssignmentRubric(assignment || {});
  const rubricHash = customRubricResult.status === 'valid' ? hashNormalizedRubric(customRubricResult) : hashRubric(assignment);
  const builtInContextHash = hashBuiltInContext(assignment);
  if (customRubricResult.status === 'invalid') {
    console.warn('[canonical-evaluation] invalid assignment rubric', {
      submissionId: String(submission._id), diagnostics: customRubricResult.diagnostics
    });
    await submission.constructor.updateOne({ _id: submission._id }, { $set: {
      evaluationStatus: 'failed', evaluationErrorCode: 'INVALID_ASSIGNMENT_RUBRIC',
      evaluationDiagnostics: { rubricValidation: customRubricResult.diagnostics }
    }, $unset: { evaluationSourceHash: 1, evaluationPolicyHash: 1 } });
    return { status: 'failed', sourceHash, rubricHash, policyHash, overallScore: null,
      errorCode: 'INVALID_ASSIGNMENT_RUBRIC', diagnostics: customRubricResult.diagnostics };
  }
  const stats = computeCanonicalCorrectionStatistics(submission.writingCorrections || []);
  const persistedFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
  if (persistedFeedback?.overriddenByTeacher) return {
    status: 'reused', sourceHash, provider: persistedFeedback.evaluationProvider || null,
    model: persistedFeedback.evaluationModel || null, overallScore: Number(persistedFeedback.overallScore), errorCode: null
  };
  const recoverableDetailed = persistedFeedback?.evaluationSourceHash === sourceHash
    && persistedFeedback?.evaluationRubricSourceHash === rubricHash
    && persistedFeedback?.evaluationPolicyHash === policyHash
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
      evaluationStatus: persistedFeedback.evaluationStatus === 'partial' ? 'partial' : 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
      evaluationUpdatedAt: new Date(), evaluationError: null
    }});
    if (recovered.modifiedCount !== 1) return { status: 'superseded', sourceHash };
    return { status: 'reused', sourceHash, rubricHash, stats, provider: persistedFeedback.evaluationProvider || null,
      model: persistedFeedback.evaluationModel || null, overallScore: Number(persistedFeedback.overallScore), recovered: true,
      timings: { detailedFeedbackMs: 0 } };
  }
  const existingCurrent = isEvaluationFresh(submission, { sourceHash, rubricHash, policyHash });
  if (existingCurrent) {
    const existingFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
    const validDetailed = existingFeedback?.assessmentVersion === ASSESSMENT_VERSION
      && existingFeedback?.evaluationVersion === VERSION
      && existingFeedback?.evaluationRubricSourceHash === rubricHash
      && existingFeedback?.evaluationPolicyHash === policyHash
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
    await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id }, { $set: {
      submissionId: submission._id, classId: submission.class, studentId: submission.student,
      teacherId: classDoc?.teacher, evaluationJobId: jobId
    }}, { upsert: true, runValidators: true });
    if (JSON.stringify(stats) !== JSON.stringify(submission.correctionStatistics?.toObject?.() || submission.correctionStatistics || {}))
      await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash }, { $set: { correctionStatistics: stats } });
    const transcript = normalizedTranscript(submission);
    const wordCount = countWords(transcript);
    const corrections = correctionsAllowedByPolicy(submission.writingCorrections || [], policy);
    const reusableBuiltInScores = Boolean(persistedFeedback && !persistedFeedback.overriddenByTeacher
      && persistedFeedback.evaluationSourceHash === sourceHash
      && persistedFeedback.evaluationPolicyHash === policyHash
      && persistedFeedback.evaluationBuiltInContextHash === builtInContextHash
      && persistedFeedback.assessmentVersion === ASSESSMENT_VERSION
      && persistedFeedback.evaluationVersion === VERSION
      && hasValidRubricScores(persistedFeedback.rubricScores));
    console.info('[canonical-evaluation] semantic rubric assessment started', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats });
    const semantic = await semanticRubricAssessment.assess({ transcript, sourceHash, assignment,
      corrections, statistics: stats, pageManifest: submission.ocrPages || [],
      transcriptComplete: submission.ocrStatus === 'completed' && Boolean(transcript.trim()),
      policy, customRubric: customRubricResult.rubric });
    for (const category of ['CONTENT', 'ORGANIZATION', 'VOCABULARY']) {
      semantic.categories[category] = applySemanticStrictness(semantic.categories[category], policy.strictness);
    }
    if (!policy.checks.coherenceLogic) semantic.categories.ORGANIZATION = {
      ...semantic.categories.ORGANIZATION, score: 20, issueCount: 0,
      comment: 'Coherence and organization scoring is disabled by the teacher evaluation policy.',
      improvementEvidence: []
    };
    console.info('[canonical-evaluation] semantic rubric assessment completed', { submissionId: String(submission._id),
      provider: semantic.provider, model: semantic.model, sourceHashMatch: semantic.sourceHash === sourceHash,
      categoryScores: Object.fromEntries(Object.entries(semantic.categories).map(([key, value]) => [key, value.score])),
      duration: semantic.metrics?.semanticRubricAssessmentMs });
    const generatedRubricScores = synchronizedRubricScores({
      CONTENT: semantic.categories.CONTENT,
      ORGANIZATION: semantic.categories.ORGANIZATION,
      VOCABULARY: semantic.categories.VOCABULARY,
      GRAMMAR: scoreGrammar({ corrections, wordCount, strictness: policy.strictness,
        enabled: policy.checks.grammarSpelling }),
      MECHANICS: scoreMechanics({ corrections, wordCount, strictness: policy.strictness,
        enabled: policy.checks.grammarSpelling }),
      PRESENTATION: scorePresentation(submission)
    }, stats);
    const rubricScores = reusableBuiltInScores
      ? synchronizedRubricScores(persistedFeedback.rubricScores, stats)
      : generatedRubricScores;
    if (!hasValidRubricScores(rubricScores)) throw new Error('Canonical assessment is missing required rubric categories');
    const customRubricScores = customRubricResult.status === 'valid'
      ? calculateCustomRubricScore(customRubricResult.rubric, semantic.customCriteria) : null;
    const overallScore = customRubricScores
      ? customRubricScores.overallScore
      : Object.values(rubricScores).reduce((sum, item) => sum + item.score, 0);
    const grade = gradeFromOverallScore(overallScore);
    const scoringAuditRecord = {
      version: SCORING_AUDIT_VERSION,
      policy: { ...policy, scoringPolicyVersion: SCORING_POLICY_VERSION },
      policyHash,
      rubricHash,
      builtInContextHash,
      builtInScoresReused: reusableBuiltInScores,
      overallMethod: customRubricScores ? 'custom_rubric_weighted_total' : 'fixed_six_category_sum',
      ...(customRubricScores ? {
        customRubric: {
          overallScore: customRubricScores.overallScore,
          criteria: customRubricScores.criteria.map((criterion) => ({
            criterionId: criterion.criterionId,
            normalizedWeight: criterion.normalizedWeight,
            selectedLevel: criterion.selectedLevel,
            configuredLevelPercentage: criterion.configuredLevelPercentage,
            weightedPoints: criterion.weightedPoints
          }))
        }
      } : {}),
      categories: [
        scoringAudit({ corrections, category: 'GRAMMAR', maxScore: RUBRIC_MAX.GRAMMAR,
          wordCount, strictness: policy.strictness }),
        scoringAudit({ corrections, category: 'MECHANICS', maxScore: RUBRIC_MAX.MECHANICS,
          wordCount, strictness: policy.strictness })
      ]
    };
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
      evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
      evaluationBuiltInContextHash: builtInContextHash,
      evaluationPolicy: { ...policy, scoringPolicyVersion: SCORING_POLICY_VERSION },
      evaluationSource: 'ai', evaluationStatus: semantic.status,
      evaluationProvider: semantic.provider, evaluationModel: semantic.model, evaluationErrorCode: null, correctionStats: stats,
      evaluationAttempts: semantic.metrics?.attempts || [],
      evaluationDiagnostics: semantic.diagnostics || { commentNormalizations: [] },
      rubricScores, customRubricScores, sourceRubric: customRubricResult.rubric, overallScore, grade,
      scoringAudit: scoringAuditRecord,
      detailedFeedback, detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: detailedFeedbackService.VERSION
    }}, { new: true, runValidators: true });
    if (!savedFeedback) throw supersededEvaluationError();
    feedbackPersisted = true;
    const completed = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: jobId }, { $set: {
      evaluationStatus: semantic.status === 'partial' ? 'partial' : 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
      evaluationProvider: semantic.provider, evaluationModel: semantic.model,
      evaluationAttempts: semantic.metrics?.attempts || [],
      evaluationDiagnostics: semantic.diagnostics || { commentNormalizations: [] },
      evaluationUpdatedAt: new Date(), evaluationError: null, evaluationErrorCode: null
    }});
    if (completed.modifiedCount !== 1) throw supersededEvaluationError();
    console.info('[canonical-evaluation] canonical evaluation persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats, categoryScores: Object.fromEntries(Object.entries(rubricScores).map(([key, value]) => [key, value.score])),
      customRubricPresent: Boolean(customRubricScores), builtInScoresReused: reusableBuiltInScores, overallScore });
    console.info('[canonical-evaluation] detailed feedback persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, duration: detailedFeedbackMs });
    return { status: semantic.status === 'partial' ? 'partial' : 'completed', sourceHash, rubricHash, policyHash, stats,
      provider: semantic.provider, model: semantic.model, overallScore, errorCode: null,
      categoryScores: rubricScores, attempts: semantic.metrics?.attempts || [], timings: { detailedFeedbackMs } };
  } catch (error) {
    if (error?.code === 'ANALYSIS_JOB_SUPERSEDED') return { status: 'superseded', sourceHash };
    // A valid feedback write followed by an interrupted status update is
    // intentionally left recoverable by the idempotent path above.
    if (feedbackPersisted) {
      const persisted = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
      const recoveredStatus = persisted?.evaluationStatus === 'partial' ? 'partial' : 'completed';
      const recovered = await submission.constructor.updateOne({ _id: submission._id,
        correctionSourceHash: sourceHash, evaluationStatus: 'processing', evaluationJobId: jobId }, { $set: {
        evaluationStatus: recoveredStatus, evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
        evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
        evaluationProvider: persisted?.evaluationProvider || null,
        evaluationModel: persisted?.evaluationModel || null,
        evaluationAttempts: persisted?.evaluationAttempts || [],
        evaluationDiagnostics: persisted?.evaluationDiagnostics || { commentNormalizations: [] },
        evaluationUpdatedAt: new Date(), evaluationError: null, evaluationErrorCode: null
      }});
      console.info('[canonical-evaluation] finalization recovery attempted', {
        submissionId: String(submission._id), stage: 'submission_status_finalization',
        provider: persisted?.evaluationProvider || null, model: persisted?.evaluationModel || null,
        errorCode: error?.code || 'SUBMISSION_STATUS_UPDATE_INTERRUPTED',
        persistenceStatus: recovered.modifiedCount === 1 ? 'recovered' : 'superseded'
      });
      return recovered.modifiedCount === 1
        ? { status: recoveredStatus, sourceHash, provider: persisted?.evaluationProvider || null,
          model: persisted?.evaluationModel || null, overallScore: Number(persisted?.overallScore), recovered: true }
        : { status: 'superseded', sourceHash };
    }
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
        } }, correctionStats: stats } }, { runValidators: true });
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
        } }, evaluationUpdatedAt: new Date() } });
    return { status: 'failed', sourceHash, provider: lastAttempt.provider || null, model: lastAttempt.model || null,
      overallScore: null, errorCode, attempts };
  }
}

module.exports = { VERSION, stable, hashRubric, hashBuiltInContext, synchronizedRubricScores, hasValidRubricScores,
  isEvaluationFresh, generate };
