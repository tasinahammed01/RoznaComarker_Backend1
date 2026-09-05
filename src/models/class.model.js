const mongoose = require('mongoose');

const { Schema } = mongoose;

const classSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true
    },
    subjectLevel: {
      type: String,
      trim: true
    },
    startDate: {
      type: Date
    },
    endDate: {
      type: Date
    },
    description: {
      type: String,
      trim: true
    },
    bannerUrl: {
      type: String,
      trim: true
    },
    teacher: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true
    },
    joinCode: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    qrCodeUrl: {
      type: String
    },
    gradingScale: {
      type: String,
      enum: ['score_0_100', 'grade_a_f', 'pass_fail'],
      default: 'score_0_100'
    },
    lateSubmissionPenaltyPercent: {
      type: Number,
      default: 10,
      min: 0,
      max: 100
    },
    autoPublishGrades: {
      type: Boolean,
      default: false
    },
    isActive: {
      type: Boolean,
      default: true
    },
    institutionId: {
      type: Schema.Types.ObjectId,
      ref: 'Institution',
      default: null,
      index: true
    },
    status: {
      type: String,
      enum: ['active', 'archived'],
      default: 'active',
      index: true
    },
    archivedAt: {
      type: Date,
      default: null
    },
    archivedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  {
    timestamps: true
  }
);

classSchema.index({ teacher: 1, status: 1, isActive: 1 });

module.exports = mongoose.model('Class', classSchema);
