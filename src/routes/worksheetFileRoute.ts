// src/routes/worksheetFileRoute.ts
// POST /api/worksheets/generate/file
// Accepts multipart/form-data with a PDF or image file, returns WorksheetDocument JSON.

import { Router, Request, Response } from "express";
import multer from "multer";
import { generateWorksheetFromFile } from "../services/worksheetFileService";
import { WorksheetDocumentModel } from "../models/WorksheetDocument";

const router = Router();

// Multer: memory storage, 10 MB max, strict MIME type allow-list
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = [
      "image/jpeg",
      "image/png",
      "image/webp",
      "application/pdf",
    ];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("UNSUPPORTED_FILE_TYPE"));
    }
  },
});

/**
 * POST /api/worksheets/generate/file
 * Content-Type: multipart/form-data
 *
 * Fields:
 *   file        File    required — PDF, JPG, PNG, or WEBP; max 10 MB
 *   teacherId   string  required
 *   gradeLevel  string  required
 *   topic       string  optional — AI detects from file when omitted
 *   subject     string  optional — AI detects from file when omitted
 */
router.post("/", upload.single("file"), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({
        error: "NO_FILE",
        message: "Please upload a PDF or image file (JPG, PNG, WEBP).",
      });
    }

    const { teacherId, gradeLevel, topic, subject } = req.body as Record<
      string,
      unknown
    >;

    if (!teacherId || typeof teacherId !== "string") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "teacherId is required.",
      });
    }

    if (!gradeLevel || typeof gradeLevel !== "string") {
      return res.status(400).json({
        error: "MISSING_FIELD",
        message: "gradeLevel is required.",
      });
    }

    const worksheet = await generateWorksheetFromFile({
      fileBuffer: req.file.buffer,
      mimeType: req.file.mimetype,
      topic:
        typeof topic === "string" && topic.trim() ? topic.trim() : undefined,
      subject:
        typeof subject === "string" && subject.trim()
          ? subject.trim()
          : undefined,
      gradeLevel: gradeLevel.trim(),
      teacherId: teacherId.trim(),
    });

    // Persist to DB (non-blocking — generation result is returned even if save fails)
    WorksheetDocumentModel.create(worksheet).catch((dbErr: unknown) => {
      console.error("[worksheetFileRoute] DB save failed:", dbErr);
    });

    return res.status(201).json(worksheet);
  } catch (err: unknown) {
    console.error("[worksheetFileRoute] Error:", err);

    const error = err as Record<string, unknown>;
    const message =
      typeof error?.message === "string" ? (error.message as string) : "";

    if (message.startsWith("PDF_RENDER_FAILED")) {
      return res.status(422).json({
        error: "PDF_RENDER_FAILED",
        message:
          "Could not read this PDF. Please try uploading an image instead.",
      });
    }

    if (message === "UNSUPPORTED_FILE_TYPE") {
      return res.status(415).json({
        error: "UNSUPPORTED_FILE_TYPE",
        message: "Only PDF, JPG, PNG, and WEBP files are supported.",
      });
    }

    if (error?.status === 429) {
      return res.status(429).json({
        error: "RATE_LIMIT",
        message: "Too many requests. Please wait 30 seconds and try again.",
      });
    }

    return res.status(500).json({
      error: "GENERATION_FAILED",
      message: message || "Worksheet generation failed. Please try again.",
    });
  }
});

export default router;
