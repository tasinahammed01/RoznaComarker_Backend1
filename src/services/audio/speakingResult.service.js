'use strict';
// Reading a speaking result (audio + speech-to-text, stage 6): GET /api/speaking/submissions/:id/result. Strict DTOs built field by field
// (never a stored document minus a denylist):
// - student (the owner): state, the rubric result (marks removed when the teacher hides them), the categories that apply to speech,
//   corrections from buildStudentCorrectionView(doc, { overlay: null }) with offsets into assessedText, the fluency figures. Never: provider,
//   model, prompt or schema version, hashes, run ids, lease fields, raw words, edit revisions, teacher-only fields, or why an assessment is
//   waiting for the teacher (credits are the teacher's business).
// - teacher (owner of the assignment and class): the same plus the job state (error code, run status, relevance, dropped corrections).
// The essay canonical result state (canonicalResultState) assumes OCR fields and the essay assessment version, so a speaking result would
// always read as "not current" there; the state below is the speaking equivalent. teacherEvaluation.finalFeedback is applied as for essays.
const Submission = require('../../models/Submission');
const SubmissionFeedback = require('../../models/SubmissionFeedback');
const AudioRecording = require('../../models/AudioRecording');
const { buildStudentCorrectionView } = require('../studentCorrectionView.service');
const { finalFeedback } = require('../teacherEvaluation.service');
const { ASSESSMENT_CATEGORY_LABELS } = require('../../constants/assessmentCategories');
const { TERMINAL_MESSAGES } = require('./speakingAssessment.service');

const APPLICABLE = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY'];
const NOT_ASSESSABLE = new Set(['SPEAKING_NOT_ENGLISH', 'SPEAKING_UNINTELLIGIBLE', 'SPEAKING_TRANSCRIPT_TOO_LONG']);
const CORRECTION_FIELDS = ['id', 'category', 'symbol', 'symbolLabel', 'quotedText', 'startChar', 'endChar', 'message', 'suggestedText'];
const OFF_TOPIC_NOTE = 'This answer did not address the task, so the score is capped.';
/** Where each removed filler stood in the assessed text, for the "show filler words" toggle. Only { offset, text }; out-of-range ones dropped. */
function fillersOf(recording) {
  const text = String(recording?.derived?.assessorText || '');
  const list = recording?.status === 'ready' && Array.isArray(recording.derived?.displayText?.fillers) ? recording.derived.displayText.fillers : [];
  return list.filter(item => Number.isInteger(item?.offset) && item.offset >= 0 && item.offset <= text.length && typeof item.text === 'string' && item.text.trim())
    .map(item => ({ offset: item.offset, text: item.text.slice(0, 40) }));
}
const pick = (object, keys) => Object.fromEntries(keys.filter(key => object?.[key] !== undefined).map(key => [key, object[key]]));

/** One state for both audiences; the student never sees 'blocked' or 'failed' (both are 'awaiting_teacher' for them). */
function stateOf({ recording, submission, feedback, audience }) {
  if (!recording || ['uploaded', 'queued', 'transcribing'].includes(recording.status)) return 'transcribing';
  if (['failed', 'cancelled'].includes(recording.status)) return 'transcription_failed';
  const status = submission.evaluationStatus;
  if (['completed', 'partial'].includes(status) && feedback && ['completed', 'partial'].includes(feedback.evaluationStatus)) return 'ready';
  if (status === 'failed' && submission.evaluationErrorCode === 'SPEAKING_NOT_ENOUGH_SPEECH') return 'not_enough_speech';
  if (status === 'failed' && NOT_ASSESSABLE.has(submission.evaluationErrorCode)) return 'not_assessable';
  if (status === 'blocked') return audience === 'teacher' ? 'blocked' : 'awaiting_teacher';
  if (status === 'failed') return audience === 'teacher' ? 'failed' : 'awaiting_teacher';
  return 'assessing';
}

function resultBlock(feedback, { marksVisible }) {
  const custom = feedback.customRubricScores || {};
  const speaking = feedback.detailedFeedback?.speaking || {};
  const criteria = (custom.criteria || []).map(c => ({ criterionId: c.criterionId, title: c.title, level: c.selectedLevel, weightPercent: c.normalizedWeight,
    ...(marksVisible ? { points: c.weightedPoints } : {}), comment: c.comment }));
  const categories = APPLICABLE.filter(key => Number(feedback.rubricScores?.[key]?.maxScore) > 0).map(key => ({ key, label: ASSESSMENT_CATEGORY_LABELS[key],
    ...(marksVisible ? { score: feedback.rubricScores[key].score, maxScore: feedback.rubricScores[key].maxScore } : {}), comment: feedback.rubricScores[key].comment || '' }));
  return {
    ...(marksVisible ? { overallScore: feedback.overallScore, maxScore: 100, grade: feedback.grade } : {}),
    criteria, categories,
    summary: speaking.summary || '', strengths: speaking.strengths || [], improvements: speaking.improvements || [],
    actionSteps: (feedback.detailedFeedback?.actionSteps || []).map(step => ({ priority: step.priority, action: step.action })),
    teacherComments: feedback.teacherComments || '',
    scoreNote: feedback.scoringAudit?.offTopicCap?.applied ? OFF_TOPIC_NOTE : null,
    assessedAt: feedback.updatedAt || null
  };
}

function fluencyBlock(fluency) {
  if (!fluency?.available) return null;
  return { wordsPerMinute: fluency.wordsPerMinute, fillersPer100Words: fluency.fillersPer100Words, pausesOverOneSecond: fluency.pausesOverThreshold,
    longestPauseSeconds: fluency.longestPauseSeconds, repetitions: fluency.repetitionCount };
}

/** context: from speakingSubmission.service accessFor ({ role, submission, assignment, recording }). */
async function readResult(context) {
  const audience = context.role === 'teacher' ? 'teacher' : 'student';
  const submission = await Submission.findById(context.submission._id)
    .select('_id assignment evaluationStatus evaluationErrorCode assessmentStatus writingCorrections correctionStatistics').lean();
  const recording = context.recording ? await AudioRecording.findById(context.recording._id).select('_id status +derived').lean() : null;
  const stored = await SubmissionFeedback.findOne({ submissionId: submission._id }).lean();
  const feedback = stored ? finalFeedback(stored, submission) : null;
  const state = stateOf({ recording, submission, feedback, audience });
  const marksVisible = audience === 'teacher' || context.assignment?.showMarksToStudent !== false;
  const ready_ = state === 'ready' && feedback;
  const corrections = ready_ ? buildStudentCorrectionView(submission, { overlay: null }).corrections.map(c => pick(c, CORRECTION_FIELDS)) : [];
  const out = {
    submissionId: String(submission._id), state,
    message: state === 'not_enough_speech' || state === 'not_assessable' ? TERMINAL_MESSAGES[submission.evaluationErrorCode] || null : null,
    marksVisible,
    assessedText: recording?.status === 'ready' ? String(recording.derived?.assessorText || '') : null,
    fluency: recording?.status === 'ready' ? fluencyBlock(recording.derived?.fluency) : null,
    fillers: fillersOf(recording),
    result: ready_ ? resultBlock(feedback, { marksVisible }) : null,
    corrections
  };
  if (audience !== 'teacher') return out;
  return { ...out, errorCode: ['failed', 'blocked', 'not_enough_speech', 'not_assessable'].includes(state) ? submission.evaluationErrorCode || null : null,
    runStatus: submission.assessmentStatus || null, relevance: stored?.scoringAudit?.relevance || null,
    droppedCorrections: ready_ ? Number(stored?.scoringAudit?.droppedCorrections || 0) : null, rubricSource: stored?.scoringAudit?.rubricSource || null,
    offTopicCap: ready_ && stored?.scoringAudit?.offTopicCap?.applied ? { cap: stored.scoringAudit.offTopicCap.cap, uncappedScore: stored.scoringAudit.offTopicCap.uncappedScore } : null,
    canRetryAssessment: ['failed', 'blocked'].includes(state) };
}

module.exports = { readResult, stateOf, OFF_TOPIC_NOTE };
