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
const Worksheet = require('../models/Worksheet');
const WorksheetSubmission = require('../models/WorksheetSubmission');
const WorksheetDraft = require('../models/WorksheetDraft');
const Assignment = require('../models/assignment.model');
const Class = require('../models/class.model');
const Membership = require('../models/membership.model');
const { createNotification } = require('../services/notification.service');
const { gradeWorksheetAnswers } = require('../services/worksheetScoring.service');
const { publishNotification } = require('../services/notificationRealtime.service');
const logger = require('../utils/logger');
const { generateWorksheetTheme, getDefaultTheme } = require('../services/worksheetTheme.service');
const { getDefaultActivityTypes, getActivityType } = require('../config/activityTypes.config');
const { extractContent, validateFile } = require('../services/fileContentExtractor.service');
const { generateChatCompletion } = require('../services/aiGeneration.service');
const multer = require('multer');
const { jsonrepair } = require('jsonrepair');

// Configure multer for in-memory file storage (temp)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

function sendSuccess(res, data, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

function sendError(res, statusCode, message) {
  return res.status(statusCode).json({ success: false, message });
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPER: Parse AI Worksheet Response with JSON Repair & Validation
// ─────────────────────────────────────────────────────────────────────────────
/**
 * Parses AI-generated worksheet response with robust JSON extraction, repair, and validation.
 * @param {string} aiText - Raw text response from AI
 * @param {string} fallbackTopic - Topic to use for default title if missing
 * @returns {object} Parsed and validated worksheet object
 * @throws {Error} If JSON extraction fails, repair fails, or validation fails
 */
function parseWorksheetAIResponse(aiText, fallbackTopic = 'Worksheet') {
  console.log('[PARSE AI] Input length:', aiText.length);

  // Step 1: Extract JSON object from AI response (handles markdown code fences, extra text)
  const jsonMatch = aiText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('No JSON object found in AI response');
  }
  const extractedJson = jsonMatch[0];
  console.log('[PARSE AI] Extracted JSON length:', extractedJson.length);

  // Step 2: Try to parse JSON directly
  let parsed;
  try {
    parsed = JSON.parse(extractedJson);
    console.log('[PARSE AI] Direct parse successful');
  } catch (parseError) {
    console.log('[PARSE AI] Direct parse failed, attempting repair:', parseError.message);
    // Step 3: Use jsonrepair to fix common JSON issues
    try {
      const repaired = jsonrepair(extractedJson);
      console.log('[PARSE AI] Repaired JSON length:', repaired.length);
      parsed = JSON.parse(repaired);
      console.log('[PARSE AI] Parse after repair successful');
    } catch (repairError) {
      console.error('[PARSE AI] Repair failed:', repairError.message);
      throw new Error(`JSON parse and repair failed: ${parseError.message}`);
    }
  }

  // Step 4: Validate required fields
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed result is not a valid object');
  }

  // Validate title
  if (!parsed.title || typeof parsed.title !== 'string' || !parsed.title.trim()) {
    console.warn('[PARSE AI] Missing title, using fallback');
    parsed.title = `${fallbackTopic.slice(0, 50)} Worksheet`;
  }

  // Validate description (optional but should exist)
  if (!parsed.description) {
    parsed.description = '';
  }

  // Validate subject (optional but should exist)
  if (!parsed.subject) {
    parsed.subject = 'General';
  }

  // Validate activities array (required)
  if (!Array.isArray(parsed.activities) || parsed.activities.length === 0) {
    throw new Error('No activities array found in response');
  }

  // Filter to valid activities only (must have type, title, instructions, data)
  const validActivities = parsed.activities.filter(
    a => a && typeof a === 'object' && a.type && a.title && a.instructions && a.data
  );

  if (validActivities.length === 0) {
    throw new Error('No valid activities after filtering (missing type, title, instructions, or data)');
  }

  parsed.activities = validActivities;
  console.log('[PARSE AI] Validation successful - activities:', validActivities.length, '| types:', validActivities.map(a => a.type).join(', '));

  return parsed;
}

function normalizeGeneratedJsonText(value) {
  return String(value || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^\uFEFF/, '')
    .trim();
}

function computeDeadlineStatus(assignment) {
  const now = new Date();
  const deadline = assignment && assignment.deadline ? new Date(assignment.deadline) : null;
  const isLate = Boolean(deadline && now.getTime() > deadline.getTime());
  const status = isLate ? 'late' : 'submitted';
  return { now, isLate, status };
}

async function resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId }) {
  if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
    return { error: { statusCode: 400, message: 'Valid assignmentId is required' } };
  }

  const assignment = await Assignment.findOne({ _id: assignmentId, isActive: true }).lean();
  if (!assignment) {
    return { error: { statusCode: 404, message: 'Assignment not found' } };
  }

  if (String(assignment.resourceType || '') !== 'worksheet') {
    return { error: { statusCode: 400, message: 'Assignment is not a worksheet assignment' } };
  }

  if (String(assignment.resourceId || '') !== String(worksheetId)) {
    return { error: { statusCode: 400, message: 'Assignment does not match worksheet' } };
  }

  const classDoc = await Class.findOne({ _id: assignment.class, isActive: true }).lean();
  if (!classDoc) {
    return { error: { statusCode: 404, message: 'Class not found' } };
  }

  const membership = await Membership.findOne({
    student: studentId,
    class: classDoc._id,
    status: 'active',
  }).lean();

  if (!membership) {
    return { error: { statusCode: 403, message: 'Not class member' } };
  }

  return { assignment, classDoc };
}

/**
 * Ensures every blank part in an activity4 object has a globally unique blankId.
 * The AI sometimes generates duplicate blankId values across sentences, causing
 * shared-state bugs in the viewer.  Any duplicate or missing blankId is replaced
 * with a deterministic position-based key `s{si}_b{pi}`.
 */
function sanitizeActivity4BlankIds(activity4) {
  if (!activity4?.sentences?.length) return activity4;
  const seen = new Set();
  return {
    ...activity4,
    sentences: activity4.sentences.map((s, si) => ({
      ...s,
      parts: (s.parts ?? []).map((p, pi) => {
        if (p.type !== 'blank') return p;
        let id = p.blankId;
        if (!id || seen.has(id)) {
          id = `s${si}_b${pi}`;
        }
        seen.add(id);
        return { ...p, blankId: id };
      }),
    })),
  };
}

/**
 * Builds the AI prompt for worksheet generation.
 * Compact prompt to minimise input tokens, leaving maximum room for output.
 */
function buildWorksheetPrompt(topic, language, difficulty, resolvedTypes) {
  const DEFAULT_TYPES = ['ordering', 'classification', 'multipleChoice', 'fillBlanks'];
  const types = Array.isArray(resolvedTypes) && resolvedTypes.length > 0 ? resolvedTypes : DEFAULT_TYPES;

  const typeInstructions = {
    ordering:       'items[] each {id,emoji,name,role,correctOrder(int)}. 4-6 items.',
    classification: 'categories[](2-3 strings), items[] each {id,emoji,name,description,correctCategory}. 6-8 items.',
    multipleChoice: 'questions[] each {id,text,options[4 strings],correctAnswer(string)}. 5 questions.',
    fillBlanks:     'wordBank[5 strings], sentences[] each {id,parts[{type:"text",value}|{type:"blank",blankId,correctAnswer}]}. 5 sentences.',
    matching:       'pairs[] each {id,leftItem:{text},rightItem:{text}}. 5-6 pairs.',
    trueFalse:      'questions[] each {id,text,correctAnswer(bool),explanation}. 5-6 questions.',
    shortAnswer:    'questions[] each {id,text,modelAnswer,maxWords:50}. 3-4 questions.',
  };

  const activityList = types.map((t, i) =>
    `Activity ${i + 1}: type="${t}" — data must contain: ${typeInstructions[t] || 'appropriate fields'}`
  ).join('\n');

  return `Generate an educational worksheet as valid JSON only.
No markdown. No explanation. Raw JSON object only. Start with { end with }.

Topic: ${topic}
Difficulty: ${difficulty || 'medium'}
Language: ${language || 'English'}

Return this exact structure:
{
  "title": "...",
  "description": "...",
  "subject": "...",
  "tags": ["..."],
  "estimatedMinutes": ${types.length * 5},
  "conceptExplanation": {"title":"...","body":"2-3 paragraphs","keyPoints":["...","...","..."]},
  "activities": [ ...${types.length} objects... ]
}

Generate EXACTLY ${types.length} activities:
${activityList}

Each activity object: {"type":"...","title":"...","instructions":"...","data":{...},"order":N}
All IDs unique strings. Replace ALL placeholder text with real content about: ${topic}
CRITICAL: Return complete valid JSON. Do not truncate.`;
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
      activityTypes = null,
    } = req.body;

    if (inputType === 'image') {
      return sendError(res, 400, 'Image-based generation: paste extracted text as content.');
    }

    const sourceText = String(content || '').trim();
    if (!sourceText || sourceText.length < 3) {
      return sendError(res, 400, 'content is required for topic-based generation');
    }

    // Resolve activity types: null/empty → 4 defaults, otherwise use selected
    const DEFAULT_TYPES = ['ordering', 'classification', 'multipleChoice', 'fillBlanks'];
    let resolvedTypes = Array.isArray(activityTypes) && activityTypes.length > 0
      ? activityTypes.filter(t => typeof t === 'string' && t.trim())
      : DEFAULT_TYPES;
    if (resolvedTypes.length === 0) resolvedTypes = DEFAULT_TYPES;
    console.log('[GENERATE] Resolved activity types:', resolvedTypes);
    console.log('[GENERATE] Topic:', sourceText.slice(0, 100));

    const prompt = buildWorksheetPrompt(sourceText, language, difficulty, resolvedTypes);

    // Use structured output for reliable JSON
    const rawText = await generateChatCompletion([
      {
        role: 'system',
        content: 'You are a worksheet generation assistant. Return ONLY valid JSON. No markdown, no code fences, no explanation. Start your response with { and end with }.',
      },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.2, // Lower temperature for more consistent output
      max_tokens: 8000,
      response_format: { type: 'json_object' }, // Force JSON output
    });

    console.log('[GENERATE] AI response length:', rawText.length);

    // Use robust parser with JSON repair and validation
    let parsed;
    try {
      parsed = parseWorksheetAIResponse(rawText, sourceText);
    } catch (parseError) {
      console.error('[GENERATE] Parse error:', parseError.message);
      return res.status(500).json({
        success: false,
        message: 'Worksheet generation failed',
        error: parseError.message,
      });
    }

    console.log('[GENERATE] Success — activities:', parsed.activities.length, '| types:', parsed.activities.map(a => a.type).join(', '));

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: sourceText.slice(0, 500),
    });
  } catch (error) {
    console.error('[GENERATE WORKSHEET] OpenAI error:', error.response?.data || error.message);
    if (error.status === 402) return sendError(res, 500, 'AI service credits exhausted. Contact admin.');
    if (error.status === 429) return sendError(res, 500, 'AI service rate limited. Try again in a moment.');
    if (error.status === 401) return sendError(res, 500, 'AI service authentication failed.');
    if (error.status === 400) return sendError(res, 500, 'Invalid model ID or request format.');
    return res.status(500).json({
      success: false,
      message: 'Worksheet generation failed',
      error: error.message,
    });
  }
}

/**
 * POST /api/worksheets/upload-and-generate
 * Auth: teacher only
 * Uploads a file, extracts content, and generates a worksheet draft via AI.
 * Accepts: multipart/form-data with file, language, difficulty, activityTypes
 */
async function uploadAndGenerate(req, res) {
  console.log('[UPLOAD AND GENERATE] Starting file upload');
  
  if (!req.file) {
    return sendError(res, 400, 'No file uploaded');
  }

  try {
    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log('[UPLOAD AND GENERATE] File validated:', req.file.originalname, req.file.mimetype);

    // Extract content from file
    let extractedText;
    try {
      extractedText = await extractContent(req.file.buffer, req.file.mimetype, req.file.originalname);
    } catch (extractionError) {
      console.error('[UPLOAD AND GENERATE] Extraction failed:', extractionError.message);
      return sendError(res, 400, extractionError.message);
    }

    console.log('[UPLOAD AND GENERATE] Content extracted, length:', extractedText.length);

    // Get generation options from form data
    const language = req.body.language || 'English';
    const difficulty = req.body.difficulty || 'medium';
    const rawActivityTypes = req.body.activityTypes ? JSON.parse(req.body.activityTypes) : null;
    const DEFAULT_TYPES = ['ordering', 'classification', 'multipleChoice', 'fillBlanks'];
    let resolvedTypes = Array.isArray(rawActivityTypes) && rawActivityTypes.length > 0
      ? rawActivityTypes.filter(t => typeof t === 'string' && t.trim())
      : DEFAULT_TYPES;
    if (resolvedTypes.length === 0) resolvedTypes = DEFAULT_TYPES;
    console.log('[UPLOAD AND GENERATE] Resolved activity types:', resolvedTypes);

    // Build prompt with extracted content
    const prompt = buildWorksheetPrompt(extractedText, language, difficulty, resolvedTypes);

    // Use structured output for reliable JSON
    const rawText = await generateChatCompletion([
      {
        role: 'system',
        content: 'You are a worksheet generation assistant. Return ONLY valid JSON. No markdown, no preamble, no explanation.',
      },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.2, // Lower temperature for more consistent output
      max_tokens: 8000,
      response_format: { type: 'json_object' }, // Force JSON output
    });

    console.log('[UPLOAD AND GENERATE] AI response length:', rawText.length);

    // Use robust parser with JSON repair and validation
    let parsed;
    try {
      parsed = parseWorksheetAIResponse(rawText, extractedText.slice(0, 50));
    } catch (parseError) {
      console.error('[UPLOAD AND GENERATE] Parse error:', parseError.message);
      return res.status(500).json({
        success: false,
        message: 'Worksheet generation failed',
        error: parseError.message,
      });
    }

    console.log('[UPLOAD AND GENERATE] Success — activities:', parsed.activities.length, '| types:', parsed.activities.map(a => a.type).join(', '));

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: extractedText.slice(0, 500),
      fileName: req.file.originalname,
    });
  } catch (error) {
    console.error('[UPLOAD AND GENERATE] OpenAI error:', error.response?.data || error.message);
    if (error.status === 402) return sendError(res, 500, 'AI service credits exhausted. Contact admin.');
    if (error.status === 429) return sendError(res, 500, 'AI service rate limited. Try again in a moment.');
    if (error.status === 401) return sendError(res, 500, 'AI service authentication failed.');
    if (error.status === 400) return sendError(res, 500, 'Invalid model ID or request format.');
    return res.status(500).json({
      success: false,
      message: 'Worksheet generation failed',
      error: error.message,
    });
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
      activities,
      generationSource, sourceContent, language, difficulty,
      cefrLevel, gradeLevel, gradeCategory,
      assignmentDeadline,
    } = req.body;

    if (!title || !String(title).trim()) {
      return sendError(res, 400, 'Title is required');
    }

    if (!assignmentDeadline) {
      return sendError(res, 400, 'Assignment deadline is required');
    }

    const d = new Date(assignmentDeadline);
    if (isNaN(d.getTime())) {
      return sendError(res, 400, 'Invalid assignment deadline');
    }
    if (d.getTime() <= Date.now()) {
      return sendError(res, 400, 'Assignment deadline must be a future date');
    }
    const parsedAssignmentDeadline = d;

    // Calculate total points from either new activities array or legacy fields
    let totalPoints = 0;
    if (Array.isArray(activities) && activities.length > 0) {
      // New extensible activities array
      activities.forEach(activity => {
        const data = activity.data || {};
        if (activity.type === 'ordering' || activity.type === 'classification' || activity.type === 'matching' || activity.type === 'dragDrop' || activity.type === 'sorting') {
          totalPoints += (data.items?.length || 0);
        } else if (activity.type === 'multipleChoice' || activity.type === 'trueFalse' || activity.type === 'shortAnswer') {
          totalPoints += (data.questions?.length || 0);
        } else if (activity.type === 'fillBlanks') {
          totalPoints += (data.sentences?.length || 0);
        } else if (activity.type === 'labeling') {
          totalPoints += (data.labels?.length || 0);
        } else if (activity.type === 'wordSearch' || activity.type === 'crossword') {
          totalPoints += (data.words?.length || 0);
        }
      });
    } else {
      // Legacy activity1-4 fields for backward compatibility
      totalPoints =
        (activity1?.items?.length || 0) +
        (activity2?.items?.length || 0) +
        (activity3?.questions?.length || 0) +
        (activity4?.sentences?.length || 0);
    }

    let theme = getDefaultTheme();
    try {
      theme = await generateWorksheetTheme(
        req.body.topic || String(subject || title).trim(),
        String(title).trim(),
        String(description || '').trim()
      );
    } catch (themeErr) {
      console.error('[CREATE WORKSHEET] Theme generation failed, using default:', themeErr.message);
    }

    const worksheet = new Worksheet({
      title:              String(title).trim(),
      description:        String(description || '').trim(),
      subject:            String(subject || '').trim(),
      assignmentDeadline: parsedAssignmentDeadline,
      tags:               Array.isArray(tags) ? tags : [],
      estimatedMinutes:   estimatedMinutes || 20,
      conceptExplanation: conceptExplanation || null,
      activities:         Array.isArray(activities) ? activities.map(act => {
        if (act?.type === 'fillBlanks' && act.data) {
          return { ...act, data: sanitizeActivity4BlankIds(act.data) };
        }
        return act;
      }) : [],
      // Legacy fields for backward compatibility
      activity1:          activity1 || null,
      activity2:          activity2 || null,
      activity3:          activity3 || null,
      activity4:          activity4 ? sanitizeActivity4BlankIds(activity4) : null,
      generationSource:   generationSource || 'topic',
      sourceContent:      sourceContent || '',
      language:           language || 'English',
      difficulty:         difficulty || null,
      cefrLevel:          cefrLevel  || null,
      gradeLevel:         gradeLevel || null,
      gradeCategory:      gradeCategory || null,
      totalPoints,
      theme,
      createdBy:          req.user._id,
      isPublished:        true,
    });

    await worksheet.save();
    console.log('[CREATE WORKSHEET] Created:', worksheet._id, 'totalPoints:', totalPoints, 'theme:', theme.patternType);
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
 * Supports filtering, search, sorting, and pagination via query params:
 *   cefrLevel, gradeLevel, gradeCategory, subject, difficulty,
 *   search, sortBy, sortOrder, page, limit
 */
async function getMyWorksheets(req, res) {
  try {
    const {
      cefrLevel, gradeLevel, gradeCategory, subject, difficulty,
      search,
      sortBy = 'updatedAt', sortOrder = 'desc',
      page = 1, limit = 50,
    } = req.query;

    const filter = { createdBy: req.user._id };

    // Support both single values and arrays for multi-select
    if (cefrLevel) {
      filter.cefrLevel = Array.isArray(cefrLevel) ? { $in: cefrLevel } : cefrLevel;
    }
    if (gradeLevel) {
      filter.gradeLevel = Array.isArray(gradeLevel) ? { $in: gradeLevel } : gradeLevel;
    }
    if (gradeCategory) {
      filter.gradeCategory = Array.isArray(gradeCategory) ? { $in: gradeCategory } : gradeCategory;
    }
    if (subject) {
      filter.subject = Array.isArray(subject) ? { $in: subject } : subject;
    }
    if (difficulty) {
      filter.difficulty = Array.isArray(difficulty) ? { $in: difficulty } : difficulty;
    }

    if (search && String(search).trim()) {
      const q = String(search).trim();
      filter.$or = [
        { title:       { $regex: q, $options: 'i' } },
        { description: { $regex: q, $options: 'i' } },
        { tags:        { $in: [new RegExp(q, 'i')] } },
      ];
    }

    const sortDir = sortOrder === 'asc' ? 1 : -1;
    const allowedSort = ['title', 'createdAt', 'updatedAt', 'totalPoints'];
    const sortField = allowedSort.includes(String(sortBy)) ? String(sortBy) : 'updatedAt';
    const sort = { [sortField]: sortDir };

    const pageNum  = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip     = (pageNum - 1) * limitNum;

    const [total, worksheets] = await Promise.all([
      Worksheet.countDocuments(filter),
      Worksheet.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .select('title description subject cefrLevel gradeLevel gradeCategory difficulty tags language estimatedMinutes totalPoints thumbnailUrl isPublic theme createdAt updatedAt')
        .lean(),
    ]);

    return res.json({
      success: true,
      data: worksheets,
      pagination: {
        total,
        page:  pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
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
 * Deletes the worksheet with full cascade cleanup using transaction.
 */
async function deleteWorksheet(req, res) {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const { id } = req.params;
    const userId = req.user._id;

    // Verify ownership
    const worksheet = await Worksheet.findOne({ _id: id, createdBy: userId }).session(session);
    if (!worksheet) {
      await session.abortTransaction();
      session.endSession();
      return sendError(res, 404, 'Worksheet not found or not authorised');
    }

    // Find all active assignments referencing this worksheet
    const assignments = await Assignment.find({
      resourceType: 'worksheet',
      resourceId: String(id),
      isActive: true
    }).select('_id class').session(session);

    const assignmentIds = (assignments || []).map((a) => a._id);
    const affectedClassIds = (assignments || []).map((a) => a.class).filter(Boolean);

    // Cascade 1: Deactivate assignments
    if (assignmentIds.length > 0) {
      await Assignment.updateMany(
        { _id: { $in: assignmentIds } },
        { $set: { isActive: false } },
        { session }
      );
    }

    // Cascade 2: Delete worksheet submissions linked to these assignments
    if (assignmentIds.length > 0) {
      await WorksheetSubmission.deleteMany(
        { assignmentId: { $in: assignmentIds } },
        { session }
      );
    }

    // Cascade 3: Delete all worksheet submissions directly linked to this worksheet
    await WorksheetSubmission.deleteMany(
      { worksheetId: id },
      { session }
    );

    // Cascade 4: Delete worksheet drafts linked to this worksheet
    await WorksheetDraft.deleteMany(
      { worksheetId: id },
      { session }
    );

    // Delete the worksheet itself
    await Worksheet.deleteOne({ _id: id }, { session });

    await session.commitTransaction();
    session.endSession();

    // Fire-and-forget notifications to affected students
    if (assignmentIds.length > 0) {
      setImmediate(async () => {
        try {
          const memberships = await Membership.find({
            class: { $in: affectedClassIds },
            status: 'active'
          }).select('student').lean();

          const studentIds = (memberships || []).map((m) => m.student).filter(Boolean);
          const teacherDisplay = String(req.user.displayName || req.user.email || 'Teacher');

          await Promise.all(studentIds.map((sId) =>
            createNotification({
              recipientId: sId,
              actorId: userId,
              type: 'assignment_removed',
              title: 'Worksheet removed',
              description: `${teacherDisplay} removed the worksheet "${worksheet.title}"`,
              data: {
                resourceType: 'worksheet',
                resourceId: String(id),
                assignmentIds: assignmentIds.map(String)
              }
            })
          ));
        } catch (notifyErr) {
          logger.warn('deleteWorksheet: notification error', notifyErr);
        }
      });
    }

    return sendSuccess(res, { message: 'Worksheet deleted successfully' });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error('deleteWorksheet failed', err);
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

    const raw = await generateChatCompletion([
      {
        role: 'system',
        content: 'You are a strict but fair grading assistant. Return ONLY valid JSON.',
      },
      { role: 'user', content: prompt },
    ], {
      temperature: 0.1,
      max_tokens: 80,
    });

    const cleaned = raw.trim();
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

    const studentId = req.user && req.user._id;
    if (!studentId) return sendError(res, 401, 'Unauthorized');

    const resolved = await resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId });
    if (resolved.error) return sendError(res, resolved.error.statusCode, resolved.error.message);
    const assignment = resolved.assignment;
    // classDoc is needed for the teacher notification (to pass classId to the frontend)
    const classDoc = resolved.classDoc;
    const { now, isLate, status } = computeDeadlineStatus(assignment);

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    const existing = await WorksheetSubmission.findOne({ assignmentId, studentId });
    
    // Enforce deadline and resubmission rules
    if (existing) {
      if (isLate && assignment.allowLateResubmission !== true) {
        return sendError(res, 403, 'Deadline passed and late resubmission is not allowed');
      }
      // If not late, check if resubmission is allowed (default: allow resubmission before deadline)
      // If you want to disable all resubmissions, add: return sendError(res, 403, 'Already submitted');
    } else {
      // New submission after deadline
      if (isLate && assignment.allowLateResubmission !== true) {
        return sendError(res, 403, 'Deadline passed and late submission is not allowed');
      }
    }

    // ── Authoritative server-side scoring engine (do NOT trust client totals) ─
    const { gradedAnswers, totals, earnedPoints, totalPoints, score, isPassed, sections } = gradeWorksheetAnswers({ worksheet, answers });

    if (existing) {
      existing.answers = gradedAnswers;
      // Legacy fields (kept for backward compatibility)
      existing.totalPointsEarned = totals.totalPointsEarned;
      existing.totalPointsPossible = totals.totalPointsPossible;
      existing.percentage = totals.percentage;
      // New root-level fields (single source of truth)
      existing.earnedPoints = earnedPoints;
      existing.totalPoints = totalPoints;
      existing.score = score;
      existing.isPassed = isPassed;
      existing.sections = sections;
      existing.timeTaken = Number(timeTaken) || 0;
      existing.gradingStatus = 'auto-graded';
      existing.isLate = isLate;
      existing.status = status;
      existing.submittedAt = now;
      existing.lastAttemptAt = now;
      existing.attempts = (Number(existing.attempts) || 1) + 1;

      await existing.save();
      console.log('[SUBMIT WORKSHEET] Updated:', existing._id, 'score:', score, '% (', earnedPoints, '/', totalPoints, ')');

      // Clear draft after successful submission update
      try {
        await WorksheetDraft.deleteOne({ assignmentId, studentId });
      } catch (draftErr) {
        logger.warn('[SUBMIT WORKSHEET] Failed to clear draft:', draftErr.message);
      }

      // Notify teacher via createNotification so the SSE fires as 'assignment_submitted'
      // (publishNotification was undefined — createNotification is the correct pattern)
      try {
        const studentDisplay = String(req.user.displayName || req.user.email || 'A student');
        await createNotification({
          recipientId: String(assignment.teacher),
          actorId: String(studentId),
          type: 'assignment_submitted',
          title: 'Worksheet submitted',
          description: `${studentDisplay} submitted "${worksheet.title}"`,
          data: {
            classId: String(classDoc._id),
            assignmentId: String(assignment._id),
            submissionId: String(existing._id),
            studentId: String(studentId),
            resourceType: 'worksheet',
            worksheetId: String(worksheet._id),
            percentage: totals.percentage,
            score: score,
            isLate: isLate,
          },
        });
      } catch (sseErr) {
        logger.warn('[SUBMIT WORKSHEET] Notification failed:', sseErr.message);
      }

      return res.status(200).json({
        success: true,
        submission: {
          ...existing.toObject(),
          worksheet: { title: worksheet.title },
          totals,
        },
      });
    }

    const created = new WorksheetSubmission({
      worksheetId: worksheet._id,
      assignmentId,
      studentId,
      answers: gradedAnswers,
      // Legacy fields (kept for backward compatibility)
      totalPointsEarned: totals.totalPointsEarned,
      totalPointsPossible: totals.totalPointsPossible,
      percentage: totals.percentage,
      // New root-level fields (single source of truth)
      earnedPoints,
      totalPoints,
      score,
      isPassed,
      sections,
      timeTaken: Number(timeTaken) || 0,
      gradingStatus: 'auto-graded',
      isLate,
      status,
      submittedAt: now,
      lastAttemptAt: now,
      attempts: 1,
    });

    await created.save();
    console.log('[SUBMIT WORKSHEET] Saved:', created._id, 'score:', score, '% (', earnedPoints, '/', totalPoints, ')');

    // Clear draft after successful submission
    try {
      await WorksheetDraft.deleteOne({ assignmentId, studentId });
    } catch (draftErr) {
      logger.warn('[SUBMIT WORKSHEET] Failed to clear draft:', draftErr.message);
    }

    // Notify teacher via createNotification so the SSE fires as 'assignment_submitted'
    // (publishNotification was undefined — createNotification is the correct pattern)
    try {
      const studentDisplay = String(req.user.displayName || req.user.email || 'A student');
      await createNotification({
        recipientId: String(assignment.teacher),
        actorId: String(studentId),
        type: 'assignment_submitted',
        title: 'Worksheet submitted',
        description: `${studentDisplay} submitted "${worksheet.title}"`,
        data: {
          classId: String(classDoc._id),
          assignmentId: String(assignment._id),
          submissionId: String(created._id),
          studentId: String(studentId),
          resourceType: 'worksheet',
          worksheetId: String(worksheet._id),
          percentage: totals.percentage,
          score: score,
          isLate: isLate,
        },
      });
    } catch (sseErr) {
      logger.warn('[SUBMIT WORKSHEET] Notification failed:', sseErr.message);
    }

    return res.status(201).json({
      success: true,
      submission: {
        ...created.toObject(),
        worksheet: { title: worksheet.title },
        totals,
      },
    });
  } catch (error) {
    console.error('[SUBMIT WORKSHEET] Error:', error.message);
    if (error.code === 11000) return sendError(res, 409, 'Already submitted');
    return sendError(res, 500, error.message || 'Submission failed');
  }
}

/**
 * POST /api/worksheets/:id/grade
 * Auth: student only
 * Returns authoritative grading results without persisting.
 * @body {{ answers: [{questionId, sectionId, studentAnswer}] }}
 */
async function gradeWorksheetAttempt(req, res) {
  try {
    const worksheetId = req.params.id;
    const { answers = [], assignmentId } = req.body;

    const studentId = req.user && req.user._id;
    if (!studentId) return sendError(res, 401, 'Unauthorized');

    const resolved = await resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId });
    if (resolved.error) return sendError(res, resolved.error.statusCode, resolved.error.message);

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    const { gradedAnswers, totals } = gradeWorksheetAnswers({ worksheet, answers });
    return sendSuccess(res, { gradedAnswers, totals });
  } catch (error) {
    console.error('[GRADE WORKSHEET] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to grade worksheet');
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
 * GET /api/worksheets/:id/report
 * Auth: teacher only (must own worksheet)
 * Returns comprehensive report with overview, per-student data, and analytics.
 * Supports pagination and filtering via query params.
 * @query { page, limit, classId, status, dateFrom, dateTo }
 */
async function getWorksheetReport(req, res) {
  try {
    const worksheetId = req.params.id;
    const {
      page = 1,
      limit = 20,
      classId,
      status,
      dateFrom,
      dateTo,
    } = req.query;

    const worksheet = await Worksheet.findOne({ _id: worksheetId, createdBy: req.user._id })
      .select('title totalPoints cefrLevel gradeLevel gradeCategory difficulty subject assignmentDeadline activity1 activity2 activity3 activity4 activity5 activity6')
      .lean();

    if (!worksheet) return sendError(res, 404, 'Worksheet not found or not authorised');

    // Build filter
    const filter = { worksheetId };
    if (classId) filter.assignmentId = { $in: await Assignment.find({ class: classId, resourceType: 'worksheet', resourceId: worksheetId }).select('_id').lean().then(a => a.map(x => x._id)) };
    if (status) filter.status = status;
    if (dateFrom || dateTo) {
      filter.submittedAt = {};
      if (dateFrom) filter.submittedAt.$gte = new Date(dateFrom);
      if (dateTo) filter.submittedAt.$lte = new Date(dateTo);
    }

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Paginated submissions for the display table, plus a lightweight all-submissions
    // query for accurate aggregate analytics (so stats don't vary per page)
    const [total, submissions, allSubmissionsForAnalytics] = await Promise.all([
      WorksheetSubmission.countDocuments(filter),
      WorksheetSubmission.find(filter)
        .populate('studentId', 'displayName email photoURL')
        .populate('assignmentId', 'title deadline class')
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      // Lightweight projection — only fields needed for aggregate stats
      WorksheetSubmission.find(filter)
        .select('score percentage isPassed isLate answers attempts')
        .lean(),
    ]);

    // Get all assignments for this worksheet to calculate total assigned
    const assignments = await Assignment.find({
      resourceType: 'worksheet',
      resourceId: worksheetId,
      isActive: true,
    }).lean();

    // Calculate total assigned students
    const assignmentIds = assignments.map(a => a._id);
    const totalAssigned = await Membership.countDocuments({
      class: { $in: assignments.map(a => a.class) },
      status: 'active',
    });

    // Calculate overview stats using total counts (not paginated subset)
    const submittedCount = total;
    const pendingCount = Math.max(0, totalAssigned - submittedCount);
    // lateCount and analytics are derived from ALL submissions, not just the current page
    const lateCount = allSubmissionsForAnalytics.filter(s => s.isLate).length;
    const completionRate = totalAssigned > 0 ? (submittedCount / totalAssigned) * 100 : 0;

    // Calculate analytics from all submissions for accuracy
    const scores = allSubmissionsForAnalytics.map(s => s.score ?? s.percentage ?? 0);
    const averageScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const medianScore = scores.length
      ? [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)]
      : 0;
    const passedCount = allSubmissionsForAnalytics.filter(s => s.isPassed === true || (s.score ?? s.percentage ?? 0) >= 70).length;
    const passRate = passedCount / (allSubmissionsForAnalytics.length || 1) * 100;

    // Analyze per-question performance using ALL submissions (not just current page)
    const questionStats = {};
    allSubmissionsForAnalytics.forEach(submission => {
      (submission.answers || []).forEach(answer => {
        const key = `${answer.sectionId}_${answer.questionId}`;
        if (!questionStats[key]) {
          questionStats[key] = { correct: 0, total: 0, skipped: 0 };
        }
        questionStats[key].total++;
        if (answer.isCorrect) questionStats[key].correct++;
        if (!answer.studentAnswer || answer.studentAnswer.trim() === '') questionStats[key].skipped++;
      });
    });

    // Find hardest and most missed questions
    const questionAnalysis = Object.entries(questionStats).map(([key, stats]) => ({
      questionId: key,
      correctRate: stats.total > 0 ? (stats.correct / stats.total) * 100 : 0,
      missedCount: stats.total - stats.correct,
      skippedRate: stats.total > 0 ? (stats.skipped / stats.total) * 100 : 0,
    })).sort((a, b) => a.correctRate - b.correctRate);

    const hardestQuestions = questionAnalysis.slice(0, 5);
    const mostMissedQuestions = questionAnalysis.sort((a, b) => b.missedCount - a.missedCount).slice(0, 5);
    const easiestQuestions = [...questionAnalysis].sort((a, b) => b.correctRate - a.correctRate).slice(0, 5);

    // Per-section analysis - support legacy activity1-4 and new activity5/activity6 types
    const sectionStats = {
      activity1: { correct: 0, total: 0, skipped: 0, attempts: 0 },
      activity2: { correct: 0, total: 0, skipped: 0, attempts: 0 },
      activity3: { correct: 0, total: 0, skipped: 0, attempts: 0 },
      activity4: { correct: 0, total: 0, skipped: 0, attempts: 0 },
      activity5: { correct: 0, total: 0, skipped: 0, attempts: 0 },
      activity6: { correct: 0, total: 0, skipped: 0, attempts: 0 },
    };

    // Also track dynamic sections from activities array if present
    const dynamicSectionIds = new Set();
    if (worksheet.activities && Array.isArray(worksheet.activities)) {
      worksheet.activities.forEach((activity, index) => {
        const sectionId = `activity_${index}`;
        dynamicSectionIds.add(sectionId);
        sectionStats[sectionId] = { correct: 0, total: 0, skipped: 0, attempts: 0 };
      });
    }

    // Use ALL submissions for section aggregates (not just current page)
    allSubmissionsForAnalytics.forEach(submission => {
      (submission.answers || []).forEach(answer => {
        if (sectionStats[answer.sectionId]) {
          sectionStats[answer.sectionId].total++;
          if (answer.isCorrect) sectionStats[answer.sectionId].correct++;
          if (!answer.studentAnswer || answer.studentAnswer.trim() === '') sectionStats[answer.sectionId].skipped++;
        }
      });
      const attemptCount = submission.attempts || 1;
      Object.keys(sectionStats).forEach(sectionId => {
        sectionStats[sectionId].attempts += attemptCount;
      });
    });

    // Calculate section-level metrics from all submissions
    const totalSubs = allSubmissionsForAnalytics.length;
    const sectionAnalytics = Object.entries(sectionStats).map(([sectionId, stats]) => {
      const completionRate = stats.total > 0 ? ((stats.total - stats.skipped) / stats.total) * 100 : 0;
      const correctRate = stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
      const avgAttempts = totalSubs > 0 ? stats.attempts / totalSubs : 0;

      // Find most missed questions in this section (from ALL submissions)
      const sectionQuestionStats = {};
      allSubmissionsForAnalytics.forEach(submission => {
        (submission.answers || []).forEach(answer => {
          if (answer.sectionId === sectionId) {
            const key = answer.questionId;
            if (!sectionQuestionStats[key]) {
              sectionQuestionStats[key] = { correct: 0, total: 0, missed: 0 };
            }
            sectionQuestionStats[key].total++;
            if (answer.isCorrect) sectionQuestionStats[key].correct++;
            else sectionQuestionStats[key].missed++;
          }
        });
      });

      const sectionMissedQuestions = Object.entries(sectionQuestionStats)
        .map(([questionId, sqStats]) => ({
          questionId,
          missedCount: sqStats.missed,
          correctRate: sqStats.total > 0 ? Math.round((sqStats.correct / sqStats.total) * 100) : 0,
        }))
        .sort((a, b) => b.missedCount - a.missedCount)
        .slice(0, 3);

      return {
        sectionId,
        correctRate: Math.round(correctRate),
        completionRate: Math.round(completionRate),
        avgAttempts: Math.round(avgAttempts * 10) / 10,
        mostMissedQuestions: sectionMissedQuestions,
        // totalQuestions = avg questions per submission (how many Q's this section has)
        totalQuestions: totalSubs > 0 ? Math.round(stats.total / totalSubs) : 0,
        // exact aggregate counts so the frontend never has to re-compute from a page subset
        correctCount: stats.correct,
        incorrectCount: stats.total - stats.correct - stats.skipped,
        skippedCount: stats.skipped,
        totalAnswered: stats.total,
      };
    });

    // Score bands (90-100, 80-89, 70-79, below 70)
    const scoreBands = {
      '90-100': scores.filter(s => s >= 90).length,
      '80-89': scores.filter(s => s >= 80 && s < 90).length,
      '70-79': scores.filter(s => s >= 70 && s < 80).length,
      'below-70': scores.filter(s => s < 70).length,
    };

    const weakSkillAreas = sectionAnalytics
      .filter(s => s.correctRate < 60)
      .sort((a, b) => a.correctRate - b.correctRate);

    // Generate teacher insights summary (rule-based)
    let teacherInsights = [];
    if (weakSkillAreas.length > 0) {
      const weakest = weakSkillAreas[0];
      teacherInsights.push(`Most students struggled with ${weakest.sectionId} (${weakest.correctRate}% average).`);
    }
    if (sectionAnalytics.length >= 2) {
      const firstHalf = sectionAnalytics.slice(0, Math.ceil(sectionAnalytics.length / 2));
      const secondHalf = sectionAnalytics.slice(Math.ceil(sectionAnalytics.length / 2));
      const firstHalfAvg = firstHalf.reduce((sum, s) => sum + s.correctRate, 0) / firstHalf.length;
      const secondHalfAvg = secondHalf.reduce((sum, s) => sum + s.correctRate, 0) / secondHalf.length;
      if (secondHalfAvg < firstHalfAvg - 10) {
        teacherInsights.push('Average completion drops significantly in later sections.');
      }
    }
    const sectionScores = sectionAnalytics.map(s => s.correctRate);
    const highestSectionScore = Math.max(...sectionScores);
    const highestSection = sectionAnalytics.find(s => s.correctRate === highestSectionScore);
    if (highestSection) {
      teacherInsights.push(`Students performed best in ${highestSection.sectionId} (${highestSection.correctRate}%).`);
    }

    return sendSuccess(res, {
      worksheet,
      overview: {
        totalAssigned,
        submittedCount,
        pendingCount,
        lateCount,
        completionRate: Math.round(completionRate),
      },
      analytics: {
        averageScore: Math.round(averageScore),
        medianScore: Math.round(medianScore),
        passRate: Math.round(passRate),
        hardestQuestions,
        mostMissedQuestions,
        easiestQuestions,
        weakSkillAreas,
        sectionStats: sectionAnalytics,
        scoreBands,
        teacherInsights,
      },
      submissions,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error('[GET WORKSHEET REPORT] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to fetch report');
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

    if (!title) {
      return sendError(res, 400, 'title is required');
    }

    // Use worksheet's assignmentDeadline if not provided in request
    const parsedDeadline = deadline ? new Date(deadline) : worksheet.assignmentDeadline;
    if (!parsedDeadline) {
      return sendError(res, 400, 'deadline is required (not set on worksheet)');
    }
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

/**
 * POST /api/worksheets/:id/regenerate-theme
 * Auth: teacher only
 * Re-generates the AI theme for a worksheet.
 */
async function regenerateTheme(req, res) {
  try {
    const worksheet = await Worksheet.findById(req.params.id);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(res, 403, 'You can only regenerate your own worksheets');
    }

    // Import AI service and regenerate theme
    const { generateWorksheetTheme } = require('../services/ai-service');
    const newTheme = await generateWorksheetTheme(worksheet);
    
    worksheet.theme = newTheme;
    await worksheet.save();

    return res.json({ success: true, data: { theme: newTheme } });
  } catch (error) {
    console.error('[REGENERATE THEME] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to regenerate theme');
  }
}

/**
 * POST /api/worksheets/:id/share
 * Auth: teacher only
 * Generates or retrieves a share token for a worksheet.
 */
async function shareWorksheet(req, res) {
  try {
    const worksheet = await Worksheet.findById(req.params.id);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(res, 403, 'You can only share your own worksheets');
    }

    // Generate or reuse existing share token
    if (!worksheet.shareToken) {
      const crypto = require('crypto');
      worksheet.shareToken = crypto.randomBytes(16).toString('hex');
      try {
        await worksheet.save();
      } catch (saveError) {
        // If duplicate key error, try generating a new token once
        if (saveError.code === 11000) {
          worksheet.shareToken = crypto.randomBytes(16).toString('hex');
          await worksheet.save();
        } else {
          throw saveError;
        }
      }
    }

    const shareUrl = `${process.env.FRONTEND_URL || 'http://localhost:4200'}/shared/worksheets/${worksheet.shareToken}`;

    return res.json({ success: true, shareUrl, shareToken: worksheet.shareToken });
  } catch (error) {
    console.error('[SHARE WORKSHEET] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to generate share link');
  }
}

/**
 * DELETE /api/worksheets/:id/share
 * Auth: teacher only
 * Revokes the share token for a worksheet.
 */
async function revokeShareWorksheet(req, res) {
  try {
    const worksheet = await Worksheet.findById(req.params.id);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(res, 403, 'You can only revoke sharing for your own worksheets');
    }

    // Unset the shareToken field completely to avoid sparse index issues
    await Worksheet.updateOne({ _id: worksheet._id }, { $unset: { shareToken: 1 } });
    worksheet.shareToken = undefined;

    return res.json({ success: true });
  } catch (error) {
    console.error('[REVOKE SHARE WORKSHEET] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to revoke share link');
  }
}

/**
 * GET /api/worksheets/:id/draft
 * Auth: student only
 * Returns the student's draft for this worksheet (if exists).
 */
async function getWorksheetDraft(req, res) {
  try {
    const worksheetId = req.params.id;
    const { assignmentId } = req.query;
    const studentId = req.user._id;

    if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Valid assignmentId query param is required');
    }

    const resolved = await resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId });
    if (resolved.error) return sendError(res, resolved.error.statusCode, resolved.error.message);

    const draft = await WorksheetDraft.findOne({ assignmentId, studentId }).lean();
    if (!draft) return sendError(res, 404, 'No draft found');

    return sendSuccess(res, draft);
  } catch (error) {
    console.error('[GET WORKSHEET DRAFT] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to fetch draft');
  }
}

/**
 * POST /api/worksheets/:id/draft
 * Auth: student only
 * Saves or updates the student's draft for this worksheet.
 * @body {{ assignmentId, activity1Answers, activity2Answers, activity2Revealed, activity3Answers, activity4Blanks, progressPercentage, timeSpent }}
 */
async function saveWorksheetDraft(req, res) {
  try {
    const worksheetId = req.params.id;
    const {
      assignmentId,
      activity1Answers = {},
      activity2Answers = {},
      activity2Revealed = {},
      activity3Answers = {},
      activity4Blanks = {},
      progressPercentage = 0,
      timeSpent = 0,
    } = req.body;
    const studentId = req.user._id;

    if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Valid assignmentId is required');
    }

    const resolved = await resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId });
    if (resolved.error) return sendError(res, resolved.error.statusCode, resolved.error.message);

    const assignment = resolved.assignment;
    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, 'Worksheet not found');

    const now = new Date();
    let isNewDraft = false;

    let draft = await WorksheetDraft.findOne({ assignmentId, studentId });

    if (draft) {
      // Update existing draft
      draft.activity1Answers = activity1Answers;
      draft.activity2Answers = activity2Answers;
      draft.activity2Revealed = activity2Revealed;
      draft.activity3Answers = activity3Answers;
      draft.activity4Blanks = activity4Blanks;
      draft.progressPercentage = Math.min(100, Math.max(0, Number(progressPercentage) || 0));
      draft.timeSpent = Number(timeSpent) || 0;
      draft.lastSavedAt = now;
      await draft.save();
    } else {
      // Create new draft
      isNewDraft = true;
      draft = new WorksheetDraft({
        worksheetId: worksheet._id,
        assignmentId,
        studentId,
        activity1Answers,
        activity2Answers,
        activity2Revealed,
        activity3Answers,
        activity4Blanks,
        progressPercentage: Math.min(100, Math.max(0, Number(progressPercentage) || 0)),
        timeSpent: Number(timeSpent) || 0,
        startedAt: now,
        lastSavedAt: now,
      });
      await draft.save();
    }

    // Publish SSE event for teacher dashboard
    try {
      const eventData = {
        type: isNewDraft ? 'worksheet_started' : 'worksheet_progress',
        worksheetId: String(worksheet._id),
        worksheetTitle: worksheet.title,
        assignmentId: String(assignment._id),
        studentId: String(studentId),
        progressPercentage: draft.progressPercentage,
        timeSpent: draft.timeSpent,
        lastSavedAt: draft.lastSavedAt,
      };
      await publishNotification(String(assignment.teacher), eventData);
    } catch (sseErr) {
      logger.warn('[SAVE WORKSHEET DRAFT] SSE publish failed:', sseErr.message);
    }

    return sendSuccess(res, draft);
  } catch (error) {
    console.error('[SAVE WORKSHEET DRAFT] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to save draft');
  }
}

/**
 * DELETE /api/worksheets/:id/draft
 * Auth: student only
 * Deletes the student's draft for this worksheet (called on successful submission).
 */
async function deleteWorksheetDraft(req, res) {
  try {
    const worksheetId = req.params.id;
    const { assignmentId } = req.query;
    const studentId = req.user._id;

    if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, 'Valid assignmentId query param is required');
    }

    const resolved = await resolveStudentWorksheetAssignment({ worksheetId, assignmentId, studentId });
    if (resolved.error) return sendError(res, resolved.error.statusCode, resolved.error.message);

    const result = await WorksheetDraft.deleteOne({ assignmentId, studentId });
    return sendSuccess(res, { deleted: result.deletedCount > 0 });
  } catch (error) {
    console.error('[DELETE WORKSHEET DRAFT] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to delete draft');
  }
}

module.exports = {
  generateWorksheet,
  uploadAndGenerate,
  createWorksheet,
  getMyWorksheets,
  getWorksheetById,
  updateWorksheet,
  deleteWorksheet,
  regenerateTheme,
  shareWorksheet,
  revokeShareWorksheet,
  gradeWorksheetAttempt,
  getWorksheetDraft,
  saveWorksheetDraft,
  deleteWorksheetDraft,
  submitWorksheet,
  getMySubmission,
  getMySubmissionByAssignment,
  getSubmissions,
  getWorksheetReport,
  assignWorksheet,
};
