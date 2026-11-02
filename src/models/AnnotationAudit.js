'use strict';
const mongoose = require('mongoose');

// Append-only history of teacher annotation changes (Task 6A). One row per applied request; no row cap. The unique
// (submissionId, requestId) index makes every write idempotent. Teacher-only content: never sent to students.
// Retention: kept for the life of the submission. ANNOTATION_AUDIT_TTL_DAYS (positive integer) adds a TTL index; changing it later
// needs collMod on 'annotation_audit_ttl_v2' (createIndexes does not rewrite an existing index).
// score_review rows (who confirmed which scores) never expire. The index covers only actions sorted before 'score_review': the one partial
// filter that works on every MongoDB version ($in needs 6.0, $nin and $ne are never allowed). A later action sorted after it is kept too, the
// safe side; tests/annotationScoreReview.test.js pins the list. Version 1 of the index expired every row: the index migration drops it.
const annotationAuditSchema = new mongoose.Schema({
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true },
  classId: { type: mongoose.Schema.Types.ObjectId, ref: 'Class', default: null },
  requestId: { type: String, required: true, maxlength: 64 },
  requestHash: { type: String, required: true, maxlength: 64 },
  action: { type: String, enum: ['add', 'edit', 'hide', 'restore', 'archive', 'reject', 'score_review'], required: true },
  actor: { type: String, required: true, maxlength: 64 },
  entryId: { type: String, default: null, maxlength: 120 },
  correctionId: { type: String, default: null, maxlength: 120 },
  previousRevision: { type: Number, required: true },
  newRevision: { type: Number, required: true },
  draftNumber: { type: Number, default: null },
  before: { type: mongoose.Schema.Types.Mixed, default: null },
  after: { type: mongoose.Schema.Types.Mixed, default: null },
  changedFields: { type: [String], default: [] },
  visibilityChanged: { type: Boolean, default: false },
  scoringReviewRequired: { type: Boolean, default: false },
  legacy: { type: Boolean, default: undefined },
  // score_review only. The reason is stored raw and escaped wherever it is rendered.
  reason: { type: String, default: undefined, maxlength: 500 },
  source: { type: String, default: undefined, maxlength: 40 },
  createdAt: { type: Date, required: true },
}, { versionKey: false });

annotationAuditSchema.index({ submissionId: 1, requestId: 1 }, { unique: true, name: 'annotation_audit_request_v1' });
annotationAuditSchema.index({ submissionId: 1, newRevision: -1 }, { name: 'annotation_audit_submission_v1' });
const ttlDays = Number(process.env.ANNOTATION_AUDIT_TTL_DAYS);
if (Number.isInteger(ttlDays) && ttlDays > 0) {
  annotationAuditSchema.index({ createdAt: 1 }, { name: 'annotation_audit_ttl_v2', expireAfterSeconds: ttlDays * 24 * 60 * 60, partialFilterExpression: { action: { $lt: 'score_review' } } });
}

module.exports = mongoose.models.AnnotationAudit || mongoose.model('AnnotationAudit', annotationAuditSchema);
