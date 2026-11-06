'use strict';
// Teacher evaluation edits (Phase B2). The teacher changes per-criterion scores and comments of the AI-assisted evaluation; the AI values are
// never modified and stay available as "AI suggested". Everything is behind TEACHER_EVALUATION_EDIT_ENABLED (default off).
//
// Stored in SubmissionFeedback.teacherEvaluation (select: false, teacher-only):
//   { version: 1, revision, draftNumber, criteria: { KEY: { score?, comment? } }, updatedAt, updatedBy, updatedByName, history: [Row] }
//   Row = { requestId, requestHash, actor, actorName, at, draftNumber, previousRevision, newRevision, reason,
//           before: { criteria: { KEY: { score, comment } }, overallScore, grade }, after: { … } }   (changed criteria only)
// The record governs only the draft it was written for: a new draft starts again from the AI values (the earlier draft's record travels in
// that draft's revision snapshot). `revision` keeps counting across drafts so a stale form can never apply to a newer draft.
// What students, guests and the PDF see comes from finalFeedback() only. Scope: the built-in six-criterion rubric (overall = sum of the
// criteria); a custom rubric (weighted levels) is not editable here.
const crypto = require('crypto');
const { gradeFromOverallScore } = require('./rubricLanguageScoring.service');

const CRITERIA = Object.freeze(['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS', 'PRESENTATION']);
const COMMENT_MAX = 1000;
const REASON_MAX = 300;
const HISTORY_MAX = 500;
const PAYLOAD_MAX = 8000;
const BODY_KEYS = ['requestId', 'revision', 'criteria', 'reset', 'reason'];
const ENTRY_KEYS = ['score', 'comment'];
// Control characters other than tab, line feed and carriage return; and anything that starts an HTML tag. Text is rendered by interpolation
// only, but it is never stored as markup either.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HTML_TAG = /<\s*\/?\s*[a-z!?]/i;

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const copy = value => value == null ? null : JSON.parse(JSON.stringify(value));
const num = value => (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) ? null : Number(value);
const round1 = value => Math.round(Number(value) * 10) / 10;
const enabled = () => String(process.env.TEACHER_EVALUATION_EDIT_ENABLED || '').trim().toLowerCase() === 'true';
const draftOf = submission => Math.max(1, Number(submission?.draftNumber) || 1);
const isCustomRubric = feedback => Boolean(feedback?.customRubricScores
  && (Array.isArray(feedback.customRubricScores.criteria) ? feedback.customRubricScores.criteria.length > 0 : num(feedback.customRubricScores.overallScore) != null));

/** The record that governs this draft, or null (none, another draft, or the feature is off). */
function activeRecord(feedback, submission) {
  const record = feedback?.teacherEvaluation;
  return record && Number(record.draftNumber) === draftOf(submission) ? record : null;
}

/** The AI values per criterion, straight from the AI fields. */
function aiCriteria(feedback) {
  const out = {};
  for (const key of CRITERIA) {
    const item = feedback?.rubricScores?.[key];
    if (!item || typeof item !== 'object') continue;
    out[key] = { score: num(item.score), maxScore: num(item.maxScore), comment: typeof item.comment === 'string' ? item.comment : '' };
  }
  return out;
}

/** The final values: the AI values with the teacher's edits applied, for this draft. */
function finalValues(feedback, criteria) {
  const ai = aiCriteria(feedback);
  const scoreEdited = Object.values(criteria || {}).some(entry => entry && entry.score != null);
  const final = {};
  for (const [key, value] of Object.entries(ai)) {
    const edit = criteria?.[key] || {};
    final[key] = { score: edit.score != null ? edit.score : value.score, comment: edit.comment != null ? edit.comment : value.comment, maxScore: value.maxScore };
  }
  // Built-in rubric: the overall score moves by exactly the teacher's changes to the criteria (the AI's overall is the sum of its criteria,
  // so this is that sum with the teacher's values). Only a score edit moves it: a comment-only edit keeps the AI's overall and grade.
  const aiOverall = num(feedback?.overallScore);
  const delta = Object.entries(final).reduce((sum, [key, item]) => sum + ((num(item.score) ?? 0) - (ai[key].score ?? 0)), 0);
  const overallScore = scoreEdited ? Math.min(100, Math.max(0, round1((aiOverall ?? 0) + delta))) : aiOverall;
  const grade = scoreEdited ? gradeFromOverallScore(overallScore) : (typeof feedback?.grade === 'string' ? feedback.grade : null);
  return { criteria: final, overallScore, grade };
}

/**
 * What every reader outside the teacher's edit panel gets: the feedback with the teacher's final values in the AI fields' places, and without
 * the teacher record. Flag off, another draft, a custom rubric or no edits: the feedback exactly as stored (minus the record).
 */
function finalFeedback(feedback, submission) {
  if (!feedback || typeof feedback !== 'object') return feedback;
  const { teacherEvaluation: _record, ...rest } = feedback;
  if (!enabled()) return rest;
  const record = activeRecord(feedback, submission);
  if (!record || isCustomRubric(feedback) || !Object.keys(record.criteria || {}).length) return rest;
  const values = finalValues(feedback, record.criteria);
  const rubricScores = { ...(rest.rubricScores || {}) };
  for (const [key, value] of Object.entries(values.criteria)) rubricScores[key] = { ...rubricScores[key], score: value.score, comment: value.comment };
  return { ...rest, rubricScores, overallScore: values.overallScore, grade: values.grade };
}

const requestHashOf = (actor, body) => crypto.createHash('sha256').update(JSON.stringify({ actor: String(actor), ...body })).digest('hex');

function checkText(value, max, code) {
  if (typeof value !== 'string' || value.length > max || CONTROL.test(value) || HTML_TAG.test(value)) throw fail(400, code);
  return value.trim();
}

/** Shape checks that need no database state. */
function checkBody(body) {
  if (JSON.stringify(body || {}).length > PAYLOAD_MAX) throw fail(413, 'TEACHER_EVALUATION_PAYLOAD_TOO_LARGE');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !BODY_KEYS.includes(key))) throw fail(400, 'TEACHER_EVALUATION_INVALID_FIELDS');
  if (!/^[a-f0-9-]{36}$/i.test(body.requestId || '') || !Number.isInteger(body.revision) || body.revision < 0) throw fail(400, 'TEACHER_EVALUATION_INVALID_REQUEST');
  const reset = body.reset === true, hasCriteria = body.criteria !== undefined;
  if (body.reset !== undefined && body.reset !== true) throw fail(400, 'TEACHER_EVALUATION_INVALID_REQUEST');
  if (reset === hasCriteria) throw fail(400, 'TEACHER_EVALUATION_INVALID_REQUEST');
  if (hasCriteria) {
    const criteria = body.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || !Object.keys(criteria).length) throw fail(400, 'TEACHER_EVALUATION_INVALID_REQUEST');
    for (const [key, entry] of Object.entries(criteria)) {
      if (!CRITERIA.includes(key)) throw fail(400, 'TEACHER_EVALUATION_UNKNOWN_CRITERION');
      if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.keys(entry).length || Object.keys(entry).some(k => !ENTRY_KEYS.includes(k))) {
        throw fail(400, 'TEACHER_EVALUATION_INVALID_FIELDS');
      }
      if (entry.score !== undefined && entry.score !== null && (typeof entry.score !== 'number' || !Number.isFinite(entry.score))) throw fail(400, 'TEACHER_EVALUATION_INVALID_SCORE');
      if (entry.comment !== undefined && entry.comment !== null) checkText(entry.comment, COMMENT_MAX, 'TEACHER_EVALUATION_INVALID_COMMENT');
    }
  }
  if (body.reason !== undefined && body.reason !== null && body.reason !== '') checkText(body.reason, REASON_MAX, 'TEACHER_EVALUATION_INVALID_REASON');
}

/** An earlier request with the same id: replay it, or refuse a different body under a reused id. */
function replayOf(record, actor, body) {
  const prior = (record?.history || []).find(row => row.requestId === body.requestId);
  if (!prior) return null;
  if (prior.requestHash !== requestHashOf(actor, body)) throw fail(409, 'TEACHER_EVALUATION_IDEMPOTENCY_CONFLICT');
  return { replay: true, revision: prior.newRevision };
}

const sameEntry = (a, b) => JSON.stringify(a || {}) === JSON.stringify(b || {});

/**
 * Applies one teacher save to the record. Returns { record, row, revision } or { replay, revision }. Throws before anything is written.
 * `actor` is the owning teacher; `actorName` is shown only in the teacher's history.
 */
function prepare(feedback, submission, actor, actorName, body, { now = new Date() } = {}) {
  checkBody(body);
  const stored = feedback?.teacherEvaluation || null;
  const replay = replayOf(stored, actor, body);
  if (replay) return replay;
  if (isCustomRubric(feedback)) throw fail(409, 'TEACHER_EVALUATION_CUSTOM_RUBRIC');
  const storedRevision = Number(stored?.revision || 0);
  if (body.revision !== storedRevision) throw fail(409, 'TEACHER_EVALUATION_REVISION_CONFLICT');
  const draftNumber = draftOf(submission);
  const active = activeRecord(feedback, submission);
  const ai = aiCriteria(feedback);
  const before = copy(active?.criteria || {});
  const criteria = body.reset ? {} : copy(before);
  if (!body.reset) {
    for (const [key, entry] of Object.entries(body.criteria)) {
      if (!ai[key]) throw fail(400, 'TEACHER_EVALUATION_UNKNOWN_CRITERION');
      const next = { ...(criteria[key] || {}) };
      if (entry.score !== undefined) {
        if (entry.score === null) delete next.score;
        else {
          const max = ai[key].maxScore;
          if (max == null || entry.score < 0 || entry.score > max || Math.abs(entry.score * 10 - Math.round(entry.score * 10)) > 1e-9) throw fail(400, 'TEACHER_EVALUATION_INVALID_SCORE');
          next.score = round1(entry.score);
        }
      }
      if (entry.comment !== undefined) {
        if (entry.comment === null) delete next.comment;
        else next.comment = entry.comment.trim();
      }
      if (Object.keys(next).length) criteria[key] = next; else delete criteria[key];
    }
  }
  const changed = [...new Set([...Object.keys(before), ...Object.keys(criteria)])].filter(key => !sameEntry(before[key], criteria[key]));
  if (!changed.length) throw fail(409, 'TEACHER_EVALUATION_NO_CHANGE');
  const valuesBefore = finalValues(feedback, before), valuesAfter = finalValues(feedback, criteria);
  const pick = (values) => ({ criteria: Object.fromEntries(changed.map(key => [key, { score: values.criteria[key]?.score ?? null, comment: values.criteria[key]?.comment ?? '' }])),
    overallScore: values.overallScore, grade: values.grade });
  const history = active ? [...(stored.history || [])] : [];
  if (history.length >= HISTORY_MAX) throw fail(409, 'TEACHER_EVALUATION_HISTORY_LIMIT');
  const at = now.toISOString();
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim() : null;
  const row = { requestId: body.requestId, requestHash: requestHashOf(actor, body), actor: String(actor), actorName: actorName || '', at, draftNumber,
    previousRevision: storedRevision, newRevision: storedRevision + 1, reason, reset: Boolean(body.reset), before: pick(valuesBefore), after: pick(valuesAfter) };
  const record = { version: 1, revision: storedRevision + 1, draftNumber, criteria, updatedAt: at, updatedBy: String(actor), updatedByName: actorName || '',
    history: [...history, row] };
  return { record, row, revision: record.revision };
}

/** The teacher's edit panel: AI suggested, the teacher's values, the final values, and the history (newest first). */
function teacherSnapshot(feedback, submission, { editable, blockedReason }) {
  const record = activeRecord(feedback, submission);
  const ai = aiCriteria(feedback);
  const values = finalValues(feedback, record?.criteria || {});
  const criteria = Object.entries(ai).map(([key, value]) => ({
    key, maxScore: value.maxScore,
    ai: { score: value.score, comment: value.comment },
    teacher: { score: record?.criteria?.[key]?.score ?? null, comment: record?.criteria?.[key]?.comment ?? null },
    final: { score: values.criteria[key].score, comment: values.criteria[key].comment },
  }));
  const aiOverall = num(feedback?.overallScore);
  return {
    enabled: true, editable: Boolean(editable), blockedReason: editable ? null : (blockedReason || null),
    revision: Number(feedback?.teacherEvaluation?.revision || 0), draftNumber: draftOf(submission),
    criteria, overall: { ai: aiOverall, final: values.overallScore, max: num(feedback?.maxOverallScore) ?? 100 },
    grade: { ai: typeof feedback?.grade === 'string' ? feedback.grade : null, final: values.grade },
    edited: Boolean(record && Object.keys(record.criteria || {}).length),
    updatedAt: record?.updatedAt || null, updatedByName: record?.updatedByName || null,
    history: [...(record?.history || [])].reverse().map(row => ({ at: row.at, actorName: row.actorName || '', reason: row.reason || null, reset: Boolean(row.reset),
      previousRevision: row.previousRevision, newRevision: row.newRevision, before: row.before, after: row.after })),
    limits: { commentMax: COMMENT_MAX, reasonMax: REASON_MAX },
  };
}

module.exports = { CRITERIA, COMMENT_MAX, REASON_MAX, HISTORY_MAX, PAYLOAD_MAX, enabled, isCustomRubric, aiCriteria, finalValues, finalFeedback,
  checkBody, prepare, teacherSnapshot, requestHashOf, activeRecord };
