const path = require('path');
const fs = require('fs');

const { ImageAnnotatorClient } = require('@google-cloud/vision');
const sizeOf = require('image-size');

const logger = require('../utils/logger');

function getBackendRootDir() {
  return path.resolve(__dirname, '..', '..');
}

function resolveCredentialsPathMaybe(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) return trimmed;

  const backendRoot = getBackendRootDir();
  const withoutDotSlash = trimmed.replace(/^\.[\\/]/, '');

  if (/^backend[\\/]/i.test(withoutDotSlash)) {
    return path.resolve(backendRoot, withoutDotSlash.replace(/^backend[\\/]/i, ''));
  }

  return path.resolve(backendRoot, trimmed);
}

function ensureGoogleCredentialsEnv() {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const resolved = resolveCredentialsPathMaybe(raw);
  if (!resolved) return null;

  if (!fs.existsSync(resolved)) {
    const backendRoot = getBackendRootDir();
    const fallback = path.resolve(backendRoot, 'key', 'vision_key.json');
    if (fs.existsSync(fallback)) {
      logger.warn({
        message: 'GOOGLE_APPLICATION_CREDENTIALS path invalid; using fallback backend/key/vision_key.json',
        configured: resolved,
        fallback
      });
      process.env.GOOGLE_APPLICATION_CREDENTIALS = fallback;
      return fallback;
    }

    throw new Error(
      `Google Vision credentials file not found at: ${resolved} (from GOOGLE_APPLICATION_CREDENTIALS=${JSON.stringify(raw)}). ` +
        'Fix GOOGLE_APPLICATION_CREDENTIALS. Recommended values: ./key/vision_key.json (backend-relative) ' +
        'or an absolute path to backend/key/vision_key.json.'
    );
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = resolved;
  return resolved;
}

/**
 * Google Vision client
 * Credentials are loaded automatically from:
 * process.env.GOOGLE_APPLICATION_CREDENTIALS
 */
const credentialsPath = ensureGoogleCredentialsEnv();
const visionClient = credentialsPath
  ? new ImageAnnotatorClient({ keyFilename: credentialsPath })
  : new ImageAnnotatorClient();

/* ------------------------- helpers ------------------------- */

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function bboxFromVertices(vertices, width, height) {
  const pts = Array.isArray(vertices) ? vertices : [];
  const xs = pts.map(v => Number(v && v.x)).filter(Number.isFinite);
  const ys = pts.map(v => Number(v && v.y)).filter(Number.isFinite);

  if (!xs.length || !ys.length) return null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  const x = clampPercent((minX / width) * 100);
  const y = clampPercent((minY / height) * 100);
  const w = clampPercent(((maxX - minX) / width) * 100);
  const h = clampPercent(((maxY - minY) / height) * 100);

  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function shouldInsertNewline(prevWord, currWord) {
  const pb = prevWord && prevWord.bbox;
  const cb = currWord && currWord.bbox;
  if (!pb || !cb) return false;

  const prevBottom = pb.y + pb.h;
  const currTop = cb.y;

  return currTop > prevBottom + pb.h * 0.6;
}

function buildTranscriptFromWords(words) {
  const list = Array.isArray(words)
    ? words.filter(w => w && typeof w.id === 'string')
    : [];

  let text = '';
  const spans = [];
  let prev = null;

  for (const w of list) {
    const wordText = typeof w.text === 'string' ? w.text.trim() : '';
    if (!wordText) continue;

    if (prev) {
      text += shouldInsertNewline(prev, w) ? '\n' : ' ';
    }

    const start = text.length;
    text += wordText;
    const end = text.length;

    spans.push({
      id: w.id,
      page: w.page,
      start,
      end,
      bbox: w.bbox
    });

    prev = w;
  }

  return { text, spans };
}

/* ------------------------- main OCR ------------------------- */

async function extractOcrFromImageFile(absoluteFilePath) {
  if (!absoluteFilePath || typeof absoluteFilePath !== 'string') {
    throw new Error('Missing file path');
  }

  if (!fs.existsSync(absoluteFilePath)) {
    throw new Error(`File not found: ${absoluteFilePath}`);
  }

  const ext = path.extname(absoluteFilePath).toLowerCase();
  if (ext === '.pdf') {
    throw new Error('PDF OCR requires async batch processing via GCS');
  }

  const dims = sizeOf(absoluteFilePath);
  const width = dims?.width;
  const height = dims?.height;

  if (!width || !height) {
    throw new Error('Unable to determine image dimensions');
  }

  let result;
  try {
    [result] = await visionClient.documentTextDetection({
      image: { source: { filename: absoluteFilePath } }
    });
  } catch (err) {
    logger.error({
      message: 'Google Vision OCR error',
      error: err?.message || err
    });
    throw err;
  }

  const annotation = result?.fullTextAnnotation || null;
  const pages = Array.isArray(annotation?.pages) ? annotation.pages : [];

  const words = [];
  const perPageCounters = new Map();

  for (let pIndex = 0; pIndex < pages.length; pIndex++) {
    const pageNumber = pIndex + 1;
    const page = pages[pIndex];

    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const word of para.words || []) {
          const text = (word.symbols || [])
            .map(s => s?.text || '')
            .join('')
            .trim();

          if (!text) continue;

          const bbox = bboxFromVertices(
            word.boundingBox?.vertices,
            width,
            height
          );
          if (!bbox) continue;

          const next = (perPageCounters.get(pageNumber) || 0) + 1;
          perPageCounters.set(pageNumber, next);

          words.push({
            id: `word_${pageNumber}_${next}`,
            page: pageNumber,
            text,
            bbox
          });
        }
      }
    }
  }

  const { text: transcriptText, spans } = buildTranscriptFromWords(words);

  return {
    fullText: annotation?.text || transcriptText,
    transcriptText,
    words,
    spans,
    pages: pages.length
      ? pages.map((_, idx) => ({
          pageNumber: idx + 1,
          width,
          height,
          words: words
            .filter(w => w.page === idx + 1)
            .map(w => ({ id: w.id, text: w.text, bbox: w.bbox })),
          lines: []
        }))
      : [
          {
            pageNumber: 1,
            width,
            height,
            words: words.map(w => ({
              id: w.id,
              text: w.text,
              bbox: w.bbox
            })),
            lines: []
          }
        ]
  };
}

/* ------------------------- exports ------------------------- */

module.exports = {
  extractOcrFromImageFile,
  buildTranscriptFromWords
};