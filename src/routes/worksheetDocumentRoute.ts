// src/routes/worksheetDocumentRoute.ts
// CRUD operations for the WorksheetDocument (Phase 1-4 format).
// Mounted at /api/worksheet-documents — separate from the legacy /api/worksheets.

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { WorksheetDocumentModel } from "../models/WorksheetDocument";

const router = Router();

// ─── GET /   List all WorksheetDocuments for a teacher ──────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const { teacherId, subject, page = "1", limit = "20" } = req.query as Record<string, string>;

    if (!teacherId) {
      return res.status(400).json({ error: "MISSING_FIELD", message: "teacherId is required." });
    }

    const filter: Record<string, unknown> = { createdBy: teacherId };
    if (subject) filter["meta.subject"] = subject;

    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, parseInt(limit));

    const [worksheets, total] = await Promise.all([
      WorksheetDocumentModel.find(filter)
        .select("_id meta.title meta.subject meta.topic meta.gradeLevel meta.difficulty design.colorScheme createdAt source")
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .lean(),
      WorksheetDocumentModel.countDocuments(filter),
    ]);

    return res.json({ worksheets, total, page: pageNum, limit: limitNum });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

// ─── GET /:id   Single worksheet ────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    const worksheet = await WorksheetDocumentModel.findById(req.params.id).lean();
    if (!worksheet) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json(worksheet);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

// ─── PUT /:id   Update worksheet (partial fields) ───────────────────────────
router.put("/:id", async (req: Request, res: Response) => {
  try {
    const updated = await WorksheetDocumentModel.findByIdAndUpdate(
      req.params.id,
      { $set: req.body as Record<string, unknown> },
      { new: true, lean: true }
    );
    if (!updated) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json(updated);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

// ─── DELETE /:id   Remove worksheet ─────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    const deleted = await WorksheetDocumentModel.findByIdAndDelete(req.params.id).lean();
    if (!deleted) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json({ success: true, id: req.params.id });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

// ─── POST /:id/duplicate   Copy with new ID and "(Copy)" title suffix ────────
router.post("/:id/duplicate", async (req: Request, res: Response) => {
  try {
    const original = await WorksheetDocumentModel.findById(req.params.id).lean();
    if (!original) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }

    const copy = {
      ...original,
      _id: uuidv4(),
      createdAt: new Date().toISOString(),
      meta: {
        ...(original.meta as Record<string, unknown>),
        title: `${(original.meta as { title: string }).title} (Copy)`,
      },
    };

    await WorksheetDocumentModel.create(copy);
    return res.status(201).json(copy);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return res.status(500).json({ error: "SERVER_ERROR", message: msg });
  }
});

export default router;
