const mongoose = require('mongoose');

const { Schema } = mongoose;

const rubricLevelSchema = new Schema(
  {
    title: { type: String, trim: true },
    score: { type: Number },
    description: { type: String, trim: true }
  },
  { _id: false }
);

const rubricCriteriaSchema = new Schema(
  {
    id: { type: String, trim: true },
    name: { type: String, trim: true },
    weight: { type: Number },
    levels: { type: [rubricLevelSchema], default: [] }
  },
  { _id: false }
);

const rubricsSchema = new Schema(
  {
    totalPoints: { type: Number },
    criteria: { type: [rubricCriteriaSchema], default: [] }
  },
  { _id: false }
);

const assignmentSchema = new Schema(
  {
    title: {
      type: String,
      required: true,
      trim: true
    },
    writingType: {
      type: String,
      required: false,
      trim: true
    },
    /** PART 1 — resourceType/resourceId allow flashcard and worksheet assignments */
    resourceType: {
      type: String,
      // 'speaking' (audio + speech-to-text): created only while AUDIO_STT_ENABLED is on (services/audio/speakingAssignment.js).
      enum: ['essay', 'flashcard', 'worksheet', 'speaking'],
      default: 'essay'
    },
    resourceId: {
      type: String,
      default: null
    },
    // Speaking assignments only (absent on every other type). maxRecordingSeconds null = the policy limit (AUDIO_MAX_DURATION_SECONDS);
    // rubricRef: one of the teacher's saved rubrics, kept for the marking stage (not used yet).
    speaking: {
      type: new Schema({
        maxRecordingSeconds: { type: Number, min: 10, default: null },
        rubricRef: { type: Schema.Types.ObjectId, ref: 'SavedRubric', default: null }
      }, { _id: false }),
      default: undefined
    },
    instructions: {
      type: String,
      trim: true
    },
    rubric: {
      type: String
    },
    rubrics: {
      type: rubricsSchema,
      default: undefined
    },
    deadline: {
      type: Date,
      required: false
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true,
      index: true
    },
    teacher: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    qrToken: {
      type: String,
      unique: true,
      sparse: true,
      index: true,
      trim: true
    },
    allowLateResubmission: {
      type: Boolean,
      default: false
    },
    allowGuestSubmission: { type: Boolean, default: false },
    showMarksToStudent: {
      type: Boolean,
      default: true
    },
    // Maximum drafts including the first (services/draftLimit.service.js, DRAFT_LIMIT_ENABLED). Absent: the default limit applies when the flag
    // is on, no limit when it is off.
    maxDrafts: { type: Number, min: 2, max: 10, default: undefined },

    // Improved Writing Model (services/writingModel.service.js, IMPROVED_WRITING_MODEL_ENABLED). Teacher-only: never selected unless asked for;
    // students get only the approved, released text through their own endpoint.
    writingModel: { type: mongoose.Schema.Types.Mixed, default: undefined, select: false },

    // Whole-assignment report AI summary (services/assignmentReportSummary.service.js, ASSIGNMENT_REPORT_SUMMARY_ENABLED). Teacher-only:
    // never selected unless asked for, never copied by Duplicate, removed from toJSON. No index.
    reportSummary: { type: mongoose.Schema.Types.Mixed, default: undefined, select: false },

    allowResubmission: {
      type: Boolean,
      default: false
    },
    requireAdaptiveBeforeResubmission: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    }
  },
  {
    timestamps: true
  }
);

assignmentSchema.index({ resourceType: 1, resourceId: 1 });
// Defence in depth: even a query that selected the report summary never serialises it.
assignmentSchema.set('toJSON', { transform(_doc, ret) { delete ret.reportSummary; return ret; } });

module.exports = mongoose.model('Assignment', assignmentSchema);
