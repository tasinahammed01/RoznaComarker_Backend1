'use strict';
// Speaking Coach: the owning teacher's read-only view of a student's (or guest's) speaking practice. Only the teacher who owns the speaking
// assignment and its class; 404 for anyone else and for anything that is not a speaking submission. Read only: nothing here writes.
const mongoose = require('mongoose');
const Submission = require('../../models/Submission');
const Assignment = require('../../models/assignment.model');
const Class = require('../../models/class.model');
const AudioRecording = require('../../models/AudioRecording');
const SpeakingPracticeSession = require('../../models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../../models/SpeakingPracticeAttempt');
const accessContext = require('../submissionAccessContext.service');
const views = require('./views');
const { CoachError, loadSource, overviewOf } = require('./generation.service');

const notFound = () => new CoachError(404, 'NOT_FOUND', 'Not found.');

/** The speaking submission when this teacher owns its assignment and class; 404 otherwise. */
async function ownedSubmission(submissionId, teacherId) {
  if (!mongoose.isValidObjectId(submissionId)) throw notFound();
  const submission = await Submission.findOne({ _id: submissionId, sourceKind: 'audio' }).select('_id assignment class student submissionMode').lean();
  if (!submission) throw notFound();
  const assignment = await Assignment.findOne({ _id: submission.assignment, teacher: teacherId, resourceType: 'speaking' }).select('_id class').lean();
  if (!assignment || String(assignment.class) !== String(submission.class) || !await Class.exists({ _id: submission.class, teacher: teacherId })) throw notFound();
  return submission;
}

/** The practice owner as the coach services see it: the student id, or the guest context of a guest submission. */
const ownerOf = submission => (submission.submissionMode === 'guest' ? accessContext.guestContext(submission) : submission.student);

/** The card with no session: why there is none (no rubric scores, the result not ready, nothing to practise, or not started yet). */
function emptyStateOf(source, overview) {
  if (!source?.ready) return source?.reason === 'no_rubric_scores' ? 'no-rubric-scores' : 'result-not-ready';
  return overview.areas.some(area => area.needsPractice) ? 'not-started' : 'no-practice-needed';
}

async function getProgress(submissionId, teacherId, { env = process.env } = {}) {
  const submission = await ownedSubmission(submissionId, teacherId);
  const session = await SpeakingPracticeSession.findOne({ submissionId: submission._id }).sort({ createdAt: -1, _id: -1 }).lean();
  let source = null;
  try { source = await loadSource(submission._id, ownerOf(submission)); } catch { /* the current result may be unavailable; the card stays readable */ }
  if (!session) {
    const overview = overviewOf({ state: null, session: null, source }, { env });
    return views.teacherProgress({ submissionId: submission._id, session: null, areas: overview.areas, emptyState: emptyStateOf(source, overview) });
  }
  const sourceStatus = source?.ready && source.sourceFingerprint === session.sourceFingerprint ? 'current' : 'outdated';
  const areas = sourceStatus === 'current' ? overviewOf({ state: null, session, source }, { env }).areas : [];
  const attempts = await SpeakingPracticeAttempt.find({ sessionId: session._id }).select('_id taskId attemptNumber status result.levelTitle result.passed createdAt').lean();
  return views.teacherProgress({ submissionId: submission._id, session, attempts, sourceStatus, areas });
}

async function getAttempts(sessionId, taskId, teacherId, pageValue, limitValue) {
  if (!mongoose.isValidObjectId(sessionId)) throw notFound();
  const session = await SpeakingPracticeSession.findById(sessionId).select('_id submissionId tasks.taskId').lean();
  if (!session) throw notFound();
  await ownedSubmission(session.submissionId, teacherId);
  if (!(session.tasks || []).some(task => task.taskId === taskId)) throw notFound();
  const page = Math.max(1, Number.parseInt(pageValue, 10) || 1);
  const limit = Math.min(25, Math.max(1, Number.parseInt(limitValue, 10) || 10));
  const filter = { sessionId: session._id, taskId };
  const [total, attempts] = await Promise.all([SpeakingPracticeAttempt.countDocuments(filter),
    SpeakingPracticeAttempt.find(filter).sort({ attemptNumber: -1 }).skip((page - 1) * limit).limit(limit)
      .select('_id attemptNumber status notAssessableReason errorCode result recordingId createdAt').lean()]);
  const ids = attempts.map(attempt => attempt.recordingId).filter(Boolean);
  const recordings = ids.length ? await AudioRecording.find({ _id: { $in: ids }, purpose: 'practice' }).select('_id +derived').lean() : [];
  const text = new Map(recordings.map(recording => [String(recording._id), String(recording.derived?.assessorText || '')]));
  return { sessionId: String(session._id), taskId, attempts: attempts.map(attempt => views.teacherAttempt(attempt, text.get(String(attempt.recordingId)))),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total } };
}

module.exports = { ownedSubmission, getProgress, getAttempts };
