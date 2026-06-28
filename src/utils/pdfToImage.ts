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

// Custom CanvasFactory for Node.js compatibility with pdfjs-dist legacy build
class NodeCanvasFactory {
  private _canvas: any;

  constructor() {
    const canvasLib = getCanvasModule();
    if (!canvasLib) {
      throw new Error("canvas module not available");
    }
    this._canvas = canvasLib.createCanvas(0, 0);
  }

  create(width: number, height: number) {
    const canvasLib = getCanvasModule();
    if (!canvasLib) {
      throw new Error("canvas module not available");
    }
    const { createCanvas } = canvasLib;
    const canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    return { canvas, context };
  }

  reset(canvasAndContext: any, width: number, height: number) {
    canvasAndContext.canvas.width = width;
    canvasAndContext.canvas.height = height;
  }

  destroy(canvasAndContext: any) {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

export async function pdfFirstPageToJpeg(pdfBuffer: Buffer): Promise<Buffer> {
  const canvasLib = getCanvasModule();

  if (!canvasLib) {
    throw new Error(
      "CANVAS_UNAVAILABLE: PDF rendering is disabled because 'canvas' native module is missing or failed to load.",
    );
  }

  const data = new Uint8Array(pdfBuffer);
  const canvasFactory = new NodeCanvasFactory();
  const pdfDocument = await pdfjsLib.getDocument({ 
    data,
    canvasFactory: canvasFactory as any
  }).promise;

  const page = await pdfDocument.getPage(1);
  const scale = 2.0;
  const viewport = page.getViewport({ scale });

  const canvasAndContext = canvasFactory.create(
    Math.floor(viewport.width),
    Math.floor(viewport.height),
  );

  await page.render({ canvasContext: canvasAndContext.context, viewport }).promise;

  const buffer = canvasAndContext.canvas.toBuffer("image/jpeg", { quality: 0.92 });
  
  // Clean up
  canvasFactory.destroy(canvasAndContext);

  return buffer;
}