// src/utils/pdfToImage.ts
// Renders the first page of a PDF buffer to a JPEG Buffer.
// Uses pdfjs-dist (v3 legacy CommonJS build) + node-canvas for server-side rendering.
/// <reference lib="dom" />

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

// Disable worker for Node.js — pdfjs runs everything in the main thread.
// This must be set before the first getDocument() call.
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

// Lazy-load canvas to prevent server startup crash if native module is missing
let canvasModule: typeof import("canvas") | null = null;

function getCanvasModule() {
  if (canvasModule === null) {
    try {
      canvasModule = require("canvas");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `CANVAS_MODULE_MISSING: The 'canvas' native module is not installed or not built for this Node.js version/platform. Error: ${msg}`,
      );
    }
  }
  return canvasModule;
}

/**
 * Renders the first page of a PDF buffer to a JPEG Buffer.
 * Scale 2.0 gives 2× resolution for better OCR and Vision API quality.
 * @throws {Error} If canvas module is unavailable or PDF rendering fails
 */
export async function pdfFirstPageToJpeg(pdfBuffer: Buffer): Promise<Buffer> {
  try {
    // Lazy-load canvas only when function is called
    const { createCanvas } = getCanvasModule();

    const data = new Uint8Array(pdfBuffer);
    const pdfDocument = await pdfjsLib.getDocument({ data }).promise;

    const page = await pdfDocument.getPage(1);
    const scale = 2.0;
    const viewport = page.getViewport({ scale });

    const canvas = createCanvas(
      Math.floor(viewport.width),
      Math.floor(viewport.height),
    );
    // node-canvas context is structurally compatible with what pdfjs expects at
    // runtime; the cast bridges the type-system gap (no DOM lib in tsconfig).
    const ctx = canvas.getContext("2d") as unknown as CanvasRenderingContext2D;

    await page.render({ canvasContext: ctx, viewport }).promise;

    // Return as JPEG buffer (quality 0.92 ≈ high quality, reasonable file size)
    return canvas.toBuffer("image/jpeg", { quality: 0.92 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Preserve the original error type for proper error handling upstream
    if (msg.startsWith("CANVAS_MODULE_MISSING")) {
      throw new Error(msg);
    }
    throw new Error(
      `PDF_RENDER_FAILED: Could not render PDF page. Original error: ${msg}`,
    );
  }
}
