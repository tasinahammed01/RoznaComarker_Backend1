'use strict';

const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const Membership = require('../models/membership.model');
const Submission = require('../models/Submission');
const SubmissionRevision = require('../models/SubmissionRevision');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const AssessmentRun = require('../models/AssessmentRun');
const AdaptivePracticeSession = require('../models/AdaptivePracticeSession');
const User = require('../models/user.model');
const { compareDrafts, normalize } = require('./draftComparison.service');
const teacherActivity = require('./teacherActivity.service');
const { createSmartNotification } = require('./notification.service');
const logger = require('../utils/logger');

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const round = (value) => Math.round(value * 100) / 100;

function resolveWindow(endValue = new Date()) {
  const end = new Date(endValue);
  if (!Number.isFinite(end.getTime())) throw Object.assign(new Error('Invalid weekly summary end date'), { statusCode: 400 });
  const now = Date.now();
  if (end.getTime() > now + 60_000 || end.getTime() < now - 366 * 24 * 60 * 60 * 1000)
    throw Object.assign(new Error('Weekly summary end date is outside the supported range'), { statusCode: 400 });
  return { start: new Date(end.getTime() - WINDOW_MS), end };
}

function assessedEntry(document, feedback, live = false) {
  return { id: document._id, chainId: live ? document._id : document.sourceSubmissionId,
    assignmentId: document.assignment, draftNumber: Number(document.draftNumber) || 1,
    submission: document, feedback: live ? feedback : document.feedbackSnapshot,
    assessedAt: document.assessmentCompletedAt || (live ? feedback?.updatedAt : document.feedbackSnapshot?.updatedAt) || document.submittedAt };
}

async function progressForWindow({ teacherId, classIds, assignmentIds, start, end }) {
  if (!classIds.length || !assignmentIds.length) return { studentsImproved: 0, improvedRevisions: 0,
    averageRevisionScoreDelta: null, issuesCorrected: 0, strongestImprovedCategory: null, improvedByClass: new Map() };
  const scope = { class: { $in: classIds }, assignment: { $in: assignmentIds } };
  const [windowArchives, windowLive] = await Promise.all([
    SubmissionRevision.find({ ...scope, draftNumber: { $gt: 1 }, assessmentCompletedAt: { $gt: start, $lte: end } }).lean(),
    Submission.find({ ...scope, draftNumber: { $gt: 1 }, assessmentCompletedAt: { $gt: start, $lte: end } }).lean()
  ]);
  const chainIds = [...new Set([...windowArchives.map((x) => String(x.sourceSubmissionId)), ...windowLive.map((x) => String(x._id))])];
  if (!chainIds.length) return { studentsImproved: 0, improvedRevisions: 0,
    averageRevisionScoreDelta: null, issuesCorrected: 0, strongestImprovedCategory: null, improvedByClass: new Map() };
  const [roots, archives, feedbacks] = await Promise.all([
    Submission.find({ _id: { $in: chainIds }, ...scope }).lean(),
    SubmissionRevision.find({ sourceSubmissionId: { $in: chainIds } }).sort({ draftNumber: 1 }).lean(),
    SubmissionFeedback.find({ submissionId: { $in: chainIds } }).lean()
  ]);
  const feedbackById = new Map(feedbacks.map((x) => [String(x.submissionId), x]));
  const entriesByChain = new Map(chainIds.map((id) => [id, []]));
  archives.forEach((x) => entriesByChain.get(String(x.sourceSubmissionId))?.push(assessedEntry(x, null, false)));
  roots.forEach((x) => entriesByChain.get(String(x._id))?.push(assessedEntry(x, feedbackById.get(String(x._id)), true)));
  const comparisons = [];
  entriesByChain.forEach((entries) => {
    entries.sort((a, b) => a.draftNumber - b.draftNumber);
    for (let index = 1; index < entries.length; index += 1) {
      const current = entries[index]; const when = new Date(current.assessedAt);
      if (!(when > start && when <= end)) continue;
      const comparison = compareDrafts(entries[index - 1], current);
      if (comparison.available) comparisons.push({ comparison, studentId: String(current.submission.student),
        classId: String(current.submission.class) });
    }
  });
  const improved = comparisons.filter((x) => x.comparison.overall.status === 'IMPROVED');
  const categoryTotals = new Map();
  comparisons.forEach(({ comparison }) => comparison.rubricCategories.filter((x) => x.available).forEach((x) => {
    const key = normalize(x.name); const row = categoryTotals.get(key) || { name: x.name, total: 0, count: 0 };
    row.total += x.delta; row.count += 1; categoryTotals.set(key, row);
  }));
  const strongest = [...categoryTotals.values()].filter((x) => x.count >= 2 && x.total > 0)
    .map((x) => ({ name: x.name, averageDelta: round(x.total / x.count), comparisonCount: x.count }))
    .sort((a, b) => b.averageDelta - a.averageDelta || a.name.localeCompare(b.name))[0] || null;
  const improvedByClass = new Map(); improved.forEach((x) => {
    const set = improvedByClass.get(x.classId) || new Set(); set.add(x.studentId); improvedByClass.set(x.classId, set);
  });
  return { studentsImproved: new Set(improved.map((x) => x.studentId)).size, improvedRevisions: improved.length,
    averageRevisionScoreDelta: comparisons.length ? round(comparisons.reduce((sum, x) => sum + x.comparison.overall.delta, 0) / comparisons.length) : null,
    issuesCorrected: comparisons.reduce((sum, x) => sum + x.comparison.issues.correctedCount, 0),
    strongestImprovedCategory: strongest, improvedByClass };
}

async function getWeeklySummary(teacher, endValue) {
  const { start, end } = resolveWindow(endValue);
  const allClasses = await Class.find({ teacher: teacher._id }).select('_id name status isActive').lean();
  const activeClasses = allClasses.filter((x) => x.isActive !== false && x.status !== 'archived');
  const historicalClassIds = allClasses.map((x) => x._id); const activeClassIds = activeClasses.map((x) => x._id);
  const assignments = historicalClassIds.length ? await Assignment.find({ teacher: teacher._id, class: { $in: historicalClassIds }, isActive: true }).select('_id class').lean() : [];
  const assignmentIds = assignments.map((x) => x._id);
  const activeMemberships = historicalClassIds.length ? await Membership.find({ class: { $in: historicalClassIds }, status: 'active' }).select('class student').lean() : [];
  const memberPairs = new Set(activeMemberships.map((x) => `${x.class}:${x.student}`));
  const validSubmission = (x) => memberPairs.has(`${x.class}:${x.student}`);
  const scope = { class: { $in: historicalClassIds }, assignment: { $in: assignmentIds } };
  const [firstRows, revisionArchives, revisionLive, adaptiveRows, assessmentRows, activityCurrent] = await Promise.all([
    Submission.find({ ...scope, createdAt: { $gt: start, $lte: end } }).select('_id class student').lean(),
    SubmissionRevision.find({ ...scope, draftNumber: { $gt: 1 }, submittedAt: { $gt: start, $lte: end } }).select('_id class student').lean(),
    Submission.find({ ...scope, draftNumber: { $gt: 1 }, submittedAt: { $gt: start, $lte: end } }).select('_id class student').lean(),
    AdaptivePracticeSession.find({ assignmentId: { $in: assignmentIds }, completedAt: { $gt: start, $lte: end } }).select('_id submissionId').lean(),
    AssessmentRun.find({ teacherId: teacher._id, assignmentId: { $in: assignmentIds }, status: 'complete', completedAt: { $gt: start, $lte: end } }).select('_id submissionId').lean(),
    teacherActivity.getSummary(teacher)
  ]);
  const relatedIds = [...new Set([...adaptiveRows, ...assessmentRows].map((x) => String(x.submissionId)))];
  const related = relatedIds.length ? await Submission.find({ _id: { $in: relatedIds }, ...scope }).select('_id class student').lean() : [];
  const relatedById = new Map(related.filter(validSubmission).map((x) => [String(x._id), x]));
  const first = firstRows.filter(validSubmission); const revisions = [...revisionArchives, ...revisionLive].filter(validSubmission);
  const adaptive = adaptiveRows.filter((x) => relatedById.has(String(x.submissionId)));
  const assessments = [...new Map(assessmentRows.filter((x) => relatedById.has(String(x.submissionId)))
    .map((x) => [String(x.submissionId), x])).values()];
  const progress = await progressForWindow({ teacherId: teacher._id, classIds: historicalClassIds, assignmentIds, start, end });
  const classStats = new Map(allClasses.map((x) => [String(x._id), { id: String(x._id), name: x.name,
    newSubmissions: 0, revisedDrafts: 0, adaptiveCompletions: 0, successfulAssessments: 0,
    waitingForReview: 0, studentsImproved: progress.improvedByClass.get(String(x._id))?.size || 0 }]));
  first.forEach((x) => classStats.get(String(x.class)).newSubmissions += 1);
  revisions.forEach((x) => classStats.get(String(x.class)).revisedDrafts += 1);
  adaptive.forEach((x) => classStats.get(String(relatedById.get(String(x.submissionId)).class)).adaptiveCompletions += 1);
  assessments.forEach((x) => classStats.get(String(relatedById.get(String(x.submissionId)).class)).successfulAssessments += 1);
  // Current pending class counts use the same active-scope definition as teacherActivity.
  const activeAssignmentIds = assignments.filter((x) => activeClassIds.some((id) => String(id) === String(x.class))).map((x) => x._id);
  const pending = activeAssignmentIds.length ? await Submission.aggregate([{ $match: { class: { $in: activeClassIds }, assignment: { $in: activeAssignmentIds } } },
    { $lookup: { from: Membership.collection.name, let: { s: '$student', c: '$class' }, pipeline: [{ $match: { $expr: { $and: [{ $eq: ['$student', '$$s'] }, { $eq: ['$class', '$$c'] }, { $eq: ['$status', 'active'] }] } } }], as: '_m' } },
    { $match: { '_m.0': { $exists: true } } },
    { $lookup: { from: SubmissionFeedback.collection.name, localField: '_id', foreignField: 'submissionId', as: '_f' } },
    { $match: { $or: [{ '_f.0': { $exists: false } }, { '_f.teacherReviewedAt': { $exists: false } }, { '_f.teacherReviewedAt': null }] } },
    { $group: { _id: '$class', count: { $sum: 1 } } }]) : [];
  pending.forEach((x) => { const row = classStats.get(String(x._id)); if (row) row.waitingForReview = x.count; });
  const classes = [...classStats.values()].filter((x) => x.newSubmissions || x.revisedDrafts || x.adaptiveCompletions || x.successfulAssessments || x.waitingForReview || x.studentsImproved);
  return { window: { start: start.toISOString(), end: end.toISOString(), label: 'Previous 7 days' },
    headline: first.length || revisions.length || progress.studentsImproved
      ? `This week: ${first.length} ${first.length === 1 ? 'submission' : 'submissions'}, ${revisions.length} revised ${revisions.length === 1 ? 'draft' : 'drafts'}, and ${progress.studentsImproved} ${progress.studentsImproved === 1 ? 'student improved' : 'students improved'}.`
      : 'Quiet week — no new student submissions yet.',
    activity: { newSubmissions: first.length, revisedDrafts: revisions.length, adaptiveCompletions: adaptive.length, successfulAssessments: assessments.length },
    progress: { studentsImproved: progress.studentsImproved, improvedRevisions: progress.improvedRevisions,
      averageRevisionScoreDelta: progress.averageRevisionScoreDelta, issuesCorrected: progress.issuesCorrected,
      strongestImprovedCategory: progress.strongestImprovedCategory },
    current: { waitingForReview: activityCurrent.current.waitingForReview,
      classesWithPendingReview: pending.length }, classes };
}

async function digestEnabled() { return (await require('./retentionSettings.service').getWeeklySummaryConfig()).enabled; }
function localScheduleParts(now, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long', hour: '2-digit',
    hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}
function scheduledSlotEnd(now, config) {
  const local = localScheduleParts(now, config.timezone);
  const target = { year: Number(local.year), month: Number(local.month), day: Number(local.day),
    hour: config.hour, minute: 0, second: 0 };
  let utc = Date.UTC(target.year, target.month - 1, target.day, target.hour, 0, 0);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const shownParts = new Intl.DateTimeFormat('en-US', { timeZone: config.timezone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utc));
    const shown = Object.fromEntries(shownParts.map((part) => [part.type, part.value]));
    const shownAsUtc = Date.UTC(Number(shown.year), Number(shown.month) - 1, Number(shown.day),
      Number(shown.hour), Number(shown.minute), Number(shown.second));
    const adjustment = Date.UTC(target.year, target.month - 1, target.day, target.hour, 0, 0) - shownAsUtc;
    utc += adjustment;
    if (!adjustment) break;
  }
  return new Date(utc);
}
async function digestScheduleDue(now = new Date()) {
  const config = await require('./retentionSettings.service').getWeeklySummaryConfig();
  if (!config.enabled || !config.day || !Number.isInteger(config.hour) || !config.timezone) return false;
  try { const local = localScheduleParts(now, config.timezone);
    return local.weekday === config.day && Number(local.hour) === config.hour;
  } catch { return false; }
}
async function deliverWeeklyDigest(teacher, endValue) {
  if (!(await digestEnabled())) return { status: 'disabled' };
  const summary = await getWeeklySummary(teacher, endValue); const { start, end } = summary.window;
  const notification = await createSmartNotification({ recipientId: teacher._id, type: 'weekly_summary',
    category: 'WORKFLOW', priority: 'NORMAL', title: 'Your weekly teaching summary',
    description: `${summary.activity.newSubmissions} submissions, ${summary.activity.revisedDrafts} revised drafts, ${summary.progress.studentsImproved} students improved, and ${summary.current.waitingForReview} currently waiting for review.`,
    idempotencyKey: `weekly-summary:${teacher._id}:${start}:${end}`, data: { windowStart: start, windowEnd: end,
      route: { path: '/teacher/dashboard', queryParams: { weeklySummary: 'true', end } } } });
  return { status: 'delivered', notification, summary };
}
async function runWeeklyDigest(endValue) {
  const now = endValue ? new Date(endValue) : new Date();
  const config = await require('./retentionSettings.service').getWeeklySummaryConfig();
  if (!config.enabled) return { status: 'disabled', delivered: 0 };
  if (!(await digestScheduleDue(now))) return { status: 'not_due', delivered: 0 };
  const canonicalEnd = scheduledSlotEnd(now, config);
  const teachers = await User.find({ role: 'teacher' }).select('_id role').lean(); let delivered = 0;
  for (const teacher of teachers) { try { await deliverWeeklyDigest(teacher, canonicalEnd); delivered += 1; }
    catch (error) { logger.error({ event: 'weekly_summary_delivery_failed', teacherId: String(teacher._id), errorCode: error?.code || 'DELIVERY_FAILED' }); } }
  return { status: 'complete', delivered };
}

module.exports = { WINDOW_MS, resolveWindow, getWeeklySummary, progressForWindow, digestEnabled, localScheduleParts,
  scheduledSlotEnd, digestScheduleDue, deliverWeeklyDigest, runWeeklyDigest };
