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
const policy = require('../services/teacherAnnotation.service');
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
  return { revision: view.revision, sourceHash, scoringReviewRequired: Boolean(view.scoringReviewRequired),
    pages, legend: defaultLegend(), corrections: view.rows, orphans: view.orphans, archivedOrphans: view.archivedOrphans,
    readOnly: Boolean(classClosed), readOnlyReason: classClosed ? 'CLASS_CLOSED' : null,
    effective: buildCanonicalCorrectionRenderModels(view.corrections, canonical, doc.ocrPages, { submission: doc }),
    transitions: { ...policy.TRANSITIONS, orphan: policy.ORPHAN_TRANSITIONS }, publication: 'saved-effective',
    scorePolicy: 'Annotation changes do not change grades. Review substantive changes using the existing teacher grading controls.' };
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

const mutate = endpoint(async (req, res) => {
  const doc = await authorized(req, { write: true });
  policy.checkBody(req.body);
  const prior = await AnnotationAudit.findOne({ submissionId: doc._id, requestId: req.body.requestId }).lean();
  const resolution = studentView.resolveOverlay(doc, doc.teacherAnnotations ?? null);
  const result = policy.prepare(doc, req.user._id, req.body, { resolution, prior });
  if (result.replay) { await syncAudit(doc); return res.json({ success: true, data: { revision: result.revision, replay: true } }); }
  if (['pending','processing'].includes(doc.ocrStatus) || ['started','processing','queued','pending'].includes(doc.assessmentStatus)
    || ['pending','processing'].includes(doc.correctionStatus) || ['pending','processing'].includes(doc.evaluationStatus)) throw fail(409, 'ANNOTATION_ASSESSMENT_BUSY');
  const match = { _id: doc._id, class: doc.class, assignment: doc.assignment };
  for (const key of ['ocrJobId','ocrUpdatedAt','correctionUpdatedAt','draftNumber','ocrPages','writingCorrections',
    'files','file','fileOrder','sourceFidelityMode','sourceReviewStatus','ocrStatus','assessmentStatus','correctionStatus','evaluationStatus']) match[key] = doc[key] === undefined ? { $exists: false } : doc[key];
  match['teacherAnnotations.revision'] = doc.teacherAnnotations?.revision === undefined ? { $exists: false } : doc.teacherAnnotations.revision;
  const saved = await Submission.updateOne(match, { $set: { teacherAnnotations: result.state } });
  if (saved.modifiedCount !== 1) throw fail(409, 'ANNOTATION_REVISION_CONFLICT');
  // The overlay already holds the row (state.recent), so a failed insert is repaired by the next history read or replay.
  try { await syncAudit(doc, [...result.legacyAudit.map(legacyRow), result.auditRow]); }
  catch (error) { logger.error({ event: 'teacher_annotation_audit_deferred', submissionId: String(doc._id), error: error.name }); }
  res.json({ success: true, data: { revision: result.revision } });
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

module.exports = { get, history, mutate, preview };
