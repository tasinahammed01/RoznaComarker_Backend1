'use strict';

const crypto = require('crypto');
const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const SubmissionRevision = require('../models/SubmissionRevision');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const AdaptivePracticeSession = require('../models/AdaptivePracticeSession');
const User = require('../models/user.model');
const { withActiveStatus } = require('./classLifecycle.service');

const ACK_MAX_AGE_MS = 15 * 60 * 1000;

function secret() {
  const value = String(process.env.JWT_SECRET || '');
  if (!value) throw new Error('JWT_SECRET is not configured');
  return value;
}

function sign(value) {
  return crypto.createHmac('sha256', secret()).update(value).digest('base64url');
}

function createAckToken(teacherId, viewedAt) {
  const payload = Buffer.from(JSON.stringify({ teacherId: String(teacherId), viewedAt: viewedAt.toISOString() }))
    .toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readAckToken(token, teacherId) {
  const [payload, signature] = String(token || '').split('.');
  if (!payload || !signature) return null;
  const expected = sign(payload);
  const left = Buffer.from(signature); const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let parsed;
  try { parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return null; }
  const viewedAt = new Date(parsed?.viewedAt);
  if (String(parsed?.teacherId) !== String(teacherId) || !Number.isFinite(viewedAt.getTime())) return null;
  const age = Date.now() - viewedAt.getTime();
  if (age < -60_000 || age > ACK_MAX_AGE_MS) return null;
  return viewedAt;
}

function membershipLookup() {
  return [{ $lookup: {
    from: 'memberships', let: { studentId: '$student', classId: '$class' },
    pipeline: [{ $match: { $expr: { $and: [
      { $eq: ['$student', '$$studentId'] }, { $eq: ['$class', '$$classId'] }, { $eq: ['$status', 'active'] }
    ] } } }, { $limit: 1 }], as: '_activeMembership'
  } }, { $match: { '_activeMembership.0': { $exists: true } } }];
}

async function aggregateCount(Model, pipeline) {
  const rows = await Model.aggregate([...pipeline, { $count: 'count' }]);
  return rows[0]?.count || 0;
}

async function getSummary(teacher) {
  const viewedAt = new Date();
  const since = teacher.teacherActivityLastViewedAt ? new Date(teacher.teacherActivityLastViewedAt) : null;
  const activeClasses = await Class.find(withActiveStatus({ teacher: teacher._id, isActive: true })).select('_id').lean();
  const classIds = activeClasses.map((item) => item._id);
  const activeAssignments = classIds.length
    ? await Assignment.find({ teacher: teacher._id, class: { $in: classIds }, isActive: true }).select('_id').lean()
    : [];
  const assignmentIds = activeAssignments.map((item) => item._id);
  const scope = { class: { $in: classIds }, assignment: { $in: assignmentIds } };
  const submissionScope = [{ $match: scope }, ...membershipLookup()];

  const waitingPipeline = [...submissionScope, { $lookup: {
    from: SubmissionFeedback.collection.name, localField: '_id', foreignField: 'submissionId', as: '_feedback'
  } }, { $match: { $or: [
    { '_feedback.0': { $exists: false } },
    { '_feedback.teacherReviewedAt': { $exists: false } },
    { '_feedback.teacherReviewedAt': null }
  ] } }];

  if (!since) {
    return {
      since: null, viewedAt: viewedAt.toISOString(), isFirstVisit: true,
      sinceLastVisit: { newSubmissions: 0, revisedDrafts: 0, adaptiveCompletions: 0 },
      current: { waitingForReview: await aggregateCount(Submission, waitingPipeline) },
      ackToken: createAckToken(teacher._id, viewedAt)
    };
  }

  const newSubmissionPipeline = [
    { $match: { ...scope, createdAt: { $gt: since, $lte: viewedAt } } }, ...membershipLookup()
  ];
  const liveRevisionPipeline = [
    { $match: { ...scope, draftNumber: { $gt: 1 }, submittedAt: { $gt: since, $lte: viewedAt } } }, ...membershipLookup()
  ];
  const archivedRevisionPipeline = [
    { $match: { ...scope, draftNumber: { $gt: 1 }, submittedAt: { $gt: since, $lte: viewedAt } } }, ...membershipLookup()
  ];
  const adaptivePipeline = [
    { $match: { completedAt: { $gt: since, $lte: viewedAt } } },
    { $lookup: { from: Submission.collection.name, localField: 'submissionId', foreignField: '_id', as: '_submission' } },
    { $unwind: '$_submission' },
    { $replaceRoot: { newRoot: { $mergeObjects: ['$$ROOT', {
      student: '$_submission.student', class: '$_submission.class', assignment: '$_submission.assignment'
    }] } } },
    { $match: scope }, ...membershipLookup()
  ];

  const [newSubmissions, liveRevisions, archivedRevisions, adaptiveCompletions, waitingForReview] = await Promise.all([
    aggregateCount(Submission, newSubmissionPipeline),
    aggregateCount(Submission, liveRevisionPipeline),
    aggregateCount(SubmissionRevision, archivedRevisionPipeline),
    aggregateCount(AdaptivePracticeSession, adaptivePipeline),
    aggregateCount(Submission, waitingPipeline)
  ]);

  return {
    since: since.toISOString(), viewedAt: viewedAt.toISOString(), isFirstVisit: false,
    sinceLastVisit: { newSubmissions, revisedDrafts: liveRevisions + archivedRevisions, adaptiveCompletions },
    current: { waitingForReview }, ackToken: createAckToken(teacher._id, viewedAt)
  };
}

async function acknowledge(teacher, ackToken) {
  const viewedAt = readAckToken(ackToken, teacher._id);
  if (!viewedAt) return null;
  await User.updateOne({ _id: teacher._id, role: 'teacher', $or: [
    { teacherActivityLastViewedAt: { $exists: false } },
    { teacherActivityLastViewedAt: null },
    { teacherActivityLastViewedAt: { $lt: viewedAt } }
  ] }, { $set: { teacherActivityLastViewedAt: viewedAt } });
  return viewedAt;
}

module.exports = { getSummary, acknowledge, createAckToken, readAckToken };
