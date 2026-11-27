'use strict';
// The internal similarity index: one document per essay submission, holding 32-bit hashes of its 5-word sequences and nothing readable.
// hashes (indexed, multikey) are the winnowed selection used to find candidate essays; allHashes (not indexed) are every sequence's hash in
// word order (null where a sequence would cross a page break), used to mark exactly which words match. No text is stored.
const mongoose = require('mongoose');
const { Schema } = mongoose;

const fingerprintSchema = new Schema({
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true },
  assignmentId: { type: Schema.Types.ObjectId, required: true },
  classId: { type: Schema.Types.ObjectId, required: true },
  teacherId: { type: Schema.Types.ObjectId, required: true },
  institutionId: { type: Schema.Types.ObjectId },
  ownerKey: { type: String, required: true, maxlength: 80 },  // 'student:<id>' or 'guest:<sha256 of the normalised email, 24 hex>'
  textSha256: { type: String, required: true, maxlength: 64 },
  words: { type: Number, min: 0, required: true },
  hashes: { type: [Number], default: [] },
  allHashes: { type: [Number], default: [] },
  indexedAt: { type: Date, required: true }
});

fingerprintSchema.index({ submissionId: 1 }, { name: 'similarity_fingerprint_submission_v1', unique: true });
fingerprintSchema.index({ hashes: 1 }, { name: 'similarity_fingerprint_hashes_v1' });
fingerprintSchema.index({ assignmentId: 1 }, { name: 'similarity_fingerprint_assignment_v1' });

module.exports = mongoose.models.SimilarityFingerprint || mongoose.model('SimilarityFingerprint', fingerprintSchema);
