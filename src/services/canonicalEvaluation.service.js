const crypto = require('crypto');
const logger = require('../utils/logger');
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
const CreditService = require('./credit.service');
const assessmentCompletion = require('./assessmentCompletion.service');

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

function preparedRubricError(code, message, diagnostics = {}) {
  const error = new Error(message);
  error.code = code;
  error.preparedRubricDiagnostics = diagnostics;
  return error;
}

function preparedRubricDiagnostics(prepared, { sourceHash, policyHash, rubricHash, customRubricStatus }) {
  const semantic = prepared?.semantic;
  const categories = semantic?.categories;
  const requiredScores = ['CONTENT', 'ORGANIZATION', 'VOCABULARY'];
  const categoryScoresPresent = Boolean(categories && requiredScores.every((category) =>
    Number.isFinite(Number(categories[category]?.score))));
  const evidencePresent = Boolean(categories && Object.values(categories).some((category) =>
    (Array.isArray(category?.strengthEvidence) && category.strengthEvidence.length > 0)
    || (Array.isArray(category?.improvementEvidence) && category.improvementEvidence.length > 0)));
  return {
    preparedRubricPresent: Boolean(prepared && typeof prepared === 'object'),
    preparedRubricStatus: prepared?.error ? 'rejected' : prepared ? 'available' : 'missing',
    preparedRubricProvider: semantic?.provider || null,
    preparedRubricModel: semantic?.model || null,
    preparedRubricSourceHash: prepared?.sourceHash || null,
    expectedSourceHash: sourceHash || null,
    preparedRubricPolicyHash: prepared?.policyHash || null,
    expectedPolicyHash: policyHash || null,
    preparedRubricRubricHash: prepared?.rubricHash || null,
    expectedRubricHash: rubricHash || null,
    preparedRubricPromptVersion: prepared?.promptVersion || null,
    expectedPromptVersion: semanticRubricAssessment.PROMPT_VERSION || null,
    preparedRubricSchemaVersion: prepared?.schemaVersion || null,
    expectedSchemaVersion: semanticRubricAssessment.SCHEMA_VERSION || null,
    preparedCustomRubricStatus: prepared?.customRubricStatus ?? null,
    expectedCustomRubricStatus: customRubricStatus,
    semanticSourceHash: semantic?.sourceHash || null,
    categoryScoresPresent,
    evidencePresent
  };
}

function validatePreparedRubric(prepared, expected) {
  const diagnostics = preparedRubricDiagnostics(prepared, expected);
  if (!diagnostics.preparedRubricPresent) throw preparedRubricError(
    'PREPARED_RUBRIC_MISSING', 'Prepared rubric evidence is required but missing', diagnostics);
  const hashMismatch = prepared.sourceHash !== expected.sourceHash
    || prepared.policyHash !== expected.policyHash || prepared.rubricHash !== expected.rubricHash
    || prepared.customRubricStatus !== expected.customRubricStatus
    || (prepared.semantic?.sourceHash && prepared.semantic.sourceHash !== expected.sourceHash);
  if (hashMismatch) throw preparedRubricError(
    'PREPARED_RUBRIC_HASH_MISMATCH', 'Prepared rubric evidence does not match the current evaluation inputs', diagnostics);
  const versionMismatch = (semanticRubricAssessment.PROMPT_VERSION
      && prepared.promptVersion !== semanticRubricAssessment.PROMPT_VERSION)
    || (semanticRubricAssessment.SCHEMA_VERSION
      && prepared.schemaVersion !== semanticRubricAssessment.SCHEMA_VERSION);
  if (versionMismatch) throw preparedRubricError(
    'PREPARED_RUBRIC_VERSION_MISMATCH', 'Prepared rubric evidence uses an incompatible contract version', diagnostics);
  if (!prepared.semantic || !diagnostics.categoryScoresPresent) throw preparedRubricError(
    'PREPARED_RUBRIC_INVALID', 'Prepared rubric evidence is missing required category scores', diagnostics);
  return prepared;
}

async function prepareRubricAssessment({ submission, assignment, sourceHash, deadlineAt = null }) {
  const rubricStartedAt = Date.now();
  const classDoc = await Class.findById(submission.class).select('teacher').lean();
  const teacher = classDoc?.teacher ? await User.findById(classDoc.teacher).select('aiConfig role').lean() : null;
  const policy = normalizeTeacherEvaluationPolicy(teacher);
  const policyHash = evaluationPolicyHash(policy);
  const customRubricResult = normalizeAssignmentRubric(assignment || {});
  if (customRubricResult.status === 'invalid') {
    const error = new Error('Assignment rubric is invalid');
    error.code = 'INVALID_ASSIGNMENT_RUBRIC';
    error.diagnostics = customRubricResult.diagnostics;
    throw error;
  }
  const rubricHash = customRubricResult.status === 'valid' ? hashNormalizedRubric(customRubricResult) : hashRubric(assignment);
  const transcript = normalizedTranscript(submission);
  logger.info({ message: 'Assessment pipeline timing', submissionId: String(submission._id), stage: 'rubricStartedAt',
    timestamp: new Date(rubricStartedAt).toISOString(), sourceHash });
  const semantic = await semanticRubricAssessment.assess({ submissionId: String(submission._id), transcript, sourceHash,
    assignment, corrections: [], statistics: {}, pageManifest: submission.ocrPages || [],
    transcriptComplete: submission.ocrStatus === 'completed' && Boolean(transcript.trim()), policy,
    customRubric: customRubricResult.rubric, includeLanguageCategories: true, deadlineAt });
  for (const category of ['CONTENT', 'ORGANIZATION', 'VOCABULARY']) {
    semantic.categories[category] = applySemanticStrictness(semantic.categories[category], policy.strictness);
  }
  if (!policy.checks.coherenceLogic) semantic.categories.ORGANIZATION = {
    ...semantic.categories.ORGANIZATION, score: 20, issueCount: 0,
    comment: 'Coherence and organization scoring is disabled by the teacher evaluation policy.', improvementEvidence: []
  };
  const rubricEndedAt = Date.now();
  logger.info({ message: 'Assessment pipeline timing', submissionId: String(submission._id), stage: 'rubricEndedAt',
    timestamp: new Date(rubricEndedAt).toISOString(), sourceHash, durationMs: rubricEndedAt - rubricStartedAt,
    provider: semantic.provider || null, model: semantic.model || null });
  return { semantic, sourceHash, policyHash, rubricHash, customRubricStatus: customRubricResult.status,
    promptVersion: semanticRubricAssessment.PROMPT_VERSION, schemaVersion: semanticRubricAssessment.SCHEMA_VERSION,
    rubricStartedAt, rubricEndedAt };
}

async function persistProvisionalScore({ submission, assignment, sourceHash, jobId, preparedRubricAssessment }) {
  const prepared = preparedRubricAssessment;
  if (!prepared) throw preparedRubricError('PREPARED_RUBRIC_MISSING',
    'Prepared rubric evidence is required for provisional scoring');
  const classDoc = await Class.findById(submission.class).select('teacher').lean();
  const teacher = classDoc?.teacher ? await User.findById(classDoc.teacher).select('aiConfig role').lean() : null;
  const policy = normalizeTeacherEvaluationPolicy(teacher);
  const policyHash = evaluationPolicyHash(policy);
  const customRubricResult = normalizeAssignmentRubric(assignment || {});
  const rubricHash = customRubricResult.status === 'valid' ? hashNormalizedRubric(customRubricResult) : hashRubric(assignment);
  validatePreparedRubric(prepared, { sourceHash, policyHash, rubricHash,
    customRubricStatus: customRubricResult.status });
  const semantic = prepared.semantic;
  const transcript = normalizedTranscript(submission);
  const stats = computeCanonicalCorrectionStatistics([]);
  const rubricScores = synchronizedRubricScores({
    CONTENT: semantic.categories.CONTENT,
    ORGANIZATION: semantic.categories.ORGANIZATION,
    VOCABULARY: semantic.categories.VOCABULARY,
    GRAMMAR: { ...semantic.categories.GRAMMAR,
      score: policy.checks.grammarSpelling ? Math.round(Number(semantic.categories.GRAMMAR.score) * 1.25 * 10) / 10 : 25,
      maxScore: 25, comment: policy.checks.grammarSpelling ? semantic.categories.GRAMMAR.comment
        : 'Grammar scoring is disabled by the teacher evaluation policy.' },
    MECHANICS: { ...semantic.categories.MECHANICS,
      score: policy.checks.grammarSpelling ? Math.round(Number(semantic.categories.MECHANICS.score) * 0.5 * 10) / 10 : 10,
      maxScore: 10, comment: policy.checks.grammarSpelling ? semantic.categories.MECHANICS.comment
        : 'Mechanics scoring is disabled by the teacher evaluation policy.' },
    PRESENTATION: scorePresentation(submission)
  }, stats);
  if (!hasValidRubricScores(rubricScores)) throw new Error('Provisional assessment is missing required rubric categories');
  const customRubricScores = customRubricResult.status === 'valid'
    ? calculateCustomRubricScore(customRubricResult.rubric, semantic.customCriteria) : null;
  const overallScore = customRubricScores ? customRubricScores.overallScore
    : Object.values(rubricScores).reduce((sum, item) => sum + item.score, 0);
  const grade = gradeFromOverallScore(overallScore);
  const ownsJob = await submission.constructor.exists({ _id: submission._id, correctionSourceHash: sourceHash,
    correctionJobId: jobId, evaluationJobId: jobId });
  if (!ownsJob) throw supersededEvaluationError();
  const feedback = await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id,
    overriddenByTeacher: { $ne: true } }, { $set: {
    submissionId: submission._id, classId: submission.class, studentId: submission.student,
    teacherId: classDoc?.teacher, evaluationJobId: jobId,
    assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: VERSION,
    evaluationSourceHash: sourceHash, evaluationRubricSourceHash: rubricHash,
    evaluationPolicyHash: policyHash, evaluationBuiltInContextHash: hashBuiltInContext(assignment),
    evaluationPolicy: { ...policy, scoringPolicyVersion: SCORING_POLICY_VERSION },
    evaluationSource: 'provisional', evaluationStatus: 'partial', evaluationProvider: semantic.provider,
    evaluationModel: semantic.model, evaluationErrorCode: null, correctionStats: stats,
    evaluationAttempts: semantic.metrics?.attempts || [], rubricScores, customRubricScores,
    sourceRubric: customRubricResult.rubric, overallScore, grade
  } }, { new: true, runValidators: true, upsert: true });
  if (!feedback) throw supersededEvaluationError();
  const updated = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash,
    correctionJobId: jobId, evaluationJobId: jobId }, { $set: {
    evaluationStatus: 'partial', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
    evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
    evaluationProvider: semantic.provider, evaluationModel: semantic.model,
    evaluationUpdatedAt: new Date(), evaluationError: null, evaluationErrorCode: null
  } });
  if (updated.modifiedCount !== 1) throw supersededEvaluationError();
  logger.info({ message: 'Assessment pipeline timing', submissionId: String(submission._id), stage: 'scoreReadyAt',
    timestamp: new Date().toISOString(), sourceHash, provisional: true, transcriptCharacters: transcript.length });
  return { status: 'partial', sourceHash, rubricHash, policyHash, overallScore, grade, rubricScores,
    provider: semantic.provider, model: semantic.model };
}

async function generate({ submission, assignment, prelockedJobId = null, allowDegradedCorrections = false,
  preparedRubricAssessment = null, preparedRubricRequired = false }) {
  const totalStartedAt = Date.now();
  const sourceHash = submission.correctionSourceHash;
  const correctionsAvailable = submission.semanticStatus !== 'failed' && submission.correctionStatus === 'completed';
  if (!sourceHash || (!correctionsAvailable && !allowDegradedCorrections)) return { status: 'superseded' };
  const classDoc = await Class.findById(submission.class).select('teacher').lean();
  const teacher = classDoc?.teacher ? await User.findById(classDoc.teacher).select('aiConfig role').lean() : null;
  const accountingEnabled = teacher?.role === 'teacher';
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
  const creditState = accountingEnabled ? await CreditService.canRunAssessment(classDoc?.teacher) : { allowed: true, availableCredits: null };
  if (!creditState.allowed) {
    await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash }, { $set: {
      evaluationStatus: 'blocked', evaluationErrorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS',
      evaluationError: 'You have used all your Assessment Credits for this billing cycle.'
    }});
    logger.info({ event: 'credit.assessment.not_charged', userId: String(classDoc?.teacher),
      submissionId: String(submission._id), assessmentId: sourceHash, reason: 'insufficient_credits' });
    return { status: 'blocked', sourceHash, errorCode: 'INSUFFICIENT_ASSESSMENT_CREDITS' };
  }
  const jobId = prelockedJobId || crypto.randomUUID();
  if (!prelockedJobId) {
    const locked = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash, evaluationStatus: { $ne: 'processing' } },
      { $set: { evaluationStatus: 'processing', evaluationJobId: jobId, evaluationError: null, evaluationErrorCode: null } });
    if (!locked.modifiedCount) return { status: 'superseded', sourceHash };
  } else {
    const ownsLock = await submission.constructor.exists({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: { $in: ['processing', 'partial'] }, evaluationJobId: jobId });
    if (!ownsLock) return { status: 'superseded', sourceHash };
  }
  if (accountingEnabled) await assessmentCompletion.start({ runId: jobId, submission,
    teacherId: classDoc.teacher, sourceHash });
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
      && persistedFeedback.evaluationSource !== 'provisional'
      && persistedFeedback.evaluationSourceHash === sourceHash
      && persistedFeedback.evaluationPolicyHash === policyHash
      && persistedFeedback.evaluationBuiltInContextHash === builtInContextHash
      && persistedFeedback.assessmentVersion === ASSESSMENT_VERSION
      && persistedFeedback.evaluationVersion === VERSION
      && hasValidRubricScores(persistedFeedback.rubricScores));
    const semanticEvaluationStartedAt = Date.now();
    logger.info({ message: 'Canonical evaluation timing', submissionId: String(submission._id),
      stage: 'semantic_evaluation_start', attemptNumber: null, provider: null, model: null,
      errorCode: null, durationMs: 0 });
    console.info('[canonical-evaluation] semantic rubric assessment started', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats });
    const expectedPrepared = { sourceHash, policyHash, rubricHash, customRubricStatus: customRubricResult.status };
    const handoffDiagnostics = preparedRubricDiagnostics(preparedRubricAssessment, expectedPrepared);
    if (process.env.NODE_ENV !== 'production') logger.info({ message: 'Prepared rubric handoff diagnostics',
      submissionId: String(submission._id), ...handoffDiagnostics });
    if (preparedRubricAssessment?.error) throw preparedRubricAssessment.error;
    if (preparedRubricRequired && !preparedRubricAssessment) throw preparedRubricError(
      'PREPARED_RUBRIC_MISSING', 'Parallel rubric evidence was not supplied to canonical finalization', handoffDiagnostics);
    const prepared = preparedRubricAssessment || await prepareRubricAssessment({ submission, assignment, sourceHash });
    validatePreparedRubric(prepared, expectedPrepared);
    const semantic = prepared.semantic;
    console.info('[canonical-evaluation] semantic rubric assessment completed', { submissionId: String(submission._id),
      provider: semantic.provider, model: semantic.model, sourceHashMatch: semantic.sourceHash === sourceHash,
      categoryScores: Object.fromEntries(Object.entries(semantic.categories).map(([key, value]) => [key, value.score])),
      duration: semantic.metrics?.semanticRubricAssessmentMs });
    logger.info({ message: 'Canonical evaluation timing', submissionId: String(submission._id),
      stage: 'semantic_evaluation_end', attemptNumber: null, provider: semantic.provider || null,
      model: semantic.model || null, errorCode: null,
      durationMs: Date.now() - semanticEvaluationStartedAt });
    const generatedRubricScores = synchronizedRubricScores({
      CONTENT: semantic.categories.CONTENT,
      ORGANIZATION: semantic.categories.ORGANIZATION,
      VOCABULARY: semantic.categories.VOCABULARY,
      GRAMMAR: correctionsAvailable ? scoreGrammar({ corrections, wordCount, strictness: policy.strictness,
        enabled: policy.checks.grammarSpelling }) : {
        ...semantic.categories.GRAMMAR,
        score: policy.checks.grammarSpelling ? Math.round(Number(semantic.categories.GRAMMAR.score) * 1.25 * 10) / 10 : 25,
        maxScore: 25,
        comment: policy.checks.grammarSpelling ? semantic.categories.GRAMMAR.comment
          : 'Grammar scoring is disabled by the teacher evaluation policy.'
      },
      MECHANICS: correctionsAvailable ? scoreMechanics({ corrections, wordCount, strictness: policy.strictness,
        enabled: policy.checks.grammarSpelling }) : {
        ...semantic.categories.MECHANICS,
        score: policy.checks.grammarSpelling ? Math.round(Number(semantic.categories.MECHANICS.score) * 0.5 * 10) / 10 : 10,
        maxScore: 10,
        comment: policy.checks.grammarSpelling ? semantic.categories.MECHANICS.comment
          : 'Mechanics scoring is disabled by the teacher evaluation policy.'
      },
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
      correctionsAvailable,
      languageScoringMode: correctionsAvailable ? 'canonical_corrections' : 'transcript_semantic_fallback',
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
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(submission._id), stage: 'feedbackReadyAt',
      timestamp: new Date().toISOString(), sourceHash, durationMs: detailedFeedbackMs });
    const persistenceStartedAt = Date.now();
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
      evaluationStatus: { $in: ['processing', 'partial'] }, evaluationJobId: jobId }, { $set: {
      evaluationStatus: semantic.status === 'partial' ? 'partial' : 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
      evaluationProvider: semantic.provider, evaluationModel: semantic.model,
      evaluationAttempts: semantic.metrics?.attempts || [],
      evaluationDiagnostics: semantic.diagnostics || { commentNormalizations: [] },
      evaluationUpdatedAt: new Date(), evaluationError: null, evaluationErrorCode: null
    }});
    if (completed.modifiedCount !== 1) throw supersededEvaluationError();
    const persistenceMs = Date.now() - persistenceStartedAt;
    const scoreReadyAt = Date.now();
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(submission._id), stage: 'scoreReadyAt',
      timestamp: new Date(scoreReadyAt).toISOString(), sourceHash });
    const totalCanonicalEvaluationMs = Date.now() - totalStartedAt;
    logger.info({ message: 'Canonical evaluation timing', submissionId: String(submission._id),
      stage: 'persistence', attemptNumber: null, provider: semantic.provider || null,
      model: semantic.model || null, errorCode: null, durationMs: persistenceMs });
    logger.info({ message: 'Canonical evaluation timing', submissionId: String(submission._id),
      stage: 'total', attemptNumber: null, provider: semantic.provider || null,
      model: semantic.model || null, errorCode: null, durationMs: totalCanonicalEvaluationMs });
    console.info('[canonical-evaluation] canonical evaluation persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats, categoryScores: Object.fromEntries(Object.entries(rubricScores).map(([key, value]) => [key, value.score])),
      customRubricPresent: Boolean(customRubricScores), builtInScoresReused: reusableBuiltInScores, overallScore });
    console.info('[canonical-evaluation] detailed feedback persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, duration: detailedFeedbackMs });
    const completion = semantic.status === 'completed' && accountingEnabled
      ? await assessmentCompletion.complete({ runId: jobId, teacherId: classDoc.teacher,
        submissionId: submission._id, sourceHash })
      : { availableCredits: creditState.availableCredits };
    if (semantic.status !== 'completed' && accountingEnabled) logger.info({ event: 'credit.assessment.not_charged',
      userId: String(classDoc.teacher), submissionId: String(submission._id), assessmentId: sourceHash, reason: 'partial_assessment' });
    return { status: semantic.status === 'partial' ? 'partial' : 'completed', sourceHash, rubricHash, policyHash, stats,
      provider: semantic.provider, model: semantic.model, overallScore, errorCode: null,
      assessmentRunId: jobId, assessmentStatus: semantic.status === 'completed' ? 'complete' : 'failed',
      availableCredits: completion.credit?.availableCredits ?? completion.availableCredits,
      categoryScores: rubricScores, attempts: semantic.metrics?.attempts || [], timings: {
        detailedFeedbackMs, validationMs: semantic.metrics?.validationMs || 0,
        persistenceMs, totalCanonicalEvaluationMs
      } };
  } catch (error) {
    logger.info({ message: 'Canonical evaluation timing', submissionId: String(submission._id),
      stage: 'total', attemptNumber: null, provider: error?.provider || null,
      model: error?.model || null, errorCode: error?.validationCode || error?.code || 'CANONICAL_EVALUATION_FAILED',
      durationMs: Date.now() - totalStartedAt });
    if (error?.code === 'ANALYSIS_JOB_SUPERSEDED') return { status: 'superseded', sourceHash };
    if (error?.code === 'ASSESSMENT_COMPLETION_FAILED') return { status: 'failed', sourceHash,
      errorCode: error.componentCode || error.code, assessmentRunId: jobId, assessmentStatus: 'failed' };
    // A valid feedback write followed by an interrupted status update is
    // intentionally left recoverable by the idempotent path above.
    if (feedbackPersisted) {
      const persisted = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
      const recoveredStatus = persisted?.evaluationStatus === 'partial' ? 'partial' : 'completed';
      const recovered = await submission.constructor.updateOne({ _id: submission._id,
        correctionSourceHash: sourceHash, evaluationStatus: { $in: ['processing', 'partial'] }, evaluationJobId: jobId }, { $set: {
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
    const preparedHandoffFailure = String(errorCode).startsWith('PREPARED_RUBRIC_');
    console.warn(preparedHandoffFailure
      ? '[canonical-evaluation] prepared rubric handoff failed'
      : '[canonical-evaluation] semantic rubric assessment failed', {
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
      { $set: { evaluationStatus: 'failed', evaluationError: preparedHandoffFailure
        ? `Canonical prepared rubric handoff failed (${errorCode})`
        : `Canonical semantic rubric evaluation failed (${errorCode})`,
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
  isEvaluationFresh, preparedRubricDiagnostics, validatePreparedRubric,
  prepareRubricAssessment, persistProvisionalScore, generate };
