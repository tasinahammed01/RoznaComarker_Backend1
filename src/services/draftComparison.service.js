const accessContext = require('./submissionAccessContext.service');
const mongoose = require('mongoose');
const crypto = require('crypto');
const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const SubmissionRevision = require('../models/SubmissionRevision');
const { showMarksToStudent } = require('./assignmentAccessPolicy.service');

// Phase B2: every draft is compared on the scores the student was shown (the teacher's final values, when there are any).
const { finalFeedback } = require('./teacherEvaluation.service');
// Draft comparison v2 (DRAFT_COMPARISON_V2_ENABLED, default off): per-error tracking, an honest result when the rubric changed, and a note
// when an earlier draft's snapshot predates the teacher overlay. Off: the payload is exactly the v1 payload.
const v2Enabled = () => String(process.env.DRAFT_COMPARISON_V2_ENABLED || '').trim().toLowerCase() === 'true';
const ISSUES_OVERLAY_MISSING = 'The earlier draft was saved before your teacher\'s changes to its corrections were kept with it, so this list may include corrections your teacher hid.';
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
  if (custom.length) {
    const definitions = Array.isArray(feedback?.sourceRubric?.criteria) ? feedback.sourceRubric.criteria : [];
    const definitionsById = new Map(definitions.map((criterion) => [String(criterion?.id || ''), criterion]));
    const definitionsByTitle = new Map(definitions.map((criterion) => [normalize(criterion?.title), criterion]));
    return custom.map((criterion) => {
      const id = String(criterion.criterionId || '').trim() || null;
      const name = String(criterion.title || '').trim();
      const definition = definitionsById.get(id) || definitionsByTitle.get(normalize(name)) || null;
      const stableId = Boolean(id && (definition?.idSource === 'persisted' || !/^criterion-\d+$/u.test(id)));
      const definitionValue = definition ? {
        title: normalize(definition.title || name),
        weight: number(definition.weight ?? criterion.normalizedWeight ?? criterion.weight),
        description: String(definition.description || '').normalize('NFKC').trim(),
        levels: (definition.levels || []).map((level) => ({
          title: normalize(level?.title), percentage: number(level?.percentage),
          description: String(level?.description || '').normalize('NFKC').trim()
        }))
      } : null;
      const semanticFingerprint = definitionValue
        ? crypto.createHash('sha256').update(JSON.stringify(definitionValue)).digest('hex') : null;
      const comparisonFingerprint = semanticFingerprint ? crypto.createHash('sha256').update(JSON.stringify({
        stableCriterionId: stableId ? id : null, semanticFingerprint
      })).digest('hex') : null;
      return { id, name, key: normalize(name), score: number(criterion.weightedPoints),
        maxScore: number(criterion.normalizedWeight ?? criterion.weight), source: 'custom', stableId,
        semanticFingerprint, comparisonFingerprint };
    }).filter((item) => item.name && item.score != null && item.maxScore != null);
  }
  return Object.entries(feedback?.rubricScores || {}).map(([id, item]) => ({
    id, name: id.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()), key: normalize(id),
    score: number(item?.score), maxScore: number(item?.maxScore), source: 'built_in', stableId: true
  })).filter((item) => item.score != null && item.maxScore != null);
}

function matchCategories(previousFeedback, currentFeedback) {
  const previous = categoryScores(previousFeedback); const current = categoryScores(currentFeedback);
  const used = new Set(); const rows = [];
  const indexes = { stableId: new Map(), legacyIdTitle: new Map(), title: new Map() };
  const add = (map, key, index) => {
    if (!key) return;
    const bucket = map.get(key) || { values: [], cursor: 0 };
    bucket.values.push(index); map.set(key, bucket);
  };
  current.forEach((item, index) => {
    if (item.stableId && item.id) add(indexes.stableId, item.id, index);
    if (!item.stableId && item.id) add(indexes.legacyIdTitle, `${item.id}|${item.key}`, index);
    add(indexes.title, item.key, index);
  });
  const take = (map, key) => {
    const bucket = map.get(key);
    if (!bucket) return -1;
    while (bucket.cursor < bucket.values.length && used.has(bucket.values[bucket.cursor])) bucket.cursor += 1;
    return bucket.cursor < bucket.values.length ? bucket.values[bucket.cursor++] : -1;
  };
  for (const oldItem of previous) {
    let index = oldItem.stableId && oldItem.id ? take(indexes.stableId, oldItem.id) : -1;
    let strategy = 'criterion_id';
    if (index < 0 && !oldItem.stableId && oldItem.id)
      index = take(indexes.legacyIdTitle, `${oldItem.id}|${oldItem.key}`);
    if (index < 0 && !oldItem.stableId) { index = take(indexes.title, oldItem.key); strategy = 'normalized_name'; }
    if (index < 0) {
      rows.push({ categoryId: oldItem.id, name: oldItem.name, previousScore: oldItem.score, currentScore: null,
        delta: null, maxScore: oldItem.maxScore, available: false, reason: 'Criterion is not present in the current rubric.' });
      continue;
    }
    used.add(index); const next = current[index];
    const compatibleScale = oldItem.maxScore === next.maxScore;
    const compatibleDefinition = !(oldItem.semanticFingerprint && next.semanticFingerprint)
      || (oldItem.stableId && next.stableId
        ? oldItem.comparisonFingerprint === next.comparisonFingerprint
        : oldItem.semanticFingerprint === next.semanticFingerprint);
    const available = compatibleScale && compatibleDefinition;
    rows.push({ categoryId: next.id || oldItem.id, name: next.name, previousScore: oldItem.score,
      currentScore: next.score, delta: available ? round(next.score - oldItem.score) : null,
      maxScore: available ? next.maxScore : null, available, matchStrategy: strategy,
      ...(!compatibleScale ? { reason: 'Criterion score scale changed between drafts.' }
        : !compatibleDefinition ? { reason: 'Criterion definition or configured levels changed between drafts.' } : {}) });
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

/** v2 additions to an available comparison: per-error lists (replacing the counts with the matcher's), the rubric-changed rule, the overlay note. */
function withV2(result, previous, current, { overlayMissing = false } = {}) {
  const out = { ...result, comparisonVersion: 2 };
  if (out.rubricChanged) {
    // Scores stay visible; the overall change and any improved/declined claim are withheld.
    out.overall = { ...out.overall, delta: null, status: 'RUBRIC_CHANGED' };
    out.summary = { improved: false, unchanged: false, declined: false, limited: true };
  }
  if (out.issuesAvailable === false || !out.issues) return out;
  const tracked = require('./draftIssueTracking.service').trackIssues({
    previousCorrections: previous.submission.writingCorrections || [], currentCorrections: current.submission.writingCorrections || [],
    previousText: out.previousText, currentText: out.currentText });
  out.issues = { previousCount: (previous.submission.writingCorrections || []).length, currentCount: (current.submission.writingCorrections || []).length,
    correctedCount: tracked.counts.fixed, remainingCount: tracked.counts.remaining, newIssueCount: tracked.counts.new, unclearCount: tracked.counts.unclear };
  out.issueDetails = tracked.lists;
  if (overlayMissing) out.issuesMessage = ISSUES_OVERLAY_MISSING;
  return out;
}

/** options.v2: only the per-submission comparison asks for it (class progress and the weekly summary keep the v1 counts and cost). */
function compareDrafts(previous, current, options = {}) {
  const result = compareDraftsV1(previous, current);
  return options.v2 && v2Enabled() && result.available ? withV2(result, previous, current, options) : result;
}

function compareDraftsV1(previous, current) {
  const ids = { previousSubmissionId: String(previous?.id || ''), currentSubmissionId: String(current?.id || '') };
  if (!isAssessed(current?.submission, current?.feedback)) return unavailable('CURRENT_UNASSESSED', 'Complete the assessment to see improvement.', ids);
  if (!previous) return unavailable('FIRST_DRAFT', 'No previous assessed draft to compare yet.', ids);
  if (!isAssessed(previous.submission, previous.feedback)) return unavailable('PREVIOUS_UNASSESSED', 'Your previous draft has not been assessed yet.', ids);
  const previousScore = number(previous.feedback.overallScore); const currentScore = number(current.feedback.overallScore);
  const identicalContent = Boolean(previous.submission.fileContentIdentity && current.submission.fileContentIdentity
    && previous.submission.fileContentIdentity === current.submission.fileContentIdentity);
  const identicalAssessment = Boolean(previous.feedback.analysisInputHash
    && previous.feedback.analysisInputHash === current.feedback.analysisInputHash);
  if (identicalContent && identicalAssessment && previousScore === currentScore) {
    const rubricCategories = matchCategories(previous.feedback, previous.feedback).map((item) => ({ ...item, delta: 0 }));
    return { available: true, ...ids, identicalContent: true,
      message: 'The submitted files are unchanged from the previous draft.',
      previousDraftNumber: previous.draftNumber, currentDraftNumber: current.draftNumber,
      overall: { previousScore, currentScore: previousScore, delta: 0, status: 'UNCHANGED' },
      rubricCategories, rubricChanged: false, rubricMessage: null,
      issues: { previousCount: (previous.submission.writingCorrections || []).length,
        currentCount: (current.submission.writingCorrections || []).length,
        correctedCount: 0, remainingCount: (current.submission.writingCorrections || []).length, newIssueCount: 0 },
      previousText: submissionText(previous.submission), currentText: submissionText(current.submission),
      summary: { improved: false, unchanged: true, declined: false } };
  }
  const delta = round(currentScore - previousScore);
  const rubricCategories = matchCategories(previous.feedback, current.feedback);
  const rubricChanged = String(previous.submission.evaluationRubricSourceHash || previous.feedback.evaluationRubricSourceHash || '')
    !== String(current.submission.evaluationRubricSourceHash || current.feedback.evaluationRubricSourceHash || '');
  const issuesAvailable = correctionSetReliable(previous.submission) && correctionSetReliable(current.submission);
  return { available: true, ...ids, identicalContent, previousDraftNumber: previous.draftNumber, currentDraftNumber: current.draftNumber,
    overall: { previousScore, currentScore, delta, status: delta > 0 ? 'IMPROVED' : delta < 0 ? 'DECLINED' : 'UNCHANGED' },
    rubricCategories, rubricChanged, rubricMessage: rubricChanged && rubricCategories.some((item) => !item.available)
      ? 'Rubric changed between drafts; category-level comparison is partially unavailable.' : null,
    issuesAvailable,
    issuesMessage: issuesAvailable ? null : 'Correction-level comparison is unavailable because one draft did not complete reliable correction analysis.',
    issues: issuesAvailable ? compareIssues(previous.submission.writingCorrections || [], current.submission.writingCorrections || []) : null,
    previousText: submissionText(previous.submission), currentText: submissionText(current.submission),
    summary: { improved: delta > 0, unchanged: delta === 0, declined: delta < 0 } };
}

/** Submissions or revision snapshots as the student sees them (studentCorrectionView.service). */
async function visibleSubmissions(list, model = 'Submission', { selected = false } = {}) {
  // selected: the query asked for +teacherAnnotations; lean() omits an absent field, which means "no overlay", not "not loaded".
  const withOverlay = selected ? list.map((item) => ('teacherAnnotations' in item ? item : { ...item, teacherAnnotations: null })) : list;
  return (await require('./studentCorrectionView.service').loadStudentCorrectionViews(withOverlay, { model })).map((view) => view.submission);
}

function revisionAssessment(revision) {
  return { id: revision._id, chainId: revision.sourceSubmissionId, assignmentId: revision.assignment,
    assignmentTitle: revision.assignmentTitle || null, draftNumber: revision.draftNumber, submission: revision,
    feedback: finalFeedback(revision.feedbackSnapshot || null, revision), assessedAt: revision.assessmentCompletedAt || revision.feedbackSnapshot?.updatedAt || revision.submittedAt };
}
function liveAssessment(submission, feedback) {
  return { id: submission._id, chainId: submission._id, assignmentId: submission.assignment,
    assignmentTitle: submission.assignmentTitle || null, draftNumber: Number(submission.draftNumber) || 1, submission, feedback: finalFeedback(feedback, submission),
    assessedAt: submission.assessmentCompletedAt || feedback?.updatedAt || submission.submittedAt };
}

async function authorizeSubmission(submission, user) {
  if (accessContext.isGuest(user)) return accessContext.ownsSubmission(submission, user);
  if (user?.role === 'student') return String(submission.student) === String(user._id);
  if (user?.role === 'teacher') return Boolean(await Class.exists({ _id: submission.class, teacher: user._id, isActive: { $ne: false } }));
  return false;
}

/** What a student or guest receives: no revision id and no category matching detail. Teachers get the comparison as computed. */
function forStudent({ previousSubmissionId: _revisionId, ...result }) {
  if (!result.rubricCategories) return result;
  return { ...result, rubricCategories: result.rubricCategories.map(({ matchStrategy: _strategy, ...row }) => row) };
}

/** ?againstDraft=<n> (v2 only): a whole draft number from 1, or null when absent. Anything else is a 400. */
function parseAgainstDraft(value) {
  if (value === undefined || value === null || value === '' || !v2Enabled()) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 1000) throw Object.assign(new Error('Invalid draft number'), { statusCode: 400, code: 'INVALID_DRAFT_NUMBER' });
  return number;
}

/** v2 draft selector: the chain's earlier drafts as the student may see them (number, date, final score). No ids. */
function earlierDraftsOf(revisions, currentDraftNumber) {
  return revisions.filter(r => Number(r.draftNumber) < currentDraftNumber).sort((a, b) => b.draftNumber - a.draftNumber).map(r => {
    const feedback = finalFeedback(r.feedbackSnapshot || null, r);
    return { draftNumber: Number(r.draftNumber), submittedAt: r.submittedAt || null,
      score: isAssessed(r, feedback) ? number(feedback.overallScore) : null };
  });
}

async function comparisonForSubmission(submissionId, user, { againstDraft = null } = {}) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) throw Object.assign(new Error('Invalid submission id'), { statusCode: 400 });
  const submission = await Submission.findById(submissionId).lean();
  if (!submission) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });
  if (!await authorizeSubmission(submission, user)) throw Object.assign(new Error('Submission not found'), { statusCode: 404 });
  const studentView = user?.role === 'student' || accessContext.isGuest(user);
  if (studentView) {
    const assignment = await Assignment.findById(submission.assignment).select('showMarksToStudent').lean();
    if (!showMarksToStudent(assignment)) {
      return unavailable('MARKS_HIDDEN', 'Your teacher has not released marks for this assignment yet.', {
        currentSubmissionId: String(submission._id)
      });
    }
  }
  const [feedback, previousRevision] = await Promise.all([
    SubmissionFeedback.findOne({ submissionId: submission._id }).select('+teacherEvaluation').lean(),
    SubmissionRevision.findOne({ sourceSubmissionId: submission._id,
      draftNumber: againstDraft ? againstDraft : { $lt: Number(submission.draftNumber) || 1 } }).sort({ draftNumber: -1 }).lean()
  ]);
  // A chosen draft must be an earlier draft of this same chain (the lookup is already limited to it).
  if (againstDraft && (!previousRevision || againstDraft >= (Number(submission.draftNumber) || 1))) {
    throw Object.assign(new Error('Draft not found'), { statusCode: 404, code: 'DRAFT_NOT_FOUND' });
  }
  // Both drafts as the student sees them: teacher-hidden corrections are not counted.
  const [current, previous] = await Promise.all([visibleSubmissions([submission]), visibleSubmissions(previousRevision ? [previousRevision] : [], 'SubmissionRevision')]);
  // v2: the earlier draft's snapshot has no overlay although the teacher changed that draft's corrections (snapshots made before overlays
  // were kept with them). Its list falls back to the raw corrections, so it is marked.
  const overlayMissing = v2Enabled() && previousRevision && !('teacherAnnotations' in previousRevision)
    && Boolean(await require('../models/AnnotationAudit').exists({ submissionId: submission._id, draftNumber: Number(previousRevision.draftNumber) }));
  let result = compareDrafts(previous[0] ? revisionAssessment(previous[0]) : null, liveAssessment(current[0], feedback), { v2: true, overlayMissing });
  if (result.comparisonVersion === 2) {
    const revisions = await SubmissionRevision.find({ sourceSubmissionId: submission._id }).select('draftNumber submittedAt evaluationStatus assessmentStatus feedbackSnapshot').lean();
    result = { ...result, earlierDrafts: earlierDraftsOf(revisions, Number(submission.draftNumber) || 1) };
  }
  return studentView ? forStudent(result) : result;
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
  const submissions = await visibleSubmissions(await Submission.find(filter).select('+teacherAnnotations').sort({ submittedAt: 1 }).lean(), 'Submission', { selected: true });
  if (!submissions.length) return { submissions, grouped: new Map() };
  const ids = submissions.map((item) => item._id);
  const assignmentIds = [...new Set(submissions.map((item) => String(item.assignment)).filter(Boolean))];
  const [feedback, revisions, assignments] = await Promise.all([
    SubmissionFeedback.find({ submissionId: { $in: ids } }).select('+teacherEvaluation').lean(),
    SubmissionRevision.find({ sourceSubmissionId: { $in: ids } }).select('+teacherAnnotations').sort({ submittedAt: 1 }).lean().then(list => visibleSubmissions(list, 'SubmissionRevision', { selected: true })),
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

module.exports = { parseAgainstDraft, earlierDraftsOf, v2Enabled, withV2, ISSUES_OVERLAY_MISSING, normalize, issueFingerprint, compareIssues, categoryScores, matchCategories, compareDrafts,
  correctionSetReliable, progressFromHistory, comparisonForSubmission, classProgressSummaries, studentProgress, isAssessed };
