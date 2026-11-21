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
//
// "Common mistakes" (commonMistakes): per correction type, how many DISTINCT students made it, with up to 3 anonymous examples. It counts
// only what students see (studentCorrectionView: removed corrections left out, teacher-edited text used, teacher-added corrections in), for
// the submissions whose corrections are current (the rule above). Its reads come AFTER the main read, which is unchanged:
//   - the correction text of those submissions (CORRECTION_TEXT_FIELDS, per FEEDBACK_BATCH ids): correction fields, the overlay, and the
//     guest's email, which is turned into a one-way key at once (guests are counted once each) and never kept, returned or logged;
//   - essays the teacher edited (an overlay with entries) need their transcript for the overlay: EDITED_FIELDS, EDITED_BATCH ids per read,
//     at most EDITED_CAP per report. Beyond the cap they are LEFT OUT of the section (never counted with corrections the teacher removed),
//     partial: true, logged once with ids and counts only. An essay whose view cannot be built is left out the same way.
const crypto = require('crypto');
const mongoose = require('mongoose');
const logger = require('../utils/logger');
const sourceFidelity = require('../utils/sourceFidelity');
const { buildCanonicalResultState } = require('./canonicalResultState.service');
const { located, sentenceSpan, sentenceOf } = require('./reportExampleSentence');

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

// "Common mistakes": thresholds, caps and reads (see the header).
const COMMON_MIN_STUDENTS = 2;
const COMMON_TOP_TYPES = 5;
// Up to 5 examples per type in the response; the page and the PDF show the first 3 (the page offers the other 2 on request).
const COMMON_EXAMPLES = 5;
const EXAMPLE_TEXT_MAX = 80;
const EXAMPLE_EXPLANATION_MAX = 160;
const EDITED_BATCH = 20;
const EDITED_CAP = 100;
const CORRECTION_TEXT_FIELDS = Object.freeze(['_id', 'draftNumber', 'teacherAnnotations', 'guest.normalizedEmail', 'writingCorrections.id',
  'writingCorrections.symbol', 'writingCorrections.category', 'writingCorrections.quotedText', 'writingCorrections.suggestedText',
  'writingCorrections.message', 'writingCorrections.source', 'writingCorrections.startChar', 'writingCorrections.endChar']);
// The example sentences: the transcript fields only (no corrections, overlay or identity), for the submissions chosen as examples (at most
// COMMON_TOP_TYPES x COMMON_EXAMPLES), in one read. The text is cut into sentences in memory and never stored or logged.
const EXAMPLE_TRANSCRIPT_FIELDS = Object.freeze(['_id', 'draftNumber', 'ocrJobId', 'files', 'file', 'fileOrder', 'ocrPages', 'ocrData', 'sourceFidelityMode',
  'sourceFidelityStatus', 'sourceFidelityVersion', 'sourceHumanReviewSummary', 'sourceTranscriptExact', 'sourceTranscriptSha256']);
// What the student view needs to place the teacher's overlay on an edited essay: its transcript (pages, files, exact-source fields), the
// whole correction list and the overlay.
const EDITED_FIELDS = Object.freeze(['_id', 'draftNumber', 'ocrJobId', 'files', 'file', 'fileOrder', 'ocrPages', 'ocrData', 'sourceFidelityMode',
  'sourceFidelityStatus', 'sourceFidelityVersion', 'sourceHumanReviewSummary', 'sourceTranscriptExact', 'sourceTranscriptSha256', 'writingCorrections',
  'correctionStatistics', 'teacherAnnotations']);

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
    _symbols: symbols, _statistics: statistics, _feedback: score !== null ? final : null,
    // "Common mistakes": who made it (internal, never in the response). A guest has no account: counted by email later (one-way key).
    _studentId: row.submissionMode === 'guest' ? null : idString(row.student), _guest: row.submissionMode === 'guest' };
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

// ---- "Common mistakes" -----------------------------------------------------------------------------------------------------------------
/** Example text: control characters and runs of spaces removed, cut to `max` characters with "…". */
function exampleText(value, max) {
  const text = String(value ?? '').replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}
/** One correction as an example ({ original, corrected, explanation }), or null without original words. */
function exampleOf(correction) {
  const original = exampleText(correction?.quotedText, EXAMPLE_TEXT_MAX);
  if (!original) return null;
  return { original, corrected: exampleText(correction?.suggestedText, EXAMPLE_TEXT_MAX), explanation: exampleText(correction?.message, EXAMPLE_EXPLANATION_MAX) };
}
const pairKey = c => `${c.original.toLowerCase()}\u0000${c.corrected.toLowerCase()}`;
/**
 * Example units: the mistakes of one type that sit in one sentence of one submission form one unit (grouped); without a sentence (no
 * transcript, or a position that no longer fits) each word pair is a unit, duplicates removed as before.
 */
function exampleUnits(candidates, transcripts) {
  const units = new Map();
  for (const c of candidates) {
    const text = transcripts?.get?.(c.submissionId);
    const span = text && located(text, c.position) ? sentenceSpan(text, c.position.startChar, c.position.endChar) : null;
    const key = span ? `s\u0000${c.submissionId}\u0000${span.start}` : `p\u0000${pairKey(c)}`;
    const unit = units.get(key);
    if (unit) { if (span) unit.members.push(c); continue; }
    units.set(key, { student: c.student, submissionId: c.submissionId, text: span ? text : null, members: [c],
      sentenceKey: span ? text.slice(span.start, span.end).replace(/\s+/gu, ' ').toLowerCase() : null });
  }
  return [...units.values()].map(u => ({ ...u, members: u.members.sort((a, b) => a.position.startChar - b.position.startChar) }));
}
/**
 * Up to COMMON_EXAMPLES units: those with a sentence first, then the shortest, one per student before a second from anyone; a sentence or a
 * word pair already shown is not shown again. Deterministic.
 */
function pickUnits(units) {
  const first = u => u.members[0];
  const size = u => first(u).original.length + first(u).corrected.length;
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const sorted = [...units].sort((a, b) => Number(Boolean(b.text)) - Number(Boolean(a.text)) || size(a) - size(b)
    || order(first(a).original, first(b).original) || order(first(a).corrected, first(b).corrected) || order(a.submissionId, b.submissionId)
    || first(a).position.startChar - first(b).position.startChar);
  const picked = [], students = new Set(), shown = new Set();
  // The same sentence with the same corrections (two students, identical words) is shown once; a different correction is shown.
  const sameKey = u => `s\u0000${u.sentenceKey}\u0000${u.members.map(pairKey).join('\u0001')}`;
  const take = u => { picked.push(u); students.add(u.student); for (const m of u.members) shown.add(pairKey(m)); if (u.sentenceKey) shown.add(sameKey(u)); };
  const fresh = u => (u.sentenceKey ? !shown.has(sameKey(u)) : !shown.has(pairKey(first(u))));
  for (const u of sorted) if (picked.length < COMMON_EXAMPLES && !students.has(u.student) && fresh(u)) take(u);
  for (const u of sorted) if (picked.length < COMMON_EXAMPLES && !picked.includes(u) && fresh(u)) take(u);
  return picked;
}
/** A picked unit as sent: the first mistake's words and reason, and the sentence when there is one. */
function exampleOfUnit(unit) {
  const { original, corrected, explanation } = unit.members[0];
  const sentence = unit.text ? sentenceOf(unit.text, unit.members.map(m => m.position)) : null;
  return sentence ? { original, corrected, explanation, sentence } : { original, corrected, explanation };
}

/** Pure. The distinct students (latest entry each) and the correction types, sorted by students, then occurrences, then code. */
function rankedTypes(entries) {
  const time = e => (e.submittedAt instanceof Date && Number.isFinite(e.submittedAt.getTime()) ? e.submittedAt.getTime() : -Infinity);
  const latest = new Map();
  for (const e of entries || []) {
    if (!e?.key) continue;
    const prev = latest.get(e.key);
    if (!prev || time(e) > time(prev) || (time(e) === time(prev) && String(e.submissionId) > String(prev.submissionId))) latest.set(e.key, e);
  }
  const totalStudents = latest.size;
  const bySymbol = new Map();
  for (const [key, e] of latest) {
    for (const c of Array.isArray(e.corrections) ? e.corrections : []) {
      const symbol = c && typeof c === 'object' && typeof c.symbol === 'string' ? c.symbol.trim().toUpperCase().slice(0, 16) : '';
      if (!symbol) continue;
      const item = bySymbol.get(symbol) || { symbol, category: String(c.category || '').toUpperCase() || null, students: new Set(), occurrences: 0, candidates: [] };
      item.students.add(key); item.occurrences += 1;
      const example = exampleOf(c);
      // The position is kept in memory only, to find the sentence; it is never sent.
      if (example) item.candidates.push({ student: key, submissionId: String(e.submissionId), ...example,
        position: { startChar: c.startChar, endChar: c.endChar, quotedText: c.quotedText, suggestedText: example.corrected } });
      bySymbol.set(symbol, item);
    }
  }
  const sorted = [...bySymbol.values()].sort((a, b) => b.students.size - a.students.size || b.occurrences - a.occurrences
    || (a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0));
  return { totalStudents, sorted };
}

/**
 * Pure. The submissions whose transcripts the examples need: per common type, up to COMMON_EXAMPLES submissions (one per student, the
 * shortest mistakes first); at most COMMON_TOP_TYPES x COMMON_EXAMPLES in all.
 */
function exampleSubmissionIds(entries) {
  const { sorted } = rankedTypes(entries);
  const ids = new Set();
  const size = c => c.original.length + c.corrected.length;
  for (const item of sorted.slice(0, COMMON_TOP_TYPES).filter(t => t.students.size >= COMMON_MIN_STUDENTS)) {
    const ordered = [...item.candidates].sort((a, b) => size(a) - size(b) || (a.submissionId < b.submissionId ? -1 : a.submissionId > b.submissionId ? 1 : 0));
    const mine = [];
    for (const c of ordered) if (mine.length < COMMON_EXAMPLES && !mine.includes(c.submissionId)) mine.push(c.submissionId);
    for (const id of mine) ids.add(id);
  }
  return [...ids];
}

/**
 * Pure. entries: [{ key (one student), submissionId, submittedAt, corrections (what the student sees) }]. A student with several entries
 * counts once, with the latest. Types are sorted by students, then occurrences, then code; the top COMMON_TOP_TYPES are returned, with
 * examples only for a type at least COMMON_MIN_STUDENTS students made (isCommon). state: 'not_enough_students' | 'none_shared' | 'ok'.
 * transcripts (Map submissionId -> canonical text, optional): examples from those submissions carry the student's sentence.
 */
function commonMistakesOf(entries, legend, { partial = false, transcripts = null } = {}) {
  const index = legendIndex(legend);
  const { totalStudents, sorted } = rankedTypes(entries);
  const state = totalStudents < COMMON_MIN_STUDENTS ? 'not_enough_students'
    : sorted.some(item => item.students.size >= COMMON_MIN_STUDENTS) ? 'ok' : 'none_shared';
  const types = state !== 'ok' ? [] : sorted.slice(0, COMMON_TOP_TYPES).map(item => {
    const meta = index.symbols.get(item.symbol);
    const isCommon = item.students.size >= COMMON_MIN_STUDENTS;
    return { typeCode: item.symbol, label: meta?.label || item.symbol, category: meta?.category || item.category || null, studentCount: item.students.size,
      totalStudents, occurrenceCount: item.occurrences, isCommon, examples: isCommon ? pickUnits(exampleUnits(item.candidates, transcripts)).map(exampleOfUnit) : [] };
  });
  return { basis: 'visible_corrections', totalStudents, minStudents: COMMON_MIN_STUDENTS, state, partial: Boolean(partial), types };
}

/**
 * The canonical transcript text (the one the highlights use; exact-source pages joined) of each chosen submission, in one read of the
 * transcript fields only. Map submissionId -> text. A transcript that cannot be built is left out (its examples keep the word pair).
 */
async function loadExampleTranscripts(submissionIds) {
  const texts = new Map();
  const ids = [...new Set((submissionIds || []).map(String))].filter(id => isObjectId(id)).slice(0, COMMON_TOP_TYPES * COMMON_EXAMPLES);
  if (!ids.length) return texts;
  const Submission = require('../models/Submission');
  const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
  const docs = await Submission.find({ _id: { $in: ids } }).select(EXAMPLE_TRANSCRIPT_FIELDS.join(' ')).lean();
  for (const doc of docs) {
    try {
      const text = buildCanonicalSubmissionTranscript(doc)?.text;
      if (typeof text === 'string' && text) texts.set(String(doc._id), text);
    } catch { /* this submission's examples keep their word pairs */ }
  }
  return texts;
}

/** One student: the account for a class member, a one-way key of the guest's email for a guest, else the submission (counted alone). */
function studentKeyOf(candidate, guestEmail) {
  if (!candidate.guest && candidate.studentId) return `u:${candidate.studentId}`;
  const email = typeof guestEmail === 'string' ? guestEmail.trim().toLowerCase() : '';
  if (candidate.guest && email) return `g:${crypto.createHash('sha256').update(`report-guest:${email}`).digest('hex')}`;
  return `s:${candidate.submissionId}`;
}

/**
 * The entries for commonMistakesOf, from the database (reads described in the header). candidates: rows with current corrections
 * ({ submissionId, studentId, guest, submittedAt }). Returns { entries, partial, edited }.
 */
async function loadCommonMistakeEntries(candidates, { assignmentId } = {}) {
  const Submission = require('../models/Submission');
  const { buildStudentCorrectionView } = require('./studentCorrectionView.service');
  const { normalizeState } = require('./teacherAnnotation.service');
  const byId = new Map(candidates.map(c => [c.submissionId, c]));
  const ids = candidates.map(c => c.submissionId);
  const entries = [], edited = [];
  let partial = false;
  const visible = doc => buildStudentCorrectionView(doc, { overlay: doc.teacherAnnotations ?? null }).corrections;
  for (let i = 0; i < ids.length; i += FEEDBACK_BATCH) {
    const docs = await Submission.find({ _id: { $in: ids.slice(i, i + FEEDBACK_BATCH) } }).select(CORRECTION_TEXT_FIELDS.join(' ')).lean();
    for (const doc of docs) {
      const candidate = byId.get(String(doc._id));
      if (!candidate) continue;
      const key = studentKeyOf(candidate, doc.guest?.normalizedEmail);
      delete doc.guest;   // the email is not kept beyond its one-way key
      const base = { key, submissionId: candidate.submissionId, submittedAt: candidate.submittedAt };
      if (normalizeState(doc.teacherAnnotations).entries.length) { edited.push(base); continue; }
      try { entries.push({ ...base, corrections: visible(doc) }); } catch { partial = true; }
    }
  }
  // Edited essays: the newest first up to the cap; the rest are left out (never counted with removed corrections).
  edited.sort((a, b) => ((b.submittedAt?.getTime?.() ?? -Infinity) - (a.submittedAt?.getTime?.() ?? -Infinity)) || (a.submissionId < b.submissionId ? 1 : -1));
  if (edited.length > EDITED_CAP) {
    partial = true;
    logger.warn({ event: 'assignment_report_common_mistakes_partial', code: 'COMMON_MISTAKES_EDITED_CAP', assignmentId: idString(assignmentId),
      edited: edited.length, cap: EDITED_CAP });
  }
  const kept = edited.slice(0, EDITED_CAP);
  const editedById = new Map(kept.map(e => [e.submissionId, e]));
  for (let i = 0; i < kept.length; i += EDITED_BATCH) {
    const docs = await Submission.find({ _id: { $in: kept.slice(i, i + EDITED_BATCH).map(e => e.submissionId) } }).select(EDITED_FIELDS.join(' ')).lean();
    for (const doc of docs) {
      const base = editedById.get(String(doc._id));
      if (!base) continue;
      try { entries.push({ ...base, corrections: visible(doc) }); } catch { partial = true; }
    }
  }
  return { entries, partial, edited: edited.length };
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
    // Filled by the loader from the corrections students see (loadCommonMistakeEntries); built from no data here.
    commonMistakes: commonMistakesOf([], legend),
    timeline: timelineOf(built.map(r => r.submittedAt).filter(Boolean), timeZone),
    students: built.map(r => ({ submissionId: r.submissionId, name: r.name, source: r.source, score: r.score, band: r.band, assessment: r.assessment,
      notScoredReason: r.notScoredReason, reviewed: r.reviewed, topIssue: topIssueOf(r, legend), submittedAt: r.submittedAt ? r.submittedAt.toISOString() : null,
      isLate: r.isLate, draftNumber: r.draftNumber, needsAttention: r.needsAttention, attentionReasons: r.attentionReasons })),
    smallData: { distributionHidden: scored.length < 3, timelineHidden: built.length < 3 }
  };
  report.insights = buildInsights(report);
  // "Common mistakes" counts the rows whose corrections are current (the same rule as the error counts).
  const commonMistakeCandidates = built.filter(r => r._statistics).map(r => ({ submissionId: r.submissionId, studentId: r._studentId, guest: r._guest,
    submittedAt: r.submittedAt }));
  return { report, skippedReasons: reasons, commonMistakeCandidates };
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
  const { report, skippedReasons, commonMistakeCandidates } = buildReport({ assignment, classDoc, rows, feedbackById, usersById, currentSettings, legend, timeZone,
    skipped, capped });
  const common = await loadCommonMistakeEntries(commonMistakeCandidates, { assignmentId: assignment._id });
  // The examples' sentences: read now from the chosen submissions' transcripts. If that read fails, the examples keep their word pairs.
  const transcripts = await loadExampleTranscripts(exampleSubmissionIds(common.entries)).catch(error => {
    logger.warn({ event: 'assignment_report_example_sentences_unavailable', code: error?.code || error?.name || 'UNKNOWN', assignmentId: idString(assignment._id) });
    return new Map();
  });
  report.commonMistakes = commonMistakesOf(common.entries, legend, { partial: common.partial, transcripts });
  if (report.counts.skippedRows > 0) {
    logger.warn({ event: 'assignment_report_rows_skipped', code: 'ASSIGNMENT_REPORT_ROWS_SKIPPED', assignmentId: String(assignment._id),
      skipped: report.counts.skippedRows, reasons: skippedReasons });
  }
  const storedSummary = assignment.reportSummary && typeof assignment.reportSummary === 'object' ? assignment.reportSummary : null;
  report.summary = require('./assignmentReportSummary.service').summaryState(report, storedSummary, { env, now });
  return { report, storedSummary };
}

module.exports = { REPORT_VERSION, SCAN_CAP, SUBMISSION_FIELDS, FEEDBACK_FIELDS, BANDS, safeTimeZone, displayNameOf, sourceOf,
  CORRECTION_TEXT_FIELDS, EDITED_FIELDS, EDITED_BATCH, EDITED_CAP, COMMON_MIN_STUDENTS, COMMON_TOP_TYPES, COMMON_EXAMPLES, EXAMPLE_TRANSCRIPT_FIELDS, commonMistakesOf, loadCommonMistakeEntries,
  exampleSubmissionIds, loadExampleTranscripts,
  sourceStatusEligible, timelineOf, buildReport, buildInsights, loadAssignmentReport, loadReportWithStoredSummary };
