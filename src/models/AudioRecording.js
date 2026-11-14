const mongoose = require('mongoose');

const { Schema } = mongoose;

// One uploaded audio recording and its speech-to-text job (services/audio, AUDIO_STT_ENABLED). Kept in its own collection so the already heavy
// Submission documents never carry words or transcripts; a speaking Submission will point here (submissionId, linked in a later stage).
// The audio bytes live in a File record of type 'audio', which no file route serves.
//
// Rules enforced below, not left to callers:
// - The raw transcript (what the provider returned) is written once, by the worker, and never changed or removed by an update.
// - Teacher edits are append-only: editedRevisions only ever receives $push.
// Retention (none in v1: audio is kept until its submission is deleted): audioDeletedAt, audioDeletionReason, purgeAfter and retentionHold are
// the hooks a later retention job needs. The transcript does not depend on the audio file, so deleting the audio never loses it.
const STATUSES = Object.freeze(['uploaded', 'queued', 'transcribing', 'ready', 'failed', 'cancelled']);

const transcriptRevisionSchema = new Schema({
  revision: { type: Number, required: true, min: 1 },
  baseRevision: { type: Number, required: true, min: 0 },
  text: { type: String, required: true, maxlength: 50000 },
  editedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  editedAt: { type: Date, required: true },
  requestId: { type: String, trim: true, maxlength: 80 }
}, { _id: false });

const audioRecordingSchema = new Schema({
  owner: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  // Client idempotency key: the same upload sent twice stores one recording.
  requestId: { type: String, required: true, trim: true, maxlength: 80 },
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', default: null },
  audioFileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
  contentType: { type: String, required: true, trim: true, maxlength: 40 },
  sizeBytes: { type: Number, required: true, min: 1 },
  durationSeconds: { type: Number, min: 0, default: null },
  audioSha256: { type: String, match: /^[a-f0-9]{64}$/, select: false },
  // Exactly what was charged to whose storage quota, so a later deletion releases exactly that.
  storageChargedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  storageChargedMB: { type: Number, min: 0, default: 0 },
  audioDeletedAt: { type: Date, default: null },
  audioDeletionReason: { type: String, trim: true, maxlength: 64, default: null },
  purgeAfter: { type: Date, default: null },
  retentionHold: { type: Boolean, default: false },

  status: { type: String, enum: STATUSES, default: 'uploaded' },
  // true while queued or transcribing (unset otherwise): the partial processing index holds only the work still to do.
  processingQueue: { type: Boolean, default: undefined, select: false },
  attempts: { type: Number, min: 0, default: 0 },
  leaseUntil: { type: Date, default: null, select: false },
  // A new random key per claim: a result is stored only by the attempt that holds the current key.
  attemptKey: { type: String, default: undefined, select: false },
  nextAttemptAt: { type: Date, default: null },
  queuedAt: { type: Date, default: null },
  readyAt: { type: Date, default: null },
  failedAt: { type: Date, default: null },
  cancelledAt: { type: Date, default: null },
  lastErrorCode: { type: String, trim: true, maxlength: 64, default: null },

  // Summary of the stored transcript (safe to read without loading it).
  transcriptSchemaVersion: { type: String, default: null },
  wordTimingsAvailable: { type: Boolean, default: null },
  speakingCoachDataAvailable: { type: Boolean, default: null },
  // The raw transcript in the stored schema (services/audio/stt/transcript.js), provider fields included. Server-only; never selected unless asked.
  transcript: { type: Schema.Types.Mixed, default: undefined, select: false },
  // Texts and metrics derived from the raw transcript (recomputable from it). Never selected unless asked.
  derived: { type: Schema.Types.Mixed, default: undefined, select: false },
  editedRevisions: { type: [transcriptRevisionSchema], default: undefined, select: false }
}, { timestamps: true, versionKey: false });

audioRecordingSchema.index({ owner: 1, requestId: 1 }, { unique: true, name: 'audio_recording_request_v1' });
audioRecordingSchema.index({ processingQueue: 1, nextAttemptAt: 1, leaseUntil: 1 },
  { name: 'audio_recording_processing_v1', partialFilterExpression: { processingQueue: true } });

const immutable = () => Object.assign(new Error('The raw transcript cannot be changed; edits are appended.'), { code: 'AUDIO_TRANSCRIPT_IMMUTABLE' });
const touchesTranscript = key => key === 'transcript' || key.startsWith('transcript.');
const touchesEdits = key => key === 'editedRevisions' || key.startsWith('editedRevisions.');

function guardUpdate() {
  const update = this.getUpdate();
  if (Array.isArray(update)) throw immutable();                                // a pipeline update cannot be checked: refused
  const options = this.getOptions() || {};
  for (const [operator, value] of Object.entries(update || {})) {
    const keys = operator.startsWith('$') ? Object.keys(value || {}) : [operator];
    for (const key of keys) {
      // The worker's single write: only into a document that has no transcript yet, and only when it says so.
      if (touchesTranscript(key) && !(operator === '$set' && key === 'transcript' && options.writeTranscriptOnce === true && this.getFilter().transcript === null)) throw immutable();
      if (touchesEdits(key) && operator !== '$push') throw immutable();
    }
  }
}
for (const operation of ['updateOne', 'updateMany', 'findOneAndUpdate']) audioRecordingSchema.pre(operation, guardUpdate);
for (const operation of ['replaceOne', 'findOneAndReplace']) audioRecordingSchema.pre(operation, () => { throw immutable(); });
audioRecordingSchema.pre('save', function guardSave() {
  if (!this.isNew && (this.isModified('transcript') || this.isModified('editedRevisions'))) throw immutable();
});

// Defence in depth: whatever serialises this document never carries the worker fields, the hash, the transcript or the edits.
audioRecordingSchema.set('toJSON', { transform(_doc, ret) {
  for (const key of ['leaseUntil', 'attemptKey', 'processingQueue', 'audioSha256', 'transcript', 'derived', 'editedRevisions']) delete ret[key];
  return ret;
} });

module.exports = mongoose.model('AudioRecording', audioRecordingSchema);
module.exports.STATUSES = STATUSES;
