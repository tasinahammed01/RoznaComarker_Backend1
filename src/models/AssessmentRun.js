const mongoose = require('mongoose');

const assessmentRunSchema = new mongoose.Schema({
  runId: { type: String, required: true, unique: true, index: true, trim: true },
  submissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
  assignmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Assignment', required: true },
  teacherId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  sourceHash: { type: String, required: true, trim: true },
  status: { type: String, enum: ['started', 'processing', 'complete', 'failed'], default: 'started', index: true },
  components: {
    transcription: { type: String, enum: ['pending', 'complete', 'failed'], default: 'pending' },
    issueDetection: { type: String, enum: ['pending', 'complete', 'failed'], default: 'pending' },
    evaluation: { type: String, enum: ['pending', 'complete', 'failed'], default: 'pending' },
    detailedFeedback: { type: String, enum: ['pending', 'complete', 'failed'], default: 'pending' },
    report: { type: String, enum: ['pending', 'complete', 'failed'], default: 'pending' },
    adaptiveLearning: { type: String, enum: ['pending', 'complete', 'failed', 'not_required'], default: 'pending' }
  },
  adaptiveState: { type: String, trim: true },
  completedAt: Date,
  failedAt: Date,
  errorCode: { type: String, trim: true }
}, { timestamps: true, versionKey: false });

assessmentRunSchema.index({ submissionId: 1, createdAt: -1 });
module.exports = mongoose.model('AssessmentRun', assessmentRunSchema);
