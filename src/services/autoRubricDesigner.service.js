const mongoose = require('mongoose');

const Assignment = require('../models/assignment.model');
const Submission = require('../models/Submission');
const SubmissionFeedback = require('../models/SubmissionFeedback');

const { completeRubric } = require('./rubricCompletion.service');
const { getNormalizedSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function sanitizeRubricDesignerCriteria(rubricDesigner) {
  const d = rubricDesigner && typeof rubricDesigner === 'object' ? rubricDesigner : null;
  if (!d) return d;

  const unwanted = new Set([
    'overall_rubric_score',
    'content_relevance',
    'structure_organization',
    'structure_&_organization',
    'grammar_mechanics',
    'grammar_&_mechanics'
  ]);

  const criteria = Array.isArray(d.criteria) ? d.criteria : [];
  const filtered = criteria.filter((c) => {
    const title = safeString(c && c.title).trim().toLowerCase();
    const key = title.replace(/\s+/g, '_');
    return !unwanted.has(key);
  });

  return { ...d, criteria: filtered };
}

async function autoGenerateRubricDesignerForSubmission({ submissionId }) {
  if (!mongoose.Types.ObjectId.isValid(submissionId)) {
    return { ok: false, skipped: true, reason: 'invalid_submission_id' };
  }

  const submission = await Submission.findById(submissionId);
  if (!submission) {
    return { ok: false, skipped: true, reason: 'submission_not_found' };
  }

  const assignment = await Assignment.findById(submission.assignment);
  if (!assignment) {
    return { ok: false, skipped: true, reason: 'assignment_not_found' };
  }

  const teacherId = assignment.teacher;
  if (!teacherId) {
    return { ok: false, skipped: true, reason: 'teacher_not_found' };
  }

  const studentText = getNormalizedSubmissionTranscript(submission);
  if (!studentText) {
    return { ok: false, skipped: true, reason: 'no_text' };
  }

  const existing = await SubmissionFeedback.findOne({ submissionId: submission._id });
  if (existing && existing.overriddenByTeacher && existing.rubricDesigner) {
    return { ok: true, skipped: true, reason: 'teacher_overridden' };
  }

  const systemInstruction = `
You are a rubric generator.

Return ONLY valid JSON.

DO NOT include:
- explanations
- markdown
- code blocks
- comments

The JSON MUST match this structure EXACTLY:

{
 "title": "string",
 "levels": [
   { "title": "string", "maxPoints": number }
 ],
 "criteria": [
   { "title": "string", "cells": ["string"] }
 ]
}

Rules:
- levels must be an ARRAY
- criteria must be an ARRAY
- cells must be an ARRAY
- cells length MUST equal levels length
- levels must be 3-5 items
- criteria must be 3-10 rows
`;

  const cappedStudentText = studentText.length > 8000 ? studentText.slice(0, 8000) : studentText;
  const assignmentTitle = safeString(assignment.title).trim();
  const assignmentInstructions = safeString(assignment.instructions).trim();
  const assignmentWritingType = safeString(assignment.writingType).trim();

  const rubricTitle = `Rubric: ${assignmentTitle || 'Submission'}`;

  const prompt = `Generate a rubric designer for grading the student's work.\n\nAssignment Title: ${assignmentTitle || 'N/A'}\nAssignment Writing Type: ${assignmentWritingType || 'N/A'}\nAssignment Instructions: ${assignmentInstructions || 'N/A'}\n\nStudent Submission Text (OCR/Transcript):\n${cappedStudentText}\n\nOutput must match this exact JSON structure:\n{"title":"string","levels":[{"title":"string","maxPoints":number}],"criteria":[{"title":"string","cells":["string"]}]}.\nRules: 3-5 levels. Each criteria row must have exactly the same number of cells as levels. Keep criteria 3-10 rows. Keep maxPoints as integers. Make criteria relevant to the writing type. Use clear descriptions in cells for each performance level. Use title: ${rubricTitle}.`;

  let rubricDesigner;
  try {
    rubricDesigner = await completeRubric({ systemInstruction, userPrompt: prompt,
      assignmentId: String(assignment._id), submissionId: String(submission._id) });
  } catch (error) {
    return { ok: false, skipped: error?.code === 'AI_PROVIDER_NOT_CONFIGURED',
      reason: error?.code === 'AI_PROVIDER_NOT_CONFIGURED' ? 'ai_not_configured' : 'ai_failed', errorCode: error?.code || 'RUBRIC_PROVIDER_FAILED' };
  }

  const sanitizedRubricDesigner = sanitizeRubricDesignerCriteria(rubricDesigner);

  await SubmissionFeedback.findOneAndUpdate(
    { submissionId: submission._id },
    {
      $set: {
        rubricDesigner: sanitizedRubricDesigner,
        overriddenByTeacher: false
      },
      $setOnInsert: {
        submissionId: submission._id,
        classId: submission.class,
        studentId: submission.student,
        teacherId
      }
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return { ok: true, skipped: false, rubricDesigner: sanitizedRubricDesigner };
}

module.exports = {
  autoGenerateRubricDesignerForSubmission
};
