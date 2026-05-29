// src/services/worksheetFileService.ts
// Method 2 — PDF/image upload → WorksheetDocument JSON
// Flow: normalize → Vision OCR → Gemini structure analysis → Gemini content gen → assemble

import { GoogleGenerativeAI } from "@google/generative-ai";
import vision from "@google-cloud/vision";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { pdfFirstPageToJpeg } from "../utils/pdfToImage";
import { fetchTopicImage } from "./imageService";
import { buildColorSchemeFromHex } from "../utils/colorUtils";
import {
  WorksheetDocument,
  WorksheetSection,
  WorksheetColorScheme,
  DiagramLabel,
  Question,
  QuestionType,
  LayoutType,
} from "../types/worksheet";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const visionClient = new vision.ImageAnnotatorClient();

// ─────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────

export async function generateWorksheetFromFile(params: {
  fileBuffer: Buffer;
  mimeType: string;
  topic?: string;
  subject?: string;
  gradeLevel: string;
  teacherId: string;
}): Promise<WorksheetDocument> {
  // Step 1: Normalize to JPEG buffer (renders PDF page 1 if needed)
  const imageBuffer = await normalizeToJpeg(params.fileBuffer, params.mimeType);
  const imageBase64 = imageBuffer.toString("base64");

  // Step 2: OCR with Google Vision
  const extractedText = await extractTextWithVision(imageBase64);

  // Step 3: Gemini Vision — detect worksheet structure
  const structureAnalysis = await analyzeWorksheetStructure(
    imageBase64,
    extractedText,
  );

  // Step 4: Resolve final topic, subject, and grade level
  const finalTopic =
    params.topic?.trim() ||
    (structureAnalysis.detectedTopic as string) ||
    "General Topic";
  const finalSubject =
    params.subject?.trim() ||
    (structureAnalysis.detectedSubject as string) ||
    "General";
  const finalGrade =
    params.gradeLevel ||
    (structureAnalysis.detectedGradeLevel as string) ||
    "Grade 4";

  // Step 5: Gemini — generate new content matching detected structure
  const generatedContent = await generateMatchingContent(
    structureAnalysis,
    finalTopic,
    finalSubject,
    finalGrade,
  );

  // Step 6: Fetch topic illustration
  const imageUrl = await fetchTopicImage(
    (generatedContent.decorativeImageQuery as string) || finalTopic,
  );

  // Step 7: Build color scheme from detected primary hex
  const colorAnalysis = structureAnalysis.colorScheme as
    | { primaryHex?: string; isDark?: boolean }
    | undefined;
  const colorScheme = buildColorSchemeFromHex(
    colorAnalysis?.primaryHex || "#2d6a2d",
    colorAnalysis?.isDark ?? true,
  );

  // Step 8: Assemble WorksheetDocument
  return buildWorksheetDocumentFromFile({
    id: uuidv4(),
    teacherId: params.teacherId,
    topic: finalTopic,
    subject: finalSubject,
    gradeLevel: finalGrade,
    structureAnalysis,
    generatedContent,
    imageUrl,
    colorScheme,
  });
}

// ─────────────────────────────────────────────
// STEP 1: NORMALIZE FILE TO JPEG BUFFER
// ─────────────────────────────────────────────

async function normalizeToJpeg(
  buffer: Buffer,
  mimeType: string,
): Promise<Buffer> {
  if (mimeType === "application/pdf") {
    return pdfFirstPageToJpeg(buffer);
  }
  // For images: resize to max 1600px wide (keeps aspect ratio), convert to JPEG
  return sharp(buffer)
    .resize({ width: 1600, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
}

// ─────────────────────────────────────────────
// STEP 2: OCR WITH GOOGLE VISION
// ─────────────────────────────────────────────

async function extractTextWithVision(imageBase64: string): Promise<string> {
  try {
    const [result] = await visionClient.textDetection({
      image: { content: imageBase64 },
    });
    return result.fullTextAnnotation?.text ?? "";
  } catch (err: unknown) {
    // OCR failure is non-fatal — Gemini Vision can still analyze the image
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[worksheetFileService] Google Vision OCR failed:", msg);
    return "";
  }
}

// ─────────────────────────────────────────────
// STEP 3: GEMINI VISION — DETECT WORKSHEET STRUCTURE
// ─────────────────────────────────────────────

async function analyzeWorksheetStructure(
  imageBase64: string,
  extractedText: string,
): Promise<Record<string, unknown>> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `
You are an expert at analyzing educational worksheets.
You are given:
1. An IMAGE of a printed worksheet
2. OCR text extracted from that worksheet

Deeply analyze the visual structure, layout, colors, and question types.
Your goal is to produce a precise JSON description so a developer can
recreate the same worksheet layout for a different topic.

OCR TEXT (first 3000 chars):
"""
${extractedText.substring(0, 3000)}
"""

RESPOND ONLY WITH VALID JSON. No markdown, no backticks, no explanation.

{
  "detectedTopic": "topic from the worksheet",
  "detectedSubject": "Science | English | Math | etc.",
  "detectedGradeLevel": "e.g. Grade 3",
  "worksheetTitle": "exact title visible on worksheet",
  "colorScheme": {
    "dominantColor": "green | blue | red | etc.",
    "primaryHex": "#hexcode",
    "isDark": true
  },
  "layout": "single_column | two_column | diagram_with_boxes | grid",
  "hasDecorativeImage": true,
  "decorativeImagePosition": "left | right | center | background | none",
  "decorativeImageDescription": "describe what image shows",
  "sections": [
    {
      "sectionType": "header | instructions | question_block | diagram_labels | word_bank | footer",
      "order": 1,
      "details": {
        "hasNameField": true,
        "hasDateField": false,
        "titleStyle": "large banner with dark green background",
        "instructionText": "exact instruction text if visible",
        "questionType": "fill_blank | mcq | short_answer | label_diagram | diagram_boxes | write_lines | matching | true_false",
        "questionCount": 6,
        "writeLinesPerQuestion": 3,
        "labelNames": ["HUSKS", "LEAVES", "FRUIT", "TRUNK", "FLOWERS", "ROOTS"],
        "labelPositions": ["top-right", "right", "right", "bottom-right", "bottom-left", "bottom-left"],
        "hasBoxBorder": true,
        "borderStyle": "rounded rectangle with colored pill-shaped label tab on top",
        "footerLeftText": "TREES WORKSHEETS",
        "footerRightText": "KIDSKONNECT.COM"
      }
    }
  ]
}

PRECISION RULES:
- Count exact number of labels or questions visible. Do not guess.
- If you see labeled boxes with answer lines, the questionType is "diagram_boxes".
- If you see numbered questions with blanks, use "fill_blank".
- Describe the border style precisely (rounded, sharp, dashed, etc).
- The label tab style matters: is it a pill shape? A rectangle? Positioned on top or to the side?
`.trim();

  const result = await model.generateContent([
    { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
    { text: prompt },
  ]);

  const raw = result.response.text();
  try {
    return parseJsonSafely(raw);
  } catch {
    console.warn(
      "[worksheetFileService] Structure analysis JSON parse failed. Retrying...",
    );
    const retryResult = await model.generateContent([
      { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
      {
        text: `Return ONLY a valid JSON object. No markdown. No explanation.\n${prompt}`,
      },
    ]);
    return parseJsonSafely(retryResult.response.text());
  }
}

// ─────────────────────────────────────────────
// STEP 5: GENERATE NEW CONTENT MATCHING STRUCTURE
// ─────────────────────────────────────────────

async function generateMatchingContent(
  structureAnalysis: Record<string, unknown>,
  newTopic: string,
  newSubject: string,
  gradeLevel: string,
): Promise<Record<string, unknown>> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  const prompt = `
You are an expert educational content creator.
Generate a new worksheet that EXACTLY matches the structure below, but for a different topic.

ORIGINAL STRUCTURE:
${JSON.stringify(structureAnalysis, null, 2)}

NEW TOPIC: ${newTopic}
NEW SUBJECT: ${newSubject}
GRADE LEVEL: ${gradeLevel}

STRICT RULES:
1. Keep EXACTLY the same number of sections, question types, and question/label counts.
2. Keep the same layout type (diagram_with_boxes stays diagram_with_boxes, etc).
3. For diagram_boxes: generate the correct anatomical or conceptual parts of the new topic.
4. For label positions: distribute them top-to-bottom, alternating sides logically.
5. All content must be factually correct and grade-appropriate.
6. Write a 2–3 sentence introduction paragraph about the new topic.
7. Include correct answers for every question.

RESPOND WITH ONLY A VALID JSON OBJECT. No markdown. No backticks.

{
  "title": "NEW WORKSHEET TITLE IN UPPERCASE",
  "instructions": "2-3 sentence intro paragraph about the new topic",
  "decorativeImageQuery": "illustration search query for ${newTopic}",
  "sections": [
    {
      "sectionType": "header | instructions | question_block | diagram_labels | word_bank | footer",
      "content": {
        "titleText": "...",
        "instructionText": "...",
        "questionType": "fill_blank | mcq | short_answer | label_diagram | diagram_boxes | write_lines | matching | true_false",
        "questions": [
          {
            "number": 1,
            "labelName": "PART NAME (diagram_boxes only)",
            "questionText": "question text (other types)",
            "position": "top-right (diagram_boxes only)",
            "writeLines": 3,
            "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
            "answer": "correct answer"
          }
        ],
        "words": ["word1", "word2"],
        "footerLeftText": "...",
        "footerRightText": ""
      }
    }
  ]
}
`.trim();

  const result = await model.generateContent(prompt);
  const raw = result.response.text();
  try {
    return parseJsonSafely(raw);
  } catch {
    console.warn(
      "[worksheetFileService] Content generation JSON parse failed. Retrying...",
    );
    const retryResult = await model.generateContent(
      `Return ONLY a valid JSON object. No markdown.\n${prompt}`,
    );
    return parseJsonSafely(retryResult.response.text());
  }
}

// ─────────────────────────────────────────────
// STEP 8: ASSEMBLE WorksheetDocument
// ─────────────────────────────────────────────

function buildWorksheetDocumentFromFile(params: {
  id: string;
  teacherId: string;
  topic: string;
  subject: string;
  gradeLevel: string;
  structureAnalysis: Record<string, unknown>;
  generatedContent: Record<string, unknown>;
  imageUrl: string;
  colorScheme: WorksheetColorScheme;
}): WorksheetDocument {
  const sections: WorksheetSection[] = [];
  const answerKey: { questionId: string; answer: string }[] = [];

  // Header
  sections.push({
    id: uuidv4(),
    type: "header",
    content: {
      showNameField: true,
      showDateField: true,
      showClassField: false,
      title:
        typeof params.generatedContent.title === "string"
          ? params.generatedContent.title
          : params.topic.toUpperCase(),
      decorativeImageUrl: params.imageUrl,
    },
  });

  // Instructions
  if (typeof params.generatedContent.instructions === "string") {
    sections.push({
      id: uuidv4(),
      type: "instructions",
      content: {
        text: params.generatedContent.instructions,
        bold: true,
        alignment: "justify",
      },
    });
  }

  // Content sections from generated content
  const aiSections = Array.isArray(params.generatedContent.sections)
    ? (params.generatedContent.sections as Record<string, unknown>[])
    : [];

  for (const aiSection of aiSections) {
    const sType = aiSection.sectionType as string;
    const content = (aiSection.content ?? {}) as Record<string, unknown>;

    if (sType === "diagram_labels") {
      const rawQuestions = Array.isArray(content.questions)
        ? (content.questions as Record<string, unknown>[])
        : [];
      const labels: DiagramLabel[] = rawQuestions.map(
        (q): DiagramLabel => ({
          id: uuidv4(),
          labelName:
            typeof q.labelName === "string"
              ? q.labelName
              : typeof q.questionText === "string"
                ? q.questionText
                : "PART",
          position: (q.position as DiagramLabel["position"]) ?? "right",
          writeLines: typeof q.writeLines === "number" ? q.writeLines : 3,
        }),
      );
      sections.push({
        id: uuidv4(),
        type: "diagram_labels",
        content: {
          centralImage: {
            query:
              typeof params.generatedContent.decorativeImageQuery === "string"
                ? params.generatedContent.decorativeImageQuery
                : params.topic,
            url: params.imageUrl,
            alt: params.topic,
            position: "left",
          },
          labels,
          instructions:
            typeof content.instructionText === "string"
              ? content.instructionText
              : undefined,
        },
      });
      continue;
    }

    if (sType === "word_bank") {
      sections.push({
        id: uuidv4(),
        type: "word_bank",
        content: {
          title: "Word Bank",
          words: Array.isArray(content.words)
            ? (content.words as string[])
            : [],
        },
      });
      continue;
    }

    if (sType === "footer") {
      sections.push({
        id: uuidv4(),
        type: "footer",
        content: {
          leftText:
            typeof content.footerLeftText === "string"
              ? content.footerLeftText
              : `${params.subject.toUpperCase()} WORKSHEET`,
          rightText:
            typeof content.footerRightText === "string"
              ? content.footerRightText
              : "",
        },
      });
      continue;
    }

    if (sType === "question_block") {
      const qType: QuestionType =
        (content.questionType as QuestionType) || "short_answer";
      const rawQuestions = Array.isArray(content.questions)
        ? (content.questions as Record<string, unknown>[])
        : [];
      const questions: Question[] = rawQuestions.map((q): Question => {
        const qId = uuidv4();
        if (typeof q.answer === "string" && q.answer) {
          answerKey.push({ questionId: qId, answer: q.answer });
        }
        return {
          id: qId,
          number: typeof q.number === "number" ? q.number : 0,
          type: qType,
          questionText:
            typeof q.questionText === "string" ? q.questionText : "",
          writeLines:
            typeof q.writeLines === "number" ? q.writeLines : undefined,
          options: Array.isArray(q.options)
            ? (q.options as string[])
            : undefined,
          answer: typeof q.answer === "string" ? q.answer : undefined,
          points: 1,
        };
      });
      sections.push({
        id: uuidv4(),
        type: "question_block",
        content: {
          sectionTitle:
            typeof content.sectionTitle === "string"
              ? content.sectionTitle
              : typeof content.titleText === "string"
                ? content.titleText
                : undefined,
          showSectionTitle: true,
          questions,
          layout: "single_column",
        },
      });
    }
  }

  // Guarantee a footer section exists
  if (!sections.some((s) => s.type === "footer")) {
    sections.push({
      id: uuidv4(),
      type: "footer",
      content: {
        leftText: `${params.subject.toUpperCase()} WORKSHEET`,
        rightText: "",
      },
    });
  }

  const detectedLayout = params.structureAnalysis.layout;
  const layout: LayoutType =
    detectedLayout === "two_column" ||
    detectedLayout === "diagram_with_boxes" ||
    detectedLayout === "grid" ||
    detectedLayout === "table"
      ? (detectedLayout as LayoutType)
      : "single_column";

  return {
    id: params.id,
    version: "1.0",
    createdAt: new Date().toISOString(),
    createdBy: params.teacherId,
    source: "file_upload",
    meta: {
      title:
        typeof params.generatedContent.title === "string"
          ? params.generatedContent.title
          : params.topic,
      subject: params.subject,
      topic: params.topic,
      gradeCategory: "", // file upload does not have a grade category form field
      gradeLevel: params.gradeLevel,
      estimatedMinutes: 30,
      difficulty: "medium",
      theme: "default", // color scheme is derived from file detection
      activityTypes: [], // activity types are AI-detected from uploaded file
      tags: [],
      language: "en",
    },
    design: {
      colorScheme: params.colorScheme,
      layout,
      fontFamily: "Arial",
      fontSize: "medium",
      pageSize: "A4",
      margins: "normal",
      hasDecorativeImage: params.structureAnalysis.hasDecorativeImage === true,
    },
    sections,
    answerKey,
  };
}

// ─────────────────────────────────────────────
// HELPER: SAFE JSON PARSER
// ─────────────────────────────────────────────

function parseJsonSafely(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  return JSON.parse(cleaned) as Record<string, unknown>;
}
