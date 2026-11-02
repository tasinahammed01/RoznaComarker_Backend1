'use strict';
// Grade check after annotation changes (Tasks 7B and 7C). A teacher confirms that the scores stand after corrections changed.
// This module never writes a score and never starts an assessment: annotation changes do not change scores, and "keep" records a decision
// on the teacher overlay only. Everything here is teacher-only; students are never told that a check happened.
//
// Stored on the overlay (Submission.teacherAnnotations):
//   scoringReviewRequired: true while a change waits for a decision. Flags stored before this task have no scoringReview block.
//   scoringReview: { requiredDraftNumber, decision: { outcome, at, by, reason, draftNumber, annotationRevision, fingerprint } }
//
// Status is derived on every read, never stored:
//   unavailable  assessment running, or the evaluation is not current: there is no result to confirm
//   needed       a change on this draft waits for a decision (a flag with no draft number reads as needed on any draft),
//                or the scores changed after the last decision on this draft (AI run or teacher edit: fingerprint mismatch)
//   checked      the last decision on this draft still matches the scores
//   not_needed   otherwise; a new draft starts here
//
// Score fingerprint: sha256 over canonical JSON (sorted keys) of the repeated-source scoreIdentity (evaluation status, overall score, grade,
// each rubric score and maximum, each custom criterion's points and level, result version) plus the evaluation source hash and the override
// state. It changes when any score changes and when the result was produced from another source, and not when comments or corrections do.
const crypto = require('crypto');
const { normalizeState, requestHashOf, RECENT_AUDIT } = require('./teacherAnnotation.service');
const { buildCanonicalResultState } = require('./canonicalResultState.service');
const { scoreIdentity } = require('./repeatedSourceConsistency.service');

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode, code });
const REASON_MAX = 500;
// C0 and C1 control characters, line breaks included: the reason is one line of text.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const canonicalJson = value => JSON.stringify(function sorted(v) {
  if (Array.isArray(v)) return v.map(sorted);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(Object.keys(v).sort().map(key => [key, sorted(v[key])]));
}(value));

function scoreFingerprint(feedback, submission) {
  return crypto.createHash('sha256').update(canonicalJson({ ...scoreIdentity(feedback || {}, submission),
    evaluationSourceHash: feedback?.evaluationSourceHash || null, overriddenByTeacher: Boolean(feedback?.overriddenByTeacher) })).digest('hex');
}

/** The scores a decision is about: what the teacher is confirming, and the audit's before and after. */
function scoresOf(feedback) {
  return { overallScore: feedback?.overallScore ?? null, grade: feedback?.grade ?? null,
    categories: Object.fromEntries(Object.entries(feedback?.rubricScores || {}).map(([key, item]) => [key, { score: item?.score ?? null, maxScore: item?.maxScore ?? null }])),
    customRubricOverallScore: feedback?.customRubricScores?.overallScore ?? null };
}

/** Assessment work is running: the same refusal as annotation writes. */
const assessmentBusy = doc => ['pending', 'processing'].includes(doc.ocrStatus) || ['started', 'processing', 'queued', 'pending'].includes(doc.assessmentStatus)
  || ['pending', 'processing'].includes(doc.correctionStatus) || ['pending', 'processing'].includes(doc.evaluationStatus);

function statusOf({ state, draftNumber, busy, evaluationCurrent, fingerprint }) {
  if (busy || !evaluationCurrent) return 'unavailable';
  const review = state.scoringReview;
  if (state.scoringReviewRequired && (review?.requiredDraftNumber == null || review.requiredDraftNumber === draftNumber)) return 'needed';
  const decision = review?.decision;
  if (decision?.draftNumber !== draftNumber) return 'not_needed';
  return decision.fingerprint === fingerprint ? 'checked' : 'needed';
}

/** The review as of now. `settings`: currentEvaluationSettings of the assignment, so a changed rubric or policy reads as not current. */
function evaluate(doc, feedback, settings) {
  const state = normalizeState(doc.teacherAnnotations);
  const draftNumber = Math.max(1, Number(doc.draftNumber) || 1);
  const { evaluationCurrent } = buildCanonicalResultState({ submission: doc, feedback, currentSettings: settings });
  const busy = assessmentBusy(doc);
  const fingerprint = scoreFingerprint(feedback, doc);
  return { state, draftNumber, busy, evaluationCurrent, fingerprint, scores: scoresOf(feedback),
    status: statusOf({ state, draftNumber, busy, evaluationCurrent, fingerprint }) };
}

function checkBody(body) {
  const allowed = ['requestId', 'revision', 'sourceHash', 'scoreFingerprint', 'outcome', 'reason'];
  const invalid = () => fail(400, 'ANNOTATION_INVALID_FIELDS');
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !allowed.includes(key))) throw invalid();
  if (!/^[a-f0-9-]{36}$/i.test(body.requestId || '') || !Number.isInteger(body.revision) || typeof body.sourceHash !== 'string' || !body.sourceHash
    || !/^[a-f0-9]{64}$/.test(body.scoreFingerprint || '') || body.outcome !== 'kept') throw invalid();
  if (body.reason !== undefined && (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > REASON_MAX || CONTROL.test(body.reason))) throw invalid();
}

/** The next overlay and the audit row for one "keep" decision. Refusals are the caller's to make first. */
function prepareDecision({ doc, actor, body, review, now = new Date() }) {
  const { state, draftNumber, scores, fingerprint } = review;
  const at = now.toISOString();
  const revision = state.revision + 1;
  const decision = { outcome: body.outcome, at, by: String(actor), ...(body.reason !== undefined ? { reason: body.reason } : {}), draftNumber, annotationRevision: revision, fingerprint };
  const before = { scores, fingerprint, status: review.status };
  const auditRow = { submissionId: String(doc._id), classId: doc.class ? String(doc.class) : null, requestId: body.requestId,
    requestHash: requestHashOf(actor, body), action: 'score_review', actor: String(actor), entryId: null, correctionId: null,
    previousRevision: body.revision, newRevision: revision, before, after: { scores, fingerprint, outcome: body.outcome, status: 'checked' },
    changedFields: [], visibilityChanged: false, scoringReviewRequired: false, draftNumber,
    ...(body.reason !== undefined ? { reason: body.reason } : {}), source: 'teacher_action', createdAt: at };
  return { auditRow, legacyAudit: state.legacyAudit || [], revision,
    state: { version: 2, revision, scoringReviewRequired: false, scoringReview: { requiredDraftNumber: null, decision }, entries: state.entries,
      recent: [...(state.recent || []), auditRow].slice(-RECENT_AUDIT) } };
}

module.exports = { REASON_MAX, scoreFingerprint, scoresOf, assessmentBusy, statusOf, evaluate, checkBody, prepareDecision };
