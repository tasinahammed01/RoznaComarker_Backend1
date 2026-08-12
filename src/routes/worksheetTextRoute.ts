// src/routes/worksheetTextRoute.ts
// POST /api/worksheets/generate/text
// Accepts teacher form data, calls worksheetTextService, returns WorksheetDocument JSON.

import { Router, Request, Response } from "express";
import { generateWorksheetFromText } from "../services/worksheetTextService";
import { WorksheetDocumentModel } from "../models/WorksheetDocument";
import { ActivityType, MAX_ACTIVITY_TYPES } from "../types/worksheet";

const router = Router();
const { verifyJwtToken } = require("../middlewares/jwtAuth.middleware");
const { requireRole } = require("../middlewares/role.middleware");
const { createSensitiveRateLimiter, createUserRateLimiter } = require("../middlewares/rateLimit.middleware");
const { createUserConcurrencyGuard } = require("../middlewares/concurrency.middleware");
const { reserveAiWorksheetUsage } = require("../middlewares/usage.middleware");

/**
 * POST /api/worksheets/generate/text
 *
 * Body (all new Phase 6 fields):
 *   topic            string    required  (worksheet title / topic)
 *   description      string    optional  max 500 chars
 *   subject          string    required
 *   cefrLevel        string    optional  A1-C2
 *   gradeCategory    string    required  e.g. "primary"
 *   gradeLevel       string    required  e.g. "grade_3"
 *   difficulty       string    optional  default "medium"
 *   language         string    optional  default "en"
 *   theme            string    optional  default "default"
 *   activityTypes    string[]  optional  max 6; defaults to ["multiple_choice","fill_in_blanks","short_answer"]
 *   customSelection  boolean   optional  default true
 *   questionCount    number    optional  default 10, max 30
 *   teacherId        string    required
 *
 * Response: WorksheetDocument JSON (201)
 */
router.post(
  "/",
  createSensitiveRateLimiter(),
  verifyJwtToken,
  requireRole("teacher"),
  createUserRateLimiter({ event: "AI_GENERATION_RATE_LIMITED", reason: "worksheet_text_user" }),
  createUserConcurrencyGuard({ operation: "worksheet_generation", maxConcurrent: 2 }),
  reserveAiWorksheetUsage(),
  async (req: Request, res: Response) => {
  try {
    const {
      topic,
      description,
      subject,
      cefrLevel,
      gradeCategory,
      gradeLevel,
      difficulty,
      language,
      theme,
      activityTypes,
      customSelection,
      questionCount,
    } = req.body as Record<string, unknown>;

    // ── Required field validation ─────────────────────────────────
    if (!topic || typeof topic !== "string" || topic.trim() === "") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "topic is required and must be a non-empty string.",
      });
    }
    if (!subject || typeof subject !== "string") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "subject is required.",
      });
    }
    if (!gradeCategory || typeof gradeCategory !== "string") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "gradeCategory is required.",
      });
    }
    if (!gradeLevel || typeof gradeLevel !== "string") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "gradeLevel is required.",
      });
    }

    // ── Description length guard ──────────────────────────────────
    if (
      description !== undefined &&
      typeof description === "string" &&
      description.length > 500
    ) {
      return res.status(400).json({
        error: "DESCRIPTION_TOO_LONG",
        message: "Description must be under 500 characters.",
      });
    }

    // ── Sanitize optional fields ──────────────────────────────────
    const resolvedTypes: ActivityType[] =
      Array.isArray(activityTypes) && activityTypes.length > 0
        ? (activityTypes as ActivityType[]).slice(0, MAX_ACTIVITY_TYPES)
        : ["multiple_choice", "fill_in_blanks", "short_answer"];

    const resolvedCount =
      typeof questionCount === "number" && questionCount >= 1
        ? Math.min(questionCount, 30)
        : 10;

    const resolvedDifficulty: "easy" | "medium" | "hard" =
      difficulty === "easy" || difficulty === "hard" ? difficulty : "medium";

    // ── Generate ──────────────────────────────────────────────────
    const worksheet = await generateWorksheetFromText({
      topic: topic.trim(),
      description:
        typeof description === "string"
          ? description.trim() || undefined
          : undefined,
      subject: subject.trim(),
      cefrLevel:
        typeof cefrLevel === "string" && cefrLevel ? cefrLevel : undefined,
      gradeCategory: gradeCategory.trim(),
      gradeLevel: gradeLevel.trim(),
      teacherId: String((req as Request & { user: { _id: unknown } }).user._id),
      activityTypes: resolvedTypes,
      questionCount: resolvedCount,
      difficulty: resolvedDifficulty,
      language: typeof language === "string" ? language : "en",
      theme: typeof theme === "string" && theme ? theme : "default",
      customSelection: customSelection !== false,
    });

    // Persist to DB (non-blocking — generation result is returned even if save fails)
    WorksheetDocumentModel.create(worksheet).catch((dbErr: unknown) => {
      console.error("[worksheetTextRoute] DB save failed:", dbErr);
    });

    return res.status(201).json(worksheet);
  } catch (err: unknown) {
    const error = err as Record<string, unknown>;
    console.error("[worksheetTextRoute] Generation failed", {
      name: typeof error?.name === "string" ? error.name : "Error",
      status: typeof error?.status === "number" ? error.status : undefined,
    });

    // Handle Gemini rate limiting
    if (error?.status === 429) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        message: "Too many requests. Please wait 30 seconds and try again.",
      });
    }

    return res.status(500).json({
      error: "GENERATION_FAILED",
      message: "Worksheet generation failed. Please try again.",
    });
  }
  },
);

export default router;
