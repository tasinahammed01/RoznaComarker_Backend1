'use strict';
// Whole-assignment report (teacher only): already-computed numbers for one essay assignment, never raw submissions.
//
// Loading rules (production safety):
//   - ONE submission query by { assignment, class } with an inclusion projection of light fields only: no ocrPages text or per-word
//     data, no transcripts, no OCR text, no annotations, no correction text (only each correction's id, symbol, category and source).
//   - NO database sort (MongoServerError 292, in-memory sort limit). Rows are sorted here; at most SCAN_CAP rows are read and reaching
//     the cap is logged with ids and a code only.
//   - Feedback by the unique submissionId index in batches; names from User.displayName only. Never an email, anywhere.
//   - A bad row is skipped and counted, never fails the report.
//
// Score rule = the teacher dashboard's rule: GET /api/feedback/:id builds the canonical result state from the teacher's final values
// (teacherEvaluation.finalFeedback) and the assignment's current evaluation settings, and the dashboard counts a score only when that
// state says 'completed'. The same functions are called here. Unscored submissions never count as 0.
//
// Error counts are the stored AI analysis counts (they may include items the teacher removed); the page says so.
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const sourceFidelity = require('../utils/sourceFidelity');
const { buildCanonicalResultState } = require('./canonicalResultState.service');

const REPORT_VERSION = 'assignment-report-v1';
const SCAN_CAP = 3000;
const FEEDBACK_BATCH = 500;
const TOP_SYMBOLS = 8;
const MAX_TIMELINE_DAYS = 92;
const MAX_NAME_LENGTH = 120;
const FALLBACK_NAME = 'Student';
const NOT_SCORED = 'NOT_SCORED';
const LOW_SCORE = 'LOW_SCORE';

const BUILTIN = Object.freeze([['CONTENT', 'Content'], ['ORGANIZATION', 'Organization'], ['GRAMMAR', 'Grammar'],
  ['VOCABULARY', 'Vocabulary'], ['MECHANICS', 'Mechanics'], ['PRESENTATION', 'Presentation']]);
const ERROR_CATEGORIES = Object.freeze([['CONTENT', 'Content'], ['ORGANIZATION', 'Organization'], ['GRAMMAR', 'Grammar'],
  ['VOCABULARY', 'Vocabulary'], ['MECHANICS', 'Mechanics']]);
const BANDS = Object.freeze([[0, 49], [50, 59], [60, 69], [70, 79], [80, 89], [90, 100]]);

// Exactly what the canonical result state reads (canonicalResultState, correctionStageRetry, sourceFidelity status checks), plus identity
// and dates. Page-level source fields are statuses and hashes only, never page text.
const SUBMISSION_FIELDS = Object.freeze(['_id', 'student', 'submissionMode', 'guest.displayName', 'teacherUpload.uploadedBy', 'teacherUpload.typedName',
  'status', 'submittedAt', 'createdAt', 'isLate', 'draftNumber',
  'ocrStatus', 'ocrErrorCode', 'assessmentStatus', 'assessmentCompletedAt',
  'correctionStatus', 'correctionError', 'correctionRetry', 'correctionSourceHash', 'correctionStatistics', 'correctionTranscriptLayoutVersion',
  'evaluationStatus', 'evaluationError', 'evaluationErrorCode', 'evaluationJobId', 'evaluationPolicyHash', 'evaluationRubricSourceHash', 'evaluationVersion',
  'semanticStatus', 'semanticAttempt', 'semanticMaxAttempts', 'semanticMetrics.coverage', 'semanticNextRetryAt', 'semanticErrorCode',
  'writingCorrections.id', 'writingCorrections.symbol', 'writingCorrections.category', 'writingCorrections.source',
  'sourceFidelityMode', 'sourceFidelityStatus', 'sourceTranscriptSha256', 'sourceHumanReviewSummary.required', 'files', 'file',
  'ocrPages.fileId', 'ocrPages.fileOrder', 'ocrPages.pageIndex', 'ocrPages.sourceFidelityMode', 'ocrPages.sourceFidelityVersion',
  'ocrPages.sourceFidelityStatus', 'ocrPages.sourceVerificationStage', 'ocrPages.sourceHumanReceiptHash', 'ocrPages.sourceHumanReviewUnresolved',
  'ocrPages.sourceVerificationSummary.unresolvedTargetedCount', 'ocrPages.sourceTextSha256']);
// What the score rule and the rubric averages read. No comments, no detailed feedback text.
const FEEDBACK_FIELDS = Object.freeze(['submissionId', 'overallScore', 'grade', 'evaluationStatus', 'evaluationSource', 'evaluationSourceHash',
  'evaluationRubricSourceHash', 'evaluationPolicyHash', 'assessmentVersion', 'evaluationVersion', 'overriddenByTeacher', 'teacherReviewedAt',
  ...BUILTIN.flatMap(([key]) => [`rubricScores.${key}.score`, `rubricScores.${key}.maxScore`]),
  'customRubricScores.overallScore', 'customRubricScores.criteria.criterionId', 'customRubricScores.criteria.title',
  'customRubricScores.criteria.configuredLevelPercentage', 'customRubricScores.criteria.percentage',
  'teacherEvaluation.draftNumber', ...BUILTIN.map(([key]) => `teacherEvaluation.criteria.${key}.score`)]);

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const isObjectId = value => value instanceof mongoose.Types.ObjectId || (typeof value === 'string' && /^[a-f0-9]{24}$/i.test(value));
const idString = value => (isObjectId(value) ? String(value) : null);
const finite = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const round1 = value => Math.round(value * 10) / 10;
const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const CONTROL = /[\u0000-\u001F\u007F]/gu;

/** A real IANA time zone, else 'UTC'. Never throws. */
function safeTimeZone(value) {
  if (typeof value !== 'string') return 'UTC';
  const zone = value.trim();
  if (!zone || zone.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/u.test(zone)) return 'UTC';
  try { return new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  const name = value.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  // Never an email address, even when someone typed one as a name.
  if (!name || /@/u.test(name)) return '';
  return name.slice(0, MAX_NAME_LENGTH);
}
/** displayName (class member), guest.displayName or teacherUpload.typedName; otherwise "Student". Never an email. */
function displayNameOf(row, user) {
  const candidates = row.submissionMode === 'guest'
    ? [row.guest?.displayName, row.teacherUpload?.typedName]
    : [user?.displayName, row.teacherUpload?.typedName, row.guest?.displayName];
  for (const candidate of candidates) { const name = cleanName(candidate); if (name) return name; }
  return FALLBACK_NAME;
}
const sourceOf = row => (row.teacherUpload && row.teacherUpload.uploadedBy ? 'teacher_upload' : row.submissionMode === 'guest' ? 'guest' : 'class');

/**
 * sourceFidelity.eligible() without page text: every verification status rule is the real one; only the text-against-hash integrity check
 * is assumed (pages must carry a stored text hash). Differs from the result page only for corrupted stored text.
 */
function sourceStatusEligible(doc) {
  if (!sourceFidelity.isExact(doc)) return true;
  const pages = Array.isArray(doc.ocrPages) ? doc.ocrPages.filter(p => p && typeof p === 'object') : [];
  if (!pages.length || !/^[a-f0-9]{64}$/u.test(String(doc.sourceTranscriptSha256 || ''))
    || !pages.every(p => /^[a-f0-9]{64}$/u.test(String(p.sourceTextSha256 || '')))) return false;
  const ordered = pages.slice().sort((a, b) => a.fileOrder - b.fileOrder || a.pageIndex - b.pageIndex);
  // Placeholder text on purpose: the report never loads page text, so the stored-text-vs-hash integrity check is intentionally skipped.
  // In the rare case where stored page text no longer matches its own hash, a score may count here while the dashboard would not.
  const placeholders = ordered.map((_, i) => `page-${i}`);
  const transcript = placeholders.join(sourceFidelity.PAGE_SEPARATOR);
  const probe = { ...doc, sourceTranscriptExact: transcript, sourceTranscriptSha256: sourceFidelity.sha(transcript),
    ocrPages: ordered.map((p, i) => ({ ...p, sourceTextExact: placeholders[i], sourceTextSha256: sourceFidelity.sha(placeholders[i]) })) };
  return sourceFidelity.eligible(probe);
}
/** The submission as the canonical result state should see it: exact-source rows are decided by their statuses here. */
function stateInput(row) {
  if (!sourceFidelity.isExact(row)) return row;
  if (sourceStatusEligible(row)) { const { sourceFidelityMode: _mode, ...rest } = row; return rest; }
  return row;   // not eligible: canonicalState answers 'blocked' for it (it never reads text on that path for the report's purposes)
}

const dayFormatters = new Map();
function dayKey(date, timeZone) {
  if (!dayFormatters.has(timeZone)) dayFormatters.set(timeZone, new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }));
  return dayFormatters.get(timeZone).format(date);
}
const DAY_MS = 86400000;
const keyTime = key => Date.parse(`${key}T00:00:00Z`);
const timeKey = time => new Date(time).toISOString().slice(0, 10);
const mondayOf = key => { const t = keyTime(key); const weekday = (new Date(t).getUTCDay() + 6) % 7; return timeKey(t - weekday * DAY_MS); };
/** Submissions per day in the teacher's zone, gaps filled with 0; a span over MAX_TIMELINE_DAYS becomes weeks (Monday dates). */
function timelineOf(dates, timeZone) {
  const keys = dates.map(d => dayKey(d, timeZone));
  if (!keys.length) return { granularity: 'day', points: [] };
  let granularity = 'day';
  let first = keys.reduce((a, b) => (a < b ? a : b)), last = keys.reduce((a, b) => (a > b ? a : b));
  let bucket = key => key, step = DAY_MS;
  if ((keyTime(last) - keyTime(first)) / DAY_MS + 1 > MAX_TIMELINE_DAYS) {
    granularity = 'week'; bucket = mondayOf; step = 7 * DAY_MS; first = mondayOf(first); last = mondayOf(last);
  }
  const counts = new Map();
  for (const key of keys) counts.set(bucket(key), (counts.get(bucket(key)) || 0) + 1);
  const points = [];
  for (let t = keyTime(first); t <= keyTime(last); t += step) points.push({ date: timeKey(t), count: counts.get(timeKey(t)) || 0 });
  return { granularity, points };
}

function median(sorted) {
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : round1((sorted[mid - 1] + sorted[mid]) / 2);
}
function bandOf(score) {
  if (score === null) return null;
  return score >= 80 ? 'on_track' : score >= 60 ? 'needs_revision' : 'needs_attention';
}
const bandIndex = score => BANDS.findIndex(([, max], i) => i === BANDS.length - 1 || score < max + 1);

function legendIndex(legend) {
  const symbols = new Map(), categories = new Map();
  for (const group of legend?.groups || []) {
    const key = String(group?.key || '').toUpperCase();
    if (key) categories.set(key, { color: String(group?.color || '') });
    for (const item of group?.symbols || []) {
      const symbol = String(item?.symbol || '').toUpperCase();
      if (symbol) symbols.set(symbol, { label: cleanName(item?.label) || symbol, category: key });
    }
  }
  return { symbols, categories };
}

/** One row of the report, or throws (the caller skips and counts it). */
function rowOf(row, { feedback, user, currentSettings, finalFeedback }) {
  const final = feedback ? finalFeedback(feedback, row) : null;
  const state = buildCanonicalResultState({ submission: stateInput(row), feedback: final, currentSettings });
  const score = state.evaluationStatus === 'completed' ? finite(state.score) : null;
  const assessment = score !== null ? 'scored' : state.processingActive ? 'in_progress' : 'not_scored';
  const symbols = new Map();
  if (state.statistics && Array.isArray(row.writingCorrections)) {
    for (const c of row.writingCorrections) {
      const symbol = c && typeof c === 'object' && typeof c.symbol === 'string' ? c.symbol.trim().toUpperCase().slice(0, 16) : '';
      if (symbol) symbols.set(symbol, { count: (symbols.get(symbol)?.count || 0) + 1, category: String(c.category || '').toUpperCase() });
    }
  }
  const statistics = state.statistics && typeof state.statistics === 'object' ? state.statistics : null;
  const submittedAt = [row.submittedAt, row.createdAt].map(v => (v instanceof Date ? v : null)).find(d => d && Number.isFinite(d.getTime())) || null;
  const attentionReasons = assessment === 'not_scored' && ['failed', 'blocked'].includes(state.evaluationStatus) ? [NOT_SCORED]
    : score !== null && score < 60 ? [LOW_SCORE] : [];
  return { submissionId: String(row._id), name: displayNameOf(row, user), source: sourceOf(row), score, band: bandOf(score), assessment,
    notScoredReason: assessment === 'not_scored' ? String(state.evaluationStatus || 'unknown').toUpperCase() : null,
    reviewed: Boolean(feedback?.teacherReviewedAt), submittedAt, isLate: row.isLate === true || row.status === 'late',
    draftNumber: Math.max(1, Number(row.draftNumber) || 1), needsAttention: attentionReasons.length > 0, attentionReasons,
    _symbols: symbols, _statistics: statistics, _feedback: score !== null ? final : null };
}

function rubricOf(rows, currentSettings) {
  const custom = Boolean(currentSettings?.hasValidCustomRubric);
  const acc = new Map();
  const add = (key, label, value) => {
    if (value === null) return;
    const entry = acc.get(key) || { key, label, sum: 0, count: 0 };
    entry.sum += value; entry.count += 1; acc.set(key, entry);
  };
  for (const row of rows) {
    const fb = row._feedback;
    if (!fb) continue;
    if (custom) {
      for (const c of Array.isArray(fb.customRubricScores?.criteria) ? fb.customRubricScores.criteria : []) {
        const key = String(c?.criterionId || c?.title || '').slice(0, 80);
        const value = finite(c?.configuredLevelPercentage) ?? finite(c?.percentage);
        if (key) add(key, cleanName(c?.title) || key, value === null ? null : Math.max(0, Math.min(100, value)));
      }
    } else {
      for (const [key, label] of BUILTIN) {
        const item = fb.rubricScores?.[key];
        const score = finite(item?.score), max = finite(item?.maxScore);
        add(key, label, score !== null && max ? Math.max(0, Math.min(100, (score / max) * 100)) : null);
      }
    }
  }
  const criteria = [...acc.values()].map(e => ({ key: e.key, label: e.label, averagePct: Math.round(e.sum / e.count), count: e.count }));
  let strongest = null, weakest = null;
  for (const c of criteria) {
    if (!strongest || c.averagePct > strongest.averagePct) strongest = c;
    if (!weakest || c.averagePct < weakest.averagePct) weakest = c;
  }
  const spread = strongest && weakest && strongest.averagePct !== weakest.averagePct;
  return { kind: custom ? 'custom' : 'builtin', criteria, strongestKey: spread ? strongest.key : null, weakestKey: spread ? weakest.key : null };
}

function errorsOf(rows, legend) {
  const index = legendIndex(legend);
  const categoryCounts = Object.fromEntries(ERROR_CATEGORIES.map(([key]) => [key, 0]));
  const symbolCounts = new Map();
  let withCorrections = 0;
  for (const row of rows) {
    if (row._statistics) {
      let any = false;
      for (const [key] of ERROR_CATEGORIES) {
        const n = Math.max(0, Math.floor(Number(row._statistics[key.toLowerCase()]) || 0));
        categoryCounts[key] += n; if (n) any = true;
      }
      if (any) withCorrections += 1;
    }
    for (const [symbol, { count, category }] of row._symbols) {
      const entry = symbolCounts.get(symbol) || { count: 0, category };
      entry.count += count; symbolCounts.set(symbol, entry);
    }
  }
  const total = Object.values(categoryCounts).reduce((a, b) => a + b, 0);
  const symbolTotal = [...symbolCounts.values()].reduce((a, b) => a + b.count, 0);
  const categories = ERROR_CATEGORIES.map(([key, label]) => ({ key, label, color: index.categories.get(key)?.color || null,
    count: categoryCounts[key], pct: pct(categoryCounts[key], total) ?? 0 }));
  const symbols = [...symbolCounts.entries()]
    .sort(([a, x], [b, y]) => y.count - x.count || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, TOP_SYMBOLS)
    .map(([symbol, { count, category }]) => {
      const meta = index.symbols.get(symbol);
      return { symbol, label: meta?.label || symbol, category: meta?.category || category || null, count, pct: pct(count, symbolTotal) ?? 0 };
    });
  return { basis: 'ai_analysis', total, symbolTotal, submissionsWithCorrections: withCorrections, categories, symbols };
}

function topIssueOf(row, legend) {
  const index = legendIndex(legend);
  let best = null;
  for (const [symbol, { count }] of row._symbols) if (!best || count > best.count || (count === best.count && symbol < best.symbol)) best = { symbol, count };
  if (best) return { symbol: best.symbol, label: index.symbols.get(best.symbol)?.label || best.symbol, count: best.count };
  return null;
}

/** Deterministic sentences built only from the report's own numbers. Also the fallback when the AI summary is unavailable. */
function buildInsights(report) {
  const { counts, scores, errors, rubric } = report;
  if (!counts.total) return [{ code: 'NO_SUBMISSIONS', text: 'No submissions yet. The report fills in as students submit.' }];
  const out = [];
  const push = (code, text) => out.push({ code, text });
  if (scores.average !== null) push('AVERAGE', `The average score is ${scores.average}% across ${plural(counts.scored, 'scored submission', 'scored submissions')}.`);
  else push('NO_SCORES', 'No submission has a score yet.');
  const top = errors.total > 0 ? errors.categories.reduce((a, b) => (b.count > a.count ? b : a)) : null;
  if (top && top.count > 0) push('TOP_ERROR_CATEGORY', `${top.label} errors are the most common issue (${top.pct}% of ${plural(errors.total, 'correction', 'corrections')}).`);
  if (scores.needsAttention > 0) push('LOW_SCORES', `${plural(scores.needsAttention, 'student', 'students')} scored below 60%.`);
  if (scores.needsRevision > 0) push('NEEDS_REVISION', `${plural(scores.needsRevision, 'student', 'students')} scored between 60% and 79%.`);
  const strongest = rubric.criteria.find(c => c.key === rubric.strongestKey), weakest = rubric.criteria.find(c => c.key === rubric.weakestKey);
  if (strongest && weakest) push('RUBRIC_RANGE', `Strongest area: ${strongest.label} (${strongest.averagePct}%). Weakest area: ${weakest.label} (${weakest.averagePct}%).`);
  if (counts.notScored > 0) push('NOT_SCORED', `${plural(counts.notScored, 'submission', 'submissions')} could not be scored.`);
  if (counts.inProgress > 0) push('IN_PROGRESS', `${plural(counts.inProgress, 'submission is', 'submissions are')} still being assessed.`);
  const awaiting = report.students.filter(s => s.assessment === 'scored' && !s.reviewed).length;
  if (awaiting > 0) push('AWAITING_REVIEW', `${plural(awaiting, 'scored submission is', 'scored submissions are')} waiting for your review.`);
  else if (counts.scored > 0 && counts.reviewed >= counts.total) push('ALL_REVIEWED', 'You have reviewed every submission.');
  const priority = ['AVERAGE', 'NO_SCORES', 'TOP_ERROR_CATEGORY', 'LOW_SCORES', 'RUBRIC_RANGE', 'NOT_SCORED', 'AWAITING_REVIEW', 'ALL_REVIEWED', 'IN_PROGRESS', 'NEEDS_REVISION'];
  return out.sort((a, b) => priority.indexOf(a.code) - priority.indexOf(b.code)).slice(0, 7);
}

/** Pure: the report from loaded light rows. */
function buildReport({ assignment, classDoc, rows, feedbackById, usersById, currentSettings, legend, timeZone, skipped = {}, capped = false,
  finalFeedback = require('./teacherEvaluation.service').finalFeedback, now = new Date() }) {
  const reasons = { ...skipped };
  const built = [];
  for (const row of rows) {
    try {
      built.push(rowOf(row, { feedback: feedbackById.get(String(row._id)) || null, user: usersById.get(idString(row.student)) || null, currentSettings, finalFeedback }));
    } catch {
      reasons.ROW_FAILED = (reasons.ROW_FAILED || 0) + 1;
    }
  }
  built.sort((a, b) => ((b.submittedAt?.getTime() ?? -Infinity) - (a.submittedAt?.getTime() ?? -Infinity)) || (a.submissionId < b.submissionId ? 1 : -1));

  const scored = built.filter(r => r.score !== null);
  const sortedScores = scored.map(r => r.score).sort((a, b) => a - b);
  const bySource = { class: 0, guest: 0, teacherUpload: 0 };
  for (const r of built) bySource[r.source === 'teacher_upload' ? 'teacherUpload' : r.source] += 1;
  const counts = { total: built.length, bySource, scored: scored.length,
    inProgress: built.filter(r => r.assessment === 'in_progress').length, notScored: built.filter(r => r.assessment === 'not_scored').length,
    reviewed: built.filter(r => r.reviewed).length, late: built.filter(r => r.isLate).length,
    skippedRows: Object.values(reasons).reduce((a, b) => a + b, 0), capped: Boolean(capped) };
  const onTrack = scored.filter(r => r.band === 'on_track').length, needsRevision = scored.filter(r => r.band === 'needs_revision').length,
    needsAttention = scored.filter(r => r.band === 'needs_attention').length;
  const bands = BANDS.map(([min, max]) => ({ key: `${min}-${max}`, label: `${min}-${max}`, min, max, count: 0 }));
  for (const s of sortedScores) bands[bandIndex(s)].count += 1;
  const scores = { average: scored.length ? round1(sortedScores.reduce((a, b) => a + b, 0) / scored.length) : null,
    median: median(sortedScores), highest: scored.length ? sortedScores[sortedScores.length - 1] : null, lowest: scored.length ? sortedScores[0] : null,
    bands, onTrack, needsRevision, needsAttention,
    // "Needing revision" = every scored submission under 80 (60-79 needs revision, under 60 needs attention).
    needsRevisionPct: pct(needsRevision + needsAttention, scored.length), needsAttentionPct: pct(needsAttention, scored.length),
    reviewedPct: pct(counts.reviewed, counts.total) };

  const report = {
    version: REPORT_VERSION, generatedAt: now.toISOString(), timeZone,
    assignment: { id: String(assignment._id), title: cleanName(assignment.title) || 'Untitled assignment', className: cleanName(classDoc?.name) || '',
      deadline: assignment.deadline instanceof Date && Number.isFinite(assignment.deadline.getTime()) ? assignment.deadline.toISOString() : null,
      writingType: cleanName(assignment.writingType) || null },
    counts, scores, rubric: rubricOf(built, currentSettings), errors: errorsOf(built, legend),
    timeline: timelineOf(built.map(r => r.submittedAt).filter(Boolean), timeZone),
    students: built.map(r => ({ submissionId: r.submissionId, name: r.name, source: r.source, score: r.score, band: r.band, assessment: r.assessment,
      notScoredReason: r.notScoredReason, reviewed: r.reviewed, topIssue: topIssueOf(r, legend), submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      isLate: r.isLate, draftNumber: r.draftNumber, needsAttention: r.needsAttention, attentionReasons: r.attentionReasons })),
    smallData: { distributionHidden: scored.length < 3, timelineHidden: built.length < 3 }
  };
  report.insights = buildInsights(report);
  return { report, skippedReasons: reasons };
}

/** Owner check, light loads, then buildReport. Throws 404 (not the owner / archived / missing) or 409 (not an essay assignment). */
async function loadAssignmentReport(options) {
  return (await loadReportWithStoredSummary(options)).report;
}

/**
 * The report plus the stored AI summary record (teacher-only field, select:false). report.summary is the summary block the page and PDF use:
 * disabled / not enough data / none / fresh / stale (see assignmentReportSummary.service). The stored record itself is only returned to the
 * summary service, never in a response.
 */
async function loadReportWithStoredSummary({ teacherId, assignmentId, timeZone: requestedZone, env = process.env, now = new Date() }) {
  if (!isObjectId(String(assignmentId || '')) || !isObjectId(String(teacherId || ''))) throw fail(404, 'ASSIGNMENT_NOT_FOUND');
  const Assignment = require('../models/assignment.model'), Class = require('../models/class.model'), Submission = require('../models/Submission');
  const SubmissionFeedback = require('../models/SubmissionFeedback'), User = require('../models/user.model');
  const timeZone = safeTimeZone(requestedZone);
  const assignment = await Assignment.findOne({ _id: assignmentId, teacher: teacherId, isActive: true }).select('+reportSummary').lean();
  if (!assignment) throw fail(404, 'ASSIGNMENT_NOT_FOUND');
  const classDoc = await Class.findOne({ _id: assignment.class, teacher: teacherId, isActive: true }).select('_id name').lean();
  if (!classDoc) throw fail(404, 'ASSIGNMENT_NOT_FOUND');
  if (assignment.resourceType && assignment.resourceType !== 'essay') throw fail(409, 'ASSIGNMENT_REPORT_UNSUPPORTED');

  const found = await Submission.find({ assignment: assignment._id, class: classDoc._id }).select(SUBMISSION_FIELDS.join(' ')).limit(SCAN_CAP + 1).lean();
  const capped = found.length > SCAN_CAP;
  if (capped) logger.warn({ event: 'assignment_report_cap_reached', code: 'ASSIGNMENT_REPORT_CAP_REACHED', assignmentId: String(assignment._id), cap: SCAN_CAP });
  const skipped = {};
  const rows = [];
  for (const row of found.slice(0, SCAN_CAP)) {
    if (!row || !(row._id instanceof mongoose.Types.ObjectId)) { skipped.INVALID_ID = (skipped.INVALID_ID || 0) + 1; continue; }
    rows.push(row);
  }

  const feedbackById = new Map();
  for (let i = 0; i < rows.length; i += FEEDBACK_BATCH) {
    const batch = rows.slice(i, i + FEEDBACK_BATCH).map(r => r._id);
    const list = await SubmissionFeedback.find({ submissionId: { $in: batch } }).select(FEEDBACK_FIELDS.join(' ')).lean();
    for (const fb of list) if (fb?.submissionId) feedbackById.set(String(fb.submissionId), fb);
  }
  const studentIds = [...new Set(rows.map(r => idString(r.student)).filter(Boolean))];
  const usersById = new Map();
  for (let i = 0; i < studentIds.length; i += FEEDBACK_BATCH) {
    const users = await User.find({ _id: { $in: studentIds.slice(i, i + FEEDBACK_BATCH) } }).select('_id displayName').lean();
    for (const user of users) usersById.set(String(user._id), user);
  }
  const currentSettings = await require('./evaluationSettingsContext.service').currentEvaluationSettings(assignment);
  const legend = await require('./correctionLegendResolver.service').resolveLegend();
  const { report, skippedReasons } = buildReport({ assignment, classDoc, rows, feedbackById, usersById, currentSettings, legend, timeZone, skipped, capped });
  if (report.counts.skippedRows > 0) {
    logger.warn({ event: 'assignment_report_rows_skipped', code: 'ASSIGNMENT_REPORT_ROWS_SKIPPED', assignmentId: String(assignment._id),
      skipped: report.counts.skippedRows, reasons: skippedReasons });
  }
  const storedSummary = assignment.reportSummary && typeof assignment.reportSummary === 'object' ? assignment.reportSummary : null;
  report.summary = require('./assignmentReportSummary.service').summaryState(report, storedSummary, { env, now });
  return { report, storedSummary };
}

module.exports = { REPORT_VERSION, SCAN_CAP, SUBMISSION_FIELDS, FEEDBACK_FIELDS, BANDS, safeTimeZone, displayNameOf, sourceOf,
  sourceStatusEligible, timelineOf, buildReport, buildInsights, loadAssignmentReport, loadReportWithStoredSummary };
