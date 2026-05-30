// src/routes/worksheetFileRoute.ts
// POST /api/worksheets/generate/file
// Accepts multipart/form-data with a PDF or image file, returns WorksheetDocument JSON.

import { Router, Request, Response } from "express";
import multer from "multer";
import { generateWorksheetFromFile } from "../services/worksheetFileService";
import { WorksheetDocumentModel } from "../models/WorksheetDocument";

const router = Router();

// ─────────────────────────────────────────────
// MULTER CONFIG
// ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
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

// ─────────────────────────────────────────────
// ROUTE
// ─────────────────────────────────────────────
router.post(
  "/",
  upload.single("file"),
  async (req: Request, res: Response) => {
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

      // ─────────────────────────────────────────────
      // MAIN WORKFLOW
      // ─────────────────────────────────────────────
      const worksheet = await generateWorksheetFromFile({
        fileBuffer: req.file.buffer,
        mimeType: req.file.mimetype,
        topic:
          typeof topic === "string" && topic.trim()
            ? topic.trim()
            : undefined,
        subject:
          typeof subject === "string" && subject.trim()
            ? subject.trim()
            : undefined,
        gradeLevel: gradeLevel.trim(),
        teacherId: teacherId.trim(),
      });

      // DB SAVE (non-blocking)
      WorksheetDocumentModel.create(worksheet).catch((dbErr: unknown) => {
        console.error("[worksheetFileRoute] DB save failed:", dbErr);
      });

      return res.status(201).json(worksheet);
    } catch (err: unknown) {
      console.error("[worksheetFileRoute] Error:", err);

      const error = err as Error & { status?: number };
      const message = error?.message || "";

      // ─────────────────────────────────────────────
      // FILE TYPE ERROR
      // ─────────────────────────────────────────────
      if (message === "UNSUPPORTED_FILE_TYPE") {
        return res.status(415).json({
          error: "UNSUPPORTED_FILE_TYPE",
          message:
            "Only PDF, JPG, PNG, and WEBP files are supported.",
        });
      }

      // ─────────────────────────────────────────────
      // PDF / CANVAS DEPENDENCY ERROR
      // ─────────────────────────────────────────────
      if (
        message.includes("CANVAS_UNAVAILABLE") ||
        message.includes("CANVAS_MODULE_MISSING") ||
        message.includes("PDF_TO_IMAGE_FAILED")
      ) {
        return res.status(503).json({
          error: "PDF_RENDER_SERVICE_UNAVAILABLE",
          message:
            "PDF processing is unavailable on the server. Please upload an image (JPG/PNG/WEBP) instead.",
        });
      }

      // ─────────────────────────────────────────────
      // PDF PARSING ERROR
      // ─────────────────────────────────────────────
      if (message.includes("PDF_RENDER_FAILED")) {
        return res.status(422).json({
          error: "PDF_RENDER_FAILED",
          message:
            "This PDF could not be processed. Please convert it to an image and try again.",
        });
      }

      // ─────────────────────────────────────────────
      // RATE LIMIT ERROR
      // ─────────────────────────────────────────────
      if (error?.status === 429) {
        return res.status(429).json({
          error: "RATE_LIMIT",
          message:
            "Too many requests. Please wait a moment and try again.",
        });
      }

      // ─────────────────────────────────────────────
      // GENERIC ERROR
      // ─────────────────────────────────────────────
      return res.status(500).json({
        error: "GENERATION_FAILED",
        message:
          message || "Worksheet generation failed. Please try again.",
      });
    }
  }
);

export default router;