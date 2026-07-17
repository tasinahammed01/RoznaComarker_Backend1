'use strict';

const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const AdaptivePracticeSession = require('../models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../models/AdaptivePracticeAttempt');
const adaptivePractice = require('./adaptivePractice.service');
const { ADAPTIVE_PRACTICE_PASS_THRESHOLD } = require('../constants/adaptivePractice.constants');

class TeacherAdaptivePracticeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function validId(value, code = 'INVALID_ID') {
  if (!mongoose.Types.ObjectId.isValid(value)) throw new TeacherAdaptivePracticeError(400, code, 'Invalid identifier.');
}

async function loadAuthorizedSubmission(submissionId, teacherId) {
  validId(submissionId, 'INVALID_SUBMISSION_ID');
  const submission = await Submission.findById(submissionId).select('_id student assignment class').lean();
  if (!submission) throw new TeacherAdaptivePracticeError(404, 'SUBMISSION_NOT_FOUND', 'Submission not found.');
  const assignment = await Assignment.findById(submission.assignment).select('_id teacher class').lean();
  if (!assignment) throw new TeacherAdaptivePracticeError(404, 'ASSIGNMENT_NOT_FOUND', 'Assignment not found.');
  let authorized = String(assignment.teacher) === String(teacherId);
  if (!authorized) {
    const classId = assignment.class || submission.class;
    authorized = Boolean(await Class.exists({ _id: classId, teacher: teacherId }));
  }
  if (!authorized) throw new TeacherAdaptivePracticeError(403, 'FORBIDDEN', 'You cannot view adaptive practice for this submission.');
  return { submission, assignment };
}

function emptyProgress(submissionId) {
  return { state: 'not-started', sourceStatus: 'current', submissionId: String(submissionId), sessionId: null,
    summary: { totalActivities: 0, improvedActivities: 0, progressPercentage: 0, totalAttempts: 0, lastPracticedAt: null }, skills: [] };
}

async function selectSession(submission, sessions) {
  if (!sessions.length) return { session: null, sourceStatus: 'current' };
  try {
    const current = await adaptivePractice.loadOwnedSource(submission._id, submission.student);
    const matching = sessions.find((session) => session.sourceFingerprint === current.sourceFingerprint);
    if (matching) return { session: matching, sourceStatus: 'current' };
  } catch {
    // Current assessment source may be incomplete; historical monitoring remains read-only and available.
  }
  return { session: sessions[0], sourceStatus: 'outdated' };
}

async function getProgress(submissionId, teacherId) {
  const { submission } = await loadAuthorizedSubmission(submissionId, teacherId);
  const sessions = await AdaptivePracticeSession.find({ submissionId: submission._id, studentId: submission.student })
    .sort({ createdAt: -1, _id: -1 })
    .select('_id submissionId studentId assignmentId status sourceFingerprint sourceSnapshot targetSkills activities.activityId activities.skillId activities.category createdAt updatedAt')
    .lean();
  const selected = await selectSession(submission, sessions);
  if (!selected.session) return emptyProgress(submission._id);
  const session = selected.session;
  const attempts = await AdaptivePracticeAttempt.find({ sessionId: session._id, studentId: session.studentId })
    .sort({ createdAt: 1, attemptNumber: 1 })
    .select('_id activityId attemptNumber status result.score result.passed createdAt updatedAt')
    .lean();
  const sourceSkills = new Map((session.sourceSnapshot?.skills || []).map((skill) => [skill.id, skill]));
  const skills = (session.activities || []).map((activity) => {
    const matching = attempts.filter((attempt) => attempt.activityId === activity.activityId);
    const ready = matching.filter((attempt) => attempt.status === 'ready' && Number.isFinite(Number(attempt.result?.score)));
    const latest = ready.at(-1) || null;
    const bestScore = ready.length ? Math.max(...ready.map((attempt) => Number(attempt.result.score))) : null;
    const source = sourceSkills.get(activity.skillId);
    return { skillId: activity.skillId, label: activity.category, originalEarnedPoints: source?.earnedPoints ?? null,
      originalMaximumPoints: source?.maximumPoints ?? null, originalPercentage: source?.percentage ?? null,
      activityId: activity.activityId, attemptCount: matching.length, latestScore: latest ? Number(latest.result.score) : null,
      bestScore, improved: bestScore !== null && bestScore >= ADAPTIVE_PRACTICE_PASS_THRESHOLD,
      lastAttemptAt: matching.length ? (matching.at(-1).createdAt || matching.at(-1).updatedAt) : null };
  });
  const improvedActivities = skills.filter((skill) => skill.improved).length;
  const totalActivities = skills.length;
  const lastAttempt = attempts.at(-1);
  let state = session.status === 'generating' ? 'generating' : session.status === 'failed' ? 'failed' : totalActivities > 0 && improvedActivities === totalActivities ? 'completed' : 'in-progress';
  return { state, sourceStatus: selected.sourceStatus, submissionId: String(submission._id), sessionId: String(session._id),
    summary: { totalActivities, improvedActivities, progressPercentage: totalActivities ? Math.round(improvedActivities / totalActivities * 100) : 0,
      totalAttempts: attempts.length, lastPracticedAt: lastAttempt ? (lastAttempt.createdAt || lastAttempt.updatedAt) : null }, skills };
}

async function getAttempts(sessionId, activityId, teacherId, pageValue, limitValue) {
  validId(sessionId, 'INVALID_SESSION_ID');
  const session = await AdaptivePracticeSession.findById(sessionId).select('_id submissionId studentId activities.activityId').lean();
  if (!session) throw new TeacherAdaptivePracticeError(404, 'SESSION_NOT_FOUND', 'Practice session not found.');
  await loadAuthorizedSubmission(session.submissionId, teacherId);
  if (!(session.activities || []).some((activity) => activity.activityId === activityId)) throw new TeacherAdaptivePracticeError(404, 'ACTIVITY_NOT_FOUND', 'Practice activity not found.');
  const page = Math.max(1, Number(pageValue) || 1);
  const limit = Math.min(25, Math.max(1, Number(limitValue) || 10));
  const filter = { sessionId: session._id, studentId: session.studentId, activityId };
  const [total, attempts] = await Promise.all([
    AdaptivePracticeAttempt.countDocuments(filter),
    AdaptivePracticeAttempt.find(filter).sort({ createdAt: -1, attemptNumber: -1 }).skip((page - 1) * limit).limit(limit)
      .select('_id attemptNumber status response result.score result.passed result.summary result.strength result.nextImprovement result.checklist result.suggestedRevision createdAt').lean()
  ]);
  return { sessionId: String(session._id), activityId, attempts: attempts.map((attempt) => ({ id: String(attempt._id), attemptNumber: attempt.attemptNumber,
    status: attempt.status, response: attempt.response, practiceScore: attempt.status === 'ready' ? attempt.result?.score ?? null : null,
    improved: attempt.status === 'ready' && Number(attempt.result?.score) >= ADAPTIVE_PRACTICE_PASS_THRESHOLD,
    summary: attempt.status === 'ready' ? attempt.result?.summary || '' : '', strength: attempt.status === 'ready' ? attempt.result?.strength || '' : '',
    nextImprovement: attempt.status === 'ready' ? attempt.result?.nextImprovement || '' : '', checklist: attempt.status === 'ready' ? attempt.result?.checklist || [] : [],
    suggestedRevision: attempt.status === 'ready' ? attempt.result?.suggestedRevision || '' : '', attemptedAt: attempt.createdAt })),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total } };
}

module.exports = { TeacherAdaptivePracticeError, loadAuthorizedSubmission, selectSession, getProgress, getAttempts };
