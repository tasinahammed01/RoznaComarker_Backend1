'use strict';

const mongoose = require('mongoose');
const { ADAPTIVE_PRACTICE_THRESHOLD, ADAPTIVE_PRACTICE_MIN_QUESTIONS,
  ADAPTIVE_PRACTICE_MAX_QUESTIONS } = require('../constants/adaptivePractice.constants');
const { CANONICAL_QUESTION_TYPES, normalizeQuestionType, isCompatibleQuestionType } = require('../utils/adaptivePracticeQuestionTypes');

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

const questionSchema = new Schema({
  questionId: { type: String, required: true, trim: true },
  questionType: { type: String, enum: CANONICAL_QUESTION_TYPES, default: 'open_response', set: normalizeQuestionType },
  task: { type: String, required: true, trim: true },
  tip: { type: String, required: true, trim: true },
  checklist: { type: [String], required: true },
  modelAnswer: { type: String, required: true, trim: true },
  options: {
    type: [{
      _id: false,
      id: { type: String, required: true, trim: true },
      text: { type: String, required: true, trim: true }
    }],
    default: undefined
  },
  correctOptionId: { type: String, trim: true, default: undefined },
  acceptedAnswers: { type: [String], default: undefined },
  caseSensitive: { type: Boolean, default: false },
  explanation: { type: String, trim: true, default: undefined }
}, { _id: false });

const activitySchema = new Schema({
  activityId: { type: String, required: true, trim: true },
  skillId: { type: String, enum: skillIds, required: true },
  category: { type: String, required: true, trim: true },
  title: { type: String, required: true, trim: true },
  description: { type: String, required: true, trim: true },
  evidence: { type: String, required: true, trim: true },
  difficulty: { type: String, enum: ['foundational', 'developing', 'proficient'], required: true },
  questions: { type: [questionSchema], default: undefined, validate: {
    validator(value) { return value === undefined || (value.length >= ADAPTIVE_PRACTICE_MIN_QUESTIONS
      && value.length <= ADAPTIVE_PRACTICE_MAX_QUESTIONS
      && new Set(value.map((question) => question.questionId)).size === value.length); },
    message: 'Practice questions must contain 1-3 unique question IDs.'
  } },
  // Optional legacy single-question fields. New writes use questions[] only.
  questionType: { type: String, enum: CANONICAL_QUESTION_TYPES, default: undefined, set: normalizeQuestionType },
  task: { type: String, trim: true }, tip: { type: String, trim: true }, checklist: { type: [String], default: undefined },
  modelAnswer: { type: String, trim: true }, options: { type: [{ _id: false, id: String, text: String }], default: undefined },
  correctOptionId: { type: String, trim: true, default: undefined }, acceptedAnswers: { type: [String], default: undefined },
  caseSensitive: { type: Boolean, default: undefined },
  createdAt: { type: Date, default: Date.now }
}, { _id: false });

activitySchema.pre('validate', function validateCanonicalQuestions() {
  if (!Array.isArray(this.questions) || !this.questions.length) return;
  this.questions.forEach((question, index) => {
    const prefix = `questions.${index}`; const type = normalizeQuestionType(question.questionType, '');
    if (!type || !isCompatibleQuestionType(this.skillId, type)) this.invalidate(`${prefix}.questionType`, 'Question type is incompatible with the practice skill.');
    if (type === 'mcq') {
      const ids = (question.options || []).map((option) => option.id);
      if (ids.length < 2 || new Set(ids).size !== ids.length || !ids.includes(question.correctOptionId))
        this.invalidate(`${prefix}.options`, 'MCQ options and correct answer must be valid.');
    } else if (type === 'fill_blank') {
      if (!Array.isArray(question.acceptedAnswers) || !question.acceptedAnswers.length)
        this.invalidate(`${prefix}.acceptedAnswers`, 'Fill-blank accepted answers are required.');
    }
  });
});

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
    skills: { type: [sourceSkillSchema], required: true },
    sourceEvaluation: {
      correctionSourceHash: { type: String, default: '' },
      evaluationSourceHash: { type: String, default: '' },
      evaluationPolicyHash: { type: String, default: '' },
      evaluationRubricSourceHash: { type: String, default: '' },
      assessmentVersion: { type: String, default: '' },
      evaluationVersion: { type: String, default: '' },
      teacherOverride: { type: Boolean, default: false }
    }
  },
  targetSkills: [{ type: String, enum: skillIds }],
  // Set once, when every generated activity has been passed. Individual
  // question attempts remain in AdaptivePracticeAttempt and are not counted
  // as separate activity completions.
  completedAt: { type: Date, default: undefined },
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
adaptivePracticeSessionSchema.index({ completedAt: 1, submissionId: 1 });
adaptivePracticeSessionSchema.index({ assignmentId: 1, completedAt: 1 });

module.exports = mongoose.model('AdaptivePracticeSession', adaptivePracticeSessionSchema);
