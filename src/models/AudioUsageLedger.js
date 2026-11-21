const mongoose = require('mongoose');

const { Schema } = mongoose;

// Speech-to-text minutes, one row per transcription ATTEMPT (services/audio/usage.js). Kept apart from CreditTransaction: minutes are a free,
// capped allowance, not credits. Minutes count against the OWNING teacher (minutesChargedTo), whoever uploaded (student, guest, teacher).
//   reserved  taken before the provider call; counts toward the caps until its lease ends (expiresAt)
//   consumed  the transcript was stored: counts for good
//   released  the attempt failed or was cancelled: never counts
//   expired   left by a stopped process; set lazily once expiresAt has passed: never counts
//   refused   over a cap: kept for the record, never counts
// key = "<recordingId>:<attemptKey>" (one per attempt): a retried call of the same attempt finds its row instead of counting again.
// At most one 'reserved' row per teacher and per uploader (unique partial indexes): the cap check is exact without transactions, and one user
// never has two transcriptions in flight.
const STATES = Object.freeze(['reserved', 'consumed', 'released', 'expired', 'refused']);

const audioUsageLedgerSchema = new Schema({
  key: { type: String, required: true, maxlength: 120 },
  recordingId: { type: Schema.Types.ObjectId, ref: 'AudioRecording', required: true },
  uploader: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  minutesChargedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  institutionId: { type: Schema.Types.ObjectId, ref: 'Institution', default: null },
  seconds: { type: Number, required: true, min: 1 },
  // UTC day and month of the reservation: the minutes count on the day the attempt started.
  dayKey: { type: String, required: true, match: /^\d{4}-\d{2}-\d{2}$/ },
  monthKey: { type: String, required: true, match: /^\d{4}-\d{2}$/ },
  state: { type: String, enum: STATES, required: true },
  reservedAt: { type: Date, required: true },
  expiresAt: { type: Date, required: true },
  closedAt: { type: Date, default: null },
  reason: { type: String, trim: true, maxlength: 64, default: null }
}, { timestamps: true, versionKey: false });

audioUsageLedgerSchema.index({ key: 1 }, { unique: true, name: 'audio_usage_key_v1' });
audioUsageLedgerSchema.index({ minutesChargedTo: 1, monthKey: 1, state: 1 }, { name: 'audio_usage_teacher_month_v1' });
audioUsageLedgerSchema.index({ minutesChargedTo: 1 }, { unique: true, name: 'audio_usage_inflight_teacher_v1', partialFilterExpression: { state: 'reserved' } });
audioUsageLedgerSchema.index({ uploader: 1 }, { unique: true, name: 'audio_usage_inflight_uploader_v1', partialFilterExpression: { state: 'reserved' } });
audioUsageLedgerSchema.index({ recordingId: 1 }, { name: 'audio_usage_recording_v1' });

module.exports = mongoose.model('AudioUsageLedger', audioUsageLedgerSchema);
module.exports.STATES = STATES;
