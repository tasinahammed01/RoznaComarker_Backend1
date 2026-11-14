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
    // Downstream teacher overrides and audit are atomic; never part of AI persistence.
    teacherAnnotations: { type: Schema.Types.Mixed, select: false },
    student: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: function () { return this.submissionMode !== 'guest'; }
    },
    submissionMode: { type: String, enum: ['registered', 'guest'], default: 'registered' },
    guest: {
      displayName: { type: String, maxlength: 120 },
      normalizedEmail: { type: String, maxlength: 254, select: false },
      requestHash: { type: String, select: false },
      accessHash: { type: String, select: false },
      resultAccessHash: { type: String, select: false },
      resultExpiresAt: Date,
      resultEmailSentAt: Date,
      resultEmailLeaseUntil: Date,
      resultEmailNextAttemptAt: Date,
      expiresAt: Date,
      revokedAt: Date,
      recoveredAt: Date,
      // Links issued by email recovery. A resend ADDS a link and never invalidates the student's other links, so a third party
      // who knows the email cannot cut off a working link. Hashes only; the newest 10 are kept.
      recoveryAccess: { type: [{ _id: false, hash: String, expiresAt: Date, createdAt: Date }], select: false, default: undefined }
    },
    guestRequestKey: { type: String, select: false },
    registeredRequestKey: { type: String, select: false },
    guestRevisionLease: { owner: String, until: Date },
    guestAcceptedRevisionKey: { type: String, select: false },
    // Work a teacher uploaded for a student (photos of handwritten pages), on a registered or a guest submission. Teacher and
    // server only: hidden from default queries and stripped from toJSON. requestKey/contentHash are hashes of the client's
    // per-student idempotency key and of the uploaded content; email is sent only when the teacher asks ("Save and send").
    teacherUpload: {
      type: new Schema({
        uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
        batchId: { type: String, maxlength: 64, required: true },
        // The student name exactly as the teacher typed it (for a class member the account name may differ). Teacher-only.
        typedName: { type: String, maxlength: 200 },
        requestKey: { type: String, maxlength: 64 },
        contentHash: { type: String, maxlength: 64 },
        uploadedAt: { type: Date, required: true },
        email: {
          type: new Schema({
            // held = asked for, but marking failed: not sent; goes back to queued when the teacher retries marking.
            status: { type: String, enum: ['none', 'queued', 'sending', 'sent', 'failed', 'held'], default: 'none' },
            requestedAt: Date,
            leaseUntil: Date,
            nextAttemptAt: Date,
            sentAt: Date,
            failedAt: Date,
            attempts: { type: Number, min: 0, default: 0 },
            lastErrorCode: { type: String, maxlength: 64 },
            // The last send attempt, as the SMTP server answered it: times, counts and codes only (never an address or the
            // server's text). "sent" means the server accepted the recipient; inbox delivery can still be delayed or filtered.
            sendStartedAt: Date,
            durationMs: { type: Number, min: 0 },
            acceptedCount: { type: Number, min: 0 },
            rejectedCount: { type: Number, min: 0 },
            smtpResponseCode: { type: Number, min: 0, max: 999 },
            smtpEnhancedStatus: { type: String, maxlength: 16 },
            messageId: { type: String, maxlength: 256 },
            // "Resend email" on an email that was already sent: the request id makes a repeated click a no-op.
            resendRequestId: { type: String, maxlength: 64 }
          }, { _id: false }),
          default: () => ({})
        }
      }, { _id: false }),
      default: undefined,
      select: false
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
    fileOrder: [{
      _id: false,
      fileId: { type: Schema.Types.ObjectId, ref: 'File', required: true },
      order: { type: Number, min: 0, required: true }
    }],
    fileUrls: [
      {
        type: String,
        trim: true
      }
    ],
    ocrPages: [
      {
        sourceTextExact: String,
        sourceTextSha256: String,
        sourceFidelityStatus: String,
        sourceFidelityMode: String,
        sourcePrimaryProvider: String,
        sourcePrimaryModel: String,
        sourceSecondaryProvider: String,
        sourceSecondaryModel: String,
        sourceDisagreementCount: Number,
        sourceUncertainSpans: { type: Schema.Types.Mixed, default: undefined },
        sourceInputSha256: String,
        sourceFidelityVersion: String,
        sourceHumanReceiptHash: String,
        sourceHumanReviewUnresolved: Number,
        sourceVerificationStage: String,
        sourceVerificationSummary: { type: Schema.Types.Mixed, default: undefined },
        fileId: { type: Schema.Types.ObjectId, ref: 'File', required: false },
        fileOrder: { type: Number, min: 0, required: false },
        pageNumber: { type: Number, required: false },
        pageIndex: { type: Number, min: 0, required: false },
        width: Number,
        height: Number,
        coordinateSpace: { type: String, enum: ['display-image', 'encoded-image'] },
        ocrImageWidth: Number,
        ocrImageHeight: Number,
        ocrExifOrientation: Number,
        sourceSha256: String,
        ocrInputSha256: String,
        encodedImageWidth: Number,
        encodedImageHeight: Number,
        sourceMimeType: String,
        ocrProvider: String,
        ocrApi: String,
        ocrPipelineVersion: String,
        studentSourceVersion: String,
        studentSourceTextSha256: String,
        studentSourceEvidence: { type: Schema.Types.Mixed, select:false },
        ocrPreprocessingVersion: String,
        ocrRunId: String,
        ocrCreatedAt: Date,
        derivedImageFileId: { type: Schema.Types.ObjectId, ref: 'File' },
        pageImageUrl: String,
        rasterHash: String,
        rasterizationVersion: String,
        text: { type: String, trim: true },
        rawText: { type: String },
        words: { type: Schema.Types.Mixed, default: undefined }
      }
    ],
    combinedOcrText: {
      type: String,
      trim: true
    },
    sourceTranscriptExact: String,
    sourceTranscriptSha256: String,
    sourceFidelityStatus: String,
    sourceFidelityMode: String,
    sourceFidelityVersion: String,
    sourceFidelityInputIdentity: String,
    sourceHumanReviewId: String,
    sourceHumanReviewSummary: { type: Schema.Types.Mixed, default: undefined },
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
    ocrErrorCode: { type: String, trim: true },
    ocrFailures: { type: [Schema.Types.Mixed], default: undefined },
    ocrData: {
      type: Schema.Types.Mixed,
      default: undefined
    },
    ocrUpdatedAt: {
      type: Date
    },
    ocrCoordinateSpaceReviewRequired: { type: Boolean, default: undefined },
    draftNumber: { type: Number, min: 1, default: 1 },
    previousRevision: { type: Schema.Types.ObjectId, ref: 'SubmissionRevision', default: null },
    fileContentIdentity: { type: String, trim: true, index: true },
    reusedFromRevisionId: { type: Schema.Types.ObjectId, ref: 'SubmissionRevision', default: null },
    reusedAssessment: { type: Boolean, default: false },
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
    correctionOcrJobId: String,
    correctionOcrEvidenceHash: String,
    correctionGenerationConfig: { type: Schema.Types.Mixed, default: undefined },
    languageToolStatus: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: undefined },
    languageToolSourceHash: { type: String, trim: true },
    languageToolVersion: { type: String, trim: true },
    languageToolMappingVersion: { type: String, trim: true },
    languageToolTranscriptLayoutVersion: { type: String, trim: true },
    semanticStatus: { type: String, enum: ['pending', 'processing', 'retry_wait', 'completed', 'partial', 'failed'], default: undefined, index: true },
    semanticAttempt: { type: Number, min: 0, default: undefined },
    semanticMaxAttempts: { type: Number, min: 0, default: undefined },
    semanticNextRetryAt: { type: Date, default: undefined },
    semanticErrorCode: { type: String, trim: true },
    // Task 20: a retry of the correction stage alone, after it failed (correctionStageRetry.service.js). Never re-scores, never charges a credit.
    // Kept apart from correctionStatus/semanticStatus so the recovery sweeper never mistakes it for a stuck full analysis. Teacher/server only.
    correctionRetry: {
      jobId: { type: String, trim: true },
      status: { type: String, enum: ['scheduled', 'processing', 'completed', 'failed'] },
      trigger: { type: String, enum: ['automatic', 'manual'] },
      startedAt: { type: Date },
      finishedAt: { type: Date },
      automaticCount: { type: Number, min: 0 },
      manualCount: { type: Number, min: 0 },
      lastErrorCode: { type: String, trim: true }
    },
    semanticSourceKey: { type: String, trim: true, index: true },
    semanticProvider: { type: String, trim: true },
    semanticModel: { type: String, trim: true },
    semanticPromptVersion: { type: String, trim: true },
    correctionLegendSource: { type: String, enum: ['DATABASE', 'VERSIONED_FALLBACK'], default: undefined },
    correctionLegendVersion: { type: String, trim: true },
    correctionLegendContentHash: { type: String, trim: true },
    deductionPolicyVersion: { type: String, trim: true },
    semanticMetrics: { type: Schema.Types.Mixed, default: undefined },
    evaluationStatus: { type: String, enum: ['pending', 'processing', 'completed', 'partial', 'failed', 'stale', 'blocked'], default: undefined, index: true },
    evaluationJobId: { type: String, index: true },
    assessmentRunId: { type: String, trim: true, index: true },
    assessmentStatus: { type: String, enum: ['started', 'processing', 'complete', 'failed'], default: undefined, index: true },
    assessmentCompletedAt: { type: Date, default: undefined },
    assessmentErrorCode: { type: String, trim: true, default: undefined },
    // A MongoDB-backed lease makes the in-process assessment pipeline
    // restart-safe without introducing a second queueing system. The status
    // fields remain the source of truth; these fields only coordinate workers.
    analysisLeaseOwner: { type: String, trim: true, default: undefined },
    analysisLeaseExpiresAt: { type: Date, default: undefined },
    analysisAttempt: { type: Number, min: 0, default: 0 },
    analysisNextRetryAt: { type: Date, default: undefined },
    analysisErrorCode: { type: String, trim: true, default: undefined },
    evaluationSourceHash: { type: String, trim: true },
    evaluationVersion: { type: String, trim: true },
    evaluationRubricSourceHash: { type: String, trim: true },
    evaluationPolicyHash: { type: String, trim: true },
    evaluationProvider: { type: String, trim: true },
    evaluationModel: { type: String, trim: true },
    evaluationErrorCode: { type: String, trim: true },
    evaluationAttempts: { type: Schema.Types.Mixed, default: undefined },
    evaluationDiagnostics: { type: Schema.Types.Mixed, default: undefined },
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

submissionSchema.index({ student: 1, assignment: 1 }, { unique: true,
  partialFilterExpression: { student: { $type: 'objectId' } } });
submissionSchema.index({ assignment: 1, guestRequestKey: 1 }, { unique: true,
  partialFilterExpression: { guestRequestKey: { $type: 'string' } } });
submissionSchema.index({ assignment: 1, 'guest.normalizedEmail': 1, submittedAt: -1 },
  { name: 'guest_recovery_lookup_v1', partialFilterExpression: { submissionMode: 'guest' } });
submissionSchema.index({ assignment: 1 });
submissionSchema.index({ submissionMode: 1, assessmentStatus: 1, 'guest.resultEmailSentAt': 1, 'guest.resultEmailNextAttemptAt': 1 }, { name: 'guest_result_email_queue_v1' });
// Teacher uploads (created in production by scripts/migrateTeacherUploadIndexes.js): one submission per idempotency key and
// assignment, the "Save and send" email queue, and the per-assignment status list.
submissionSchema.index({ assignment: 1, 'teacherUpload.requestKey': 1 }, { name: 'teacher_upload_request_v1', unique: true,
  partialFilterExpression: { 'teacherUpload.requestKey': { $type: 'string' } } });
submissionSchema.index({ 'teacherUpload.email.status': 1, assessmentStatus: 1, 'teacherUpload.email.nextAttemptAt': 1 },
  { name: 'teacher_upload_email_queue_v1', partialFilterExpression: { 'teacherUpload.email.status': { $type: 'string' } } });
submissionSchema.index({ assignment: 1, 'teacherUpload.uploadedBy': 1, createdAt: -1 },
  { name: 'teacher_upload_list_v1', partialFilterExpression: { 'teacherUpload.uploadedBy': { $type: 'objectId' } } });
submissionSchema.index({ class: 1 });
submissionSchema.index({ class: 1, student: 1, submittedAt: 1 });
submissionSchema.index({ class: 1, assignment: 1, submittedAt: 1, draftNumber: 1 });
submissionSchema.index({ class: 1, assignment: 1, createdAt: 1 });
submissionSchema.index({ feedback: 1 });
submissionSchema.index({ ocrStatus: 1, analysisNextRetryAt: 1, analysisLeaseExpiresAt: 1, updatedAt: 1 });

require('../services/sourceFidelity/immutability').install(submissionSchema);
submissionSchema.set('toJSON',{transform(_doc,ret){
  delete ret.registeredRequestKey;
  delete ret.teacherAnnotations; // teacher-only, even when a query selected it
  delete ret.teacherUpload; // teacher/server-only, even when a query selected it; teacher endpoints build their own DTO
  for(const page of ret.ocrPages||[])delete page.studentSourceEvidence;
  const source=require('../utils/sourceFidelity').payload(ret);if(source)ret.sourceFidelity=source;return ret;
}});
module.exports = mongoose.model('Submission', submissionSchema);
