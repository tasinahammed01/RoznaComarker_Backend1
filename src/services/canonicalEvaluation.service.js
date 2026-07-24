const crypto = require('crypto');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const Class = require('../models/class.model');
const { computeCanonicalCorrectionStatistics } = require('./correctionCanonical.service');
const detailedFeedbackService = require('./canonicalDetailedFeedback.service');
const semanticRubricAssessment = require('./semanticRubricAssessment.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION, RUBRIC_MAX, normalizedTranscript, countWords,
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

async function generate({ submission, assignment }) {
  const sourceHash = submission.correctionSourceHash;
  if (!sourceHash || submission.correctionStatus !== 'completed') return null;
  const rubricHash = hashRubric(assignment);
  const stats = computeCanonicalCorrectionStatistics(submission.writingCorrections || []);
  const persistedFeedback = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
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
    if (recovered.modifiedCount !== 1) return null;
    return { sourceHash, rubricHash, stats, overallScore: Number(persistedFeedback.overallScore), recovered: true,
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
    if (existingFeedback?.overriddenByTeacher || validDetailed) return null;
  }
  const jobId = crypto.randomUUID();
  const locked = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash, evaluationStatus: { $ne: 'processing' } },
    { $set: { evaluationStatus: 'processing', evaluationJobId: jobId, evaluationError: null } });
  if (!locked.modifiedCount) return null;
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
      corrections, statistics: stats, pageManifest: submission.ocrPages || [] });
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
    if (!jobStillCurrent) return null;
    let savedFeedback = existing;
    if (!existing?.overriddenByTeacher) savedFeedback = await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id,
      evaluationJobId: jobId, overriddenByTeacher: { $ne: true } }, { $set: {
      submissionId: submission._id, classId: submission.class, studentId: submission.student, teacherId: classDoc?.teacher,
      assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: VERSION, evaluationSourceHash: sourceHash,
      evaluationRubricSourceHash: rubricHash, evaluationSource: 'ai', evaluationStatus: semantic.status,
      evaluationProvider: semantic.provider, evaluationModel: semantic.model, evaluationErrorCode: null, correctionStats: stats,
      rubricScores, overallScore, grade,
      detailedFeedback, detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: detailedFeedbackService.VERSION
    }}, { new: true, runValidators: true });
    if (!savedFeedback) throw supersededEvaluationError();
    feedbackPersisted = true;
    const completed = await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash,
      evaluationStatus: 'processing', evaluationJobId: jobId }, { $set: {
      evaluationStatus: semantic.status === 'partial' ? 'partial' : 'completed', evaluationSourceHash: sourceHash, evaluationVersion: VERSION,
      evaluationRubricSourceHash: rubricHash, evaluationUpdatedAt: new Date(), evaluationError: null
    }});
    if (completed.modifiedCount !== 1) throw supersededEvaluationError();
    console.info('[canonical-evaluation] canonical evaluation persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, correctionCounts: stats, categoryScores: Object.fromEntries(Object.entries(rubricScores).map(([key, value]) => [key, value.score])),
      overallScore });
    console.info('[canonical-evaluation] detailed feedback persisted', { submissionId: String(submission._id),
      sourceHashMatch: true, duration: detailedFeedbackMs });
    return { sourceHash, rubricHash, stats, overallScore, timings: { detailedFeedbackMs } };
  } catch (error) {
    if (error?.code === 'ANALYSIS_JOB_SUPERSEDED') return null;
    // A valid feedback write followed by an interrupted status update is
    // intentionally left recoverable by the idempotent path above.
    if (feedbackPersisted) return null;
    const transcript = normalizedTranscript(submission);
    const wordCount = countWords(transcript);
    const corrections = submission.writingCorrections || [];
    const rubricScores = synchronizedRubricScores({
      GRAMMAR: scoreGrammar({ corrections, wordCount }),
      MECHANICS: scoreMechanics({ corrections, wordCount }),
      PRESENTATION: scorePresentation(submission),
      CONTENT: { score: 0, maxScore: RUBRIC_MAX.CONTENT, issueCount: Number(stats.content || 0),
        comment: 'Content evaluation is unavailable because semantic rubric assessment did not complete.' },
      ORGANIZATION: { score: 0, maxScore: RUBRIC_MAX.ORGANIZATION, issueCount: Number(stats.organization || 0),
        comment: 'Organization evaluation is unavailable because semantic rubric assessment did not complete.' },
      VOCABULARY: { score: 0, maxScore: RUBRIC_MAX.VOCABULARY, issueCount: Number(stats.vocabulary || 0),
        comment: 'Vocabulary evaluation is unavailable because semantic rubric assessment did not complete.' }
    }, stats);
    await SubmissionFeedback.findOneAndUpdate({ submissionId: submission._id, evaluationJobId: jobId, overriddenByTeacher: { $ne: true } },
      { $set: { assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: VERSION, evaluationSourceHash: sourceHash,
        evaluationRubricSourceHash: rubricHash, evaluationSource: 'provisional', evaluationStatus: 'failed',
        evaluationErrorCode: error?.code || 'SEMANTIC_RUBRIC_FAILED', correctionStats: stats, rubricScores,
        detailedFeedback: { status: 'failed', sourceHash, areasForImprovement: [], strengths: [], actionSteps: [] },
        detailedFeedbackSourceHash: sourceHash, detailedFeedbackVersion: detailedFeedbackService.VERSION } }, { runValidators: true });
    await submission.constructor.updateOne({ _id: submission._id, correctionSourceHash: sourceHash, evaluationJobId: jobId },
      { $set: { evaluationStatus: 'failed', evaluationError: String(error?.message || error), evaluationUpdatedAt: new Date() } });
    return null;
  }
}

module.exports = { VERSION, stable, hashRubric, synchronizedRubricScores, hasValidRubricScores, generate };
