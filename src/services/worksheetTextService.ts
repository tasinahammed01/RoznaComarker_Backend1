// src/services/worksheetTextService.ts
// Method 1 — Topic name → WorksheetDocument JSON
// Flow: prompt → Gemini 2.0 Flash → parse JSON → fetch image → assemble document

import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { v4 as uuidv4 } from "uuid";
import { fetchTopicImage } from "./imageService";
import { buildColorScheme } from "../utils/colorUtils";
import {
  WorksheetDocument,
  WorksheetSection,
  WorksheetColorScheme,
  ActivityType,
  DiagramLabel,
  Question,
} from "../types/worksheet";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

// ─────────────────────────────────────────────
// PUBLIC ENTRY POINT
// ─────────────────────────────────────────────

export async function generateWorksheetFromText(params: {
  topic: string;
  description?: string;
  subject: string;
  gradeCategory: string;
  gradeLevel: string;
  cefrLevel?: string;
  activityTypes: ActivityType[];
  questionCount: number;
  difficulty: "easy" | "medium" | "hard";
  language: string;
  theme: string;
  customSelection?: boolean;
  teacherId: string;
}): Promise<WorksheetDocument> {
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

  // Step 1: Generate raw AI content
  const aiContent = await generateAiContent(model, params);

  // Step 2: Fetch illustration
  const imageUrl = await fetchTopicImage(
    (aiContent.decorativeImageQuery as string) || params.topic,
  );

  // Step 3: Build color scheme — map theme name to preset
  const themeColor = params.theme === "default" ? "green" : params.theme;
  const colorScheme = buildColorScheme(
    (aiContent.colorSuggestion as string) || themeColor,
  );

  // Step 4: Assemble final WorksheetDocument
  return buildWorksheetDocument({
    id: uuidv4(),
    source: "text_prompt",
    teacherId: params.teacherId,
    topic: params.topic,
    description: params.description,
    subject: params.subject,
    gradeCategory: params.gradeCategory,
    gradeLevel: params.gradeLevel,
    cefrLevel: params.cefrLevel,
    difficulty: params.difficulty,
    language: params.language,
    theme: params.theme,
    activityTypes: params.activityTypes,
    aiContent,
    imageUrl,
    colorScheme,
  });
}

// ─────────────────────────────────────────────
// STEP 1: ASK GEMINI TO GENERATE CONTENT
// ─────────────────────────────────────────────

async function generateAiContent(
  model: GenerativeModel,
  params: {
    topic: string;
    description?: string;
    subject: string;
    gradeCategory: string;
    gradeLevel: string;
    cefrLevel?: string;
    activityTypes: ActivityType[];
    questionCount: number;
    difficulty: string;
    language: string;
    theme: string;
  },
): Promise<Record<string, unknown>> {
  const prompt = buildContentPrompt(params);

  const result = await model.generateContent(prompt);
  const rawText = result.response.text();

  // First parse attempt
  try {
    return parseJsonSafely(rawText);
  } catch {
    console.warn("[worksheetTextService] First JSON parse failed. Retrying...");
    const retryPrompt = `Your previous response was not valid JSON.
Return ONLY the JSON object below with no markdown fences, no explanation, no extra text.
${prompt}`;
    const retryResult = await model.generateContent(retryPrompt);
    const retryText = retryResult.response.text();
    return parseJsonSafely(retryText);
  }
}

// ─────────────────────────────────────────────
// PROMPT BUILDER
// ─────────────────────────────────────────────

function buildContentPrompt(params: {
  topic: string;
  description?: string;
  subject: string;
  gradeCategory: string;
  gradeLevel: string;
  cefrLevel?: string;
  activityTypes: ActivityType[];
  questionCount: number;
  difficulty: string;
  language: string;
  theme: string;
}): string {
  const cefrNote = params.cefrLevel
    ? `- CEFR Level: ${params.cefrLevel} — adjust vocabulary and sentence complexity accordingly.`
    : "";

  const descNote = params.description
    ? `- Teacher's description/context: "${params.description}" — use this as additional context.`
    : "";

  return `
You are an expert educational worksheet creator. Generate a complete, accurate worksheet for teachers.

SPECIFICATIONS:
- Topic: ${params.topic}
- Subject: ${params.subject}
- Grade Category: ${params.gradeCategory}
- Grade Level: ${params.gradeLevel}
- Difficulty: ${params.difficulty}
- Language: ${params.language}
- Activity Types to include: ${params.activityTypes.join(", ")}
- Total Questions/Items: ${params.questionCount}
${cefrNote}
${descNote}

ACTIVITY TYPE RULES — implement each type correctly:

1. ordering_sequencing:
   - Provide 5-7 items that must be arranged in a specific correct order
   - Scramble them in the question; give correct order in answer field
   - JSON: { "questionText": "Arrange these steps:", "items": ["step3","step1","step2"], "correctOrder": ["step1","step2","step3"], "answer": "step1 → step2 → step3" }

2. classification:
   - Provide 8-12 items belonging to 2-4 categories; student sorts them
   - JSON: { "questionText": "Sort these items:", "categories": ["Mammals","Reptiles"], "classificationItems": ["Dog","Snake","Cat","Lizard"], "classificationAnswers": {"Mammals":["Dog","Cat"],"Reptiles":["Snake","Lizard"]}, "answer": "See answers object" }

3. multiple_choice:
   - Exactly 4 options (A, B, C, D). One correct answer.
   - JSON: { "questionText": "...", "options": ["A) ...", "B) ...", "C) ...", "D) ..."], "answer": "A" }

4. fill_in_blanks:
   - Embed "______" directly in the sentence where the missing word goes
   - JSON: { "questionText": "The capital of France is ______.", "answer": "Paris" }

5. matching_pairs:
   - Provide 5-8 pairs in matchPairs array
   - JSON: { "questionText": "Match each item:", "matchPairs": [{"left":"Dog","right":"Mammal"}], "answer": "see pairs" }

6. true_false:
   - Clear, unambiguous statement. Answer is exactly "True" or "False"
   - JSON: { "questionText": "The Earth is flat.", "answer": "False" }

7. short_answer:
   - Open-ended question, answerable in 2-3 sentences. Provide a model answer.
   - JSON: { "questionText": "Explain why...", "writeLines": 3, "answer": "Model answer..." }

GENERAL RULES:
- All content must be factually correct and grade-appropriate.
- Distribute questions evenly across selected activity types.
- Include a 2-3 sentence introduction paragraph about the topic.
- Include a complete answer for every question.
- Use ${params.language} language throughout.

RESPOND ONLY WITH A VALID JSON OBJECT. No markdown. No backticks. No explanation.

{
  "title": "WORKSHEET TITLE IN UPPERCASE",
  "instructions": "2-3 sentence intro paragraph about the topic",
  "colorSuggestion": "${params.theme === "default" ? "green" : params.theme}",
  "hasDecorativeImage": true,
  "decorativeImageQuery": "illustration search query for the topic",
  "sections": [
    {
      "sectionTitle": "Section A: Ordering / Sequencing",
      "activityType": "ordering_sequencing",
      "questions": [
        {
          "number": 1,
          "questionText": "Arrange these steps in the correct order:",
          "items": ["scrambled item 3", "scrambled item 1", "scrambled item 2"],
          "correctOrder": ["item 1", "item 2", "item 3"],
          "answer": "item 1 → item 2 → item 3"
        }
      ]
    }
  ],
  "footerLeft": "${params.subject.toUpperCase()} WORKSHEET",
  "footerRight": "${params.cefrLevel || ""}",
  "tags": ["relevant", "tags"]
}
`.trim();
}

// ─────────────────────────────────────────────
// SAFE JSON PARSER (strips markdown fences)
// ─────────────────────────────────────────────

function parseJsonSafely(raw: string): Record<string, unknown> {
  const cleaned = raw
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  return JSON.parse(cleaned) as Record<string, unknown>;
}

// ─────────────────────────────────────────────
// STEP 4: ASSEMBLE WorksheetDocument
// ─────────────────────────────────────────────

function buildWorksheetDocument(params: {
  id: string;
  source: "text_prompt";
  teacherId: string;
  topic: string;
  description?: string;
  subject: string;
  gradeCategory: string;
  gradeLevel: string;
  cefrLevel?: string;
  difficulty: "easy" | "medium" | "hard";
  language: string;
  theme: string;
  activityTypes: ActivityType[];
  aiContent: Record<string, unknown>;
  imageUrl: string;
  colorScheme: WorksheetColorScheme;
}): WorksheetDocument {
  const sections: WorksheetSection[] = [];
  const answerKey: { questionId: string; answer: string }[] = [];

  // 1. Header section
  sections.push({
    id: uuidv4(),
    type: "header",
    content: {
      showNameField: true,
      showDateField: true,
      showClassField: false,
      title:
        typeof params.aiContent.title === "string"
          ? params.aiContent.title
          : params.topic.toUpperCase(),
      decorativeImageUrl: params.imageUrl,
    },
  });

  // 2. Instructions section
  if (typeof params.aiContent.instructions === "string") {
    sections.push({
      id: uuidv4(),
      type: "instructions",
      content: {
        text: params.aiContent.instructions,
        bold: true,
        alignment: "justify",
      },
    });
  }

  // 3. Question sections
  const aiSections = Array.isArray(params.aiContent.sections)
    ? (params.aiContent.sections as Record<string, unknown>[])
    : [];

  for (const aiSection of aiSections) {
    // Support both new "activityType" and legacy "questionType" from AI response
    const activityType =
      (aiSection.activityType as ActivityType) ||
      (aiSection.questionType as ActivityType);

    const rawQuestions = Array.isArray(aiSection.questions)
      ? (aiSection.questions as Record<string, unknown>[])
      : [];

    // Standard question block — all new activity types are handled here
    const questions: Question[] = rawQuestions.map((q): Question => {
      const qId = uuidv4();
      if (typeof q.answer === "string" && q.answer) {
        answerKey.push({ questionId: qId, answer: q.answer });
      }
      return {
        id: qId,
        number: typeof q.number === "number" ? q.number : 0,
        type: activityType,
        questionText: typeof q.questionText === "string" ? q.questionText : "",
        writeLines: typeof q.writeLines === "number" ? q.writeLines : undefined,
        // Multiple choice
        options: Array.isArray(q.options) ? (q.options as string[]) : undefined,
        // Matching pairs
        matchPairs: Array.isArray(q.matchPairs)
          ? (q.matchPairs as { left: string; right: string }[])
          : undefined,
        // Ordering/sequencing
        items: Array.isArray(q.items) ? (q.items as string[]) : undefined,
        correctOrder: Array.isArray(q.correctOrder)
          ? (q.correctOrder as string[])
          : undefined,
        // Classification
        categories: Array.isArray(q.categories)
          ? (q.categories as string[])
          : undefined,
        classificationItems: Array.isArray(q.classificationItems)
          ? (q.classificationItems as string[])
          : undefined,
        classificationAnswers:
          q.classificationAnswers && typeof q.classificationAnswers === "object"
            ? (q.classificationAnswers as Record<string, string[]>)
            : undefined,
        answer: typeof q.answer === "string" ? q.answer : undefined,
        points: typeof q.points === "number" ? q.points : 1,
      };
    });

    sections.push({
      id: uuidv4(),
      type: "question_block",
      content: {
        sectionTitle:
          typeof aiSection.sectionTitle === "string"
            ? aiSection.sectionTitle
            : undefined,
        showSectionTitle: true,
        questions,
        layout: "single_column",
      },
    });
  }

  // 4. Footer section
  const footerRight =
    typeof params.aiContent.footerRight === "string"
      ? params.aiContent.footerRight
      : (params.cefrLevel ?? "");

  sections.push({
    id: uuidv4(),
    type: "footer",
    content: {
      leftText:
        typeof params.aiContent.footerLeft === "string"
          ? params.aiContent.footerLeft
          : `${params.subject.toUpperCase()} WORKSHEET`,
      rightText: footerRight,
    },
  });

  return {
    id: params.id,
    version: "1.0",
    createdAt: new Date().toISOString(),
    createdBy: params.teacherId,
    source: params.source,
    meta: {
      title:
        typeof params.aiContent.title === "string"
          ? params.aiContent.title
          : params.topic,
      description: params.description,
      subject: params.subject,
      topic: params.topic,
      gradeCategory: params.gradeCategory,
      gradeLevel: params.gradeLevel,
      cefrLevel: params.cefrLevel,
      estimatedMinutes: 30,
      difficulty: params.difficulty,
      theme: params.theme,
      activityTypes: params.activityTypes,
      tags: Array.isArray(params.aiContent.tags)
        ? (params.aiContent.tags as string[])
        : [],
      language: params.language,
    },
    design: {
      colorScheme: params.colorScheme,
      layout: "single_column",
      fontFamily: "Arial",
      fontSize: "medium",
      pageSize: "A4",
      margins: "normal",
      hasDecorativeImage: !!params.imageUrl,
    },
    sections,
    answerKey,
  };
}
