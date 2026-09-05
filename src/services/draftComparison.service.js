const mongoose = require('mongoose');
const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const SubmissionRevision = require('../models/SubmissionRevision');
const { showMarksToStudent } = require('./assignmentAccessPolicy.service');

const normalize = (value) => String(value || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const number = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const round = (value) => Math.round(Number(value) * 100) / 100;

function isAssessed(submission, feedback) {
  return Boolean(feedback && submission
    && String(submission.evaluationStatus || feedback.evaluationStatus) === 'completed'
    && ['complete', 'completed'].includes(String(submission.assessmentStatus || 'complete'))
    && number(feedback.overallScore) != null);
}

function categoryScores(feedback) {
  const custom = Array.isArray(feedback?.customRubricScores?.criteria) ? feedback.customRubricScores.criteria : [];
  if (custom.length) return custom.map((criterion) => ({
    id: String(criterion.criterionId || '').trim() || null,
    name: String(criterion.title || '').trim(), key: normalize(criterion.title),
    score: number(criterion.weightedPoints), maxScore: number(criterion.normalizedWeight ?? criterion.weight), source: 'custom'
  })).filter((item) => item.name && item.score != null && item.maxScore != null);
  return Object.entries(feedback?.rubricScores || {}).map(([id, item]) => ({
    id, name: id.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), key: normalize(id),
    score: number(item?.score), maxScore: number(item?.maxScore), source: 'built_in'
  })).filter((item) => item.score != null && item.maxScore != null);
}

function matchCategories(previousFeedback, currentFeedback) {
  const previous = categoryScores(previousFeedback); const current = categoryScores(currentFeedback);
  const used = new Set(); const rows = [];
  for (const oldItem of previous) {
    let index = current.findIndex((item, candidateIndex) => !used.has(candidateIndex) && oldItem.id && item.id === oldItem.id
      && (oldItem.source === 'built_in' || oldItem.key === item.key));
    let strategy = 'criterion_id';
    if (index < 0) { index = current.findIndex((item, candidateIndex) => !used.has(candidateIndex) && oldItem.key && item.key === oldItem.key); strategy = 'normalized_name'; }
    if (index < 0) {
      rows.push({ categoryId: oldItem.id, name: oldItem.name, previousScore: oldItem.score, currentScore: null,
        delta: null, maxScore: oldItem.maxScore, available: false, reason: 'Criterion is not present in the current rubric.' });
      continue;
    }
    used.add(index); const next = current[index];
    const compatibleScale = oldItem.maxScore === next.maxScore;
    rows.push({ categoryId: next.id || oldItem.id, name: next.name, previousScore: oldItem.score,
      currentScore: next.score, delta: compatibleScale ? round(next.score - oldItem.score) : null,
      maxScore: compatibleScale ? next.maxScore : null, available: compatibleScale, matchStrategy: strategy,
      ...(!compatibleScale ? { reason: 'Criterion score scale changed between drafts.' } : {}) });
  }
  current.forEach((item, index) => { if (!used.has(index)) rows.push({ categoryId: item.id, name: item.name,
    previousScore: null, currentScore: item.score, delta: null, maxScore: item.maxScore, available: false,
    reason: 'Criterion was added in the current rubric.' }); });
  return rows;
}

function issueFingerprint(issue) {
  return [normalize(issue?.canonicalCategory || issue?.category || issue?.groupKey),
    normalize(issue?.symbol || issue?.code || issue?.type), normalize(issue?.quotedText || issue?.originalText)].join('|');
}

function compareIssues(previousIssues = [], currentIssues = []) {
  const currentBuckets = new Map();
  currentIssues.forEach((issue) => { const key = issueFingerprint(issue); if (!key.replace(/\|/g, '')) return;
    const bucket = currentBuckets.get(key) || []; bucket.push(issue); currentBuckets.set(key, bucket); });
  let correctedCount = 0; let remainingCount = 0;
  previousIssues.forEach((issue) => { const bucket = currentBuckets.get(issueFingerprint(issue));
    if (bucket?.length) { bucket.pop(); remainingCount += 1; } else correctedCount += 1; });
  const newIssueCount = [...currentBuckets.values()].reduce((sum, bucket) => sum + bucket.length, 0);
  return { previousCount: previousIssues.length, currentCount: currentIssues.length,
    correctedCount, remainingCount, newIssueCount };
}

function correctionSetReliable(submission) {
  // Historical assessed submissions predate semantic reliability metadata.
  // Preserve their comparison behavior; current pipeline runs must explicitly
  // complete whenever they carry the new status/coverage contract.
  if (!submission?.semanticStatus && !submission?.semanticMetrics?.coverage) return true;
  if (String(submission?.semanticStatus || '') !== 'completed') return false;
  const coverage = submission?.semanticMetrics?.coverage;
  return !coverage || (coverage.coverageComplete === true && Number(coverage.failedChunks || 0) === 0);
}

function unavailable(code, message, ids = {}) {
  return { available: false, code, message, ...ids };
}

function submissionText(submission) {
  const direct = String(submission?.transcriptText || submission?.combinedOcrText || submission?.ocrText || '').trim();
  if (direct) return direct;
  return [...(Array.isArray(submission?.ocrPages) ? submission.ocrPages : [])]
    .sort((a, b) => Number(a?.fileOrder || 0) - Number(b?.fileOrder || 0) || Number(a?.pageNumber || 0) - Number(b?.pageNumber || 0))
    .map((page) => String(page?.text || '').trim()).filter(Boolean).join('\n\n');
}

function compareDrafts(previous, current) {
  const ids = { previousSubmissionId: String(previous?.id || ''), currentSubmissionId: String(current?.id || '') };
  if (!isAssessed(current?.submission, current?.feedback)) return unavailable('CURRENT_UNASSESSED', 'Complete the assessment to see improvement.', ids);
  if (!previous) return unavailable('FIRST_DRAFT', 'No previous assessed draft to compare yet.', ids);
  if (!isAssessed(previous.submission, previous.feedback)) return unavailable('PREVIOUS_UNASSESSED', 'Your previous draft has not been assessed yet.', ids);
  const previousScore = number(previous.feedback.overallScore); const currentScore = number(current.feedback.overallScore);
  const identicalContent = Boolean(previous.submission.fileContentIdentity && current.submission.fileContentIdentity
    && previous.submission.fileContentIdentity === current.submission.fileContentIdentity);
  if (identicalContent) {
    const rubricCategories = matchCategories(previous.feedback, previous.feedback).map((item) => ({ ...item, delta: 0 }));
    return { available: true, ...ids, identicalContent: true,
      message: 'The submitted files are unchanged from the previous draft.',
      previousDraftNumber: previous.draftNumber, currentDraftNumber: current.draftNumber,
      overall: { previousScore, currentScore: previousScore, delta: 0, status: 'UNCHANGED' },
      rubricCategories, rubricChanged: false, rubricMessage: null,
      issues: { previousCount: (previous.submission.writingCorrections || []).length,
        currentCount: (previous.submission.writingCorrections || []).length,
        correctedCount: 0, remainingCount: (previous.submission.writingCorrections || []).length, newIssueCount: 0 },
      previousText: submissionText(previous.submission), currentText: submissionText(current.submission),
      summary: { improved: false, unchanged: true, declined: false } };
  }
  const delta = round(currentScore - previousScore);
  const rubricCategories = matchCategories(previous.feedback, current.feedback);
  const rubricChanged = String(previous.submission.evaluationRubricSourceHash || previous.feedback.evaluationRubricSourceHash || '')
    !== String(current.submission.evaluationRubricSourceHash || current.feedback.evaluationRubricSourceHash || '');
  const issuesAvailable = correctionSetReliable(previous.submission) && correctionSetReliable(current.submission);
  return { available: true, ...ids, previousDraftNumber: previous.draftNumber, currentDraftNumber: current.draftNumber,
    overall: { previousScore, currentScore, delta, status: delta > 0 ? 'IMPROVED' : delta < 0 ? 'DECLINED' : 'UNCHANGED' },
    rubricCategories, rubricChanged, rubricMessage: rubricChanged && rubricCategories.some((item) => !item.available)
      ? 'Rubric changed between drafts; category-level comparison is partially unavailable.' : null,
    issuesAvailable,
    issuesMessage: issuesAvailable ? null : 'Correction-level comparison is unavailable because one draft did not complete reliable correction analysis.',
    issues: issuesAvailable ? compareIssues(previous.submission.writingCorrections || [], current.submission.writingCorrections || []) : null,
    previousText: submissionText(previous.submission), currentText: submissionText(current.submission),
    summary: { improved: delta > 0, unchanged: delta === 0, declined: delta < 0 } };
}

function revisionAssessment(revision) {
  return { id: revision._id, chainId: revision.sourceSubmissionId, assignmentId: revision.assignment,
    assignmentTitle: revision.assignmentTitle || null, draftNumber: revision.draftNumber, submission: revision,
    feedback: revision.feedbackSnapshot || null, assessedAt: revision.assessmentCompletedAt || revision.feedbackSnapshot?.updatedAt || revision.submittedAt };
}
function liveAssessment(submission, feedback) {
  return { id: submission._id, chainId: submission._id, assignmentId: submission.assignment,
    assignmentTitle: submission.assignmentTitle || null, draftNumber: Number(submission.draftNumber) || 1, submission, feedback,
    assessedAt: submission.assessmentCompletedAt || feedback?.updatedAt || submission.submittedAt };
}

async function authorizeSubmission(submission, user) {
  if (user?.role === 'student') return String(submission.student) === String(user._id);
  if (user?.role === 'teacher') return Boolean(await Class.exists({ _id: submission.class, teacher: user._id }));
  return false;
}

async function comparisonForSubmission(submissionId, user) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) throw Object.assign(new Error('Invalid submission id'), { statusCode: 400 });
  const submission = await Submission.findById(submissionId).lean();
  if (!submission) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });
  if (!await authorizeSubmission(submission, user)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  if (user?.role === 'student') {
    const assignment = await Assignment.findById(submission.assignment).select('showMarksToStudent').lean();
    if (!showMarksToStudent(assignment)) {
      return unavailable('MARKS_HIDDEN', 'Your teacher has not released marks for this assignment yet.', {
        currentSubmissionId: String(submission._id), previousSubmissionId: ''
      });
    }
  }
  const [feedback, previousRevision] = await Promise.all([
    SubmissionFeedback.findOne({ submissionId: submission._id }).lean(),
    SubmissionRevision.findOne({ sourceSubmissionId: submission._id, draftNumber: { $lt: Number(submission.draftNumber) || 1 } }).sort({ draftNumber: -1 }).lean()
  ]);
  return compareDrafts(previousRevision ? revisionAssessment(previousRevision) : null, liveAssessment(submission, feedback));
}

function progressFromHistory(entries) {
  const ordered = [...entries].sort((a, b) => new Date(a.assessedAt) - new Date(b.assessedAt));
  const assessed = ordered.filter((entry) => isAssessed(entry.submission, entry.feedback));
  if (!assessed.length) return { latestAssessedScore: null, assessedDraftCount: 0, assignmentsWithRevisions: 0,
    revisionComparisonCount: 0, improvedRevisionCount: 0, unchangedRevisionCount: 0, declinedRevisionCount: 0,
    averageRevisionScoreDelta: null, latestDraftImprovement: null, totalIssuesCorrected: 0,
    strongestImprovedCategory: null, categoriesNeedingAttention: [], lastAssessmentDate: null, draftHistory: [] };
  const comparisonEntries = [];
  const bySubmission = new Map();
  ordered.forEach((entry) => { const key = String(entry.chainId || entry.id); const list = bySubmission.get(key) || []; list.push(entry); bySubmission.set(key, list); });
  bySubmission.forEach((list, chainId) => { list.sort((a, b) => a.draftNumber - b.draftNumber);
    for (let index = 1; index < list.length; index += 1) {
      if (!isAssessed(list[index - 1].submission, list[index - 1].feedback) || !isAssessed(list[index].submission, list[index].feedback)) continue;
      const comparison = compareDrafts(list[index - 1], list[index]);
      if (comparison.available) comparisonEntries.push({ comparison, chainId, assessedAt: list[index].assessedAt });
    }
  });
  const latest = assessed[assessed.length - 1]; const comparisons = comparisonEntries.map((item) => item.comparison);
  const categoryTotals = new Map();
  comparisons.forEach((comparison) => comparison.rubricCategories.filter((item) => item.available).forEach((item) => {
    const current = categoryTotals.get(normalize(item.name)) || { name: item.name, delta: 0 }; current.delta += item.delta; categoryTotals.set(normalize(item.name), current); }));
  const categories = [...categoryTotals.values()].sort((a, b) => b.delta - a.delta);
  const latestComparison = [...comparisonEntries].sort((a, b) => new Date(b.assessedAt) - new Date(a.assessedAt))[0]?.comparison || null;
  const deltaTotal = comparisons.reduce((sum, comparison) => sum + comparison.overall.delta, 0);
  const draftHistory = [...bySubmission.entries()].map(([chainId, list]) => {
    const assessedInChain = list.filter((entry) => isAssessed(entry.submission, entry.feedback));
    if (!assessedInChain.length) return null;
    const sample = assessedInChain[0];
    return { chainId, assignmentId: String(sample.assignmentId || sample.submission?.assignment || ''),
      assignmentTitle: sample.assignmentTitle || null,
      comparisonCount: comparisonEntries.filter((item) => item.chainId === chainId).length,
      drafts: assessedInChain.map((entry) => ({ submissionId: String(entry.id), draftNumber: entry.draftNumber,
        score: number(entry.feedback.overallScore), assessedAt: entry.assessedAt })) };
  }).filter(Boolean).sort((a, b) => new Date(a.drafts[0].assessedAt) - new Date(b.drafts[0].assessedAt));
  return { latestAssessedScore: number(latest.feedback.overallScore), assessedDraftCount: assessed.length,
    assignmentsWithRevisions: draftHistory.filter((chain) => chain.comparisonCount > 0).length,
    revisionComparisonCount: comparisons.length,
    improvedRevisionCount: comparisons.filter((item) => item.overall.delta > 0).length,
    unchangedRevisionCount: comparisons.filter((item) => item.overall.delta === 0).length,
    declinedRevisionCount: comparisons.filter((item) => item.overall.delta < 0).length,
    averageRevisionScoreDelta: comparisons.length ? round(deltaTotal / comparisons.length) : null,
    latestDraftImprovement: latestComparison?.overall?.delta ?? null,
    totalIssuesCorrected: comparisons.reduce((sum, comparison) => sum + Number(comparison.issues?.correctedCount || 0), 0),
    strongestImprovedCategory: categories.find((item) => item.delta > 0) || null,
    categoriesNeedingAttention: categories.filter((item) => item.delta <= 0).map((item) => item.name),
    lastAssessmentDate: latest.assessedAt, draftHistory };
}

async function historiesForFilter(filter) {
  const submissions = await Submission.find(filter).sort({ submittedAt: 1 }).lean();
  if (!submissions.length) return { submissions, grouped: new Map() };
  const ids = submissions.map((item) => item._id);
  const assignmentIds = [...new Set(submissions.map((item) => String(item.assignment)).filter(Boolean))];
  const [feedback, revisions, assignments] = await Promise.all([
    SubmissionFeedback.find({ submissionId: { $in: ids } }).lean(),
    SubmissionRevision.find({ sourceSubmissionId: { $in: ids } }).sort({ submittedAt: 1 }).lean(),
    Assignment.find({ _id: { $in: assignmentIds } }).select('_id title').lean()
  ]);
  const assignmentTitles = new Map(assignments.map((item) => [String(item._id), item.title]));
  const feedbackBySubmission = new Map(feedback.map((item) => [String(item.submissionId), item]));
  const revisionsBySubmission = new Map();
  revisions.forEach((item) => { const key = String(item.sourceSubmissionId); const list = revisionsBySubmission.get(key) || [];
    item.assignmentTitle = assignmentTitles.get(String(item.assignment)) || null;
    list.push(revisionAssessment(item)); revisionsBySubmission.set(key, list); });
  const grouped = new Map();
  submissions.forEach((submission) => { const studentId = String(submission.student); const list = grouped.get(studentId) || [];
    submission.assignmentTitle = assignmentTitles.get(String(submission.assignment)) || null;
    list.push(...(revisionsBySubmission.get(String(submission._id)) || []), liveAssessment(submission, feedbackBySubmission.get(String(submission._id)))); grouped.set(studentId, list); });
  return { submissions, grouped };
}

async function classProgressSummaries(classId) {
  const { grouped } = await historiesForFilter({ class: classId }); const result = new Map();
  grouped.forEach((entries, studentId) => result.set(studentId, progressFromHistory(entries))); return result;
}

async function studentProgress(classId, studentId, user) {
  if (!mongoose.Types.ObjectId.isValid(classId) || !mongoose.Types.ObjectId.isValid(studentId))
    throw Object.assign(new Error('Invalid class or student id'), { statusCode: 400 });
  if (user.role === 'student' && String(user._id) !== String(studentId)) throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
  if (user.role === 'teacher' && !await Class.exists({ _id: classId, teacher: user._id, isActive: true }))
    throw Object.assign(new Error('Class not found'), { statusCode: 404 });
  const filter = { class: classId, student: studentId };
  if (user.role === 'student') {
    const visibleAssignments = await Assignment.find({ class: classId, showMarksToStudent: { $ne: false } }).select('_id').lean();
    filter.assignment = { $in: visibleAssignments.map((item) => item._id) };
  }
  const { grouped } = await historiesForFilter(filter);
  return progressFromHistory(grouped.get(String(studentId)) || []);
}

module.exports = { normalize, issueFingerprint, compareIssues, categoryScores, matchCategories, compareDrafts,
  correctionSetReliable, progressFromHistory, comparisonForSubmission, classProgressSummaries, studentProgress, isAssessed };
