'use strict';
// One similarity report per essay submission (teacher only). It stores where the essay's words match other text (positions on the essay's
// canonical transcript, never another document's text), which sources the teacher excluded, and the job state. Percentages are never stored:
// they are computed from the sources and the exclusions on every read (services/similarity/overall.js), so the page and the PDF always agree.
// Provider names, scan ids, costs and pending provider data are select:false and only reach the teacher's audit block.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const STATUSES = Object.freeze(['queued', 'running', 'submitted', 'completed', 'failed', 'expired']);
const SOURCE_KINDS = Object.freeze(['web', 'repository', 'internal']);
const EXTERNAL_STATES = Object.freeze(['skipped', 'not_configured', 'not_permitted', 'pending', 'submitted', 'completed', 'failed', 'expired']);

const spanSchema = new Schema({
  start: { type: Number, min: 0, required: true },   // characters on the canonical text, end exclusive
  end: { type: Number, min: 0, required: true },
  wordStart: { type: Number, min: 0, required: true }, // word indexes on the canonical text, end exclusive
  wordEnd: { type: Number, min: 0, required: true }
}, { _id: false });

const sourceSchema = new Schema({
  sourceId: { type: String, required: true, maxlength: 16 },
  kind: { type: String, enum: SOURCE_KINDS, required: true },
  label: { type: String, required: true, maxlength: 200 },
  title: { type: String, maxlength: 300 },
  url: { type: String, maxlength: 2048 },
  viewUrl: { type: String, maxlength: 2048 },          // a provider's comparison page, shown unmodified (Copyscape requires this)
  // internal sources only: the other submission and its owner, never sent to the client (views.js decides what the teacher may see)
  refSubmissionId: { type: Schema.Types.ObjectId },
  refTeacherId: { type: Schema.Types.ObjectId },
  sameStudent: { type: Boolean, default: false },
  compared: { type: Boolean, default: true },          // false: the provider found it but gave no matched text (no highlight, 0%)
  approxWords: { type: Number, min: 0 },               // the provider's own count when not compared
  spans: { type: [spanSchema], default: [] },
  excluded: { type: Boolean, default: false },
  excludedAt: Date,
  excludedBy: { type: Schema.Types.ObjectId }
}, { _id: false });

const checkSchema = new Schema({
  at: { type: Date, required: true },
  by: { type: Schema.Types.ObjectId, required: true },
  requestId: { type: String, maxlength: 64 },
  textSha256: { type: String, maxlength: 64 },
  external: { type: String, enum: EXTERNAL_STATES },
  refunded: { type: Boolean, default: false }
}, { _id: false });

const reportSchema = new Schema({
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
  assignmentId: { type: Schema.Types.ObjectId, required: true },
  classId: { type: Schema.Types.ObjectId, required: true },
  teacherId: { type: Schema.Types.ObjectId, required: true },
  status: { type: String, enum: STATUSES, required: true },
  revision: { type: Number, min: 0, default: 0 },
  lastRequestId: { type: String, maxlength: 64 },
  text: {
    sha256: { type: String, maxlength: 64 },
    chars: { type: Number, min: 0 },
    words: { type: Number, min: 0 },
    origin: { type: String, enum: ['exact', 'ocr'] }
  },
  settings: {
    excludeQuotes: Boolean,
    minMatchWords: Number,
    internalScope: String
  },
  external: {
    state: { type: String, enum: EXTERNAL_STATES },
    reason: { type: String, maxlength: 64 }
  },
  sources: { type: [sourceSchema], default: [] },
  checks: { type: [checkSchema], default: [] },
  errorCode: { type: String, maxlength: 64 },
  completedAt: Date,
  inQueue: { type: Boolean, default: undefined },      // true while queued, running or submitted (the worker and the sweeper read it)
  nextAttemptAt: Date,
  job: {
    leaseUntil: Date,
    attemptKey: { type: String, select: false },
    attempts: { type: Number, min: 0, default: 0 },
    submittedAt: Date,
    deadlineAt: Date,
    resentAt: Date,
    externalRef: { type: String, maxlength: 64, select: false },
    charged: { type: Boolean, default: false }         // the provider may have charged: the daily check is not given back
  },
  // Teacher-only audit (never in a student or guest response): provider, scan id, units, estimated cost, counts. No raw payload.
  providerAudit: {
    type: new Schema({
      provider: { type: String, maxlength: 32 },
      externalRef: { type: String, maxlength: 64 },
      units: Number,
      costUsd: Number,
      resultCount: Number,
      queryWords: Number,
      errorId: { type: String, maxlength: 64 },
      at: Date
    }, { _id: false }),
    select: false,
    default: undefined
  },
  // An asynchronous provider's partial data between its webhooks (summary, per-result match positions, the text it read). Deleted on finish.
  providerPending: { type: Schema.Types.Mixed, select: false, default: undefined }
}, { timestamps: true });

reportSchema.index({ submissionId: 1 }, { name: 'similarity_report_submission_v1', unique: true });
reportSchema.index({ inQueue: 1, nextAttemptAt: 1 }, { name: 'similarity_report_queue_v1', partialFilterExpression: { inQueue: true } });
reportSchema.index({ 'job.externalRef': 1 }, { name: 'similarity_report_external_v1', unique: true,
  partialFilterExpression: { 'job.externalRef': { $type: 'string' } } });

module.exports = mongoose.models.SimilarityReport || mongoose.model('SimilarityReport', reportSchema);
module.exports.STATUSES = STATUSES;
module.exports.SOURCE_KINDS = SOURCE_KINDS;
module.exports.EXTERNAL_STATES = EXTERNAL_STATES;
