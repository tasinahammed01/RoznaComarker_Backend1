'use strict';
// What the teacher's similarity panel receives (teacher only: students and guests never reach these routes). Percentages are computed here,
// on every read, from the stored sources and exclusions (overall.js). Internal sources are decided now, not when the check ran:
//   - in the viewer's own class (the other essay's class is still the viewer's): label, percentage, matched passages, and a link to open it;
//   - anywhere else: the label and the percentage only (never its text, id, student or teacher);
//   - an essay that no longer exists: "A submission that was removed".
// Provider names appear only in the audit block; external failure reasons are generic.
const crypto = require('crypto');
const Submission = require('../../models/Submission');
const Class = require('../../models/class.model');
const { readSettings } = require('./policy');
const { getProvider } = require('./provider');
const { computeView } = require('./overall');

const REMOVED = 'A submission that was removed';
const SAME_STUDENT = 'Same student, another assignment';
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');

const GENERIC_REASONS = Object.freeze({ daily_spend_reached: 'daily_spend_reached', too_short: 'too_short', submission_unavailable: 'submission_unavailable',
  timeout: 'service_unavailable', network: 'service_unavailable', rate_limited: 'service_unavailable', bad_response: 'service_unavailable' });
const genericReason = code => (code ? GENERIC_REASONS[code] || (/^http_5\d\d$/u.test(code) ? 'service_unavailable' : 'service_error') : null);

async function internalVisibility(sources, viewerId) {
  const ids = sources.filter(s => s.kind === 'internal' && s.refSubmissionId).map(s => s.refSubmissionId);
  if (!ids.length) return new Map();
  const subs = await Submission.find({ _id: { $in: ids } }).select('class assignment student submissionMode').lean();
  const classes = await Class.find({ _id: { $in: [...new Set(subs.map(s => String(s.class)))] } }).select('teacher').lean();
  const teacherOf = new Map(classes.map(c => [String(c._id), String(c.teacher)]));
  return new Map(subs.map(s => [String(s._id), { own: teacherOf.get(String(s.class)) === String(viewerId), sub: s }]));
}

/** The panel before any check: { state: 'none', eligible, reason, wordCount, checksLeftToday, checksLeftForSubmission, externalAvailable, noticeShown }. */
function emptyView({ essay, checksLeftToday, settings, used, noticeShown, env }) {
  const provider = getProvider(env);
  return { state: 'none', eligible: essay.eligible && essay.tokens.length <= settings.maxWords,
    reason: !essay.tokens.length ? 'no_text' : !essay.eligible ? 'transcript_not_confirmed' : essay.tokens.length > settings.maxWords ? 'too_long' : null,
    wordCount: essay.tokens.length, checksLeftToday, checksLeftForSubmission: Math.max(0, settings.checksPerSubmission - used),
    externalAvailable: Boolean(provider && provider.isConfigured(env, settings) && noticeShown), noticeShown };
}

/** The full report for its owning teacher. */
async function teacherView({ report, essay, viewerId, checksLeftToday, noticeShown, env = process.env }) {
  const { settings } = readSettings(env);
  const used = report?.checks?.length || 0;
  if (!report) return emptyView({ essay, checksLeftToday, settings, used, noticeShown, env });
  const base = emptyView({ essay, checksLeftToday, settings, used, noticeShown, env });
  const visibility = await internalVisibility(report.sources || [], viewerId);
  const computed = computeView(report.sources || [], essay.tokens);
  const sources = computed.sources.map(row => {
    const source = report.sources.find(s => s.sourceId === row.sourceId);
    const out = { sourceId: row.sourceId, number: row.rank && row.words > 0 ? row.rank : null, kind: source.kind, label: source.label,
      percent: row.percent, words: row.words, excluded: row.excluded, compared: row.compared };
    if (!row.compared && Number.isFinite(source.approxWords)) out.approxWords = source.approxWords;
    const spans = (source.spans || []).map(sp => ({ start: sp.start, end: sp.end }));
    if (source.kind !== 'internal') {
      if (source.title) out.title = source.title;
      if (source.url) out.url = source.url;
      if (source.viewUrl) out.viewUrl = source.viewUrl;
      if (spans.length) out.spans = spans;
      return out;
    }
    const seen = visibility.get(String(source.refSubmissionId));
    if (!seen) { out.label = REMOVED; return out; }
    if (source.sameStudent) out.label = SAME_STUDENT;
    if (seen.own) {
      if (spans.length) out.spans = spans;
      if (seen.sub.submissionMode !== 'guest' && seen.sub.student) {
        out.open = { studentId: String(seen.sub.student), classId: String(seen.sub.class), assignmentId: String(seen.sub.assignment), submissionId: String(seen.sub._id) };
      }
    }
    return out;
  });
  // ranked sources by number, then the rest in source order
  sources.sort((a, b) => (a.number ?? Infinity) - (b.number ?? Infinity));   // stable: the rest keep their order
  const audit = report.providerAudit || {};
  return { ...base, state: report.status, revision: report.revision, checkedAt: report.completedAt || null,
    outdated: Boolean(report.text?.sha256) && report.text.sha256 !== sha256(essay.text),
    text: essay.text, totalWords: computed.totalWords, matchedWords: computed.matchedWords, overallPercent: computed.overallPercent,
    external: { state: report.external?.state || 'skipped', reason: genericReason(report.external?.reason) },
    settings: { excludeQuotes: report.settings?.excludeQuotes ?? settings.excludeQuotes, minMatchWords: report.settings?.minMatchWords ?? settings.minMatchWords },
    sources, highlights: computed.highlights,
    audit: { provider: audit.provider || null, units: audit.units ?? null, costUsd: audit.costUsd ?? null, resultCount: audit.resultCount ?? null },
    ...(report.status === 'failed' ? { failed: { reason: genericReason(report.errorCode) } } : {}) };
}

module.exports = { teacherView, emptyView, genericReason, REMOVED, SAME_STUDENT };
