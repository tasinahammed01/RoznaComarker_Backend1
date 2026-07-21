const mongoose = require('mongoose');

const { Schema } = mongoose;

const correctionStatisticsSchema = new Schema(
  {
    content: { type: Number, default: 0 },
    grammar: { type: Number, default: 0 },
    organization: { type: Number, default: 0 },
    vocabulary: { type: Number, default: 0 },
    mechanics: { type: Number, default: 0 },
    total: { type: Number, default: 0 }
  },
  { _id: false }
);

const submissionSchema = new Schema(
  {
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    assignment: {
      type: Schema.Types.ObjectId,
      ref: 'Assignment',
      required: true
    },
    class: {
      type: Schema.Types.ObjectId,
      ref: 'Class',
      required: true
    },
    // Legacy single-file fields (kept for backward compatibility)
    file: {
      type: Schema.Types.ObjectId,
      ref: 'File',
      required: false
    },
    fileUrl: {
      type: String,
      required: false,
      trim: true
    },

    // New multi-file fields
    files: [
      {
        type: Schema.Types.ObjectId,
        ref: 'File',
        required: false
      }
    ],
    fileUrls: [
      {
        type: String,
        trim: true
      }
    ],
    ocrPages: [
      {
        fileId: { type: Schema.Types.ObjectId, ref: 'File', required: false },
        pageNumber: { type: Number, required: false },
        text: { type: String, trim: true },
        rawText: { type: String },
        words: { type: Schema.Types.Mixed, default: undefined }
      }
    ],
    combinedOcrText: {
      type: String,
      trim: true
    },
    rawCombinedOcrText: {
      type: String
    },
    status: {
      type: String,
      enum: ['submitted', 'late', 'missing'],
      required: true
    },
    submittedAt: {
      type: Date,
      required: true
    },
    isLate: {
      type: Boolean,
      required: true,
      default: false
    },
    qrToken: {
      type: String,
      trim: true
    },
    ocrStatus: {
      type: String,
      enum: ['pending', 'completed', 'failed'],
      default: undefined,
      index: true
    },
    // Legacy OCR fields (single-file)
    ocrText: {
      type: String,
      trim: true
    },
    rawOcrText: {
      type: String
    },
    ocrError: {
      type: String,
      trim: true
    },
    ocrData: {
      type: Schema.Types.Mixed,
      default: undefined
    },
    ocrUpdatedAt: {
      type: Date
    },
    // Changes on every resubmission so an older background OCR job cannot overwrite it.
    ocrJobId: {
      type: String,
      index: true
    },
    transcriptText: {
      type: String,
      trim: true
    },
    rawTranscriptText: {
      type: String
    },
    correctionStatistics: {
      type: correctionStatisticsSchema,
      default: undefined
    },
    correctionStatus: {
      type: String,
      enum: ['pending', 'processing', 'completed', 'partial', 'failed'],
      default: undefined,
      index: true
    },
    writingCorrections: { type: [Schema.Types.Mixed], default: undefined },
    correctionSourceHash: { type: String, trim: true },
    correctionVersion: { type: String, trim: true },
    correctionTranscriptLayoutVersion: { type: String, trim: true },
    correctionError: { type: String, trim: true },
    correctionUpdatedAt: { type: Date },
    correctionJobId: { type: String, index: true },
    semanticStatus: { type: String, enum: ['pending', 'processing', 'retry_wait', 'completed', 'failed'], default: undefined, index: true },
    semanticAttempt: { type: Number, min: 0, default: undefined },
    semanticMaxAttempts: { type: Number, min: 0, default: undefined },
    semanticNextRetryAt: { type: Date, default: undefined },
    semanticErrorCode: { type: String, trim: true },
    semanticSourceKey: { type: String, trim: true, index: true },
    semanticProvider: { type: String, trim: true },
    semanticModel: { type: String, trim: true },
    semanticPromptVersion: { type: String, trim: true },
    semanticMetrics: { type: Schema.Types.Mixed, default: undefined },
    evaluationStatus: { type: String, enum: ['pending', 'processing', 'completed', 'partial', 'failed', 'stale'], default: undefined, index: true },
    evaluationJobId: { type: String, index: true },
    evaluationSourceHash: { type: String, trim: true },
    evaluationVersion: { type: String, trim: true },
    evaluationRubricSourceHash: { type: String, trim: true },
    evaluationError: { type: String, trim: true },
    evaluationUpdatedAt: { type: Date },
    feedback: {
      type: Schema.Types.ObjectId,
      ref: 'Feedback'
    }
  },
  {
    timestamps: true
  }
);

submissionSchema.index({ student: 1, assignment: 1 }, { unique: true });
submissionSchema.index({ assignment: 1 });
submissionSchema.index({ class: 1 });
submissionSchema.index({ feedback: 1 });

module.exports = mongoose.model('Submission', submissionSchema);
