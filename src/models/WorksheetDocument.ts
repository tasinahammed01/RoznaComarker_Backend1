// src/models/WorksheetDocument.ts
// Mongoose model for the Phase-1 WorksheetDocument format.
// Stored in a separate "worksheetDocuments" collection to avoid conflicting
// with the existing "worksheets" collection (legacy Worksheet.js model).

import mongoose, { Schema } from "mongoose";

const WorksheetDocumentSchema = new Schema(
  {
    _id: { type: String, required: true },
    version: { type: String, default: "1.0" },
    createdAt: { type: String }, // ISO-8601 string produced by service
    createdBy: { type: String, required: true, index: true },
    source: {
      type: String,
      enum: ["text_prompt", "file_upload"],
      required: true,
    },
    sourceFileUrl: { type: String },

    meta: {
      title: { type: String, required: true },
      description: { type: String, maxlength: 500 }, // Phase 6
      subject: { type: String, index: true },
      topic: { type: String },
      gradeCategory: { type: String }, // Phase 6
      gradeLevel: { type: String },
      cefrLevel: { type: String }, // Phase 6
      estimatedMinutes: { type: Number },
      difficulty: { type: String, enum: ["easy", "medium", "hard"] },
      theme: { type: String, default: "default" }, // Phase 6
      activityTypes: { type: [String] }, // Phase 6 (renamed from questionTypes)
      tags: { type: [String], index: true },
      language: { type: String, default: "en" },
    },

    // Store design, sections, and answerKey as flexible Mixed to match the
    // WorksheetDocument union types without specifying every sub-field.
    design: { type: Schema.Types.Mixed },
    sections: { type: [Schema.Types.Mixed] },
    answerKey: { type: [Schema.Types.Mixed] },
  },
  {
    _id: false, // disable ObjectId auto-generation; we supply string UUID
    timestamps: false,
    collection: "worksheetDocuments",
  },
);

// Compound index for teacher dashboard list queries
WorksheetDocumentSchema.index({ createdBy: 1, createdAt: -1 });
WorksheetDocumentSchema.index({ "meta.subject": 1 });

export const WorksheetDocumentModel = mongoose.model(
  "WorksheetDocument",
  WorksheetDocumentSchema,
);
