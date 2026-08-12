// src/routes/worksheetDocumentRoute.ts
// CRUD operations for the WorksheetDocument (Phase 1-4 format).
// Mounted at /api/worksheet-documents — separate from the legacy /api/worksheets.

import { Router, Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { WorksheetDocumentModel } from "../models/WorksheetDocument";

const router = Router();
const { verifyJwtToken } = require("../middlewares/jwtAuth.middleware");
const { requireRole } = require("../middlewares/role.middleware");

router.use(verifyJwtToken, requireRole("teacher"));

function teacherId(req: Request): string {
  return String((req as Request & { user: { _id: unknown } }).user._id);
}

function isUuid(value: unknown): boolean {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function invalidId(res: Response): Response | null {
  return res.status(400).json({ error: "INVALID_ID", message: "Invalid worksheet id." });
}

function editablePatch(body: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of ["version", "sourceFileUrl", "meta", "design", "sections", "answerKey"]) {
    if (Object.prototype.hasOwnProperty.call(body, key)) patch[key] = body[key];
  }
  return patch;
}

// ─── GET /   List all WorksheetDocuments for a teacher ──────────────────────
router.get("/", async (req: Request, res: Response) => {
  try {
    const subject = typeof req.query.subject === "string" ? req.query.subject.trim().slice(0, 100) : "";
    const page = typeof req.query.page === "string" ? req.query.page : "1";
    const limit = typeof req.query.limit === "string" ? req.query.limit : "20";

    const filter: Record<string, unknown> = { createdBy: teacherId(req) };
    if (subject) filter["meta.subject"] = subject;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.max(1, Math.min(50, parseInt(limit, 10) || 20));

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
    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to list worksheets." });
  }
});

// ─── GET /:id   Single worksheet ────────────────────────────────────────────
router.get("/:id", async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return invalidId(res);
    const worksheet = await WorksheetDocumentModel.findOne({ _id: req.params.id, createdBy: teacherId(req) }).lean();
    if (!worksheet) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json(worksheet);
  } catch (err: unknown) {
    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to fetch worksheet." });
  }
});

// ─── PUT /:id   Update worksheet (partial fields) ───────────────────────────
router.put("/:id", async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return invalidId(res);
    const updated = await WorksheetDocumentModel.findOneAndUpdate(
      { _id: req.params.id, createdBy: teacherId(req) },
      { $set: editablePatch(req.body as Record<string, unknown>) },
      { new: true, lean: true }
    );
    if (!updated) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json(updated);
  } catch (err: unknown) {
    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to update worksheet." });
  }
});

// ─── DELETE /:id   Remove worksheet ─────────────────────────────────────────
router.delete("/:id", async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return invalidId(res);
    const deleted = await WorksheetDocumentModel.findOneAndDelete({ _id: req.params.id, createdBy: teacherId(req) }).lean();
    if (!deleted) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }
    return res.json({ success: true, id: req.params.id });
  } catch (err: unknown) {
    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to delete worksheet." });
  }
});

// ─── POST /:id/duplicate   Copy with new ID and "(Copy)" title suffix ────────
router.post("/:id/duplicate", async (req: Request, res: Response) => {
  try {
    if (!isUuid(req.params.id)) return invalidId(res);
    const original = await WorksheetDocumentModel.findOne({ _id: req.params.id, createdBy: teacherId(req) }).lean();
    if (!original) {
      return res.status(404).json({ error: "NOT_FOUND", message: "Worksheet not found." });
    }

    const copy = {
      ...original,
      _id: uuidv4(),
      createdBy: teacherId(req),
      createdAt: new Date().toISOString(),
      meta: {
        ...(original.meta as Record<string, unknown>),
        title: `${(original.meta as { title: string }).title} (Copy)`,
      },
    };

    await WorksheetDocumentModel.create(copy);
    return res.status(201).json(copy);
  } catch (err: unknown) {
    return res.status(500).json({ error: "SERVER_ERROR", message: "Failed to duplicate worksheet." });
  }
});

export default router;
