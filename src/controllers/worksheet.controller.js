/**
 * worksheet.controller.js
 *
 * Handles AI generation, CRUD, student submission (with auto-grading),
 * and result retrieval for Worksheet documents.
 *
 * Mirrors the patterns established in flashcard.controller.js:
 * – Uses OpenAI SDK client (openai.chat.completions.create) pointing at OpenRouter
 * – sendSuccess / sendError helpers
 * – normalizeGeneratedJsonText for cleaning AI responses
 */
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const OpenAI = require('openai');

const Worksheet = require('../models/Worksheet');
const WorksheetSubmission = require('../models/WorksheetSubmission');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const { createNotification } = require('../services/notification.service');
const logger = require('../utils/logger');

const openai = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: process.env.OPENROUTER_BASE_URL,
  timeout: parseInt(process.env.OPENROUTER_TIMEOUT_MS) || 60000,
  defaultHeaders: {
    'HTTP-Referer': process.env.FRONTEND_URL || 'http://localhost:4200',
    'X-Title': 'RoznaComarker Worksheets',
  },
});

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

function normalizeGeneratedJsonText(value) {
  return String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\uFEFF/, '')
    .trim();
}

/**
 * Builds the AI prompt for worksheet generation.
 * Produces a structured worksheet with conceptExplanation + 4 activities.
 */
function buildWorksheetPrompt(topic, language, difficulty) {
  const difficultyDesc =
    difficulty === 'easy'
      ? 'simple vocabulary, basic recall'
      : difficulty === 'medium'
      ? 'mix of recall and understanding'
      : 'analysis, comparison, critical thinking';

  return `You are an expert teacher creating an interactive worksheet.
Topic: "${topic}"
Language: ${language}
Difficulty: ${difficulty}

Create a complete interactive worksheet. Adapt ALL content to the topic.
Do NOT use food chain examples unless the topic is specifically about food chains.

Rules:
- tags: 3 key concept labels from the topic (2-3 words each)
- conceptExplanation.items: 4-6 items showing the topic sequence/hierarchy with appropriate emojis
- activity1.items: same items in a DIFFERENT (shuffled) order; each has correctOrder (1-based integer)
- activity2.items: exactly 3 items classifiable into exactly 3 relevant categories
- activity3.questions: exactly 3 MCQ questions, each with exactly 4 options, one correct answer
- activity4.sentences: exactly 4 sentences; wordBank has exactly the 4 correct answers (one per blank)
- All emojis must suit the topic
- Difficulty: ${difficultyDesc}

Return ONLY valid JSON. No markdown, no explanation. Start with { end with }.

{
  "title": "...",
  "description": "...",
  "subject": "...",
  "tags": ["...","...","..."],
  "estimatedMinutes": 20,
  "conceptExplanation": {
    "title": "...",
    "body": "...",
    "chainSummary": "... \u2192 ... \u2192 ...",
    "items": [{"emoji":"...","name":"...","role":"..."}]
  },
  "activity1": {
    "title": "Activity 1: ...",
    "instructions": "...",
    "items": [{"id":"a1_1","emoji":"...","name":"...","role":"...","correctOrder":1}]
  },
  "activity2": {
    "title": "Activity 2: Who Am I?",
    "instructions": "...",
    "categories": ["...","...","..."],
    "items": [{"id":"a2_1","emoji":"...","name":"...","description":"...","correctCategory":"..."}]
  },
  "activity3": {
    "title": "Activity 3: Quick Quiz",
    "instructions": "...",
    "questions": [{"id":"a3_q1","text":"...","options":["...","...","...","..."],"correctAnswer":"..."}]
  },
  "activity4": {
    "title": "Activity 4: Fill in the Blanks",
    "instructions": "...",
    "wordBank": ["...","...","...","..."],
    "sentences": [{
      "id": "a4_s1",
      "parts": [
        {"type":"text","value":"..."},
        {"type":"blank","blankId":"b1","correctAnswer":"..."},
        {"type":"text","value":"..."}
      ]
    }]
  }
}`;
}

/**
 * POST /api/worksheets/generate
 * Auth: teacher only
 * Generates a worksheet draft via AI (does NOT save to DB).
 * Accepts: { inputType:'topic', content, questionCount, language, difficulty, questionTypes }
 */
async function generateWorksheet(req, res) {
  console.log('[GENERATE WORKSHEET] req.body:', JSON.stringify(req.body));
  try {
    const {
      inputType = 'topic',
      content = '',
      language = 'English',
      difficulty = 'medium',
    } = req.body;

    if (inputType === 'image') {
      return sendError(res, 400, 'Image-based generation: paste extracted text as content.');
    }

    const sourceText = String(content || '').trim();
    if (!sourceText || sourceText.length < 5) {
      return sendError(res, 400, 'content is required for topic-based generation');
    }

    const prompt = buildWorksheetPrompt(sourceText, language, difficulty);

    const completion = await openai.chat.completions.create({
      model: process.env.LLAMA_MODEL || 'meta-llama/llama-3-8b-instruct',
      messages: [
        {
          role: 'system',
          content: 'You are a worksheet generation assistant. Return ONLY valid JSON. No markdown, no preamble, no explanation.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.4,
      max_tokens: 4000,
    });

    let rawText = completion.choices?.[0]?.message?.content ?? '';
    console.log('[GENERATE WORKSHEET] Raw response:', rawText.substring(0, 300));

    rawText = normalizeGeneratedJsonText(rawText);
    const firstBrace = rawText.indexOf('{');
    const lastBrace = rawText.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
      rawText = rawText.slice(firstBrace, lastBrace + 1);
    }

    let parsed;
    try {
      parsed = JSON.parse(rawText);
    } catch (e) {
      console.error('[GENERATE WORKSHEET] JSON parse error:', rawText.slice(0, 500));
      return sendError(res, 500, 'AI returned invalid format. Please try again.');
    }

    if (!parsed || (!parsed.activity1 && !parsed.activity3)) {
      return sendError(res, 500, 'AI returned invalid worksheet structure. Please try again.');
    }

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: sourceText.slice(0, 500),
    });
  } catch (error) {
    console.error('[GENERATE WORKSHEET] Error:', error.message);
    if (error.status === 402) return sendError(res, 500, 'AI service credits exhausted. Contact admin.');
    if (error.status === 429) return sendError(res, 500, 'AI service rate limited. Try again in a moment.');
    if (error.status === 401) return sendError(res, 500, 'AI service authentication failed.');
    return sendError(res, 500, error.message || 'Generation failed');
  }
}

/**
 * POST /api/worksheets
 * Auth: teacher only
 * Saves a finalized worksheet to the database.
 * @body {{ title, description, sections, language, estimatedMinutes, generationSource, sourceContent }}
 */
async function createWorksheet(req, res) {
  try {
    const {
      title, description, subject, tags, estimatedMinutes,
      conceptExplanation, activity1, activity2, activity3, activity4,
      generationSource, sourceContent, language, difficulty,
    } = req.body;

    if (!title || !String(title).trim()) {
      return sendError(res, 400, 'Title is required');
    }

    const totalPoints =
      (activity1?.items?.length || 0) +
      (activity2?.items?.length || 0) +
      (activity3?.questions?.length || 0) +
      (activity4?.sentences?.length || 0);

    const worksheet = new Worksheet({
      title:              String(title).trim(),
      description:        String(description || '').trim(),
      subject:            String(subject || '').trim(),
      tags:               Array.isArray(tags) ? tags : [],
      estimatedMinutes:   estimatedMinutes || 20,
      conceptExplanation: conceptExplanation || null,
      activity1:          activity1 || null,
      activity2:          activity2 || null,
      activity3:          activity3 || null,
      activity4:          activity4 || null,
      generationSource:   generationSource || 'topic',
      sourceContent:      sourceContent || '',
      language:           language || 'English',
      difficulty:         difficulty || 'medium',
      totalPoints,
      createdBy:          req.user._id,
      isPublished:        true,
    });

    await worksheet.save();
    console.log('[CREATE WORKSHEET] Created:', worksheet._id, 'totalPoints:', totalPoints);
    return res.status(201).json({ success: true, worksheet });
  } catch (error) {
    console.error('[CREATE WORKSHEET] Error:', error.message);
    console.error('[CREATE WORKSHEET] Stack:', error.stack);
    if (error.name === 'ValidationError') {
      console.error('[CREATE WORKSHEET] Validation:', JSON.stringify(error.errors, null, 2));
      return sendError(res, 400, `Validation failed: ${Object.values(error.errors).map((e) => e.message).join(', ')}`);
    }
    return sendError(res, 500, error.message || 'Failed to save worksheet');
  }
}

/**
 * GET /api/worksheets
 * Auth: teacher only
 * Returns all worksheets created by this teacher.
 */
async function getMyWorksheets(req, res) {
  try {
    const worksheets = await Worksheet.find({ createdBy: req.user._id })
      .sort({ updatedAt: -1 })
      .select('title description subject tags language estimatedMinutes totalPoints createdAt updatedAt')
      .lean();

    return sendSuccess(res, worksheets);
  } catch (error) {
    console.error('[GET WORKSHEETS] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * GET /api/worksheets/:id
 * Auth: teacher or enrolled student
 * Returns a single worksheet by ID.
 */
async function getWorksheetById(req, res) {
  try {
    const worksheet = await Worksheet.findById(req.params.id).lean();
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    if (req.user.role === 'student') {
      const memberships = await Membership.find({ student: req.user._id, status: 'active' }).select('class').lean();
      const activeClassIds = (memberships || []).map((m) => String(m.class));

      const assignment = await Assignment.findOne({
        resourceType: 'worksheet',
        resourceId: String(worksheet._id),
        class: { $in: activeClassIds },
        isActive: true,
      }).select('_id').lean();

      if (!assignment) {
        return sendError(res, 403, 'You do not have access to this worksheet');
      }
    } else {
      if (String(worksheet.createdBy) !== String(req.user._id)) {
        return sendError(res, 403, 'Forbidden');
      }
    }

    return sendSuccess(res, worksheet);
  } catch (error) {
    console.error('[GET WORKSHEET] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * PUT /api/worksheets/:id
 * Auth: teacher only (must own worksheet)
 * Updates a worksheet's fields.
 */
async function updateWorksheet(req, res) {
  try {
    const worksheet = await Worksheet.findOneAndUpdate(
      { _id: req.params.id, createdBy: req.user._id },
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!worksheet) return sendError(res, 404, 'Worksheet not found or not authorised');
    return sendSuccess(res, worksheet);
  } catch (error) {
    console.error('[UPDATE WORKSHEET] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * DELETE /api/worksheets/:id
 * Auth: teacher only (must own worksheet)
 * Deletes the worksheet and its submissions.
 */
async function deleteWorksheet(req, res) {
  try {
    const worksheet = await Worksheet.findOneAndDelete({ _id: req.params.id, createdBy: req.user._id });
    if (!worksheet) return sendError(res, 404, 'Worksheet not found or not authorised');

    // Cascade: deactivate all assignments referencing this worksheet
    try {
      const assignments = await Assignment.find({
        resourceType: 'worksheet',
        resourceId: String(req.params.id),
        isActive: true,
      }).select('_id').lean();

      const assignmentIds = (assignments || []).map((a) => a._id);

      if (assignmentIds.length) {
        await Assignment.updateMany(
          { _id: { $in: assignmentIds } },
          { $set: { isActive: false } }
        );
        await WorksheetSubmission.deleteMany({ assignmentId: { $in: assignmentIds } });
      }
    } catch (cascadeErr) {
      console.warn('[DELETE WORKSHEET] cascade assignment cleanup failed:', cascadeErr.message);
    }

    await WorksheetSubmission.deleteMany({ worksheetId: req.params.id });
    return sendSuccess(res, null);
  } catch (error) {
    console.error('[DELETE WORKSHEET] Error:', error.message, error.stack);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * Grades a single short-answer or fill-blank response using the AI.
 * @param {string} questionText - The question text
 * @param {string} correctAnswer - Model answer
 * @param {string} studentAnswer - Student's answer
 * @param {string} type - 'short-answer' | 'fill-blank'
 * @returns {{ isCorrect: boolean, feedback: string }}
 */
async function gradeShortAnswer(questionText, correctAnswer, studentAnswer, type) {
  if (!studentAnswer || !studentAnswer.trim()) {
    return { isCorrect: false, feedback: 'No answer given.' };
  }

  if (type === 'fill-blank') {
    const correct = correctAnswer.toLowerCase().trim();
    const student = studentAnswer.toLowerCase().trim();
    if (student === correct || student.includes(correct)) {
      return { isCorrect: true, feedback: 'Correct!' };
    }
  }

  try {
    const prompt = `Grade this student answer.
Question: "${questionText}"
Correct answer: "${correctAnswer}"
Student answer: "${studentAnswer}"
Return ONLY JSON: {"isCorrect": true or false, "feedback": "one sentence explanation"}`;

    const completion = await openai.chat.completions.create({
      model: process.env.LLAMA_MODEL || 'meta-llama/llama-3-8b-instruct',
      messages: [
        {
          role: 'system',
          content: 'You are a strict but fair grading assistant. Return ONLY valid JSON.',
        },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 80,
    });

    const raw = normalizeGeneratedJsonText(completion.choices?.[0]?.message?.content ?? '');
    const result = JSON.parse(raw);
    return {
      isCorrect: result.isCorrect === true,
      feedback: String(result.feedback || ''),
    };
  } catch {
    return { isCorrect: false, feedback: 'Could not auto-grade.' };
  }
}

/**
 * POST /api/worksheets/:id/submit
 * Auth: student only
 * Grades and stores a worksheet submission. One submission per student per assignment.
 * @body {{ assignmentId, answers: [{questionId, sectionId, studentAnswer}], timeTaken }}
 */
async function submitWorksheet(req, res) {
  try {
    const worksheetId = req.params.id;
    const {
      assignmentId,
      answers = [],
      timeTaken = 0,
      totalPointsEarned = 0,
      totalPointsPossible = 0,
      percentage = 0,
    } = req.body;

    if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Valid assignmentId is required');
    }

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    const existing = await WorksheetSubmission.findOne({ assignmentId, studentId: req.user._id });
    if (existing) return sendError(res, 409, 'Already submitted');

    const gradedAnswers = answers.map((a) => ({
      questionId:       String(a.questionId || ''),
      sectionId:        String(a.sectionId || ''),
      studentAnswer:    String(a.studentAnswer || ''),
      isCorrect:        Boolean(a.isCorrect),
      pointsEarned:     a.isCorrect ? 1 : 0,
      aiGradingFeedback: a.isCorrect ? 'Correct!' : 'Incorrect.',
    }));

    const submission = new WorksheetSubmission({
      worksheetId:         worksheet._id,
      assignmentId,
      studentId:           req.user._id,
      answers:             gradedAnswers,
      totalPointsEarned,
      totalPointsPossible,
      percentage,
      timeTaken:           timeTaken || 0,
      gradingStatus:       'auto-graded',
    });

    await submission.save();
    console.log('[SUBMIT WORKSHEET] Saved:', submission._id, 'score:', totalPointsEarned, '/', totalPointsPossible);

    return res.status(201).json({
      success: true,
      submission: {
        ...submission.toObject(),
        worksheet: { title: worksheet.title },
      },
    });
  } catch (error) {
    console.error('[SUBMIT WORKSHEET] Error:', error.message);
    if (error.code === 11000) return sendError(res, 409, 'Already submitted');
    return sendError(res, 500, error.message || 'Submission failed');
  }
}

/**
 * GET /api/worksheets/:id/my-submission
 * Auth: student only
 * Returns the current student's submission for this worksheet, joined with worksheet sections.
 */
async function getMySubmission(req, res) {
  try {
    const submission = await WorksheetSubmission.findOne({
      worksheetId: req.params.id,
      studentId: req.user._id,
    }).lean();

    if (!submission) return sendError(res, 404, 'No submission found');

    const worksheet = await Worksheet.findById(req.params.id).select('sections title totalPoints').lean();

    return sendSuccess(res, {
      ...submission,
      worksheet: { sections: worksheet?.sections || [], title: worksheet?.title || '' },
    });
  } catch (error) {
    console.error('[GET MY SUBMISSION] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * GET /api/worksheets/:id/my-submission-by-assignment
 * Auth: student only
 * Returns submission looked up by assignmentId query param (alternative lookup).
 * @query assignmentId
 */
async function getMySubmissionByAssignment(req, res) {
  try {
    const { assignmentId } = req.query;
    if (!assignmentId) return sendError(res, 400, 'assignmentId query param required');

    const submission = await WorksheetSubmission.findOne({
      assignmentId,
      studentId: req.user._id,
    }).lean();

    if (!submission) return sendError(res, 404, 'No submission found');

    const worksheet = await Worksheet.findById(submission.worksheetId).select('sections title totalPoints').lean();

    return sendSuccess(res, {
      ...submission,
      worksheet: { sections: worksheet?.sections || [], title: worksheet?.title || '' },
    });
  } catch (error) {
    console.error('[GET MY SUBMISSION BY ASSIGNMENT] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * GET /api/worksheets/:id/submissions
 * Auth: teacher only (must own worksheet)
 * Returns all student submissions for this worksheet with student names and scores.
 */
async function getSubmissions(req, res) {
  try {
    const worksheet = await Worksheet.findOne({ _id: req.params.id, createdBy: req.user._id })
      .select('title totalPoints sections')
      .lean();

    if (!worksheet) return sendError(res, 404, 'Worksheet not found or not authorised');

    const submissions = await WorksheetSubmission.find({ worksheetId: req.params.id })
      .populate('studentId', 'displayName email photoURL')
      .sort({ submittedAt: -1 })
      .lean();

    return sendSuccess(res, {
      worksheet,
      submissions,
    });
  } catch (error) {
    console.error('[GET SUBMISSIONS] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

/**
 * POST /api/worksheets/:id/assign
 * Auth: teacher only
 * Assigns a worksheet to a class — creates an Assignment record and notifies students.
 * @body {{ classId, title, deadline }}
 */
async function assignWorksheet(req, res) {
  try {
    const { id } = req.params;
    const { classId, title, deadline } = req.body;

    if (!classId || !mongoose.Types.ObjectId.isValid(classId)) {
      return sendError(res, 400, 'Valid classId is required');
    }

    const teacherId = req.user._id;
    const cls = await Class.findOne({ _id: classId, teacher: teacherId });
    if (!cls) return sendError(res, 403, 'Class not found or does not belong to you');

    const worksheet = await Worksheet.findOne({ _id: id, createdBy: teacherId });
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    if (!title || !deadline) {
      return sendError(res, 400, 'title and deadline are required');
    }

    const parsedDeadline = new Date(deadline);
    if (isNaN(parsedDeadline.getTime()) || parsedDeadline.getTime() <= Date.now()) {
      return sendError(res, 400, 'deadline must be a future date');
    }

    let assignment = null;
    for (let i = 0; i < 5; i++) {
      const qrToken = uuidv4();
      try {
        assignment = await Assignment.create({
          title: String(title).trim(),
          writingType: 'worksheet',
          resourceType: 'worksheet',
          resourceId: String(id),
          deadline: parsedDeadline,
          class: classId,
          teacher: teacherId,
          qrToken,
        });
        break;
      } catch (err) {
        if (err && err.code === 11000 && err.keyPattern && err.keyPattern.qrToken) continue;
        throw err;
      }
    }

    setImmediate(async () => {
      try {
        const memberships = await Membership.find({ class: classId, status: 'active' }).select('student');
        const studentIds = (memberships || []).map((m) => m && m.student).filter(Boolean);
        const teacherDisplay = String(req.user.displayName || req.user.email || 'Teacher');
        const className = cls.name ? String(cls.name) : 'Class';
        await Promise.all(
          studentIds.map((sId) =>
            createNotification({
              recipientId: sId,
              actorId: teacherId,
              type: 'assignment_uploaded',
              title: 'New worksheet assigned',
              description: `${teacherDisplay} assigned a new worksheet in ${className}: ${title}`,
              data: {
                classId: String(classId),
                assignmentId: assignment ? String(assignment._id) : null,
                resourceType: 'worksheet',
                resourceId: String(id),
                route: { path: '/student/my-classes/detail', params: [String(classId)] },
              },
            })
          )
        );
      } catch (e) {
        logger.warn('assignWorksheet: notification error', e);
      }
    });

    return res.json({ success: true, message: 'Worksheet assigned to class', data: { assignment } });
  } catch (error) {
    console.error('[ASSIGN WORKSHEET] Error:', error.message);
    return sendError(res, 500, 'Internal server error');
  }
}

module.exports = {
  generateWorksheet,
  createWorksheet,
  getMyWorksheets,
  getWorksheetById,
  updateWorksheet,
  deleteWorksheet,
  submitWorksheet,
  getMySubmission,
  getMySubmissionByAssignment,
  getSubmissions,
  assignWorksheet,
};
