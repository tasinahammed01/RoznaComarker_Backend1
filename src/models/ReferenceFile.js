const mongoose = require('mongoose');

const { Schema } = mongoose;

// AI knowledge and reference files (services/referenceFiles, REFERENCE_FILES_ENABLED). Teacher-only background material for marking.
// Kept in its own collection on purpose: class and assignment documents reach students whole (minus a denylist), so nothing about these files is
// ever stored on them or populated into them. The original bytes live in a File record of type 'references', which no file route serves.
// Class-scope files apply to every assignment of the class; assignment-scope files to that assignment only (class is stored too, for cleanup).
const referenceFileSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  scope: { type: String, enum: ['class', 'assignment'], required: true },
  class: { type: Schema.Types.ObjectId, ref: 'Class', required: true },
  assignment: { type: Schema.Types.ObjectId, ref: 'Assignment', default: null },
  file: { type: Schema.Types.ObjectId, ref: 'File', required: true },
  // Display name only (policy.safeDisplayName); the stored file has a random name.
  originalName: { type: String, required: true, trim: true, maxlength: 120 },
  kind: { type: String, enum: ['pdf', 'docx', 'doc', 'pptx'], required: true },
  sizeBytes: { type: Number, required: true, min: 1 },
  // Client idempotency key: the same upload sent twice stores one file.
  requestId: { type: String, required: true, trim: true, maxlength: 80 },
  contentHash: { type: String, select: false },
  // The teacher ticked "This file is a rubric" (assignment scope only).
  markedAsRubric: { type: Boolean, default: false },
  status: { type: String, enum: ['processing', 'ready', 'failed'], default: 'processing' },
  failureCode: { type: String, default: null },
  failureMessage: { type: String, default: null },
  // Extracted plain text, cached once: marking never re-extracts. Never selected unless asked for.
  text: { type: String, select: false },
  textChars: { type: Number, default: 0 },
  textTruncated: { type: Boolean, default: false },
  units: { type: Number, default: null },                    // pages (PDF) or slides (PPTX), when known
  extractionVersion: { type: String, default: null },
  extractedAt: { type: Date, default: null },
  attempts: { type: Number, default: 0 },
  leaseUntil: { type: Date, default: null, select: false },
  // Deterministic rubric detection (services/referenceFiles/rubricDetect.js), assignment scope only: codes and a score, never file text.
  rubricDetection: { type: Schema.Types.Mixed, default: undefined },
  // When this file's converted rubric was applied to its assignment, and by whom.
  rubricAppliedAt: { type: Date, default: null },
  rubricAppliedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  removedAt: { type: Date, default: null },
  removedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true, versionKey: false });

referenceFileSchema.index({ owner: 1, requestId: 1 }, { unique: true, name: 'reference_file_request_v1' });
referenceFileSchema.index({ class: 1, scope: 1, removedAt: 1, createdAt: 1 }, { name: 'reference_file_class_v1' });
referenceFileSchema.index({ assignment: 1, removedAt: 1, createdAt: 1 }, { name: 'reference_file_assignment_v1' });
referenceFileSchema.index({ status: 1, leaseUntil: 1 }, { name: 'reference_file_processing_v1', partialFilterExpression: { status: 'processing' } });

// Defence in depth: whatever serializes this document never carries the text, hash, lease or stored-file id. Responses use their own allowlist.
referenceFileSchema.set('toJSON', { transform(_doc, ret) {
  delete ret.text; delete ret.contentHash; delete ret.leaseUntil; delete ret.file; return ret;
} });

module.exports = mongoose.model('ReferenceFile', referenceFileSchema);
