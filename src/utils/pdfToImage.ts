// src/utils/pdfToImage.ts
/// <reference lib="dom" />

import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "";

// Cache canvas module safely
let canvasModule: any = null;
let canvasLoadFailed = false;

function getCanvasModule() {
  if (canvasLoadFailed) return null;

  if (!canvasModule) {
    try {
      canvasModule = require("canvas");
    } catch (err) {
      canvasLoadFailed = true;
      console.error("[PDF] canvas module not available:", err);
      return null;
    }
  }

  return canvasModule;
}

export async function pdfFirstPageToJpeg(pdfBuffer: Buffer): Promise<Buffer> {
  const canvasLib = getCanvasModule();

  if (!canvasLib) {
    throw new Error(
      "CANVAS_UNAVAILABLE: PDF rendering is disabled because 'canvas' native module is missing or failed to load.",
    );
  }

  const { createCanvas } = canvasLib;

  const data = new Uint8Array(pdfBuffer);
  const pdfDocument = await pdfjsLib.getDocument({ data }).promise;

  const page = await pdfDocument.getPage(1);
  const scale = 2.0;
  const viewport = page.getViewport({ scale });

  const canvas = createCanvas(
    Math.floor(viewport.width),
    Math.floor(viewport.height),
  );

  const ctx = canvas.getContext("2d");

  await page.render({ canvasContext: ctx, viewport }).promise;

  return canvas.toBuffer("image/jpeg", { quality: 0.92 });
}