/**
 * geminiWorksheet.service.js
 *
 * Generates a printable HTML worksheet from an uploaded file
 * using Google Gemini 1.5 Flash API.
 *
 * Supported input formats:
 *   - PDF / images (PNG, JPG): sent as base64 inline_data to Gemini
 *   - DOCX / DOC: text extracted via mammoth, then sent as text
 *   - TXT: read directly, sent as text
 */
const mammoth = require("mammoth");
const path = require("path");
const logger = require("../utils/logger");

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";
const GEMINI_TIMEOUT_MS = 120_000; // 2 minutes

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Strip markdown code-fences that Gemini sometimes wraps around HTML output. */
function cleanHtmlResponse(raw) {
  let text = raw.trim();
  text = text.replace(/^```html\s*/i, "");
  text = text.replace(/^```\s*/i, "");
  text = text.replace(/\s*```\s*$/i, "");
  return text.trim();
}

/** Pull first <title> or <h1> from generated HTML. */
function extractTitle(html) {
  const m =
    html.match(/<title[^>]*>([^<]+)<\/title>/i) ||
    html.match(/<h1[^>]*>([^<\n]+)<\/h1>/i);
  return m ? m[1].trim().replace(/&amp;/g, "&") : "Generated Worksheet";
}

/** Build the Gemini system prompt, injecting teacher-selected form values. */
function buildGeminiPrompt(options = {}) {
  const {
    subject = "General",
    gradeLevel = "",
    gradeCategory = "",
    difficulty = "medium",
    language = "English",
    cefrLevel = "",
    activityTypes = [
      "ordering",
      "classification",
      "multipleChoice",
      "fillBlanks",
    ],
    theme = "modern",
  } = options;

  const activityList = Array.isArray(activityTypes)
    ? activityTypes.join(", ")
    : String(activityTypes);

  const themeGuidance = {
    modern:
      "teal/cyan palette (#008081 primary), clean sans-serif fonts, subtle card shadows",
    classic: "dark navy (#1e293b), serif fonts, clean lines",
    corporate:
      "deep blue (#1e40af), professional sans-serif, structured grid layout",
    academic: "purple (#7c3aed), formal academic feel, clear hierarchy",
    futuristic: "cyan (#06b6d4) on dark navy (#0f172a), tech-style",
  };
  const themeHint = themeGuidance[theme] || themeGuidance.modern;

  return `You are an expert educational worksheet designer.

Analyze the provided file content carefully. Then create a complete, visually polished, print-ready worksheet for students.

CONTEXT PROVIDED BY TEACHER:
- Subject: ${subject || "General"}
- Grade Level: ${gradeLevel || "Not specified"}
- Grade Category: ${gradeCategory || "Not specified"}
- Difficulty: ${difficulty}
- Language: ${language}
- CEFR Level: ${cefrLevel || "Not specified"}
- Activity Types to include: ${activityList}
- Visual theme: ${theme} (${themeHint})

WORKSHEET DESIGN REQUIREMENTS:
1. Identify the main topic from the file content
2. Create a structured, complete worksheet including:
   - A colored header section with the worksheet title and subject
   - A student info row: "Name: ____________  Date: ____________  Class: ____________"
   - A brief concept explanation box (key vocabulary or background info from the content)
   - Clearly separated activity sections that match the selected Activity Types:
       • "ordering" → Ordering / Sequencing activity
       • "classification" → Classification / Sorting activity
       • "multipleChoice" → Multiple Choice questions
       • "fillBlanks" → Fill in the Blanks sentences
       • "matching" → Matching Pairs activity
       • "trueFalse" → True or False statements
       • "shortAnswer" → Short Answer questions
   - Each activity must have a numbered section header, clear instructions, and answer boxes/lines
3. Use ONLY inline CSS and a single <style> block inside <head> — no external CSS, no Google Fonts imports
4. The worksheet must be A4 width (794px) and look professional when printed
5. Root element: <html> with a <body> that has a top-level <div class="worksheet-container">
6. Color scheme: follow the theme hint above; use a colored header gradient

OUTPUT RULES — READ CAREFULLY:
- Return ONLY raw HTML starting with <!DOCTYPE html>
- Do NOT include markdown code fences (\`\`\`html or \`\`\`)
- Do NOT include any explanation, comments outside HTML, or preamble
- The entire response must be valid, self-contained HTML`;
}

// ─── Main Export ────────────────────────────────────────────────────────────

/**
 * Generate a printable HTML worksheet from an uploaded file using Gemini.
 *
 * @param {Buffer} fileBuffer   - Raw file bytes
 * @param {string} mimeType     - MIME type of the file
 * @param {string} fileName     - Original filename (used for extension fallback)
 * @param {Object} options      - Teacher form settings (subject, difficulty, …)
 * @returns {Promise<{html: string, title: string}>}
 */
async function generateHtmlWorksheetFromFile(
  fileBuffer,
  mimeType,
  fileName,
  options = {},
) {
  if (!GEMINI_API_KEY) {
    throw new Error(
      "GEMINI_API_KEY is not set. Add it to your .env file to use this feature.",
    );
  }

  const ext = path
    .extname(fileName || "")
    .toLowerCase()
    .replace(".", "");
  const prompt = buildGeminiPrompt(options);
  let parts;

  const isDocx =
    mimeType ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    mimeType === "application/msword" ||
    ext === "docx" ||
    ext === "doc";

  const isTxt = mimeType === "text/plain" || ext === "txt";

  const isPdf = mimeType === "application/pdf" || ext === "pdf";

  const isImage =
    ["image/png", "image/jpeg", "image/jpg"].includes(mimeType) ||
    ["png", "jpg", "jpeg"].includes(ext);

  // ── DOCX: extract text first ─────────────────────────────────────────────
  if (isDocx) {
    logger.info("[GEMINI WORKSHEET] Extracting DOCX text via mammoth");
    const result = await mammoth.extractRawText({ buffer: fileBuffer });
    const text = (result.value || "").trim();
    if (text.length < 20) {
      throw new Error(
        "Could not extract enough text from the DOCX file. The file may be empty or corrupt.",
      );
    }
    parts = [{ text: `FILE CONTENT:\n${text.slice(0, 30000)}\n\n${prompt}` }];
  }

  // ── TXT: read directly ───────────────────────────────────────────────────
  else if (isTxt) {
    const text = fileBuffer.toString("utf-8").trim();
    if (text.length < 20) {
      throw new Error("The uploaded text file appears to be empty.");
    }
    parts = [{ text: `FILE CONTENT:\n${text.slice(0, 30000)}\n\n${prompt}` }];
  }

  // ── PDF / Image: base64 inline_data ──────────────────────────────────────
  else if (isPdf || isImage) {
    let normalizedMime = mimeType;
    if (normalizedMime === "image/jpg") normalizedMime = "image/jpeg";
    if (!normalizedMime || normalizedMime === "application/octet-stream") {
      if (isPdf) normalizedMime = "application/pdf";
      else if (ext === "png") normalizedMime = "image/png";
      else normalizedMime = "image/jpeg";
    }

    const base64 = fileBuffer.toString("base64");
    parts = [
      { inline_data: { mime_type: normalizedMime, data: base64 } },
      { text: prompt },
    ];
  }

  // ── Unsupported ───────────────────────────────────────────────────────────
  else {
    throw new Error(
      `Unsupported file type: ${mimeType || ext}. Supported: PDF, DOCX, TXT, PNG, JPG.`,
    );
  }

  // ── Call Gemini API ───────────────────────────────────────────────────────
  logger.info(
    `[GEMINI WORKSHEET] Calling Gemini 2.0 Flash | file: ${fileName} | type: ${mimeType}`,
  );

  const requestBody = {
    contents: [{ parts }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 8192,
    },
  };

  let response;
  try {
    response = await fetch(`${GEMINI_ENDPOINT}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
      signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
    });
  } catch (fetchErr) {
    if (fetchErr.name === "TimeoutError" || fetchErr.name === "AbortError") {
      throw new Error(
        "Gemini API timed out. The file may be too complex — try a smaller file.",
      );
    }
    throw new Error(`Network error contacting Gemini API: ${fetchErr.message}`);
  }

  if (!response.ok) {
    const errText = await response.text().catch(() => "(no body)");
    logger.error(
      `[GEMINI WORKSHEET] HTTP ${response.status}:`,
      errText.slice(0, 400),
    );

    if (response.status === 400)
      throw new Error(
        "Gemini rejected the file. Try a different format or smaller file.",
      );
    if (response.status === 401 || response.status === 403)
      throw new Error(
        "GEMINI_API_KEY is invalid or lacks permission. Check your .env file.",
      );
    if (response.status === 429)
      throw new Error(
        "Gemini API rate limit reached. Please wait a moment and try again.",
      );
    if (response.status >= 500)
      throw new Error(
        "Gemini API is temporarily unavailable. Please try again in a few seconds.",
      );
    throw new Error(`Gemini API error (${response.status}). Please try again.`);
  }

  const data = await response.json();
  const rawHtml = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  if (!rawHtml || rawHtml.trim().length < 100) {
    throw new Error(
      "Gemini returned an empty worksheet. The file may not contain enough content.",
    );
  }

  logger.info(`[GEMINI WORKSHEET] HTML generated, length: ${rawHtml.length}`);

  const html = cleanHtmlResponse(rawHtml);
  const title = extractTitle(html);

  return { html, title };
}

module.exports = { generateHtmlWorksheetFromFile };
