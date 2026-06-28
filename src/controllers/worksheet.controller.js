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
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const Worksheet = require("../models/Worksheet");
const WorksheetSubmission = require("../models/WorksheetSubmission");
const WorksheetDraft = require("../models/WorksheetDraft");
const Assignment = require("../models/assignment.model");
const Class = require("../models/class.model");
const Membership = require("../models/membership.model");
const { createNotification } = require("../services/notification.service");
const {
  gradeWorksheetAnswers,
} = require("../services/worksheetScoring.service");
const {
  publishNotification,
} = require("../services/notificationRealtime.service");
const logger = require("../utils/logger");
const { callVisionModelWithFallback, parseVisionJSON } = require("../utils/visionAI.utils");
const {
  generateWorksheetTheme,
  getDefaultTheme,
} = require("../services/worksheetTheme.service");
const {
  getDefaultActivityTypes,
  getActivityType,
} = require("../config/activityTypes.config");
const {
  extractContent,
  validateFile,
} = require("../services/fileContentExtractor.service");
const { generateChatCompletion } = require("../services/aiGeneration.service");
const multer = require("multer");
const jsonrepair = require("jsonrepair");
const {
  generateHtmlWorksheetFromFile,
} = require("../services/geminiWorksheet.service");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const vision = require('@google-cloud/vision');
const fs = require("fs");
const path = require("path");
const pdfjsLib = require("pdfjs-dist/legacy/build/pdf.js");
const { createCanvas } = require("canvas");

// Custom CanvasFactory for Node.js compatibility with pdfjs-dist legacy build
class NodeCanvasFactory {
  constructor() {
    this._canvas = createCanvas(0, 0);
  }

  create(width, height) {
    const canvas = createCanvas(width, height);
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(canvasAndContext, width, height) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

// Configure multer for in-memory file storage (temp)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
});

// Helper: Convert PDF buffer to base64 image using pdfjs-dist + canvas
async function convertPdfToBase64Image(fileBuffer) {
  // Load PDF from buffer with custom CanvasFactory
  const canvasFactory = new NodeCanvasFactory();
  const loadingTask = pdfjsLib.getDocument({ 
    data: new Uint8Array(fileBuffer),
    canvasFactory: canvasFactory
  });
  const pdf = await loadingTask.promise;
  
  // Get first page
  const page = await pdf.getPage(1);
  
  // Set scale for good quality
  const scale = 1.5;
  const viewport = page.getViewport({ scale });
  
  // Create canvas using the factory
  const canvasAndContext = canvasFactory.create(viewport.width, viewport.height);
  
  // Render PDF page to canvas
  await page.render({
    canvasContext: canvasAndContext.context,
    viewport: viewport
  }).promise;
  
  // Export as base64 JPEG
  const base64 = canvasAndContext.canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
  
  // Clean up
  canvasFactory.destroy(canvasAndContext);
  
  return base64;
}

/**
 * Helper: Fetch a single Unsplash image for labeling activities
 * @param {string} topic - The worksheet topic to search for relevant images
 * @returns {Promise<string>} Image URL or fallback URL
 */
async function fetchUnsplashImageForLabeling(topic) {
  const unsplashAccessKey = process.env.UNSPLASH_ACCESS_KEY;
  const fallbackUrl = 'https://images.unsplash.com/photo-1441974231531-c6227db76b6e?w=800';

  if (!unsplashAccessKey) {
    logger.warn("[LABELING] UNSPLASH_ACCESS_KEY not configured, using fallback image");
    return fallbackUrl;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(
      `https://api.unsplash.com/search/photos?query=${encodeURIComponent(topic)}&per_page=1&orientation=landscape`,
      {
        headers: {
          Authorization: `Client-ID ${unsplashAccessKey}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      },
    );

    clearTimeout(timeoutId);

    if (!response.ok) {
      logger.warn(`[LABELING] Unsplash API failed: ${response.status}, using fallback`);
      return fallbackUrl;
    }

    const data = await response.json();
    const results = data.results || [];

    if (results.length === 0) {
      logger.warn("[LABELING] No Unsplash results found, using fallback");
      return fallbackUrl;
    }

    // Use regular URL (not small) for better quality in labeling activity
    const imageUrl = results[0].urls?.regular || results[0].urls?.full || results[0].urls?.small;
    
    if (!imageUrl) {
      logger.warn("[LABELING] Unsplash result has no URL, using fallback");
      return fallbackUrl;
    }

    logger.info(`[LABELING] Fetched Unsplash image for topic: ${topic}`);
    return imageUrl;
  } catch (error) {
    if (error.name === "AbortError") {
      logger.warn("[LABELING] Unsplash request timeout, using fallback");
    } else {
      logger.error("[LABELING] Unsplash fetch error:", error);
    }
    return fallbackUrl;
  }
}

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
function parseWorksheetAIResponse(aiText, fallbackTopic = "Worksheet") {
  console.log("[PARSE AI] Input length:", aiText.length);

  // Step 1: Extract JSON object from AI response (handles markdown code fences, extra text)
  const jsonMatch = aiText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("No JSON object found in AI response");
  }
  const extractedJson = jsonMatch[0];
  console.log("[PARSE AI] Extracted JSON length:", extractedJson.length);

  // Step 2: Try to parse JSON directly
  let parsed;
  try {
    parsed = JSON.parse(extractedJson);
    console.log("[PARSE AI] Direct parse successful");
  } catch (parseError) {
    console.log(
      "[PARSE AI] Direct parse failed, attempting repair:",
      parseError.message,
    );
    // Step 3: Use jsonrepair to fix common JSON issues
    try {
      const repaired = jsonrepair(extractedJson);
      console.log("[PARSE AI] Repaired JSON length:", repaired.length);
      parsed = JSON.parse(repaired);
      console.log("[PARSE AI] Parse after repair successful");
    } catch (repairError) {
      console.error("[PARSE AI] Repair failed:", repairError.message);
      throw new Error(`JSON parse and repair failed: ${parseError.message}`);
    }
  }

  // Step 4: Validate required fields
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Parsed result is not a valid object");
  }

  // Validate title
  if (
    !parsed.title ||
    typeof parsed.title !== "string" ||
    !parsed.title.trim()
  ) {
    console.warn("[PARSE AI] Missing title, using fallback");
    parsed.title = `${fallbackTopic.slice(0, 50)} Worksheet`;
  }

  // Validate description (optional but should exist)
  if (!parsed.description) {
    parsed.description = "";
  }

  // Validate subject (optional but should exist)
  if (!parsed.subject) {
    parsed.subject = "General";
  }

  // Validate activities array (required)
  if (!Array.isArray(parsed.activities) || parsed.activities.length === 0) {
    throw new Error("No activities array found in response");
  }

  // Filter to valid activities only (must have type, title, instructions, data)
  const validActivities = parsed.activities.filter(
    (a) =>
      a &&
      typeof a === "object" &&
      a.type &&
      a.title &&
      a.instructions &&
      a.data,
  );

  if (validActivities.length === 0) {
    throw new Error(
      "No valid activities after filtering (missing type, title, instructions, or data)",
    );
  }

  parsed.activities = validActivities;
  console.log(
    "[PARSE AI] Validation successful - activities:",
    validActivities.length,
    "| types:",
    validActivities.map((a) => a.type).join(", "),
  );

  return parsed;
}

function normalizeGeneratedJsonText(value) {
  return String(value || "")
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^\uFEFF/, "")
    .trim();
}

function computeDeadlineStatus(assignment) {
  const now = new Date();
  const deadline =
    assignment && assignment.deadline ? new Date(assignment.deadline) : null;
  const isLate = Boolean(deadline && now.getTime() > deadline.getTime());
  const status = isLate ? "late" : "submitted";
  return { now, isLate, status };
}

async function resolveStudentWorksheetAssignment({
  worksheetId,
  assignmentId,
  studentId,
}) {
  if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
    return {
      error: { statusCode: 400, message: "Valid assignmentId is required" },
    };
  }

  const assignment = await Assignment.findOne({
    _id: assignmentId,
    isActive: true,
  }).lean();
  if (!assignment) {
    return { error: { statusCode: 404, message: "Assignment not found" } };
  }

  if (String(assignment.resourceType || "") !== "worksheet") {
    return {
      error: {
        statusCode: 400,
        message: "Assignment is not a worksheet assignment",
      },
    };
  }

  if (String(assignment.resourceId || "") !== String(worksheetId)) {
    return {
      error: {
        statusCode: 400,
        message: "Assignment does not match worksheet",
      },
    };
  }

  const classDoc = await Class.findOne({
    _id: assignment.class,
    isActive: true,
  }).lean();
  if (!classDoc) {
    return { error: { statusCode: 404, message: "Class not found" } };
  }

  const membership = await Membership.findOne({
    student: studentId,
    class: classDoc._id,
    status: "active",
  }).lean();

  if (!membership) {
    return { error: { statusCode: 403, message: "Not class member" } };
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
        if (p.type !== "blank") return p;
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
 * Builds the AI prompt for worksheet generation with template structure.
 * Includes design guidance from analyzed template.
 */
function buildWorksheetPromptWithTemplate(topic, language, difficulty, resolvedTypes, templateStructure) {
  const DEFAULT_TYPES = [
    "ordering",
    "classification",
    "multipleChoice",
    "fillBlanks",
    "labeling",
  ];
  const types =
    Array.isArray(resolvedTypes) && resolvedTypes.length > 0
      ? resolvedTypes
      : DEFAULT_TYPES;

  const typeInstructions = {
    ordering: "items[] each {id,emoji,name,role,correctOrder(int)}. 4-6 items.",
    classification:
      "categories[](2-3 strings), items[] each {id,emoji,name,description,correctCategory}. 6-8 items.",
    multipleChoice:
      "questions[] each {id,text,options[4 strings],correctAnswer(string)}. 5 questions.",
    fillBlanks:
      'wordBank[5 strings], sentences[] each {id,parts[{type:"text",value}|{type:"blank",blankId,correctAnswer}]}. 5 sentences.',
    matching: "pairs[] each {id,leftItem:{text},rightItem:{text}}. 5-6 pairs.",
    trueFalse:
      "questions[] each {id,text,correctAnswer(bool),explanation}. 5-6 questions.",
    shortAnswer:
      "questions[] each {id,text,modelAnswer,maxWords:50}. 3-4 questions.",
    labeling: `imageUrl(string - a real Unsplash image URL relevant to the topic, e.g. https://images.unsplash.com/photo-... use a real working URL), labels[] each {id(string),text(string - the label name e.g. "Roots","Trunk","Leaves"),x(number 10-90 - percentage position from left),y(number 10-90 - percentage position from top),targetId(string same as id)}. 5-8 labels. IMPORTANT: x and y coordinates must be spread across the image, not all clustered together. Think about where that part actually appears on the image and place the label there.`,
  };

  const activityList = types
    .map(
      (t, i) =>
        `Activity ${i + 1}: type="${t}" — data must contain: ${typeInstructions[t] || "appropriate fields"}`,
    )
    .join("\n");

  // Build template design guidance
  const templateGuidance = templateStructure ? `
IMPORTANT: Generate the worksheet following this EXACT visual design structure that the teacher provided as a template:

Layout: ${templateStructure.pageLayout || 'single_column'}
Visual Style: ${templateStructure.visualStyle || 'structured'}
Has student info header: ${templateStructure.hasStudentInfoSection || false}
Design notes: ${templateStructure.designNotes || 'N/A'}

Sections to generate (in this exact order):
${templateStructure.sections?.map((s, i) => `- Section ${i + 1}: ${s.type} (${s.questionCount} questions) - ${s.layoutHint || 'standard layout'}`).join('\n') || 'No sections specified'}

The teacher wants the final worksheet to look and feel like their template but with new content about: ${topic}
` : '';

  return `Generate an educational worksheet as valid JSON only.
No markdown. No explanation. Raw JSON object only. Start with { end with }.

Topic: ${topic}
Difficulty: ${difficulty || "medium"}
Language: ${language || "English"}

${templateGuidance}

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
 * Builds the AI prompt for worksheet generation.
 * Compact prompt to minimise input tokens, leaving maximum room for output.
 */
function buildWorksheetPrompt(topic, language, difficulty, resolvedTypes) {
  const DEFAULT_TYPES = [
    "ordering",
    "classification",
    "multipleChoice",
    "fillBlanks",
    "labeling",
  ];
  const types =
    Array.isArray(resolvedTypes) && resolvedTypes.length > 0
      ? resolvedTypes
      : DEFAULT_TYPES;

  const typeInstructions = {
    ordering: "items[] each {id,emoji,name,role,correctOrder(int)}. 4-6 items.",
    classification:
      "categories[](2-3 strings), items[] each {id,emoji,name,description,correctCategory}. 6-8 items.",
    multipleChoice:
      "questions[] each {id,text,options[4 strings],correctAnswer(string)}. 5 questions.",
    fillBlanks:
      'wordBank[5 strings], sentences[] each {id,parts[{type:"text",value}|{type:"blank",blankId,correctAnswer}]}. 5 sentences.',
    matching: "pairs[] each {id,leftItem:{text},rightItem:{text}}. 5-6 pairs.",
    trueFalse:
      "questions[] each {id,text,correctAnswer(bool),explanation}. 5-6 questions.",
    shortAnswer:
      "questions[] each {id,text,modelAnswer,maxWords:50}. 3-4 questions.",
    labeling: `imageUrl(string - a real Unsplash image URL relevant to the topic, e.g. https://images.unsplash.com/photo-... use a real working URL), labels[] each {id(string),text(string - the label name e.g. "Roots","Trunk","Leaves"),x(number 10-90 - percentage position from left),y(number 10-90 - percentage position from top),targetId(string same as id)}. 5-8 labels. IMPORTANT: x and y coordinates must be spread across the image, not all clustered together. Think about where that part actually appears on the image and place the label there.`,
  };

  const activityList = types
    .map(
      (t, i) =>
        `Activity ${i + 1}: type="${t}" — data must contain: ${typeInstructions[t] || "appropriate fields"}`,
    )
    .join("\n");

  return `Generate an educational worksheet as valid JSON only.
No markdown. No explanation. Raw JSON object only. Start with { end with }.

Topic: ${topic}
Difficulty: ${difficulty || "medium"}
Language: ${language || "English"}

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
 * Accepts: { inputType:'topic', content, questionCount, language, difficulty, questionTypes, templateStructure }
 */
async function generateWorksheet(req, res) {
  console.log("[GENERATE WORKSHEET] req.body:", JSON.stringify(req.body));
  try {
    const {
      inputType = "topic",
      content = "",
      language = "English",
      difficulty = "medium",
      activityTypes = null,
      templateStructure = null,
    } = req.body;

    if (inputType === "image") {
      return sendError(
        res,
        400,
        "Image-based generation: paste extracted text as content.",
      );
    }

    const sourceText = String(content || "").trim();
    if (!sourceText || sourceText.length < 3) {
      return sendError(
        res,
        400,
        "content is required for topic-based generation",
      );
    }

    // Resolve activity types: null/empty → 4 defaults, otherwise use selected
    const DEFAULT_TYPES = [
      "ordering",
      "classification",
      "multipleChoice",
      "fillBlanks",
      "labeling",
    ];
    let resolvedTypes =
      Array.isArray(activityTypes) && activityTypes.length > 0
        ? activityTypes.filter((t) => typeof t === "string" && t.trim())
        : DEFAULT_TYPES;
    if (resolvedTypes.length === 0) resolvedTypes = DEFAULT_TYPES;
    console.log("[GENERATE] Resolved activity types:", resolvedTypes);
    console.log("[GENERATE] Topic:", sourceText.slice(0, 100));

    // If templateStructure is provided, modify the prompt to include design structure
    let prompt;
    if (templateStructure && typeof templateStructure === "object") {
      console.log("[GENERATE] Using template structure for design guidance");
      prompt = buildWorksheetPromptWithTemplate(
        sourceText,
        language,
        difficulty,
        resolvedTypes,
        templateStructure
      );
    } else {
      prompt = buildWorksheetPrompt(
        sourceText,
        language,
        difficulty,
        resolvedTypes,
      );
    }

    // Use structured output for reliable JSON
    const rawText = await generateChatCompletion(
      [
        {
          role: "system",
          content:
            "You are a worksheet generation assistant. Return ONLY valid JSON. No markdown, no code fences, no explanation. Start your response with { and end with }.",
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.2, // Lower temperature for more consistent output
        max_tokens: 8000,
        response_format: { type: "json_object" }, // Force JSON output
      },
    );

    console.log("[GENERATE] AI response length:", rawText.length);

    // Use robust parser with JSON repair and validation
    let parsed;
    try {
      parsed = parseWorksheetAIResponse(rawText, sourceText);
    } catch (parseError) {
      console.error("[GENERATE] Parse error:", parseError.message);
      return res.status(500).json({
        success: false,
        message: "Worksheet generation failed",
        error: parseError.message,
      });
    }

    console.log(
      "[GENERATE] Success — activities:",
      parsed.activities.length,
      "| types:",
      parsed.activities.map((a) => a.type).join(", "),
    );

    // Fetch Unsplash images for labeling activities
    for (const activity of parsed.activities) {
      if (activity.type === 'labeling' && activity.data) {
        console.log("[GENERATE] Fetching Unsplash image for labeling activity");
        const imageUrl = await fetchUnsplashImageForLabeling(sourceText);
        activity.data.imageUrl = imageUrl;
        console.log("[GENERATE] Injected imageUrl for labeling activity:", imageUrl);
      }
    }

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: sourceText.slice(0, 500),
    });
  } catch (error) {
    console.error(
      "[GENERATE WORKSHEET] OpenAI error:",
      error.response?.data || error.message,
    );
    if (error.status === 402)
      return sendError(
        res,
        500,
        "AI service credits exhausted. Contact admin.",
      );
    if (error.status === 429)
      return sendError(
        res,
        500,
        "AI service rate limited. Try again in a moment.",
      );
    if (error.status === 401)
      return sendError(res, 500, "AI service authentication failed.");
    if (error.status === 400)
      return sendError(res, 500, "Invalid model ID or request format.");
    return res.status(500).json({
      success: false,
      message: "Worksheet generation failed",
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
  console.log("[UPLOAD AND GENERATE] Starting file upload");

  if (!req.file) {
    return sendError(res, 400, "No file uploaded");
  }

  try {
    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log(
      "[UPLOAD AND GENERATE] File validated:",
      req.file.originalname,
      req.file.mimetype,
    );

    // Extract content from file
    let extractedText;
    try {
      extractedText = await extractContent(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname,
      );
    } catch (extractionError) {
      console.error(
        "[UPLOAD AND GENERATE] Extraction failed:",
        extractionError.message,
      );
      return sendError(res, 400, extractionError.message);
    }

    console.log(
      "[UPLOAD AND GENERATE] Content extracted, length:",
      extractedText.length,
    );

    // Get generation options from form data
    const language = req.body.language || "English";
    const difficulty = req.body.difficulty || "medium";
    const rawActivityTypes = req.body.activityTypes
      ? JSON.parse(req.body.activityTypes)
      : null;
    const DEFAULT_TYPES = [
      "ordering",
      "classification",
      "multipleChoice",
      "fillBlanks",
      "labeling",
    ];
    let resolvedTypes =
      Array.isArray(rawActivityTypes) && rawActivityTypes.length > 0
        ? rawActivityTypes.filter((t) => typeof t === "string" && t.trim())
        : DEFAULT_TYPES;
    if (resolvedTypes.length === 0) resolvedTypes = DEFAULT_TYPES;
    console.log(
      "[UPLOAD AND GENERATE] Resolved activity types:",
      resolvedTypes,
    );

    // Build prompt with extracted content
    const prompt = buildWorksheetPrompt(
      extractedText,
      language,
      difficulty,
      resolvedTypes,
    );

    // Use structured output for reliable JSON
    const rawText = await generateChatCompletion(
      [
        {
          role: "system",
          content:
            "You are a worksheet generation assistant. Return ONLY valid JSON. No markdown, no preamble, no explanation.",
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.2, // Lower temperature for more consistent output
        max_tokens: 8000,
        response_format: { type: "json_object" }, // Force JSON output
      },
    );

    console.log("[UPLOAD AND GENERATE] AI response length:", rawText.length);

    // Use robust parser with JSON repair and validation
    let parsed;
    try {
      parsed = parseWorksheetAIResponse(rawText, extractedText.slice(0, 50));
    } catch (parseError) {
      console.error("[UPLOAD AND GENERATE] Parse error:", parseError.message);
      return res.status(500).json({
        success: false,
        message: "Worksheet generation failed",
        error: parseError.message,
      });
    }

    console.log(
      "[UPLOAD AND GENERATE] Success — activities:",
      parsed.activities.length,
      "| types:",
      parsed.activities.map((a) => a.type).join(", "),
    );

    // Fetch Unsplash images for labeling activities
    for (const activity of parsed.activities) {
      if (activity.type === 'labeling' && activity.data) {
        console.log("[UPLOAD AND GENERATE] Fetching Unsplash image for labeling activity");
        const imageUrl = await fetchUnsplashImageForLabeling(extractedText);
        activity.data.imageUrl = imageUrl;
        console.log("[UPLOAD AND GENERATE] Injected imageUrl for labeling activity:", imageUrl);
      }
    }

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: extractedText.slice(0, 500),
      fileName: req.file.originalname,
    });
  } catch (error) {
    console.error(
      "[UPLOAD AND GENERATE] OpenAI error:",
      error.response?.data || error.message,
    );
    if (error.status === 402)
      return sendError(
        res,
        500,
        "AI service credits exhausted. Contact admin.",
      );
    if (error.status === 429)
      return sendError(
        res,
        500,
        "AI service rate limited. Try again in a moment.",
      );
    if (error.status === 401)
      return sendError(res, 500, "AI service authentication failed.");
    if (error.status === 400)
      return sendError(res, 500, "Invalid model ID or request format.");
    return res.status(500).json({
      success: false,
      message: "Worksheet generation failed",
      error: error.message,
    });
  }
}

/**
 * POST /api/worksheets/generate-from-file
 * Auth: teacher only
 * Uploads a file (PDF/DOCX/TXT/PNG/JPG), analyzes it with Gemini Vision,
 * and generates a new worksheet matching the same format and activity types.
 * Accepts: multipart/form-data with file, topic, subject, gradeLevel, difficulty, language
 */
async function generateFromFile(req, res) {
  console.log("[GENERATE FROM FILE] Starting Gemini file analysis");

  if (!req.file) {
    return sendError(res, 400, "No file uploaded");
  }

  // Check if GEMINI_API_KEY is configured
  if (!process.env.GEMINI_API_KEY) {
    console.error("[GENERATE FROM FILE] GEMINI_API_KEY not configured");
    return sendError(
      res,
      500,
      "AI service not configured. Please contact admin."
    );
  }

  try {
    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log(
      "[GENERATE FROM FILE] File validated:",
      req.file.originalname,
      req.file.mimetype
    );

    // Extract content from file
    let extractedText;
    try {
      extractedText = await extractContent(
        req.file.buffer,
        req.file.mimetype,
        req.file.originalname
      );
    } catch (extractionError) {
      console.error(
        "[GENERATE FROM FILE] Extraction failed:",
        extractionError.message
      );
      return sendError(res, 400, extractionError.message);
    }

    console.log(
      "[GENERATE FROM FILE] Content extracted, length:",
      extractedText.length
    );

    // Get generation options from form data
    const topic = req.body.topic || "";
    const subject = req.body.subject || "General";
    const gradeLevel = req.body.gradeLevel || "Not specified";
    const difficulty = req.body.difficulty || "medium";
    const language = req.body.language || "English";

    if (!topic || topic.trim().length === 0) {
      return sendError(res, 400, "Topic is required");
    }

    // Initialize Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    // Build content array for Gemini
    let contentParts = [];

    // For images and PDFs, send as base64
    if (
      req.file.mimetype.startsWith("image/") ||
      req.file.mimetype === "application/pdf"
    ) {
      const base64Data = req.file.buffer.toString("base64");
      contentParts.push({
        inlineData: {
          mimeType: req.file.mimetype,
          data: base64Data,
        },
      });
    }

    // Add text content
    contentParts.push({
      text: buildGeminiPrompt(
        topic,
        subject,
        gradeLevel,
        difficulty,
        language,
        extractedText
      ),
    });

    console.log(
      "[GENERATE FROM FILE] Sending to Gemini with",
      contentParts.length,
      "parts"
    );

    // Call Gemini
    const result = await model.generateContent(contentParts);
    const responseText = result.response.text();

    console.log("[GENERATE FROM FILE] Gemini response length:", responseText.length);

    // Clean and parse JSON response
    const cleaned = responseText.replace(/```json|```/g, "").trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch (parseError) {
      console.error("[GENERATE FROM FILE] JSON parse error:", parseError.message);
      // Try jsonrepair
      try {
        const repaired = require("jsonrepair")(cleaned);
        parsed = JSON.parse(repaired);
      } catch (repairError) {
        console.error("[GENERATE FROM FILE] JSON repair failed:", repairError.message);
        return res.status(500).json({
          success: false,
          message: "Invalid response format from AI",
          error: "Could not parse generated worksheet structure",
        });
      }
    }

    // Validate parsed result
    if (!parsed || typeof parsed !== "object") {
      return res.status(500).json({
        success: false,
        message: "Invalid worksheet structure",
        error: "Generated result is not a valid object",
      });
    }

    // Ensure title exists
    if (!parsed.title || typeof parsed.title !== "string") {
      parsed.title = `${topic.slice(0, 50)} Worksheet`;
    }

    // Ensure activities array exists
    if (!Array.isArray(parsed.activities) || parsed.activities.length === 0) {
      return res.status(500).json({
        success: false,
        message: "Invalid worksheet structure",
        error: "No activities in generated worksheet",
      });
    }

    console.log(
      "[GENERATE FROM FILE] Success — activities:",
      parsed.activities.length,
      "| types:",
      parsed.activities.map((a) => a.type).join(", ")
    );

    return res.json({
      success: true,
      worksheet: parsed,
      sourceContent: extractedText.slice(0, 500),
      fileName: req.file.originalname,
    });
  } catch (error) {
    console.error("[GENERATE FROM FILE] Error:", error.message);

    // Handle Gemini-specific errors
    if (error.message && error.message.includes("API key")) {
      return sendError(
        res,
        500,
        "AI service authentication failed. Please check API configuration."
      );
    }

    if (error.message && error.message.includes("429")) {
      return res.status(429).json({
        success: false,
        message: "AI quota exceeded. Please try again later.",
      });
    }

    if (error.message && error.message.includes("400")) {
      return sendError(res, 400, "Invalid request to AI service.");
    }

    return res.status(500).json({
      success: false,
      message: "Worksheet generation failed",
      error: error.message,
    });
  }
}

/**
 * Build the prompt for Gemini to generate a worksheet based on uploaded file.
 */
function buildGeminiPrompt(topic, subject, gradeLevel, difficulty, language, extractedContent) {
  return `You are an expert educational worksheet creator.

Analyze the uploaded worksheet content carefully and identify:
1. The activity types used (e.g., multiple_choice, fill_in_blanks, matching, ordering, true_false, short_answer)
2. The number of questions per activity
3. The difficulty level and structure
4. The formatting and style

Now generate a BRAND NEW worksheet with these specifications:
- Topic: ${topic}
- Subject: ${subject}
- Grade Level: ${gradeLevel}
- Difficulty: ${difficulty}
- Language: ${language}

USE THE EXACT SAME activity types, structure, and number of questions as identified from the example.

Return ONLY a valid JSON object. No markdown, no explanation, no extra text.
Format exactly as shown:
{
  "title": "worksheet title related to ${topic}",
  "topic": "${topic}",
  "subject": "${subject}",
  "difficulty": "${difficulty}",
  "language": "${language}",
  "gradeLevel": "${gradeLevel}",
  "description": "Brief description of the worksheet",
  "activities": [
    {
      "type": "multiple_choice | fill_in_blanks | matching | ordering | true_false | short_answer",
      "title": "Activity title",
      "instruction": "Clear instruction for students",
      "questions": [
        {
          "id": 1,
          "question": "question text",
          "options": ["A", "B", "C", "D"],
          "answer": "correct answer"
        }
      ]
    }
  ]
}

Example structure from the uploaded file:
${extractedContent.slice(0, 1000)}

Generate new content with the SAME activity types and question count as the example. Make all content original and related to: ${topic}`;
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
      title,
      description,
      subject,
      tags,
      estimatedMinutes,
      conceptExplanation,
      activity1,
      activity2,
      activity3,
      activity4,
      activities,
      generationSource,
      sourceContent,
      language,
      difficulty,
      cefrLevel,
      gradeLevel,
      gradeCategory,
      assignmentDeadline,
    } = req.body;

    if (!title || !String(title).trim()) {
      return sendError(res, 400, "Title is required");
    }

    if (!assignmentDeadline) {
      return sendError(res, 400, "Assignment deadline is required");
    }

    const d = new Date(assignmentDeadline);
    if (isNaN(d.getTime())) {
      return sendError(res, 400, "Invalid assignment deadline");
    }
    if (d.getTime() <= Date.now()) {
      return sendError(res, 400, "Assignment deadline must be a future date");
    }
    const parsedAssignmentDeadline = d;

    // Calculate total points from either new activities array or legacy fields
    let totalPoints = 0;
    if (Array.isArray(activities) && activities.length > 0) {
      // New extensible activities array
      activities.forEach((activity) => {
        const data = activity.data || {};
        if (
          activity.type === "ordering" ||
          activity.type === "classification" ||
          activity.type === "matching" ||
          activity.type === "dragDrop" ||
          activity.type === "sorting"
        ) {
          totalPoints += data.items?.length || 0;
        } else if (
          activity.type === "multipleChoice" ||
          activity.type === "trueFalse" ||
          activity.type === "shortAnswer"
        ) {
          totalPoints += data.questions?.length || 0;
        } else if (activity.type === "fillBlanks") {
          totalPoints += data.sentences?.length || 0;
        } else if (activity.type === "labeling") {
          totalPoints += data.labels?.length || 0;
        } else if (
          activity.type === "wordSearch" ||
          activity.type === "crossword"
        ) {
          totalPoints += data.words?.length || 0;
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
        String(description || "").trim(),
      );
    } catch (themeErr) {
      console.error(
        "[CREATE WORKSHEET] Theme generation failed, using default:",
        themeErr.message,
      );
    }

    const worksheet = new Worksheet({
      title: String(title).trim(),
      description: String(description || "").trim(),
      subject: String(subject || "").trim(),
      assignmentDeadline: parsedAssignmentDeadline,
      tags: Array.isArray(tags) ? tags : [],
      estimatedMinutes: estimatedMinutes || 20,
      conceptExplanation: conceptExplanation || null,
      activities: Array.isArray(activities)
        ? activities.map((act) => {
            if (act?.type === "fillBlanks" && act.data) {
              return { ...act, data: sanitizeActivity4BlankIds(act.data) };
            }
            return act;
          })
        : [],
      // Legacy fields for backward compatibility
      activity1: activity1 || null,
      activity2: activity2 || null,
      activity3: activity3 || null,
      activity4: activity4 ? sanitizeActivity4BlankIds(activity4) : null,
      generationSource: generationSource || "topic",
      sourceContent: sourceContent || "",
      language: language || "English",
      difficulty: difficulty || null,
      cefrLevel: cefrLevel || null,
      gradeLevel: gradeLevel || null,
      gradeCategory: gradeCategory || null,
      totalPoints,
      theme,
      createdBy: req.user._id,
      isPublished: true,
    });

    await worksheet.save();
    console.log(
      "[CREATE WORKSHEET] Created:",
      worksheet._id,
      "totalPoints:",
      totalPoints,
      "theme:",
      theme.patternType,
    );
    return res.status(201).json({ success: true, worksheet });
  } catch (error) {
    console.error("[CREATE WORKSHEET] Error:", error.message);
    console.error("[CREATE WORKSHEET] Stack:", error.stack);
    if (error.name === "ValidationError") {
      console.error(
        "[CREATE WORKSHEET] Validation:",
        JSON.stringify(error.errors, null, 2),
      );
      return sendError(
        res,
        400,
        `Validation failed: ${Object.values(error.errors)
          .map((e) => e.message)
          .join(", ")}`,
      );
    }
    return sendError(res, 500, error.message || "Failed to save worksheet");
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
      cefrLevel,
      gradeLevel,
      gradeCategory,
      subject,
      difficulty,
      search,
      sortBy = "updatedAt",
      sortOrder = "desc",
      page = 1,
      limit = 50,
    } = req.query;

    const filter = { createdBy: req.user._id };

    // Support both single values and arrays for multi-select
    if (cefrLevel) {
      filter.cefrLevel = Array.isArray(cefrLevel)
        ? { $in: cefrLevel }
        : cefrLevel;
    }
    if (gradeLevel) {
      filter.gradeLevel = Array.isArray(gradeLevel)
        ? { $in: gradeLevel }
        : gradeLevel;
    }
    if (gradeCategory) {
      filter.gradeCategory = Array.isArray(gradeCategory)
        ? { $in: gradeCategory }
        : gradeCategory;
    }
    if (subject) {
      filter.subject = Array.isArray(subject) ? { $in: subject } : subject;
    }
    if (difficulty) {
      filter.difficulty = Array.isArray(difficulty)
        ? { $in: difficulty }
        : difficulty;
    }

    if (search && String(search).trim()) {
      const q = String(search).trim();
      filter.$or = [
        { title: { $regex: q, $options: "i" } },
        { description: { $regex: q, $options: "i" } },
        { tags: { $in: [new RegExp(q, "i")] } },
      ];
    }

    const sortDir = sortOrder === "asc" ? 1 : -1;
    const allowedSort = ["title", "createdAt", "updatedAt", "totalPoints"];
    const sortField = allowedSort.includes(String(sortBy))
      ? String(sortBy)
      : "updatedAt";
    const sort = { [sortField]: sortDir };

    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.min(100, Math.max(1, Number(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [total, worksheets] = await Promise.all([
      Worksheet.countDocuments(filter),
      Worksheet.find(filter)
        .sort(sort)
        .skip(skip)
        .limit(limitNum)
        .select(
          "title description subject cefrLevel gradeLevel gradeCategory difficulty tags language estimatedMinutes totalPoints thumbnailUrl isPublic theme createdAt updatedAt",
        )
        .lean(),
    ]);

    return res.json({
      success: true,
      data: worksheets,
      pagination: {
        total,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(total / limitNum),
      },
    });
  } catch (error) {
    console.error("[GET WORKSHEETS] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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
    if (!worksheet) return sendError(res, 404, "Worksheet not found");

    if (req.user.role === "student") {
      const memberships = await Membership.find({
        student: req.user._id,
        status: "active",
      })
        .select("class")
        .lean();
      const activeClassIds = (memberships || []).map((m) => String(m.class));

      const assignment = await Assignment.findOne({
        resourceType: "worksheet",
        resourceId: String(worksheet._id),
        class: { $in: activeClassIds },
        isActive: true,
      })
        .select("_id")
        .lean();

      if (!assignment) {
        return sendError(res, 403, "You do not have access to this worksheet");
      }
    } else {
      if (String(worksheet.createdBy) !== String(req.user._id)) {
        return sendError(res, 403, "Forbidden");
      }
    }

    return sendSuccess(res, worksheet);
  } catch (error) {
    console.error("[GET WORKSHEET] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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
      { new: true, runValidators: true },
    );
    if (!worksheet)
      return sendError(res, 404, "Worksheet not found or not authorised");
    return sendSuccess(res, worksheet);
  } catch (error) {
    console.error("[UPDATE WORKSHEET] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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
    const worksheet = await Worksheet.findOne({
      _id: id,
      createdBy: userId,
    }).session(session);
    if (!worksheet) {
      await session.abortTransaction();
      session.endSession();
      return sendError(res, 404, "Worksheet not found or not authorised");
    }

    // Find all active assignments referencing this worksheet
    const assignments = await Assignment.find({
      resourceType: "worksheet",
      resourceId: String(id),
      isActive: true,
    })
      .select("_id class")
      .session(session);

    const assignmentIds = (assignments || []).map((a) => a._id);
    const affectedClassIds = (assignments || [])
      .map((a) => a.class)
      .filter(Boolean);

    // Cascade 1: Deactivate assignments
    if (assignmentIds.length > 0) {
      await Assignment.updateMany(
        { _id: { $in: assignmentIds } },
        { $set: { isActive: false } },
        { session },
      );
    }

    // Cascade 2: Delete worksheet submissions linked to these assignments
    if (assignmentIds.length > 0) {
      await WorksheetSubmission.deleteMany(
        { assignmentId: { $in: assignmentIds } },
        { session },
      );
    }

    // Cascade 3: Delete all worksheet submissions directly linked to this worksheet
    await WorksheetSubmission.deleteMany({ worksheetId: id }, { session });

    // Cascade 4: Delete worksheet drafts linked to this worksheet
    await WorksheetDraft.deleteMany({ worksheetId: id }, { session });

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
            status: "active",
          })
            .select("student")
            .lean();

          const studentIds = (memberships || [])
            .map((m) => m.student)
            .filter(Boolean);
          const teacherDisplay = String(
            req.user.displayName || req.user.email || "Teacher",
          );

          await Promise.all(
            studentIds.map((sId) =>
              createNotification({
                recipientId: sId,
                actorId: userId,
                type: "assignment_removed",
                title: "Worksheet removed",
                description: `${teacherDisplay} removed the worksheet "${worksheet.title}"`,
                data: {
                  resourceType: "worksheet",
                  resourceId: String(id),
                  assignmentIds: assignmentIds.map(String),
                },
              }),
            ),
          );
        } catch (notifyErr) {
          logger.warn("deleteWorksheet: notification error", notifyErr);
        }
      });
    }

    return sendSuccess(res, { message: "Worksheet deleted successfully" });
  } catch (err) {
    await session.abortTransaction();
    session.endSession();
    logger.error("deleteWorksheet failed", err);
    return sendError(res, 500, "Internal server error");
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
async function gradeShortAnswer(
  questionText,
  correctAnswer,
  studentAnswer,
  type,
) {
  if (!studentAnswer || !studentAnswer.trim()) {
    return { isCorrect: false, feedback: "No answer given." };
  }

  if (type === "fill-blank") {
    const correct = correctAnswer.toLowerCase().trim();
    const student = studentAnswer.toLowerCase().trim();
    if (student === correct || student.includes(correct)) {
      return { isCorrect: true, feedback: "Correct!" };
    }
  }

  try {
    const prompt = `Grade this student answer.
Question: "${questionText}"
Correct answer: "${correctAnswer}"
Student answer: "${studentAnswer}"
Return ONLY JSON: {"isCorrect": true or false, "feedback": "one sentence explanation"}`;

    const raw = await generateChatCompletion(
      [
        {
          role: "system",
          content:
            "You are a strict but fair grading assistant. Return ONLY valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      {
        temperature: 0.1,
        max_tokens: 80,
      },
    );

    const cleaned = raw.trim();
    const result = JSON.parse(raw);
    return {
      isCorrect: result.isCorrect === true,
      feedback: String(result.feedback || ""),
    };
  } catch {
    return { isCorrect: false, feedback: "Could not auto-grade." };
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
      activity9Answers,
      activity9Results,
      activity9Feedbacks,
    } = req.body;

    const studentId = req.user && req.user._id;
    if (!studentId) return sendError(res, 401, "Unauthorized");

    const resolved = await resolveStudentWorksheetAssignment({
      worksheetId,
      assignmentId,
      studentId,
    });
    if (resolved.error)
      return sendError(res, resolved.error.statusCode, resolved.error.message);
    const assignment = resolved.assignment;
    // classDoc is needed for the teacher notification (to pass classId to the frontend)
    const classDoc = resolved.classDoc;
    const { now, isLate, status } = computeDeadlineStatus(assignment);

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, "Worksheet not found");

    const existing = await WorksheetSubmission.findOne({
      assignmentId,
      studentId,
    });

    // Enforce deadline and resubmission rules
    if (existing) {
      if (isLate && assignment.allowLateResubmission !== true) {
        return sendError(
          res,
          403,
          "Deadline passed and late resubmission is not allowed",
        );
      }
      // If not late, check if resubmission is allowed (default: allow resubmission before deadline)
      // If you want to disable all resubmissions, add: return sendError(res, 403, 'Already submitted');
    } else {
      // New submission after deadline
      if (isLate && assignment.allowLateResubmission !== true) {
        return sendError(
          res,
          403,
          "Deadline passed and late submission is not allowed",
        );
      }
    }

    // ── Authoritative server-side scoring engine (do NOT trust client totals) ─
    const {
      gradedAnswers,
      totals,
      earnedPoints,
      totalPoints,
      score,
      isPassed,
      sections,
    } = gradeWorksheetAnswers({ worksheet, answers });

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
      existing.gradingStatus = "auto-graded";
      existing.isLate = isLate;
      existing.status = status;
      existing.submittedAt = now;
      existing.lastAttemptAt = now;
      existing.attempts = (Number(existing.attempts) || 1) + 1;
      // Activity 9 overlay worksheet data
      if (activity9Answers) existing.activity9Answers = activity9Answers;
      if (activity9Results) existing.activity9Results = activity9Results;
      if (activity9Feedbacks) existing.activity9Feedbacks = activity9Feedbacks;
      // Save activity9 specific score fields
      existing.activity9Score = totalPointsEarned;
      existing.activity9Total = totalPointsPossible;

      await existing.save();
      console.log(
        "[SUBMIT WORKSHEET] Updated:",
        existing._id,
        "score:",
        score,
        "% (",
        earnedPoints,
        "/",
        totalPoints,
        ")",
      );

      // Clear draft after successful submission update
      try {
        await WorksheetDraft.deleteOne({ assignmentId, studentId });
      } catch (draftErr) {
        logger.warn(
          "[SUBMIT WORKSHEET] Failed to clear draft:",
          draftErr.message,
        );
      }

      // Notify teacher via createNotification so the SSE fires as 'assignment_submitted'
      // (publishNotification was undefined — createNotification is the correct pattern)
      try {
        const studentDisplay = String(
          req.user.displayName || req.user.email || "A student",
        );
        await createNotification({
          recipientId: String(assignment.teacher),
          actorId: String(studentId),
          type: "assignment_submitted",
          title: "Worksheet submitted",
          description: `${studentDisplay} submitted "${worksheet.title}"`,
          data: {
            classId: String(classDoc._id),
            assignmentId: String(assignment._id),
            submissionId: String(existing._id),
            studentId: String(studentId),
            resourceType: "worksheet",
            worksheetId: String(worksheet._id),
            percentage: totals.percentage,
            score: score,
            isLate: isLate,
          },
        });
      } catch (sseErr) {
        logger.warn("[SUBMIT WORKSHEET] Notification failed:", sseErr.message);
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
      gradingStatus: "auto-graded",
      isLate,
      status,
      submittedAt: now,
      lastAttemptAt: now,
      attempts: 1,
      // Activity 9 overlay worksheet data
      activity9Answers: activity9Answers || {},
      activity9Results: activity9Results || {},
      activity9Feedbacks: activity9Feedbacks || {},
      activity9Score: totalPointsEarned,
      activity9Total: totalPointsPossible,
    });

    await created.save();
    console.log(
      "[SUBMIT WORKSHEET] Saved:",
      created._id,
      "score:",
      score,
      "% (",
      earnedPoints,
      "/",
      totalPoints,
      ")",
    );

    // Clear draft after successful submission
    try {
      await WorksheetDraft.deleteOne({ assignmentId, studentId });
    } catch (draftErr) {
      logger.warn(
        "[SUBMIT WORKSHEET] Failed to clear draft:",
        draftErr.message,
      );
    }

    // Notify teacher via createNotification so the SSE fires as 'assignment_submitted'
    // (publishNotification was undefined — createNotification is the correct pattern)
    try {
      const studentDisplay = String(
        req.user.displayName || req.user.email || "A student",
      );
      await createNotification({
        recipientId: String(assignment.teacher),
        actorId: String(studentId),
        type: "assignment_submitted",
        title: "Worksheet submitted",
        description: `${studentDisplay} submitted "${worksheet.title}"`,
        data: {
          classId: String(classDoc._id),
          assignmentId: String(assignment._id),
          submissionId: String(created._id),
          studentId: String(studentId),
          resourceType: "worksheet",
          worksheetId: String(worksheet._id),
          percentage: totals.percentage,
          score: score,
          isLate: isLate,
        },
      });
    } catch (sseErr) {
      logger.warn("[SUBMIT WORKSHEET] Notification failed:", sseErr.message);
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
    console.error("[SUBMIT WORKSHEET] Error:", error.message);
    if (error.code === 11000) return sendError(res, 409, "Already submitted");
    return sendError(res, 500, error.message || "Submission failed");
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
    if (!studentId) return sendError(res, 401, "Unauthorized");

    const resolved = await resolveStudentWorksheetAssignment({
      worksheetId,
      assignmentId,
      studentId,
    });
    if (resolved.error)
      return sendError(res, resolved.error.statusCode, resolved.error.message);

    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, "Worksheet not found");

    const { gradedAnswers, totals } = gradeWorksheetAnswers({
      worksheet,
      answers,
    });
    return sendSuccess(res, { gradedAnswers, totals });
  } catch (error) {
    console.error("[GRADE WORKSHEET] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to grade worksheet");
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

    if (!submission) return sendError(res, 404, "No submission found");

    // Convert Mongoose Map types to plain objects for proper serialization
    if (submission.activity9Answers && typeof submission.activity9Answers.toObject === 'function') {
      submission.activity9Answers = submission.activity9Answers.toObject();
    }
    if (submission.activity9Results && typeof submission.activity9Results.toObject === 'function') {
      submission.activity9Results = submission.activity9Results.toObject();
    }
    if (submission.activity9Feedbacks && typeof submission.activity9Feedbacks.toObject === 'function') {
      submission.activity9Feedbacks = submission.activity9Feedbacks.toObject();
    }

    const worksheet = await Worksheet.findById(req.params.id)
      .select("sections title totalPoints")
      .lean();

    return sendSuccess(res, {
      ...submission,
      worksheet: {
        sections: worksheet?.sections || [],
        title: worksheet?.title || "",
      },
    });
  } catch (error) {
    console.error("[GET MY SUBMISSION] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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
    if (!assignmentId)
      return sendError(res, 400, "assignmentId query param required");

    const submission = await WorksheetSubmission.findOne({
      assignmentId,
      studentId: req.user._id,
    }).lean();

    if (!submission) return sendError(res, 404, "No submission found");

    // Convert Mongoose Map types to plain objects for proper serialization
    if (submission.activity9Answers && typeof submission.activity9Answers.toObject === 'function') {
      submission.activity9Answers = submission.activity9Answers.toObject();
    }
    if (submission.activity9Results && typeof submission.activity9Results.toObject === 'function') {
      submission.activity9Results = submission.activity9Results.toObject();
    }
    if (submission.activity9Feedbacks && typeof submission.activity9Feedbacks.toObject === 'function') {
      submission.activity9Feedbacks = submission.activity9Feedbacks.toObject();
    }

    const worksheet = await Worksheet.findById(submission.worksheetId)
      .select("sections title totalPoints")
      .lean();

    console.log('[GET SUBMISSION] Returning activity9Data:', {
      hasData: !!submission.activity9Answers,
      answerCount: Object.keys(submission.activity9Answers || {}).length
    });

    return sendSuccess(res, {
      ...submission,
      worksheet: {
        sections: worksheet?.sections || [],
        title: worksheet?.title || "",
      },
    });
  } catch (error) {
    console.error("[GET MY SUBMISSION BY ASSIGNMENT] Error:", error.message);
    return sendError(res, 500, "Internal server error");
  }
}

/**
 * GET /api/worksheets/:id/submissions
 * Auth: teacher only (must own worksheet)
 * Returns all student submissions for this worksheet with student names and scores.
 */
async function getSubmissions(req, res) {
  try {
    const worksheet = await Worksheet.findOne({
      _id: req.params.id,
      createdBy: req.user._id,
    })
      .select("title totalPoints sections")
      .lean();

    if (!worksheet)
      return sendError(res, 404, "Worksheet not found or not authorised");

    const submissions = await WorksheetSubmission.find({
      worksheetId: req.params.id,
    })
      .populate("studentId", "displayName email photoURL")
      .sort({ submittedAt: -1 })
      .lean();

    // Convert Mongoose Map types to plain objects for proper serialization
    submissions.forEach(sub => {
      if (sub.activity9Answers && typeof sub.activity9Answers.toObject === 'function') {
        sub.activity9Answers = sub.activity9Answers.toObject();
      }
      if (sub.activity9Results && typeof sub.activity9Results.toObject === 'function') {
        sub.activity9Results = sub.activity9Results.toObject();
      }
      if (sub.activity9Feedbacks && typeof sub.activity9Feedbacks.toObject === 'function') {
        sub.activity9Feedbacks = sub.activity9Feedbacks.toObject();
      }
    });

    return sendSuccess(res, {
      worksheet,
      submissions,
    });
  } catch (error) {
    console.error("[GET SUBMISSIONS] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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

    const worksheet = await Worksheet.findOne({
      _id: worksheetId,
      createdBy: req.user._id,
    })
      .select(
        "title totalPoints cefrLevel gradeLevel gradeCategory difficulty subject assignmentDeadline activity1 activity2 activity3 activity4 activity5 activity6",
      )
      .lean();

    if (!worksheet)
      return sendError(res, 404, "Worksheet not found or not authorised");

    // Build filter
    const filter = { worksheetId };
    if (classId)
      filter.assignmentId = {
        $in: await Assignment.find({
          class: classId,
          resourceType: "worksheet",
          resourceId: worksheetId,
        })
          .select("_id")
          .lean()
          .then((a) => a.map((x) => x._id)),
      };
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
        .populate("studentId", "displayName email photoURL")
        .populate("assignmentId", "title deadline class")
        .select("studentId assignmentId worksheetId score percentage isPassed isLate answers timeTaken submittedAt totalPointsEarned totalPointsPossible activity9Answers activity9Results activity9Score activity9Total")
        .sort({ submittedAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      // Lightweight projection — only fields needed for aggregate stats
      WorksheetSubmission.find(filter)
        .select("score percentage isPassed isLate answers attempts")
        .lean(),
    ]);

    // Convert Mongoose Map types to plain objects for proper serialization
    // This fixes the Teacher PDF bug where activity9Answers are not rendered
    console.log('[GET WORKSHEET REPORT] === BEFORE MAP CONVERSION ===');
    if (submissions.length > 0) {
      const firstSub = submissions[0];
      console.log('[GET WORKSHEET REPORT] typeof activity9Answers:', typeof firstSub.activity9Answers);
      console.log('[GET WORKSHEET REPORT] activity9Answers instanceof Map:', firstSub.activity9Answers instanceof Map);
      console.log('[GET WORKSHEET REPORT] has toObject method:', typeof firstSub.activity9Answers?.toObject === 'function');
    }

    submissions.forEach(sub => {
      if (sub.activity9Answers && typeof sub.activity9Answers.toObject === 'function') {
        sub.activity9Answers = sub.activity9Answers.toObject();
      }
      if (sub.activity9Results && typeof sub.activity9Results.toObject === 'function') {
        sub.activity9Results = sub.activity9Results.toObject();
      }
      if (sub.activity9Feedbacks && typeof sub.activity9Feedbacks.toObject === 'function') {
        sub.activity9Feedbacks = sub.activity9Feedbacks.toObject();
      }
    });

    console.log('[GET WORKSHEET REPORT] === AFTER MAP CONVERSION ===');
    if (submissions.length > 0) {
      const firstSub = submissions[0];
      console.log('[GET WORKSHEET REPORT] typeof activity9Answers:', typeof firstSub.activity9Answers);
      console.log('[GET WORKSHEET REPORT] activity9Answers instanceof Map:', firstSub.activity9Answers instanceof Map);
      console.log('[GET WORKSHEET REPORT] Object.keys(activity9Answers):', Object.keys(firstSub.activity9Answers || {}));
      console.log('[GET WORKSHEET REPORT] full activity9Answers:', JSON.stringify(firstSub.activity9Answers, null, 2));
    }

    // Get all assignments for this worksheet to calculate total assigned
    const assignments = await Assignment.find({
      resourceType: "worksheet",
      resourceId: worksheetId,
      isActive: true,
    }).lean();

    // Calculate total assigned students
    const assignmentIds = assignments.map((a) => a._id);
    const totalAssigned = await Membership.countDocuments({
      class: { $in: assignments.map((a) => a.class) },
      status: "active",
    });

    // Calculate overview stats using total counts (not paginated subset)
    const submittedCount = total;
    const pendingCount = Math.max(0, totalAssigned - submittedCount);
    // lateCount and analytics are derived from ALL submissions, not just the current page
    const lateCount = allSubmissionsForAnalytics.filter((s) => s.isLate).length;
    const completionRate =
      totalAssigned > 0 ? (submittedCount / totalAssigned) * 100 : 0;

    // Calculate analytics from all submissions for accuracy
    const scores = allSubmissionsForAnalytics.map(
      (s) => s.score ?? s.percentage ?? 0,
    );
    const averageScore = scores.length
      ? scores.reduce((a, b) => a + b, 0) / scores.length
      : 0;
    const medianScore = scores.length
      ? [...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)]
      : 0;
    const passedCount = allSubmissionsForAnalytics.filter(
      (s) => s.isPassed === true || (s.score ?? s.percentage ?? 0) >= 70,
    ).length;
    const passRate =
      (passedCount / (allSubmissionsForAnalytics.length || 1)) * 100;

    // Analyze per-question performance using ALL submissions (not just current page)
    const questionStats = {};
    allSubmissionsForAnalytics.forEach((submission) => {
      (submission.answers || []).forEach((answer) => {
        const key = `${answer.sectionId}_${answer.questionId}`;
        if (!questionStats[key]) {
          questionStats[key] = { correct: 0, total: 0, skipped: 0 };
        }
        questionStats[key].total++;
        if (answer.isCorrect) questionStats[key].correct++;
        if (!answer.studentAnswer || answer.studentAnswer.trim() === "")
          questionStats[key].skipped++;
      });
    });

    // Find hardest and most missed questions
    const questionAnalysis = Object.entries(questionStats)
      .map(([key, stats]) => ({
        questionId: key,
        correctRate: stats.total > 0 ? (stats.correct / stats.total) * 100 : 0,
        missedCount: stats.total - stats.correct,
        skippedRate: stats.total > 0 ? (stats.skipped / stats.total) * 100 : 0,
      }))
      .sort((a, b) => a.correctRate - b.correctRate);

    const hardestQuestions = questionAnalysis.slice(0, 5);
    const mostMissedQuestions = questionAnalysis
      .sort((a, b) => b.missedCount - a.missedCount)
      .slice(0, 5);
    const easiestQuestions = [...questionAnalysis]
      .sort((a, b) => b.correctRate - a.correctRate)
      .slice(0, 5);

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
        sectionStats[sectionId] = {
          correct: 0,
          total: 0,
          skipped: 0,
          attempts: 0,
        };
      });
    }

    // Use ALL submissions for section aggregates (not just current page)
    allSubmissionsForAnalytics.forEach((submission) => {
      (submission.answers || []).forEach((answer) => {
        if (sectionStats[answer.sectionId]) {
          sectionStats[answer.sectionId].total++;
          if (answer.isCorrect) sectionStats[answer.sectionId].correct++;
          if (!answer.studentAnswer || answer.studentAnswer.trim() === "")
            sectionStats[answer.sectionId].skipped++;
        }
      });
      const attemptCount = submission.attempts || 1;
      Object.keys(sectionStats).forEach((sectionId) => {
        sectionStats[sectionId].attempts += attemptCount;
      });
    });

    // Calculate section-level metrics from all submissions
    const totalSubs = allSubmissionsForAnalytics.length;
    const sectionAnalytics = Object.entries(sectionStats).map(
      ([sectionId, stats]) => {
        const completionRate =
          stats.total > 0
            ? ((stats.total - stats.skipped) / stats.total) * 100
            : 0;
        const correctRate =
          stats.total > 0 ? (stats.correct / stats.total) * 100 : 0;
        const avgAttempts = totalSubs > 0 ? stats.attempts / totalSubs : 0;

        // Find most missed questions in this section (from ALL submissions)
        const sectionQuestionStats = {};
        allSubmissionsForAnalytics.forEach((submission) => {
          (submission.answers || []).forEach((answer) => {
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
            correctRate:
              sqStats.total > 0
                ? Math.round((sqStats.correct / sqStats.total) * 100)
                : 0,
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
          totalQuestions:
            totalSubs > 0 ? Math.round(stats.total / totalSubs) : 0,
          // exact aggregate counts so the frontend never has to re-compute from a page subset
          correctCount: stats.correct,
          incorrectCount: stats.total - stats.correct - stats.skipped,
          skippedCount: stats.skipped,
          totalAnswered: stats.total,
        };
      },
    );

    // Score bands (90-100, 80-89, 70-79, below 70)
    const scoreBands = {
      "90-100": scores.filter((s) => s >= 90).length,
      "80-89": scores.filter((s) => s >= 80 && s < 90).length,
      "70-79": scores.filter((s) => s >= 70 && s < 80).length,
      "below-70": scores.filter((s) => s < 70).length,
    };

    const weakSkillAreas = sectionAnalytics
      .filter((s) => s.correctRate < 60)
      .sort((a, b) => a.correctRate - b.correctRate);

    // Generate teacher insights summary (rule-based)
    let teacherInsights = [];
    if (weakSkillAreas.length > 0) {
      const weakest = weakSkillAreas[0];
      teacherInsights.push(
        `Most students struggled with ${weakest.sectionId} (${weakest.correctRate}% average).`,
      );
    }
    if (sectionAnalytics.length >= 2) {
      const firstHalf = sectionAnalytics.slice(
        0,
        Math.ceil(sectionAnalytics.length / 2),
      );
      const secondHalf = sectionAnalytics.slice(
        Math.ceil(sectionAnalytics.length / 2),
      );
      const firstHalfAvg =
        firstHalf.reduce((sum, s) => sum + s.correctRate, 0) / firstHalf.length;
      const secondHalfAvg =
        secondHalf.reduce((sum, s) => sum + s.correctRate, 0) /
        secondHalf.length;
      if (secondHalfAvg < firstHalfAvg - 10) {
        teacherInsights.push(
          "Average completion drops significantly in later sections.",
        );
      }
    }
    const sectionScores = sectionAnalytics.map((s) => s.correctRate);
    const highestSectionScore = Math.max(...sectionScores);
    const highestSection = sectionAnalytics.find(
      (s) => s.correctRate === highestSectionScore,
    );
    if (highestSection) {
      teacherInsights.push(
        `Students performed best in ${highestSection.sectionId} (${highestSection.correctRate}%).`,
      );
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
    console.error("[GET WORKSHEET REPORT] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to fetch report");
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
      return sendError(res, 400, "Valid classId is required");
    }

    const teacherId = req.user._id;
    const cls = await Class.findOne({ _id: classId, teacher: teacherId });
    if (!cls)
      return sendError(res, 403, "Class not found or does not belong to you");

    const worksheet = await Worksheet.findOne({
      _id: id,
      createdBy: teacherId,
    });
    if (!worksheet) return sendError(res, 404, "Worksheet not found");

    if (!title) {
      return sendError(res, 400, "title is required");
    }

    // Use worksheet's assignmentDeadline if not provided in request
    const parsedDeadline = deadline
      ? new Date(deadline)
      : worksheet.assignmentDeadline;
    if (!parsedDeadline) {
      return sendError(res, 400, "deadline is required (not set on worksheet)");
    }
    if (
      isNaN(parsedDeadline.getTime()) ||
      parsedDeadline.getTime() <= Date.now()
    ) {
      return sendError(res, 400, "deadline must be a future date");
    }

    let assignment = null;
    for (let i = 0; i < 5; i++) {
      const qrToken = uuidv4();
      try {
        assignment = await Assignment.create({
          title: String(title).trim(),
          writingType: "worksheet",
          resourceType: "worksheet",
          resourceId: String(id),
          deadline: parsedDeadline,
          class: classId,
          teacher: teacherId,
          qrToken,
        });
        break;
      } catch (err) {
        if (
          err &&
          err.code === 11000 &&
          err.keyPattern &&
          err.keyPattern.qrToken
        )
          continue;
        throw err;
      }
    }

    setImmediate(async () => {
      try {
        const memberships = await Membership.find({
          class: classId,
          status: "active",
        }).select("student");
        const studentIds = (memberships || [])
          .map((m) => m && m.student)
          .filter(Boolean);
        const teacherDisplay = String(
          req.user.displayName || req.user.email || "Teacher",
        );
        const className = cls.name ? String(cls.name) : "Class";
        await Promise.all(
          studentIds.map((sId) =>
            createNotification({
              recipientId: sId,
              actorId: teacherId,
              type: "assignment_uploaded",
              title: "New worksheet assigned",
              description: `${teacherDisplay} assigned a new worksheet in ${className}: ${title}`,
              data: {
                classId: String(classId),
                assignmentId: assignment ? String(assignment._id) : null,
                resourceType: "worksheet",
                resourceId: String(id),
                route: {
                  path: "/student/my-classes/detail",
                  params: [String(classId)],
                },
              },
            }),
          ),
        );
      } catch (e) {
        logger.warn("assignWorksheet: notification error", e);
      }
    });

    return res.json({
      success: true,
      message: "Worksheet assigned to class",
      data: { assignment },
    });
  } catch (error) {
    console.error("[ASSIGN WORKSHEET] Error:", error.message);
    return sendError(res, 500, "Internal server error");
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
    if (!worksheet) return sendError(res, 404, "Worksheet not found");
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(res, 403, "You can only regenerate your own worksheets");
    }

    // Import AI service and regenerate theme
    const { generateWorksheetTheme } = require("../services/ai-service");
    const newTheme = await generateWorksheetTheme(worksheet);

    worksheet.theme = newTheme;
    await worksheet.save();

    return res.json({ success: true, data: { theme: newTheme } });
  } catch (error) {
    console.error("[REGENERATE THEME] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to regenerate theme");
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
    if (!worksheet) return sendError(res, 404, "Worksheet not found");
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(res, 403, "You can only share your own worksheets");
    }

    // Generate or reuse existing share token
    if (!worksheet.shareToken) {
      const crypto = require("crypto");
      worksheet.shareToken = crypto.randomBytes(16).toString("hex");
      try {
        await worksheet.save();
      } catch (saveError) {
        // If duplicate key error, try generating a new token once
        if (saveError.code === 11000) {
          worksheet.shareToken = crypto.randomBytes(16).toString("hex");
          await worksheet.save();
        } else {
          throw saveError;
        }
      }
    }

    const shareUrl = `${process.env.FRONTEND_URL || "http://localhost:4200"}/shared/worksheets/${worksheet.shareToken}`;

    return res.json({
      success: true,
      shareUrl,
      shareToken: worksheet.shareToken,
    });
  } catch (error) {
    console.error("[SHARE WORKSHEET] Error:", error.message);
    return sendError(
      res,
      500,
      error.message || "Failed to generate share link",
    );
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
    if (!worksheet) return sendError(res, 404, "Worksheet not found");
    if (String(worksheet.createdBy) !== String(req.user._id)) {
      return sendError(
        res,
        403,
        "You can only revoke sharing for your own worksheets",
      );
    }

    // Unset the shareToken field completely to avoid sparse index issues
    await Worksheet.updateOne(
      { _id: worksheet._id },
      { $unset: { shareToken: 1 } },
    );
    worksheet.shareToken = undefined;

    return res.json({ success: true });
  } catch (error) {
    console.error("[REVOKE SHARE WORKSHEET] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to revoke share link");
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
      return sendError(res, 400, "Valid assignmentId query param is required");
    }

    const resolved = await resolveStudentWorksheetAssignment({
      worksheetId,
      assignmentId,
      studentId,
    });
    if (resolved.error)
      return sendError(res, resolved.error.statusCode, resolved.error.message);

    const draft = await WorksheetDraft.findOne({
      assignmentId,
      studentId,
    }).lean();
    if (!draft) return sendError(res, 404, "No draft found");

    // Convert Mongoose Map types to plain objects for proper serialization
    if (draft.activity9Answers && typeof draft.activity9Answers.toObject === 'function') {
      draft.activity9Answers = draft.activity9Answers.toObject();
    }
    if (draft.activity9Results && typeof draft.activity9Results.toObject === 'function') {
      draft.activity9Results = draft.activity9Results.toObject();
    }

    return sendSuccess(res, draft);
  } catch (error) {
    console.error("[GET WORKSHEET DRAFT] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to fetch draft");
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
      activity9Answers,
      activity9Results,
      activity9Score,
      activity9Total,
      progressPercentage = 0,
      timeSpent = 0,
    } = req.body;
    const studentId = req.user._id;

    if (!assignmentId || !mongoose.Types.ObjectId.isValid(assignmentId)) {
      return sendError(res, 400, "Valid assignmentId is required");
    }

    const resolved = await resolveStudentWorksheetAssignment({
      worksheetId,
      assignmentId,
      studentId,
    });
    if (resolved.error)
      return sendError(res, resolved.error.statusCode, resolved.error.message);

    const assignment = resolved.assignment;
    const worksheet = await Worksheet.findById(worksheetId);
    if (!worksheet) return sendError(res, 404, "Worksheet not found");

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
      // Activity 9 overlay worksheet data
      if (activity9Answers !== undefined) draft.activity9Answers = activity9Answers;
      if (activity9Results !== undefined) draft.activity9Results = activity9Results;
      if (activity9Score !== undefined) draft.activity9Score = activity9Score;
      if (activity9Total !== undefined) draft.activity9Total = activity9Total;
      draft.progressPercentage = Math.min(
        100,
        Math.max(0, Number(progressPercentage) || 0),
      );
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
        // Activity 9 overlay worksheet data
        activity9Answers: activity9Answers || {},
        activity9Results: activity9Results || {},
        activity9Score: activity9Score || 0,
        activity9Total: activity9Total || 0,
        progressPercentage: Math.min(
          100,
          Math.max(0, Number(progressPercentage) || 0),
        ),
        timeSpent: Number(timeSpent) || 0,
        startedAt: now,
        lastSavedAt: now,
      });
      await draft.save();
    }

    // Publish SSE event for teacher dashboard
    try {
      const eventData = {
        type: isNewDraft ? "worksheet_started" : "worksheet_progress",
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
      logger.warn("[SAVE WORKSHEET DRAFT] SSE publish failed:", sseErr.message);
    }

    return sendSuccess(res, draft);
  } catch (error) {
    console.error("[SAVE WORKSHEET DRAFT] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to save draft");
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
      return sendError(res, 400, "Valid assignmentId query param is required");
    }

    const resolved = await resolveStudentWorksheetAssignment({
      worksheetId,
      assignmentId,
      studentId,
    });
    if (resolved.error)
      return sendError(res, resolved.error.statusCode, resolved.error.message);

    const result = await WorksheetDraft.deleteOne({ assignmentId, studentId });
    return sendSuccess(res, { deleted: result.deletedCount > 0 });
  } catch (error) {
    console.error("[DELETE WORKSHEET DRAFT] Error:", error.message);
    return sendError(res, 500, error.message || "Failed to delete draft");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GEMINI HTML WORKSHEET GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * POST /api/worksheets/gemini-html-generate
 * Teacher uploads a file; Gemini 1.5 Flash returns a ready-to-print HTML worksheet.
 * The returned HTML is NOT saved to the database — the teacher downloads it as PDF.
 */
async function generateHtmlWorksheet(req, res) {
  console.log("[GEMINI HTML WORKSHEET] Request received");

  if (!req.file) {
    return sendError(res, 400, "No file uploaded. Please attach a file.");
  }

  try {
    // Reuse existing validation logic
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log(
      "[GEMINI HTML WORKSHEET] File validated:",
      req.file.originalname,
      req.file.mimetype,
      `${(req.file.size / 1024).toFixed(1)} KB`,
    );

    // Parse teacher form options from multipart body
    let activityTypes;
    try {
      activityTypes = req.body.activityTypes
        ? JSON.parse(req.body.activityTypes)
        : null;
    } catch {
      activityTypes = null;
    }

    const options = {
      subject: req.body.subject || "",
      gradeLevel: req.body.gradeLevel || "",
      gradeCategory: req.body.gradeCategory || "",
      difficulty: req.body.difficulty || "medium",
      language: req.body.language || "English",
      cefrLevel: req.body.cefrLevel || "",
      activityTypes: activityTypes,
      theme: req.body.theme || "modern",
    };

    console.log("[GEMINI HTML WORKSHEET] Options:", JSON.stringify(options));

    // Call generation service which may use Gemini or Groq fallback.
    const worksheetResult = await generateHtmlWorksheetFromFile(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      options,
    );

    const usedProvider = worksheetResult?.provider || 'gemini';
    const html = worksheetResult.html;
    const title = worksheetResult.title;

    console.log(
      `[GEMINI HTML WORKSHEET] Success — title: "${title}", html length: ${html?.length || 0}`,
    );

    console.log('[WORKSHEET] Final response being sent. Provider:', usedProvider,
      '| Data type:', typeof worksheetResult,
      '| Keys:', worksheetResult ? Object.keys(worksheetResult) : 'null');

    return res.json({
      success: true,
      html,
      title,
      fileName: req.file.originalname,
    });
  } catch (error) {
    console.error("[GEMINI HTML WORKSHEET] Error:", error.message);
    return res.status(500).json({
      success: false,
      message:
        error.message || "Failed to generate worksheet. Please try again.",
    });
  }
}

/**
 * POST /api/worksheets/analyze-template
 * Auth: teacher only
 * Analyzes a worksheet DESIGN TEMPLATE (visual layout, not text content).
 * Converts all file types to image first, then uses vision AI to understand design structure.
 * Accepts: multipart/form-data with file field "templateFile"
 */
async function analyzeTemplate(req, res) {
  console.log("[ANALYZE TEMPLATE] Starting visual design analysis");

  if (!req.file) {
    return sendError(res, 400, "No file uploaded");
  }

  try {
    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log(
      "[ANALYZE TEMPLATE] File validated:",
      req.file.originalname,
      req.file.mimetype,
    );

    const mimeType = req.file.mimetype;
    const fileName = req.file.originalname.toLowerCase();
    let imageBase64;
    let imageMimeType = "image/png";

    // Convert file to image
    if (mimeType.startsWith("image/") || fileName.match(/\.(png|jpg|jpeg|gif|webp)$/)) {
      // IMAGE files: use directly
      console.log("[ANALYZE TEMPLATE] Processing as image");
      imageBase64 = req.file.buffer.toString("base64");
      imageMimeType = mimeType;
    } else if (mimeType === "application/pdf" || fileName.endsWith(".pdf")) {
      // PDF files: convert page 1 to image using pdfjs-dist + canvas
      console.log("[ANALYZE TEMPLATE] Converting PDF to image");
      try {
        const base64Image = await convertPdfToBase64Image(req.file.buffer);
        imageBase64 = base64Image;
        imageMimeType = "image/jpeg";
        console.log("[ANALYZE TEMPLATE] PDF converted to image successfully");
      } catch (pdfError) {
        console.error("[ANALYZE TEMPLATE] PDF render error:", pdfError.message);
        return res.status(422).json({
          error: 'PDF_CONVERSION_FAILED',
          message: 'Could not render this PDF. Please upload a PNG or JPG screenshot of your worksheet instead.'
        });
      }
    } else if (
      mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
      fileName.endsWith(".docx")
    ) {
      // DOCX files: tell user to upload as image (libreoffice not available)
      return sendError(
        res,
        400,
        "DOCX files are not supported for visual template analysis. Please save your document as a PDF or image (PNG/JPG) and upload again."
      );
    } else {
      return sendError(
        res,
        400,
        "Unsupported file type for visual template analysis. Supported formats: PNG, JPG, PDF"
      );
    }

    console.log("[ANALYZE TEMPLATE] Image ready, sending to vision AI");

    // Call vision model with fallback chain
    let contentText;
    try {
      contentText = await callVisionModelWithFallback(imageBase64, getVisualAnalysisPrompt());
    } catch (fallbackError) {
      console.error("[ANALYZE TEMPLATE] All vision models failed:", fallbackError.message);
      // Return graceful 200 response to allow frontend to skip template analysis
      return res.status(200).json({
        skipped: true,
        reason: 'Vision AI temporarily unavailable. Generating from topic only.',
        structure: null
      });
    }

    console.log("[ANALYZE TEMPLATE] AI response length:", contentText.length);

    // Parse JSON response using shared utility
    let structure;
    try {
      structure = parseVisionJSON(contentText);
    } catch (parseError) {
      console.error("[ANALYZE TEMPLATE] JSON parse error:", parseError.message);
      // Try jsonrepair as fallback
      try {
        const repaired = jsonrepair(contentText);
        structure = JSON.parse(repaired);
      } catch (repairError) {
        console.error("[ANALYZE TEMPLATE] JSON repair failed:", repairError.message);
        return sendError(
          res,
          500,
          "Failed to parse AI response. Please try again."
        );
      }
    }

    // Validate structure
    if (!structure || typeof structure !== "object") {
      return sendError(res, 500, "Invalid structure from AI");
    }

    if (!structure.sections || !Array.isArray(structure.sections)) {
      return sendError(res, 500, "Invalid structure: missing sections array");
    }

    console.log(
      "[ANALYZE TEMPLATE] Success — sections:",
      structure.sections.length,
      "totalQuestions:",
      structure.totalQuestions,
      "pageLayout:",
      structure.pageLayout
    );

    return res.json({
      success: true,
      structure,
    });
  } catch (error) {
    console.error("[ANALYZE TEMPLATE] Error:", error.message);
    if (error.name === "AbortError" || error.code === "ETIMEDOUT") {
      return sendError(res, 500, "Request timed out. Please try again.");
    }
    return sendError(
      res,
      500,
      error.message || "Template analysis failed"
    );
  }
}

/**
 * Robust JSON extraction and repair for vision AI responses
 * Handles truncated JSON, markdown code blocks, and malformed responses
 */
function extractAndParseJSON(rawContent) {
  if (!rawContent) throw new Error('Empty AI response');
  
  let cleaned = rawContent.trim();
  
  // Remove markdown code blocks
  cleaned = cleaned.replace(/```json\s*/gi, '');
  cleaned = cleaned.replace(/```\s*/gi, '');
  cleaned = cleaned.trim();
  
  // Try 1: Direct parse
  try {
    return JSON.parse(cleaned);
  } catch(e1) {
    console.log('[DETECT FIELDS] Direct parse failed, trying extraction');
  }
  
  // Try 2: Extract JSON object with regex
  try {
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
  } catch(e2) {
    console.log('[DETECT FIELDS] Regex extraction failed');
  }
  
  // Try 3: Find and fix truncated JSON
  // If JSON is cut off mid-array, close it properly
  try {
    let partial = cleaned;
    
    // Find the last complete field object
    const lastCompleteField = partial.lastIndexOf('},');
    const lastField = partial.lastIndexOf('{');
    
    if (lastCompleteField > 0) {
      // Truncate after last complete field and close the JSON
      partial = partial.substring(0, lastCompleteField + 1);
      
      // Find the fields array opening
      const fieldsStart = partial.indexOf('"fields"');
      if (fieldsStart > 0) {
        // Close the array and object properly
        partial = partial + '\n  ]\n}';
        return JSON.parse(partial);
      }
    }
  } catch(e3) {
    console.log('[DETECT FIELDS] Truncation fix failed');
  }
  
  // Try 4: Use jsonrepair if available
  try {
    const repaired = jsonrepair(cleaned);
    return JSON.parse(repaired);
  } catch(e4) {
    console.log('[DETECT FIELDS] jsonrepair failed:', e4.message);
  }
  
  // Try 5: Manual field extraction using regex
  // Even if JSON is broken, extract individual field objects
  try {
    console.log('[DETECT FIELDS] Trying manual field extraction');
    
    const titleMatch = cleaned.match(/"worksheetTitle"\s*:\s*"([^"]+)"/);
    const subjectMatch = cleaned.match(/"subject"\s*:\s*"([^"]+)"/);
    const statusMatch = cleaned.match(/"worksheetStatus"\s*:\s*"([^"]+)"/);
    const typeMatch = cleaned.match(/"worksheetType"\s*:\s*"([^"]+)"/);
    
    // Extract individual field objects using regex
    const fieldMatches = cleaned.matchAll(
      /\{\s*"id"\s*:\s*"([^"]+)"[^}]*"label"\s*:\s*"([^"]+)"[^}]*"x"\s*:\s*([\d.]+)[^}]*"y"\s*:\s*([\d.]+)[^}]*"width"\s*:\s*([\d.]+)[^}]*"height"\s*:\s*([\d.]+)[^}]*\}/g
    );
    
    const fields = [];
    let fieldIndex = 1;
    for (const match of fieldMatches) {
      fields.push({
        id: match[1] || `field_${fieldIndex}`,
        label: match[2] || `Field ${fieldIndex}`,
        order: fieldIndex,
        x: parseFloat(match[3]) || 50,
        y: parseFloat(match[4]) || (10 + fieldIndex * 12),
        width: parseFloat(match[5]) || 30,
        height: parseFloat(match[6]) || 7,
        type: 'textarea',
        isFilled: false,
        expectedAnswer: '',
        hint: `Write about ${match[2] || 'this field'}` 
      });
      fieldIndex++;
    }
    
    if (fields.length > 0) {
      return {
        worksheetTitle: titleMatch?.[1] || '',
        subject: subjectMatch?.[1] || '',
        worksheetStatus: statusMatch?.[1] || 'blank',
        worksheetType: typeMatch?.[1] || 'questions',
        fields: fields,
        totalFields: fields.length
      };
    }
  } catch(e6) {
    console.log('[DETECT FIELDS] Manual extraction failed:', e6.message);
  }
  
  throw new Error('Could not parse AI response after all attempts');
}

/**
 * Google Vision OCR: Detect text blocks with coordinates from worksheet image
 */
async function detectFieldsWithGoogleVision(imagePath, imageWidth, imageHeight) {
  // Verify key file exists
  const keyPath = path.resolve(__dirname, '../../key/vision_key.json');
  if (!fs.existsSync(keyPath)) {
    console.error('[GOOGLE VISION] Key file not found:', keyPath);
    throw new Error('Google Vision key not found');
  }

  // Initialize vision client
  const visionClient = new vision.ImageAnnotatorClient({
    keyFilename: keyPath
  });

  console.log('[GOOGLE VISION] Running document text detection on:', imagePath);

  // Run FULL text detection to get all text with coordinates
  const [result] = await visionClient.documentTextDetection(imagePath);
  const fullText = result.fullTextAnnotation;

  if (!fullText) {
    throw new Error('Google Vision returned no text');
  }

  console.log('[GOOGLE VISION] Full text detected, pages:', 
    fullText.pages?.length);

  // Extract all text blocks with their bounding boxes
  const textBlocks = [];

  for (const page of fullText.pages || []) {
    for (const block of page.blocks || []) {
      // Get block text
      let blockText = '';
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const wordText = word.symbols
            .map(s => s.text).join('');
          blockText += wordText + ' ';
        }
        blockText = blockText.trim();
      }

      // Get bounding box
      const vertices = block.boundingBox?.vertices || [];
      if (vertices.length === 4 && blockText.trim()) {
        const x1 = Math.min(...vertices.map(v => v.x || 0));
        const y1 = Math.min(...vertices.map(v => v.y || 0));
        const x2 = Math.max(...vertices.map(v => v.x || 0));
        const y2 = Math.max(...vertices.map(v => v.y || 0));

        textBlocks.push({
          text: blockText.trim(),
          x1, y1, x2, y2,
          // Convert to percentages
          xPct: (x1 / imageWidth) * 100,
          yPct: (y1 / imageHeight) * 100,
          widthPct: ((x2 - x1) / imageWidth) * 100,
          heightPct: ((y2 - y1) / imageHeight) * 100
        });
      }
    }
  }

  console.log('[GOOGLE VISION] Text blocks found:', textBlocks.length);
  console.log('[GOOGLE VISION] Blocks:', 
    textBlocks.map(b => ({ text: b.text, x: b.xPct, y: b.yPct }))
  );

  return textBlocks;
}

/**
 * Find input fields from text blocks using spatial analysis
 * Checks 4 directions (right, below, left, above) for empty space near labels
 */
function findInputFields(textBlocks, imageWidth, imageHeight) {
  const fields = [];
  
  // Strategy: Find text labels first, then find the nearest
  // empty area (no overlapping text blocks)
  
  // Filter to get only SHORT label-like text blocks
  // (not paragraphs, not titles)
  const labelBlocks = textBlocks.filter(block => {
    const text = block.text.trim();
    const wordCount = text.split(/\s+/).length;
    // Labels are 1-4 words, not too long
    return wordCount >= 1 && wordCount <= 4 && 
           text.length >= 2 && text.length <= 30 &&
           // Exclude common non-label text
           !text.toLowerCase().includes('worksheet') &&
           !text.toLowerCase().includes('copyright') &&
           !text.toLowerCase().includes('www.') &&
           !text.toLowerCase().includes('.com');
  });
  
  console.log('[GOOGLE VISION] Label candidates:', 
    labelBlocks.map(b => b.text));
  
  // For each label, search for nearby empty rectangular areas
  // Empty area = a region with NO text blocks overlapping it
  
  labelBlocks.forEach((label, index) => {
    // Check 4 directions for empty space:
    // RIGHT, BELOW, LEFT, ABOVE
    
    const directions = [
      // RIGHT of label
      {
        x: label.xPct + label.widthPct + 0.5,
        y: label.yPct - 1,
        width: Math.min(35, 98 - label.xPct - label.widthPct),
        height: Math.max(label.heightPct * 2, 6),
        direction: 'right'
      },
      // BELOW label
      {
        x: label.xPct - 2,
        y: label.yPct + label.heightPct + 0.5,
        width: label.widthPct + 4,
        height: 8,
        direction: 'below'
      },
      // LEFT of label
      {
        x: Math.max(0, label.xPct - 36),
        y: label.yPct - 1,
        width: Math.min(35, label.xPct - 0.5),
        height: Math.max(label.heightPct * 2, 6),
        direction: 'left'
      }
    ];
    
    // Find which direction has the most empty space
    // (fewest overlapping text blocks)
    let bestDirection = null;
    let minOverlap = Infinity;
    
    for (const dir of directions) {
      if (dir.width < 5 || dir.height < 3) continue;
      
      // Count text blocks that overlap with this area
      const overlapping = textBlocks.filter(b => {
        if (b === label) return false;
        // Check overlap
        const noOverlapX = b.xPct + b.widthPct < dir.x || 
                           b.xPct > dir.x + dir.width;
        const noOverlapY = b.yPct + b.heightPct < dir.y || 
                           b.yPct > dir.y + dir.height;
        return !noOverlapX && !noOverlapY;
      });
      
      if (overlapping.length < minOverlap) {
        minOverlap = overlapping.length;
        bestDirection = dir;
      }
    }
    
    // Only add field if we found a reasonably empty area
    if (bestDirection && minOverlap <= 1) {
      // Clamp to image bounds
      const x = Math.max(0, Math.min(bestDirection.x, 90));
      const y = Math.max(0, Math.min(bestDirection.y, 92));
      const w = Math.min(bestDirection.width, 99 - x);
      const h = Math.min(bestDirection.height, 99 - y);
      
      if (w >= 5 && h >= 3) {
        fields.push({
          id: `field_${index + 1}`,
          label: label.text.toUpperCase(),
          order: index + 1,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          width: Math.round(w * 10) / 10,
          height: Math.round(h * 10) / 10,
          type: 'text',
          isFilled: false,
          expectedAnswer: '',
          hint: `Write: ${label.text}` 
        });
        
        console.log(`[GOOGLE VISION] Field for "${label.text}":`,
          `x=${x.toFixed(1)}% y=${y.toFixed(1)}%`,
          `dir=${bestDirection.direction}`,
          `overlap=${minOverlap}` 
        );
      }
    }
  });
  
  // Remove duplicate fields that are too close together
  const uniqueFields = fields.filter((field, index) => {
    return !fields.some((other, otherIndex) => {
      if (otherIndex >= index) return false;
      const tooCloseX = Math.abs(other.x - field.x) < 5;
      const tooCloseY = Math.abs(other.y - field.y) < 5;
      return tooCloseX && tooCloseY;
    });
  });
  
  console.log('[GOOGLE VISION] Final fields:', uniqueFields.length);
  return uniqueFields;
}

/**
 * Detect worksheet status (blank/partial/filled) from text blocks
 * Smarter detection that separates header/label text from potential answers
 */
function detectWorksheetStatus(textBlocks) {
  // Separate header/label text from potential answers
  const headerText = textBlocks.filter(b => b.yPct < 20);
  const bodyText = textBlocks.filter(b => b.yPct >= 20);
  
  // Look for text that appears to be answers
  // (appears near empty box locations, longer than labels)
  const potentialAnswers = bodyText.filter(b => {
    const wordCount = b.text.split(/\s+/).length;
    return wordCount >= 2 || b.text.length > 8;
  });
  
  const totalBodyBlocks = bodyText.length;
  if (totalBodyBlocks === 0) return 'blank';
  
  const answerRatio = potentialAnswers.length / totalBodyBlocks;
  
  if (answerRatio > 0.5) return 'filled';
  if (answerRatio > 0.2) return 'partial';
  return 'blank';
}

/**
 * Detect if worksheet is a diagram-style worksheet
 * (like tree diagram with boxes around an image)
 */
function isDiagramWorksheet(textBlocks, imageWidth, imageHeight) {
  // Diagrams have text spread around the image in all directions
  // not just top-to-bottom
  
  const leftText = textBlocks.filter(b => b.xPct < 30);
  const rightText = textBlocks.filter(b => b.xPct > 70);
  const centerText = textBlocks.filter(
    b => b.xPct >= 30 && b.xPct <= 70
  );
  
  // If text exists on both left and right sides → likely diagram
  return leftText.length > 0 && rightText.length > 0;
}

/**
 * POST /api/worksheets/detect-fields
 * Auth: teacher only
 * Accepts an uploaded PDF or image file, converts it to a high-quality image,
 * stores it temporarily, and uses vision AI to detect input fields/boxes.
 * Returns the image URL + detected field positions.
 */
async function detectFields(req, res) {
  console.log("[DETECT FIELDS] Starting field detection");

  if (!req.file) {
    return sendError(res, 400, "No file uploaded");
  }

  try {
    // Validate file
    const validation = validateFile(req.file);
    if (!validation.valid) {
      return sendError(res, 400, validation.error);
    }

    console.log(
      "[DETECT FIELDS] File validated:",
      req.file.originalname,
      req.file.mimetype
    );

    // Step 2: Convert to base64 image
    let base64Image;
    if (req.file.mimetype === "application/pdf") {
      console.log("[DETECT FIELDS] Converting PDF to image");
      base64Image = await convertPdfToBase64Image(req.file.buffer);
    } else if (
      req.file.mimetype.startsWith("image/") ||
      req.file.mimetype === "image/jpeg" ||
      req.file.mimetype === "image/jpg" ||
      req.file.mimetype === "image/png"
    ) {
      console.log("[DETECT FIELDS] Converting image to base64");
      base64Image = req.file.buffer.toString("base64");
    } else {
      return sendError(res, 400, "Unsupported file type. Please upload PDF, PNG, or JPG.");
    }

    // Step 3: Store the image temporarily and return a URL
    const { v4: uuidv4 } = require("uuid");
    const filename = `template_${uuidv4()}.jpg`;
    const uploadBasePath =
      (process.env.UPLOAD_BASE_PATH || "uploads").trim() || "uploads";
    const uploadsRoot = path.join(__dirname, "..", "..", uploadBasePath);
    const templatesDir = path.join(uploadsRoot, "templates");
    const filePath = path.join(templatesDir, filename);

    // Convert base64 to buffer and save
    const imageBuffer = Buffer.from(base64Image, "base64");
    fs.writeFileSync(filePath, imageBuffer);

    console.log("[DETECT FIELDS] Image saved to:", filePath);

    // Generate public URL
    const protocol = req.protocol;
    const host = req.get("host");
    const imageUrl = `${protocol}://${host}/uploads/templates/${filename}`;

    console.log("[DETECT FIELDS] Image URL:", imageUrl);

    // Get image dimensions using image-size, falling back to canvas/defaults if needed
    let imgWidth = 720;
    let imgHeight = 960;
    try {
      const sizeOf = require('image-size');
      const dimensions = sizeOf(imageBuffer);
      imgWidth = dimensions.width || 720;
      imgHeight = dimensions.height || 960;
      console.log(`[DETECT FIELDS] Read image dimensions: ${imgWidth}x${imgHeight}`);
    } catch (e) {
      try {
        imgWidth = canvas.width || 720;
        imgHeight = canvas.height || 960;
      } catch (err) {
        imgWidth = 720;
        imgHeight = 960;
      }
    }

    const detectionPrompt = `You are analyzing an educational 
worksheet image.

FIRST: Determine if this worksheet is BLANK or FILLED.
- BLANK: writing areas are empty (no handwriting or typed text)
- FILLED: writing areas contain answers (handwritten or typed)
- PARTIAL: some areas filled, some empty

SECOND: Find ALL writing areas regardless of filled status.

For EACH writing area:
1. Find its label (text in colored header/tab near the box,
   or question number/text before the blank space)
2. Measure its position as PERCENTAGES (0-100):
   - x = left edge of writing box as % of image width
   - y = top edge of writing box as % of image height
   - width = box width as % of image width  
   - height = box height as % of image height
   IMPORTANT: Return PERCENTAGES not pixels.
   x=0 is left edge, x=100 is right edge.
   y=0 is top edge, y=100 is bottom edge.
3. Read the answer IF the box is filled:
   - Read handwritten or typed text carefully
   - If box is empty → expectedAnswer = ""
4. Determine field type:
   - "text" = single line
   - "textarea" = multiple lines

Return ONLY this JSON:
{
  "worksheetTitle": "title from worksheet header",
  "subject": "subject if visible",
  "worksheetStatus": "blank" | "filled" | "partial",
  "worksheetType": "diagram" | "questions" | "table" | "mixed",
  "fields": [
    {
      "id": "field_1",
      "label": "LABEL TEXT",
      "order": 1,
      "x": 45.5,
      "y": 22.3,
      "width": 30.0,
      "height": 7.5,
      "type": "textarea",
      "isFilled": true,
      "expectedAnswer": "the answer text if filled, empty string if blank",
      "hint": "brief hint what to write here"
    }
  ],
  "totalFields": 6
}
Return ONLY JSON. No markdown. No explanation.`;

    console.log("[DETECT FIELDS] Attempting Google Vision OCR first");

    // Try Google Vision OCR first
    let detectedFields;
    let detectionMethod = 'google-vision';
    
    try {
      console.log('[DETECT FIELDS] Using Google Vision OCR');
      
      const textBlocks = await detectFieldsWithGoogleVision(
        filePath,  // local file path
        imgWidth,
        imgHeight
      );
      
      // Detect if this is a diagram worksheet
      const isDiagram = isDiagramWorksheet(textBlocks, imgWidth, imgHeight);
      console.log('[GOOGLE VISION] Is diagram worksheet:', isDiagram);
      
      const fields = findInputFields(textBlocks, imgWidth, imgHeight);
      const worksheetStatus = detectWorksheetStatus(textBlocks);
      
      // Get worksheet title from first large text block
      const titleBlock = textBlocks
        .sort((a, b) => (b.x2 - b.x1) - (a.x2 - a.x1))[0];
      
      // Adjust field sizing based on worksheet type
      // Diagram fields are smaller (just covering label boxes)
      // Question fields are wider (full line width)
      let adjustedFields = fields;
      if (isDiagram) {
        adjustedFields = fields.map(f => ({
          ...f,
          width: Math.min(f.width, 20),  // Smaller width for diagram boxes
          height: Math.min(f.height, 5),  // Smaller height for diagram boxes
          type: 'text'  // Diagram boxes are usually single-line
        }));
        console.log('[GOOGLE VISION] Adjusted fields for diagram worksheet');
      }
      
      const validatedFields = validateFieldCoordinates(
        adjustedFields, imgWidth, imgHeight
      );
      
      // Add detailed debugging logs
      console.log('[GOOGLE VISION] === FIELD DETECTION SUMMARY ===');
      console.log('Total text blocks:', textBlocks.length);
      console.log('Label candidates:', fields.length);
      console.log('Fields found:', validatedFields.length);
      console.log('Worksheet type:', isDiagram ? 'diagram' : 'questions');
      console.log('Worksheet status:', worksheetStatus);
      validatedFields.forEach(f => {
        console.log(`  ${f.label}: x=${f.x}% y=${f.y}% w=${f.width}% h=${f.height}%`);
      });
      console.log('========================================');
      
      console.log('[GOOGLE VISION] Fields detected:', validatedFields.length);
      console.log('[DETECT FIELDS] Detection method: ✅ Google Vision OCR');
      
      detectedFields = {
        worksheetTitle: titleBlock?.text || '',
        subject: '',
        worksheetStatus: worksheetStatus,
        worksheetType: isDiagram ? 'diagram' : 'questions',
        fields: validatedFields,
        totalFields: validatedFields.length
      };
      
    } catch (visionError) {
      console.error('[GOOGLE VISION] Error:', visionError.message);
      // Fall back to OpenRouter if Vision fails
      console.log('[DETECT FIELDS] Falling back to OpenRouter...');
      detectionMethod = 'openrouter';
      
      try {
        aiResponseText = await callVisionModelWithFallback(base64Image, detectionPrompt);
        
        console.log('[DETECT FIELDS] Detection method: ⚠️ OpenRouter fallback');
        
        // Parse JSON response using robust extraction and repair
        try {
          detectedFields = extractAndParseJSON(aiResponseText);
        } catch (parseError) {
          console.error('[DETECT FIELDS] OpenRouter JSON parse failed:', parseError.message);
          throw parseError;
        }
        
      } catch (fallbackError) {
        console.error("[DETECT FIELDS] All vision models failed:", fallbackError.message);
        // Return graceful 200 response with image saved but no fields detected
        return res.status(200).json({
          success: true,
          imageUrl: imageUrl,
          imageWidth: imgWidth,
          imageHeight: imgHeight,
          worksheetTitle: '',
          subject: '',
          worksheetStatus: 'blank',
          worksheetType: 'questions',
          fields: [],
          totalFields: 0,
          hasAnswerKey: false,
          aiError: true,
          detectionMethod: 'none',
          message: 'Could not detect fields automatically. The worksheet image was saved successfully.'
        });
      }
    }

    console.log(
      "[DETECT FIELDS] Detected fields:",
      detectedFields.totalFields || 0
    );

    // Smart validator: trust AI coordinates but fix bad/missing values
    function validateFieldCoordinates(fields, imageWidth, imageHeight) {
      if (!fields || fields.length === 0) return [];

      // Auto-detect if values are pixels or percentages
      // If any x > 100 or any y > 100 → values are pixels
      const maxX = Math.max(...fields.map(f => parseFloat(f.x) || 0));
      const maxY = Math.max(...fields.map(f => parseFloat(f.y) || 0));
      const maxW = Math.max(...fields.map(f => parseFloat(f.width || f.w) || 0));
      const maxH = Math.max(...fields.map(f => parseFloat(f.height || f.h) || 0));

      // Determine if pixel or percentage values
      const isPixelValues = maxX > 100 || maxY > 100;

      // Use actual image dimensions or sensible defaults
      const imgW = imageWidth || 720;
      const imgH = imageHeight || 960;

      console.log(`[DETECT FIELDS] Coordinate type: ${isPixelValues ? 'PIXELS' : 'PERCENTAGES'}`);
      console.log(`[DETECT FIELDS] Image size: ${imgW}x${imgH}`);
      console.log(`[DETECT FIELDS] Max values: x=${maxX} y=${maxY} w=${maxW} h=${maxH}`);

      // Check if all y values are the same (fallback needed)
      const yValues = fields.map(f => parseFloat(f.y) || 0);
      const allSameY = yValues.every(y => Math.abs(y - yValues[0]) < 2);
      const hasNoCoords = fields.every(
        f => !f.x && !f.y && !f.width && !f.height && !f.w && !f.h
      );

      if (hasNoCoords || (allSameY && fields.length > 1)) {
        console.log('[DETECT FIELDS] AI gave no real coords, using fallback layout');
        return generateFallbackPositions(fields);
      }

      // AI gave real coordinates → validate and fix each field
      return fields.map((field, index) => {
        let x = parseFloat(field.x) || 0;
        let y = parseFloat(field.y) || 0;
        let width = parseFloat(field.width || field.w) || 35;
        let height = parseFloat(field.height || field.h) || 7;

        // If pixel values, convert to percentages
        if (isPixelValues) {
          x = (x / imgW) * 100;
          y = (y / imgH) * 100;
          width = (width / imgW) * 100;
          height = (height / imgH) * 100;
        }

        // Clamp to valid range
        x = Math.max(0, Math.min(x, 95));
        y = Math.max(0, Math.min(y, 95));
        width = Math.max(10, Math.min(width, 90));
        height = Math.max(4, Math.min(height, 30));

        // Prevent overflow
        if (x + width > 99) width = 99 - x;
        if (y + height > 99) height = 99 - y;

        return {
          id: field.id || `field_${index + 1}`,
          label: (field.label || `Field ${index + 1}`).toUpperCase(),
          order: field.order || index + 1,
          x: Math.round(x * 10) / 10,
          y: Math.round(y * 10) / 10,
          width: Math.round(width * 10) / 10,
          height: Math.round(height * 10) / 10,
          type: field.type || 'textarea',
          isFilled: field.isFilled || false,
          expectedAnswer: field.expectedAnswer || '',
          hint: field.hint || `Write about ${field.label || 'this'}`
        };
      });
    }

    // Fallback when AI gives no coordinates:
    function generateFallbackPositions(fields) {
      const total = fields.length;
      const startY = 15;
      const endY = 88;
      const spacing = (endY - startY) / Math.max(total - 1, 1);

      return fields.map((field, index) => ({
        id: field.id || `field_${index + 1}`,
        label: (field.label || `Field ${index + 1}`).toUpperCase(),
        order: field.order || index + 1,
        x: 48,
        y: Math.round((startY + index * spacing) * 10) / 10,
        width: 48,
        height: 8,
        type: field.type || 'textarea',
        isFilled: field.isFilled || false,
        expectedAnswer: field.expectedAnswer || '',
        hint: field.hint || `Write about ${field.label || 'this'}`
      }));
    }

    // Add logging for raw AI fields
    console.log('[DETECT FIELDS] Raw AI fields:', 
      detectedFields.fields?.map(f => ({
        label: f.label, x: f.x, y: f.y,
        w: f.width || f.w, h: f.height || f.h
      }))
    );

    // Get fields from AI response and sort by order
    // If Google Vision was used, fields are already validated
    let positionedFields;
    if (detectionMethod === 'google-vision') {
      positionedFields = detectedFields.fields || [];
      console.log('[DETECT FIELDS] Using Google Vision validated fields directly');
    } else {
      // OpenRouter fallback: validate the fields
      const rawFields = detectedFields.fields || [];
      const sortedFields = rawFields.sort((a, b) => (a.order || 0) - (b.order || 0));
      positionedFields = validateFieldCoordinates(sortedFields, imgWidth, imgHeight);
      
      console.log('[DETECT FIELDS] After validation:', 
        positionedFields.map(f => ({
          label: f.label, x: f.x, y: f.y,
          w: f.width, h: f.height
        }))
      );
    }

    // Step 5: Return response with algorithmically positioned fields
    return res.json({
      success: true,
      imageUrl: imageUrl,
      imageWidth: imgWidth,
      imageHeight: imgHeight,
      worksheetTitle: detectedFields.worksheetTitle || '',
      subject: detectedFields.subject || '',
      worksheetStatus: detectedFields.worksheetStatus || 'blank',
      worksheetType: detectedFields.worksheetType || 'questions',
      fields: positionedFields,
      totalFields: positionedFields.length,
      hasAnswerKey: positionedFields.some(f => f.expectedAnswer && 
                    f.expectedAnswer.trim() !== ''),
      detectionMethod: detectionMethod
    });
  } catch (error) {
    console.error("[DETECT FIELDS] Error:", error.message);
    return sendError(
      res,
      500,
      error.message || "Field detection failed"
    );
  }
}

/**
 * POST /api/worksheets/save-overlay
 * Auth: teacher only
 * Saves a PDF overlay worksheet with detected fields as a complete worksheet.
 * Accepts: { worksheetId?, title, subject, backgroundImageUrl, originalFileUrl, fields, gradeLevel?, language? }
 * Returns: the saved worksheet object with _id
 */
async function saveOverlayWorksheet(req, res) {
  console.log("[SAVE OVERLAY] Starting overlay worksheet save");

  try {
    const {
      worksheetId,
      title,
      subject,
      cefrLevel,
      gradeCategory,
      gradeLevel,
      difficulty,
      assignmentDeadline,
      backgroundImageUrl,
      originalFileUrl,
      fields,
    } = req.body;

    // Validate required fields
    if (!title || typeof title !== 'string' || !title.trim()) {
      return sendError(res, 400, 'Title is required');
    }
    if (!subject || typeof subject !== 'string') {
      return sendError(res, 400, 'Subject is required');
    }
    if (!backgroundImageUrl || typeof backgroundImageUrl !== 'string') {
      return sendError(res, 400, 'Background image URL is required');
    }
    if (!originalFileUrl || typeof originalFileUrl !== 'string') {
      return sendError(res, 400, 'Original file URL is required');
    }
    // Allow empty fields - image is still useful
    const fieldsArray = Array.isArray(fields) ? fields : [];
    console.log(`[SAVE OVERLAY] Saving with ${fieldsArray.length} fields`);

    const teacherId = req.user?.id;
    if (!teacherId) {
      return sendError(res, 401, 'User not authenticated');
    }

    // Build activity9 object
    const activity9 = {
      title: req.body.title || 'Fill in the Fields',
      instructions: req.body.instructions || '',
      backgroundImageUrl,
      originalFileUrl,
      fields: fieldsArray.map((field, index) => ({
        id: field.id || `field_${index + 1}`,
        label: field.label || `Field ${index + 1}`,
        x: Number(field.x) || 0,
        y: Number(field.y) || 0,
        width: Number(field.width) || 10,
        height: Number(field.height) || 5,
        type: field.type === 'textarea' ? 'textarea' : 'text',
        isFilled: field.isFilled || false,
        expectedAnswer: field.expectedAnswer || '',
        hint: field.hint || '',
      })),
      totalFields: req.body.totalFields || fieldsArray.length,
      worksheetStatus: req.body.worksheetStatus || 'blank',
      hasAnswerKey: req.body.hasAnswerKey || false
    };

    // Calculate total points based on field count
    const totalPoints = fieldsArray.length;

    // Parse assignment deadline if provided, otherwise set default (7 days from now)
    let parsedDeadline;
    if (assignmentDeadline) {
      parsedDeadline = new Date(assignmentDeadline);
      if (isNaN(parsedDeadline.getTime())) {
        parsedDeadline = new Date();
        parsedDeadline.setDate(parsedDeadline.getDate() + 7);
      }
    } else {
      parsedDeadline = new Date();
      parsedDeadline.setDate(parsedDeadline.getDate() + 7);
    }

    // No theme for overlay worksheets (not applicable)
    const themeObj = null;

    let worksheet;

    if (worksheetId && mongoose.Types.ObjectId.isValid(worksheetId)) {
      // Update existing worksheet
      worksheet = await Worksheet.findOneAndUpdate(
        { _id: worksheetId, createdBy: teacherId },
        {
          title,
          subject,
          'meta.cefrLevel': cefrLevel || '',
          'meta.gradeCategory': gradeCategory || '',
          'meta.gradeLevel': gradeLevel || '',
          'meta.difficulty': difficulty || 'Medium',
          gradeLevel: gradeLevel || null,
          assignmentDeadline: parsedDeadline,
          theme: themeObj,
          activity9,
          totalPoints,
          updatedAt: new Date(),
        },
        { new: true, runValidators: true }
      );

      if (!worksheet) {
        return sendError(res, 404, 'Worksheet not found or you do not have permission to update it');
      }

      console.log('[SAVE OVERLAY] Updated existing worksheet:', worksheetId);
    } else {
      // Create new worksheet
      worksheet = await Worksheet.create({
        title,
        description: `PDF overlay worksheet with ${fieldsArray.length} input fields.`,
        subject,
        'meta.cefrLevel': cefrLevel || '',
        'meta.gradeCategory': gradeCategory || '',
        'meta.gradeLevel': gradeLevel || '',
        'meta.difficulty': difficulty || 'Medium',
        gradeLevel: gradeLevel || null,
        assignmentDeadline: parsedDeadline,
        theme: themeObj,
        activity9,
        totalPoints,
        createdBy: teacherId,
        isPublished: true,
        generationSource: 'manual',
        activities: [
          {
            type: 'overlay',
            title: activity9.title,
            instructions: activity9.instructions,
            data: {
              backgroundImageUrl: activity9.backgroundImageUrl,
              originalFileUrl: activity9.originalFileUrl,
              fields: activity9.fields,
              totalFields: activity9.totalFields,
              worksheetStatus: activity9.worksheetStatus,
              hasAnswerKey: activity9.hasAnswerKey,
            },
            order: 0,
          },
        ],
      });

      console.log('[SAVE OVERLAY] Created new worksheet:', worksheet._id);
    }

    return sendSuccess(res, { worksheet: worksheet.toObject() });
  } catch (error) {
    console.error('[SAVE OVERLAY] Error:', error.message);
    return sendError(res, 500, error.message || 'Failed to save overlay worksheet');
  }
}

/**
 * POST /api/worksheets/:id/download-overlay
 * Downloads a PDF of the overlay worksheet with student answers printed on it.
 * Accepts: { answers, results, studentName, score, total, className, assignmentTitle, subject, grade, dueDate }
 * Returns: PDF file as download
 */
async function downloadOverlayPdf(req, res) {
  console.log('[PDF BACKEND] === ANSWERS OBJECT INSPECTION ===');
  console.log('[PDF BACKEND] typeof req.body.answers:', typeof req.body.answers);
  console.log('[PDF BACKEND] req.body.answers instanceof Map:', req.body.answers instanceof Map);
  console.log('[PDF BACKEND] Object.keys(req.body.answers):', Object.keys(req.body.answers || {}));
  console.log('[PDF BACKEND] full answers object:', JSON.stringify(req.body.answers, null, 2));
  console.log('[PDF BACKEND] Generating overlay PDF for worksheet:', req.params.id);

  try {
    const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');
    const sharp = require('sharp');
    const fs = require('fs');
    const path = require('path');

    const worksheet = await Worksheet.findById(req.params.id);
    if (!worksheet?.activity9) {
      return res.status(404).json({ error: 'Not found' });
    }

    const activity9 = worksheet.activity9;
    const answers = req.body.answers || {};
    const results = req.body.results || {};
    const studentName = req.body.studentName || 'Student';
    const score = parseInt(req.body.score) || 0;
    const total = parseInt(req.body.total) || activity9.fields?.length || 0;
    const subject = req.body.subject || worksheet.meta?.subject || '';
    const grade = req.body.grade || worksheet.meta?.gradeLevel || '';
    const scorePct = total > 0 ? Math.round((score/total)*100) : 0;

    console.log('[PDF BACKEND] Generating for:', studentName);
    console.log('[PDF BACKEND] Answers received:', Object.keys(answers).length);
    console.log('[PDF BACKEND] Score:', score, '/', total);

    // Log field-level answer lookup
    const fields = activity9.fields || [];
    console.log('[PDF BACKEND] === FIELD-LEVEL ANSWER LOOKUP ===');
    console.log('[PDF BACKEND] total fields:', fields.length);
    fields.forEach(field => {
      console.log('[PDF BACKEND] field lookup:', {
        fieldId: field.id,
        answer: answers?.[field.id],
        hasAnswer: field.id in answers,
        answerType: typeof answers?.[field.id]
      });
    });

    // Load image from disk
    const imageUrl = activity9.backgroundImageUrl || '';
    const filename = imageUrl.split('/').pop();
    const possiblePaths = [
      path.join(__dirname, '../../uploads/templates', filename),
      path.join(__dirname, '../uploads/templates', filename),
      path.join(process.cwd(), 'uploads/templates', filename),
    ];

    let imagePath = null;
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) { imagePath = p; break; }
    }

    if (!imagePath) {
      return res.status(404).json({ error: 'Worksheet image not found' });
    }

    const imageBuffer = fs.readFileSync(imagePath);
    const jpegBuffer = await sharp(imageBuffer).jpeg({ quality: 92 }).toBuffer();
    const metadata = await sharp(imageBuffer).metadata();
    const imgW = metadata.width || 800;
    const imgH = metadata.height || 1000;

    // Create PDF
    const pdfDoc = await PDFDocument.create();
    const regularFont = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    // Page dimensions - A4 width
    const pageWidth = 595;
    
    // SECTION A: Header (like viewer header)
    const headerHeight = 120;
    
    // SECTION B: Score section  
    const scoreHeight = 60;
    
    // SECTION C: Worksheet image
    const imgDisplayW = pageWidth - 40; // 20px margin each side
    const imgDisplayH = Math.round((imgH / imgW) * imgDisplayW);
    
    // SECTION D: Footer
    const footerHeight = 35;
    
    // Total page height
    const pageHeight = headerHeight + scoreHeight + imgDisplayH + footerHeight + 40;

    const page = pdfDoc.addPage([pageWidth, pageHeight]);

    // DRAW SECTION A: Header
    page.drawRectangle({
      x: 0,
      y: pageHeight - headerHeight,
      width: pageWidth,
      height: headerHeight,
      color: rgb(0.08, 0.35, 0.38)
    });

    page.drawText(worksheet.title || 'Worksheet', {
      x: 20,
      y: pageHeight - 35,
      size: 18,
      font: boldFont,
      color: rgb(1, 1, 1)
    });

    page.drawText(`PDF overlay worksheet with ${total} input fields.`, {
      x: 20,
      y: pageHeight - 52,
      size: 8,
      font: regularFont,
      color: rgb(0.8, 0.9, 0.9)
    });

    const metaText = [
      subject ? `SUBJECT ${subject}` : '',
      grade ? `GRADE ${grade}` : ''
    ].filter(Boolean).join('   ');

    if (metaText) {
      page.drawText(metaText, {
        x: 20,
        y: pageHeight - 70,
        size: 8,
        font: regularFont,
        color: rgb(0.8, 0.9, 0.9)
      });
    }

    page.drawRectangle({
      x: pageWidth - 160,
      y: pageHeight - headerHeight + 10,
      width: 145,
      height: headerHeight - 20,
      color: rgb(0.1, 0.42, 0.45),
      borderColor: rgb(0.15, 0.5, 0.53),
      borderWidth: 1
    });

    page.drawText('Student name', {
      x: pageWidth - 150,
      y: pageHeight - 40,
      size: 7,
      font: regularFont,
      color: rgb(0.7, 0.85, 0.85)
    });

    page.drawText(studentName, {
      x: pageWidth - 150,
      y: pageHeight - 55,
      size: 10,
      font: boldFont,
      color: rgb(1, 1, 1)
    });

    page.drawText('Date', {
      x: pageWidth - 150,
      y: pageHeight - 78,
      size: 7,
      font: regularFont,
      color: rgb(0.7, 0.85, 0.85)
    });

    page.drawText(new Date().toLocaleDateString('en-US', {
      month: '2-digit',
      day: '2-digit', 
      year: 'numeric'
    }), {
      x: pageWidth - 150,
      y: pageHeight - 93,
      size: 10,
      font: boldFont,
      color: rgb(1, 1, 1)
    });

    // DRAW SECTION B: Score
    const scoreSectionY = pageHeight - headerHeight - scoreHeight;
    
    page.drawRectangle({
      x: 15,
      y: scoreSectionY,
      width: pageWidth - 30,
      height: scoreHeight - 5,
      color: scorePct === 0 ? rgb(1, 0.97, 0.97) :
             scorePct >= 70 ? rgb(0.97, 1, 0.97) :
             rgb(1, 0.99, 0.95),
      borderColor: scorePct === 0 ? rgb(0.9, 0.7, 0.7) :
                   scorePct >= 70 ? rgb(0.7, 0.9, 0.7) :
                   rgb(0.9, 0.85, 0.6),
      borderWidth: 1
    });

    page.drawText('SCORE', {
      x: 25,
      y: scoreSectionY + scoreHeight - 18,
      size: 7,
      font: boldFont,
      color: rgb(0.4, 0.4, 0.4)
    });

    const scoreColor = scorePct === 0 ? rgb(0.8, 0.1, 0.1) :
                       scorePct >= 70 ? rgb(0.05, 0.55, 0.1) :
                       rgb(0.7, 0.4, 0.0);

    page.drawText(`${score} / ${total}`, {
      x: 25,
      y: scoreSectionY + 22,
      size: 18,
      font: boldFont,
      color: scoreColor
    });

    page.drawText(`(${scorePct}%)`, {
      x: 95,
      y: scoreSectionY + 22,
      size: 12,
      font: boldFont,
      color: scoreColor
    });

    const scoreMsg = scorePct === 0 ? 'Review and try again.' :
                     scorePct >= 70 ? 'Great work!' :
                     'Keep practicing!';
    page.drawText(scoreMsg, {
      x: 25,
      y: scoreSectionY + 8,
      size: 8,
      font: regularFont,
      color: rgb(0.5, 0.5, 0.5)
    });

    // DRAW SECTION C: Worksheet Image
    const embeddedImage = await pdfDoc.embedJpg(jpegBuffer);
    const imgY = scoreSectionY - imgDisplayH - 15;

    page.drawRectangle({
      x: 18,
      y: imgY - 3,
      width: imgDisplayW + 4,
      height: imgDisplayH + 4,
      color: rgb(0.85, 0.85, 0.85)
    });

    page.drawImage(embeddedImage, {
      x: 20,
      y: imgY,
      width: imgDisplayW,
      height: imgDisplayH
    });

    // OVERLAY ANSWERS ON IMAGE
    console.log('[PDF] Drawing', fields.length, 'fields');

    for (const field of fields) {
      const studentAnswer = answers[field.id] || '';
      const isCorrect = results[field.id];

      if (!studentAnswer) continue;

      const fieldX = 20 + (field.x / 100) * imgDisplayW;
      const fieldW = (field.width / 100) * imgDisplayW;
      const fieldH = Math.max((field.height / 100) * imgDisplayH, 20);
      const fieldY = imgY + imgDisplayH - (field.y / 100) * imgDisplayH - fieldH;

      console.log(`[PDF] Field "${field.label}":`, `answer="${studentAnswer.substring(0,30)}..."`, `correct=${isCorrect}`);

      page.drawRectangle({
        x: fieldX,
        y: fieldY,
        width: fieldW,
        height: fieldH,
        color: rgb(1, 1, 1),
        opacity: 0.9
      });

      const borderColor = isCorrect === true ? rgb(0.086, 0.58, 0.26) :
                           isCorrect === false ? rgb(0.86, 0.15, 0.15) :
                           rgb(0.4, 0.4, 0.4);

      page.drawRectangle({
        x: fieldX,
        y: fieldY,
        width: fieldW,
        height: fieldH,
        borderColor: borderColor,
        borderWidth: isCorrect !== null ? 2 : 1,
        opacity: 0
      });

      const textColor = isCorrect === true ? rgb(0.04, 0.45, 0.12) :
                         isCorrect === false ? rgb(0.75, 0.08, 0.08) :
                         rgb(0.1, 0.1, 0.5);

      const fontSize = Math.max(Math.min(fieldH * 0.38, 11), 9);
      const maxChars = Math.floor(fieldW / (fontSize * 0.54));
      const displayText = studentAnswer.length > maxChars ?
        studentAnswer.substring(0, maxChars - 2) + '..' : studentAnswer;

      page.drawText(displayText, {
        x: fieldX + 4,
        y: fieldY + fieldH * 0.28,
        size: fontSize,
        font: regularFont,
        color: textColor
      });

      if (isCorrect === true) {
        page.drawCircle({
          x: fieldX + fieldW - 9,
          y: fieldY + fieldH - 9,
          size: 8,
          color: rgb(0.086, 0.58, 0.26)
        });
        page.drawText('v', {
          x: fieldX + fieldW - 13,
          y: fieldY + fieldH - 15,
          size: 9, font: boldFont,
          color: rgb(1, 1, 1)
        });
      } else if (isCorrect === false) {
        page.drawCircle({
          x: fieldX + fieldW - 9,
          y: fieldY + fieldH - 9,
          size: 8,
          color: rgb(0.86, 0.15, 0.15)
        });
        page.drawText('x', {
          x: fieldX + fieldW - 13,
          y: fieldY + fieldH - 15,
          size: 9, font: boldFont,
          color: rgb(1, 1, 1)
        });
      }
    }

    // DRAW SECTION D: Footer
    page.drawRectangle({
      x: 0, y: 0,
      width: pageWidth,
      height: footerHeight,
      color: rgb(0.08, 0.55, 0.50),
      opacity: 0.95
    });

    const footerLine1 = [studentName, subject ? `| ${subject}` : '', grade ? `Grade ${grade}` : ''].filter(Boolean).join(' ');
    page.drawText(footerLine1, {
      x: 10, y: 20,
      size: 8, font: boldFont,
      color: rgb(1, 1, 1)
    });

    page.drawText(`Score: ${score}/${total} (${scorePct}%) | Date: ${new Date().toLocaleDateString()}`, {
      x: 10, y: 7,
      size: 8, font: regularFont,
      color: rgb(0.85, 0.95, 0.95)
    });

    const pdfBytes = await pdfDoc.save();

    const safeTitle = (worksheet.title || 'worksheet').replace(/[^a-z0-9]/gi, '-').toLowerCase().substring(0, 40);
    const safeName = studentName.replace(/[^a-z0-9]/gi, '-').toLowerCase();

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${safeName}_${safeTitle}.pdf"`);
    res.setHeader('Content-Length', pdfBytes.length);
    res.send(Buffer.from(pdfBytes));

    console.log('[PDF] Generated successfully:', pdfBytes.length, 'bytes');

  } catch (error) {
    console.error('[PDF] Error:', error);
    res.status(500).json({ error: 'PDF generation failed', message: error.message });
  }
}

/**
 * Evaluates student answers using AI for activity9 overlay worksheets
 * @param {string} worksheetTitle - Title of the worksheet
 * @param {string} worksheetSubject - Subject of the worksheet
 * @param {Array} fields - Array of field objects
 * @param {Object} answers - Object mapping fieldId to student answer
 * @returns {Object} Object with results and feedbacks maps
 */
async function evaluateAnswersWithAI(worksheetTitle, worksheetSubject, fields, answers) {
  const fieldEvaluations = fields
    .filter(f => answers[f.id] && answers[f.id].trim())
    .map(f => ({
      fieldId: f.id,
      label: f.label,
      studentAnswer: answers[f.id],
      expectedAnswer: f.expectedAnswer || ''
    }));

  if (fieldEvaluations.length === 0) {
    return {};
  }

  const prompt = `You are an expert teacher evaluating student worksheet answers.

Worksheet: "${worksheetTitle}"
Subject: "${worksheetSubject || 'General'}"

Evaluate each student answer below.
Consider an answer CORRECT if:
- It shows understanding of the concept
- It is factually accurate
- It mentions key relevant points
- Minor spelling mistakes are OK
- Partial answers that show understanding = correct
- Different wording that means the same thing = correct

Consider an answer WRONG if:
- It is completely unrelated to the label/question
- It shows a fundamental misunderstanding
- It is nonsense or random text

${fieldEvaluations.map((f, i) => `
Field ${i + 1}:
Label: ${f.label}
${f.expectedAnswer ? `Expected: ${f.expectedAnswer}` : ''}
Student answered: "${f.studentAnswer}"
`).join('\n')}

Return ONLY this JSON array, no explanation:
[
  {
    "fieldId": "field_1",
    "correct": true,
    "score": 1,
    "feedback": "Good answer! You correctly identified..."
  }
]

One object per field evaluated above.
Return ONLY the JSON array.`;

  // Use existing OpenRouter setup
  const apiKey = process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_KEY;
  const baseUrl = process.env.OPENROUTER_BASE_URL?.trim() || 'https://openrouter.ai/api/v1';
  const model = process.env.LLAMA_MODEL?.trim() || 'meta-llama/llama-3-8b-instruct';

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://roznahub.com',
      'X-Title': 'RoznaHub'
    },
    body: JSON.stringify({
      model: model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 1000,
      temperature: 0.1
    })
  });

  if (!response.ok) {
    throw new Error(`AI evaluation failed: ${response.status}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';

  // Parse JSON response
  let cleaned = content.trim()
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/gi, '')
    .trim();

  const jsonMatch = cleaned.match(/\[[\s\S]*\]/);
  if (!jsonMatch) throw new Error('Invalid AI response');

  const evaluations = JSON.parse(jsonMatch[0]);

  // Convert to results map
  const results = {};
  const feedbacks = {};

  for (const ev of evaluations) {
    results[ev.fieldId] = ev.correct === true;
    feedbacks[ev.fieldId] = ev.feedback || '';
  }

  return { results, feedbacks };
}

/**
 * POST /api/worksheets/:id/evaluate-answers
 * Evaluates student answers using AI for activity9 overlay worksheets
 */
async function evaluateAnswers(req, res) {
  try {
    const worksheet = await Worksheet.findById(req.params.id);

    if (!worksheet || !worksheet.activity9) {
      return res.status(404).json({
        error: 'Worksheet not found'
      });
    }

    const { answers } = req.body;
    if (!answers || Object.keys(answers).length === 0) {
      return res.status(400).json({
        error: 'No answers provided'
      });
    }

    const fields = worksheet.activity9.fields || [];
    const title = worksheet.title || 'Worksheet';
    const subject = worksheet.meta?.subject || 'General';

    console.log('[EVALUATE] Evaluating', Object.keys(answers).length, 'answers');
    console.log('[EVALUATE] Worksheet:', title);

    const { results, feedbacks } = await evaluateAnswersWithAI(title, subject, fields, answers);

    const score = Object.values(results).filter(v => v === true).length;
    const total = Object.keys(results).length;

    console.log('[EVALUATE] Score:', score, '/', total);

    res.json({
      success: true,
      results,
      feedbacks,
      score,
      total,
      percentage: total > 0 ? Math.round((score / total) * 100) : 0
    });

  } catch (error) {
    console.error('[EVALUATE] Error:', error.message);
    res.status(500).json({
      error: 'Evaluation failed',
      message: error.message
    });
  }
}

/**
 * Returns the visual analysis prompt for the AI
 * @returns The prompt string for visual design analysis
 */
function getVisualAnalysisPrompt() {
  return `You are analyzing a worksheet DESIGN TEMPLATE image.
This is a blank or sample worksheet layout. Your job is to understand its visual structure and design — NOT to extract its text content.

Look at the image carefully and identify:
- How many sections/boxes are there?
- What type of activity does each section seem designed for?
  (multiple_choice, fill_blank, ordering, classification, matching,
   short_answer, drawing, table)
- How is the page laid out? (single column, two column, grid, mixed)
- Are there numbered lines for writing answers?
- Are there boxes/circles for multiple choice options?
- Are there tables or grids?
- What is the general visual style? (formal, colorful, minimalist, structured, creative)
- Roughly how many questions per section based on the space provided?

IMPORTANT: If the worksheet shows a diagram, illustration, labeled picture, or any image with parts being identified 
(like a tree with labeled parts, body diagram, map, etc.), set the worksheetStyle to 'diagram' and set the recommended 
activityType to 'labeling'. Count how many labeled parts/boxes you see and set labelCount to that number.

Return ONLY this JSON object, nothing else:
{
  sections: [
    {
      title: string,
      type: 'multiple_choice' | 'fill_blank' | 'ordering' |
            'classification' | 'short_answer' | 'matching' |
            'drawing' | 'table',
      questionCount: number,
      layoutHint: string,
      instructions: string
    }
  ],
  totalQuestions: number,
  pageLayout: 'single_column' | 'two_column' | 'grid' | 'mixed',
  visualStyle: string,
  hasHeader: boolean,
  hasStudentInfoSection: boolean,
  difficultyHint: 'easy' | 'medium' | 'hard',
  subjectHint: string,
  designNotes: string,
  worksheetStyle: 'diagram' | 'questions' | 'mixed',
  recommendedActivityType: string,
  labelCount: number
}`;
}

module.exports = {
  generateWorksheet,
  uploadAndGenerate,
  generateFromFile,
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
  generateHtmlWorksheet,
  analyzeTemplate,
  detectFields,
  saveOverlayWorksheet,
  downloadOverlayPdf,
  evaluateAnswers,
};
