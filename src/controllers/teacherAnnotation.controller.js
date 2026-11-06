'use strict';
// Teacher annotation API (Task 6A). Only the teacher who owns the class and assignment may read or change a submission's overlay;
// everyone else, students and guests included, gets 404 so the endpoints do not confirm that a submission exists.
//   closed (archived) class: read-only (409 ANNOTATION_CLASS_CLOSED on writes); deleted class or assignment: 404;
//   revoked guest link: editable (the guest can no longer read it; the overlay still governs any later restore);
//   registered and guest submissions behave the same.
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const AnnotationAudit = require('../models/AnnotationAudit');
const SubmissionFeedback = require('../models/SubmissionFeedback');
const policy = require('../services/teacherAnnotation.service');
const review = require('../services/scoreReview.service');
const { currentEvaluationSettings } = require('../services/evaluationSettingsContext.service');
const studentView = require('../services/studentCorrectionView.service');
const logger = require('../utils/logger');
const { defaultLegend } = require('../services/writingCorrections.service');
const { buildCanonicalCorrectionRenderModels } = require('../services/canonicalCorrectionRender.service');

const fail = (statusCode, code) => Object.assign(new Error(code), { statusCode });
async function authorized(req, { write = false } = {}) {
  if (req.user?.role !== 'teacher' || req.guestAccessContext || !mongoose.isValidObjectId(req.params.submissionId)) throw fail(404, 'ANNOTATION_NOT_FOUND');
  const doc = await Submission.findById(req.params.submissionId).select('+teacherAnnotations').lean();
  const owned = doc && await Class.findOne({ _id: doc.class, teacher: req.user._id, isActive: true }).select('status').lean();
  if (!owned || !await Assignment.exists({ _id: doc.assignment, class: doc.class, teacher: req.user._id, isActive: true })) throw fail(404, 'ANNOTATION_NOT_FOUND');
  req.annotationClassClosed = owned.status === 'archived';
  if (write && req.annotationClassClosed) throw fail(409, 'ANNOTATION_CLASS_CLOSED');
  return doc;
}

const COUNT_KEYS = ['content', 'organization', 'grammar', 'vocabulary', 'mechanics', 'total'];
const counts = stats => Object.fromEntries(COUNT_KEYS.map(key => [key, Number(stats?.[key] || 0)]));
/** The grade check as of now, read from the current feedback and the assignment's current settings. Reads only. */
async function evaluateReview(doc) {
  const [feedback, assignment] = await Promise.all([SubmissionFeedback.findOne({ submissionId: doc._id }).lean(), Assignment.findById(doc.assignment).lean()]);
  return { feedback, current: review.evaluate(doc, feedback, assignment ? await currentEvaluationSettings(assignment) : null) };
}
/** What the teacher sees. countsScored: the list the scores were computed from; countsVisible: what the student is shown now. */
function reviewPayload(current, doc, visibleStatistics) {
  return { status: current.status, scores: current.scores, fingerprint: current.fingerprint, decision: current.state.scoringReview?.decision ?? null,
    countsScored: counts(doc.correctionStatistics), countsVisible: counts(visibleStatistics) };
}

async function snapshot(doc, classClosed) {
  const { canonical, sourceHash } = policy.source(doc);
  const view = studentView.buildStudentCorrectionView(doc, { overlay: doc.teacherAnnotations ?? null, audience: 'teacher' });
  const pages = await Promise.all(canonical.pages.map(async page => {
    const stored = doc.ocrPages.find(p => String(p.fileId) === page.fileId && p.pageNumber === page.pageNumber);
    const separators = new Map(page.words.map(w => [w.id, w.separatorBefore]));
    const words = require('../services/ocrCorrections.service').normalizeOcrWordsFromStored(page.words,
      { fileId: page.fileId, preserveSourceTokens: doc.sourceFidelityMode === 'gpt_vision_exact' })
      .map(w => ({ ...w, separatorBefore: separators.get(w.id) || '' }));
    const sourceGeometry = await require('../services/annotationImageGeometry.service').annotationImageGeometry(stored,
      id => require('../models/File').findById(id).select('path').lean());
    return { ...page, words, sourceGeometry, pageImageUrl: stored?.pageImageUrl };
  }));
  const { current } = await evaluateReview(doc);
  // Teacher only: the reader may have skipped a written line. This endpoint is the only place it leaves the server; students never get sourceVerificationSummary.
  const possibleMissedLines = (doc.ocrPages || []).reduce((sum, page) => sum + (Number(page?.sourceVerificationSummary?.performance?.geometry?.possibleMissedLineCount) || 0), 0);
  return { possibleMissedLines, revision: view.revision, sourceHash, scoringReviewRequired: Boolean(view.scoringReviewRequired), scoreReview: reviewPayload(current, doc, view.statistics),
    pages, legend: defaultLegend(), corrections: view.rows, orphans: view.orphans, archivedOrphans: view.archivedOrphans,
    readOnly: Boolean(classClosed), readOnlyReason: classClosed ? 'CLASS_CLOSED' : null,
    effective: buildCanonicalCorrectionRenderModels(view.corrections, canonical, doc.ocrPages, { submission: doc }),
    transitions: { ...policy.TRANSITIONS, orphan: policy.ORPHAN_TRANSITIONS }, publication: 'saved-effective' };
}

/** Audit rows kept on the overlay (the last few, and version 1 history) that are not yet in the collection. Idempotent. */
async function syncAudit(doc, rows) {
  const list = rows || [...(policy.normalizeState(doc.teacherAnnotations).recent || []),
    ...(policy.normalizeState(doc.teacherAnnotations).legacyAudit || []).map(legacyRow)];
  if (!list.length) return;
  await AnnotationAudit.bulkWrite(list.map(row => ({ updateOne: { filter: { submissionId: doc._id, requestId: row.requestId },
    update: { $setOnInsert: { ...row, submissionId: doc._id, classId: doc.class || null, createdAt: new Date(row.createdAt) } }, upsert: true } })),
  { ordered: false });
}
const legacyRow = row => ({ requestId: row.requestId, requestHash: row.requestHash, action: row.action, actor: String(row.actor),
  entryId: row.correctionId || null, correctionId: row.correctionId || null, previousRevision: row.previousRevision, newRevision: row.newRevision,
  before: row.before ?? null, after: row.after ?? null, changedFields: row.changedFields || [], visibilityChanged: Boolean(row.visibilityChanged),
  scoringReviewRequired: Boolean(row.scoringReviewRequired), legacy: true, createdAt: row.timestamp || new Date(0).toISOString() });

const endpoint = fn => async (req, res) => { try { res.set('Cache-Control', 'private, no-store'); await fn(req, res); } catch (error) {
  const code = /^ANNOTATION_[A-Z_]+$/.test(error.message) ? error.message : 'ANNOTATION_OPERATION_FAILED';
  if (!error.statusCode) logger.error({ event: 'teacher_annotation_failed', submissionId: String(req.params.submissionId || ''), error: error.name });
  res.status(error.statusCode || 500).json({ success: false, code, message: code });
} };

const get = endpoint(async (req, res) => { const doc = await authorized(req); res.json({ success: true, data: await snapshot(doc, req.annotationClassClosed) }); });

const history = endpoint(async (req, res) => {
  const doc = await authorized(req);
  const offset = Number(req.query.offset || 0);
  if (!Number.isInteger(offset) || offset < 0 || offset > 1e6) throw fail(400, 'ANNOTATION_INVALID_REQUEST');
  await syncAudit(doc);
  const rows = await AnnotationAudit.find({ submissionId: doc._id }).sort({ newRevision: -1, createdAt: -1 }).skip(offset).limit(21)
    .select('-_id -requestHash').lean();
  res.json({ success: true, data: { items: rows.slice(0, 20), nextOffset: rows.length > 20 ? offset + 20 : null } });
});

/** Writes the whole overlay, only if the submission and the overlay revision are still what the request was checked against. */
async function saveOverlay(doc, state) {
  const match = { _id: doc._id, class: doc.class, assignment: doc.assignment };
  for (const key of ['ocrJobId','ocrUpdatedAt','correctionUpdatedAt','draftNumber','ocrPages','writingCorrections',
    'files','file','fileOrder','sourceFidelityMode','sourceReviewStatus','ocrStatus','assessmentStatus','correctionStatus','evaluationStatus']) match[key] = doc[key] === undefined ? { $exists: false } : doc[key];
  match['teacherAnnotations.revision'] = doc.teacherAnnotations?.revision === undefined ? { $exists: false } : doc.teacherAnnotations.revision;
  const saved = await Submission.updateOne(match, { $set: { teacherAnnotations: state } });
  if (saved.modifiedCount !== 1) throw fail(409, 'ANNOTATION_REVISION_CONFLICT');
}

const mutate = endpoint(async (req, res) => {
  const doc = await authorized(req, { write: true });
  policy.checkBody(req.body);
  const prior = await AnnotationAudit.findOne({ submissionId: doc._id, requestId: req.body.requestId }).lean();
  const resolution = studentView.resolveOverlay(doc, doc.teacherAnnotations ?? null);
  const result = policy.prepare(doc, req.user._id, req.body, { resolution, prior });
  if (result.replay) { await syncAudit(doc); return res.json({ success: true, data: { revision: result.revision, replay: true } }); }
  if (review.assessmentBusy(doc)) throw fail(409, 'ANNOTATION_ASSESSMENT_BUSY');
  await saveOverlay(doc, result.state);
  // The overlay already holds the row (state.recent), so a failed insert is repaired by the next history read or replay.
  try { await syncAudit(doc, [...result.legacyAudit.map(legacyRow), result.auditRow]); }
  catch (error) { logger.error({ event: 'teacher_annotation_audit_deferred', submissionId: String(doc._id), error: error.name }); }
  res.json({ success: true, data: { revision: result.revision } });
});

// Phase A: bulk hide / restore by ids, by category, or (restore) all hidden. Same owner check (404), class-closed rule, assessment lock,
// revision and idempotency as a single action; one audit row per changed item; one overlay write. Scores are never recomputed: like a
// single hide, it only sets the grade-check flag.
const resolveForBulk = (doc, overlay) => { const r = studentView.resolveOverlay(doc, overlay); return { resolution: r, rows: r.rows, orphans: r.orphans, archivedOrphans: r.archivedOrphans }; };
const bulk = endpoint(async (req, res) => {
  const doc = await authorized(req, { write: true });
  policy.checkBulkBody(req.body, defaultLegend().groups.map(g => g.key));
  const stored = policy.normalizeState(doc.teacherAnnotations);
  const prefix = new RegExp(`^${req.body.requestId.replace(/[^a-f0-9-]/gi, '')}:\\d{3}$`, 'i');
  const priorRows = [...await AnnotationAudit.find({ submissionId: doc._id, requestId: prefix }).lean(), ...(stored.recent || []).filter(row => prefix.test(row.requestId))];
  const unique = [...new Map(priorRows.map(row => [row.requestId, row])).values()];
  const replay = policy.bulkReplayOf(unique, req.user._id, req.body);
  if (replay) { await syncAudit(doc); return res.json({ success: true, data: replay }); }
  if (review.assessmentBusy(doc)) throw fail(409, 'ANNOTATION_ASSESSMENT_BUSY');
  const result = policy.prepareBulk(doc, req.user._id, req.body, { resolve: resolveForBulk });
  if (!result.changedIds.length) return res.json({ success: true, data: { revision: result.revision, changedIds: [] } });
  await saveOverlay(doc, result.state);
  try { await syncAudit(doc, [...result.legacyAudit.map(legacyRow), ...result.auditRows]); }
  catch (error) { logger.error({ event: 'teacher_annotation_audit_deferred', submissionId: String(doc._id), error: error.name }); }
  res.json({ success: true, data: { revision: result.revision, changedIds: result.changedIds } });
});

// Task 7C: "keep these scores". Writes the teacher overlay and the audit row, nothing else: it only reads the feedback document, calls no AI
// and spends no credits. It goes through the overlay revision, so it serialises against annotation writes.
const scoreReview = endpoint(async (req, res) => {
  const doc = await authorized(req, { write: true });
  review.checkBody(req.body);
  const prior = await AnnotationAudit.findOne({ submissionId: doc._id, requestId: req.body.requestId }).lean();
  const stored = policy.normalizeState(doc.teacherAnnotations);
  const visible = () => studentView.buildStudentCorrectionView(doc, { overlay: doc.teacherAnnotations ?? null }).statistics;
  const replay = policy.replayOf(prior || (stored.recent || []).find(row => row.requestId === req.body.requestId), req.user._id, req.body);
  if (replay) {
    await syncAudit(doc);
    const { current } = await evaluateReview(doc);
    return res.json({ success: true, data: { revision: replay.revision, replay: true, scoreReview: reviewPayload(current, doc, visible()) } });
  }
  if (review.assessmentBusy(doc)) throw fail(409, 'ANNOTATION_ASSESSMENT_BUSY');
  if (req.body.revision !== stored.revision || req.body.sourceHash !== policy.source(doc).sourceHash) throw fail(409, 'ANNOTATION_REVISION_CONFLICT');
  const { current } = await evaluateReview(doc);
  if (!current.evaluationCurrent) throw fail(409, 'ANNOTATION_EVALUATION_NOT_CURRENT');
  if (req.body.scoreFingerprint !== current.fingerprint) throw fail(409, 'ANNOTATION_SCORE_CHANGED');
  if (current.status !== 'needed') throw fail(409, 'ANNOTATION_REVIEW_NOT_NEEDED');
  const result = review.prepareDecision({ doc, actor: req.user._id, body: req.body, review: current });
  await saveOverlay(doc, result.state);
  try { await syncAudit(doc, [...result.legacyAudit.map(legacyRow), result.auditRow]); }
  catch (error) { logger.error({ event: 'teacher_annotation_audit_deferred', submissionId: String(doc._id), error: error.name }); }
  const saved = { ...doc, teacherAnnotations: result.state };
  res.json({ success: true, data: { revision: result.revision, scoreReview: reviewPayload({ ...current, state: result.state, status: 'checked' }, saved,
    studentView.buildStudentCorrectionView(saved, { overlay: result.state }).statistics) } });
});

/** Runs a student-facing handler as the submission's owner and returns the body it would send. */
async function asOwner(handler, doc) {
  const owner = doc.submissionMode === 'guest' ? { guestAccessContext: require('../services/submissionAccessContext.service').guestContext(doc) }
    : { user: { _id: doc.student, role: 'student' } };
  const req = { method: 'GET', params: { submissionId: String(doc._id) }, query: {}, body: {}, headers: {}, ...owner };
  let status = 200, body = null;
  const res = { status(code) { status = code; return this; }, json(value) { body = value; return this; }, send(value) { body = value; return this; },
    set() { return this; }, setHeader() { return this; } };
  await handler(req, res);
  return { status, body };
}

// Exactly what the student receives, produced by the student endpoints themselves (and so by the same builder).
const preview = endpoint(async (req, res) => {
  const doc = await authorized(req);
  const [corrections, feedback] = await Promise.all([asOwner(require('./submission.controller').getOcrCorrections, doc),
    asOwner(require('./feedback.controller').getSubmissionFeedback, doc)]);
  res.json({ success: true, data: { audience: doc.submissionMode === 'guest' ? 'guest' : 'student',
    ocrCorrections: corrections.body?.data ?? null, ocrCorrectionsStatus: corrections.status,
    feedback: feedback.body?.data ?? null, feedbackStatus: feedback.status } });
});

module.exports = { get, history, mutate, bulk, scoreReview, preview };
