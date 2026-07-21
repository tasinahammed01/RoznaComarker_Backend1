'use strict';

const mongoose = require('mongoose');
const { ADAPTIVE_PRACTICE_THRESHOLD } = require('../constants/adaptivePractice.constants');

const { Schema } = mongoose;
const skillIds = ['CONTENT', 'ORGANIZATION', 'VOCABULARY', 'GRAMMAR', 'MECHANICS'];

const sourceSkillSchema = new Schema({
  id: { type: String, enum: skillIds, required: true },
  category: { type: String, required: true, trim: true },
  earnedPoints: { type: Number, required: true },
  maximumPoints: { type: Number, required: true },
  percentage: { type: Number, required: true },
  status: { type: String, enum: ['priority', 'needs-practice', 'on-track'], required: true }
}, { _id: false });

const activitySchema = new Schema({
  activityId: { type: String, required: true, trim: true },
  skillId: { type: String, enum: skillIds, required: true },
  category: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  evidence: { type: String, required: true, trim: true },
  task: { type: String, required: true, trim: true },
  tip: { type: String, required: true, trim: true },
  checklist: { type: [String], required: true },
  modelAnswer: { type: String, required: true, trim: true },
  difficulty: { type: String, enum: ['foundational', 'developing', 'proficient'], required: true },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

const adaptivePracticeSessionSchema = new Schema({
  submissionId: { type: Schema.Types.ObjectId, ref: 'Submission', required: true, index: true },
  studentId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  assignmentId: { type: Schema.Types.ObjectId, ref: 'Assignment', required: true },
  status: { type: String, enum: ['generating', 'ready', 'failed'], required: true, index: true },
  threshold: { type: Number, default: ADAPTIVE_PRACTICE_THRESHOLD, immutable: true },
  sourceFingerprint: { type: String, required: true },
  sourceSnapshot: {
    transcriptFingerprint: { type: String, required: true },
    feedbackId: { type: Schema.Types.ObjectId, ref: 'SubmissionFeedback', required: true },
    feedbackUpdatedAt: { type: Date, required: true },
    skills: { type: [sourceSkillSchema], required: true }
  },
  targetSkills: [{ type: String, enum: skillIds }],
  activities: { type: [activitySchema], default: [] },
  generation: {
    provider: { type: String, trim: true },
    model: { type: String, trim: true },
    promptVersion: { type: String, trim: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
    metrics: { type: Schema.Types.Mixed, default: undefined },
    errorCode: { type: String, trim: true },
    errorMessage: { type: String, trim: true }
  }
}, { timestamps: true });

adaptivePracticeSessionSchema.index(
  { submissionId: 1, studentId: 1, sourceFingerprint: 1 },
  { unique: true, name: 'unique_adaptive_practice_source' }
);
adaptivePracticeSessionSchema.index({ updatedAt: -1 });

module.exports = mongoose.model('AdaptivePracticeSession', adaptivePracticeSessionSchema);
