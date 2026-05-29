// src/utils/pdfToImage.ts
// Renders the first page of a PDF buffer to a JPEG Buffer.
// Uses pdfjs-dist (v3 legacy CommonJS build) + node-canvas for server-side rendering.
/// <reference lib="dom" />

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import { createCanvas } from "canvas";

// Disable worker for Node.js — pdfjs runs everything in the main thread.
// This must be set before the first getDocument() call.
pdfjsLib.GlobalWorkerOptions.workerSrc = "";

/**
 * Renders the first page of a PDF buffer to a JPEG Buffer.
 * Scale 2.0 gives 2× resolution for better OCR and Vision API quality.
 */
export async function pdfFirstPageToJpeg(pdfBuffer: Buffer): Promise<Buffer> {
  try {
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
    throw new Error(
      `PDF_RENDER_FAILED: Could not render PDF page. Original error: ${msg}`,
    );
  }
}
