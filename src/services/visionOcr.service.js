const path = require('path');
const fs = require('fs');

const { ImageAnnotatorClient } = require('@google-cloud/vision');
const sizeOf = require('image-size');

const logger = require('../utils/logger');

function getBackendRootDir() {
  return path.resolve(__dirname, '..', '..', '..');
}

function resolveCredentialsPathMaybe(rawPath) {
  if (!rawPath || typeof rawPath !== 'string') return null;
  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (path.isAbsolute(trimmed)) return trimmed;

  const backendRoot = getBackendRootDir();
  const cwdCandidate = path.resolve(process.cwd(), trimmed);
  const backendCandidate = path.resolve(backendRoot, trimmed);

  const candidates = [cwdCandidate, backendCandidate];

  const backendDirName = path.basename(backendRoot);
  if (backendDirName.toLowerCase() === 'backend' && /^backend[\\/]/i.test(trimmed)) {
    candidates.push(path.resolve(backendRoot, trimmed.replace(/^backend[\\/]/i, '')));
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return candidates[0] || null;
}

function ensureGoogleCredentialsEnv() {
  const isDev = process.env.NODE_ENV !== 'production';
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const abs = resolveCredentialsPathMaybe(raw);

  if (!abs) {
    if (!isDev) {
      throw new Error(
        'Google Vision credentials not configured. Set GOOGLE_APPLICATION_CREDENTIALS to your service-account JSON path.'
      );
    }

    return null;
  }

  if (!fs.existsSync(abs)) {
    throw new Error(
      `Google Vision credentials file not found at: ${abs}. ` +
        'Fix GOOGLE_APPLICATION_CREDENTIALS. Recommended values: ./key/roznaKey_vision_key.json (backend-relative) ' +
        'or an absolute path to backend/key/roznaKey_vision_key.json.'
    );
  }

  process.env.GOOGLE_APPLICATION_CREDENTIALS = abs;

  return abs;
}

function classifyVisionError(err) {
  const msg = err && err.message ? String(err.message) : '';
  if (msg.includes('Could not load the default credentials')) return 'credentials';
  if (msg.includes('credentials') && msg.includes('not configured')) return 'credentials';
  if (msg.includes('credentials file not found')) return 'credentials';
  if (msg.includes('PERMISSION_DENIED') || msg.includes('permission')) return 'credentials';
  return 'processing';
}

function createVisionClient(credentialsPath) {
  const isDev = process.env.NODE_ENV !== 'production';
  if (isDev && credentialsPath) {
    return new ImageAnnotatorClient({ keyFilename: credentialsPath });
  }
  return new ImageAnnotatorClient();
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function bboxFromVertices(vertices, width, height) {
  const pts = Array.isArray(vertices) ? vertices : [];
  const xs = pts.map((v) => Number(v && v.x)).filter((n) => Number.isFinite(n));
  const ys = pts.map((v) => Number(v && v.y)).filter((n) => Number.isFinite(n));
  if (!xs.length || !ys.length) return null;

  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }

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
  const list = Array.isArray(words) ? words.filter((w) => w && typeof w.id === 'string') : [];

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

async function extractOcrFromImageFile(absoluteFilePath) {
  if (!absoluteFilePath || typeof absoluteFilePath !== 'string') {
    throw new Error('Missing file path');
  }

  const ext = path.extname(absoluteFilePath).toLowerCase();
  if (ext === '.pdf') {
    throw new Error('PDF OCR is not supported without GCS async batch processing');
  }

  const credentialsPath = ensureGoogleCredentialsEnv();

  const dims = sizeOf(absoluteFilePath);
  const width = dims && typeof dims.width === 'number' ? dims.width : null;
  const height = dims && typeof dims.height === 'number' ? dims.height : null;

  if (!width || !height) {
    throw new Error('Unable to determine image dimensions');
  }

  const client = createVisionClient(credentialsPath);

  let result;
  try {
    [result] = await client.documentTextDetection({
      image: { source: { filename: absoluteFilePath } }
    });
  } catch (err) {
    const kind = classifyVisionError(err);
    if (kind === 'credentials') {
      logger.error({
        message: 'Google Vision credentials error',
        error: err && err.message ? err.message : err,
        credentialsPath: credentialsPath || null
      });
    } else {
      logger.error({
        message: 'Google Vision OCR processing error',
        error: err && err.message ? err.message : err
      });
    }
    throw err;
  }

  const annotation = result && result.fullTextAnnotation ? result.fullTextAnnotation : null;
  const pages = annotation && Array.isArray(annotation.pages) ? annotation.pages : [];

  const words = [];
  const perPageCounters = new Map();

  for (let pIndex = 0; pIndex < pages.length; pIndex += 1) {
    const pageNumber = pIndex + 1;
    const page = pages[pIndex];

    const blocks = page && Array.isArray(page.blocks) ? page.blocks : [];
    for (const b of blocks) {
      const paragraphs = b && Array.isArray(b.paragraphs) ? b.paragraphs : [];
      for (const para of paragraphs) {
        const ws = para && Array.isArray(para.words) ? para.words : [];
        for (const word of ws) {
          const symbols = word && Array.isArray(word.symbols) ? word.symbols : [];
          const text = symbols
            .map((s) => (s && typeof s.text === 'string' ? s.text : ''))
            .join('')
            .trim();

          if (!text) continue;

          const bb = bboxFromVertices(word.boundingBox && word.boundingBox.vertices, width, height);
          if (!bb) continue;

          const next = (perPageCounters.get(pageNumber) || 0) + 1;
          perPageCounters.set(pageNumber, next);

          const id = `word_${pageNumber}_${next}`;

          words.push({
            id,
            page: pageNumber,
            text,
            bbox: bb
          });
        }
      }
    }
  }

  const { text: transcriptText, spans } = buildTranscriptFromWords(words);

  return {
    fullText: annotation && typeof annotation.text === 'string' ? annotation.text : transcriptText,
    transcriptText,
    words,
    spans,
    pages: pages.length
      ? pages.map((_, idx) => {
          const pageNumber = idx + 1;
          return {
            pageNumber,
            width,
            height,
            words: words
              .filter((w) => w.page === pageNumber)
              .map((w) => ({ id: w.id, text: w.text, bbox: w.bbox })),
            lines: []
          };
        })
      : [
          {
            pageNumber: 1,
            width,
            height,
            words: words.map((w) => ({ id: w.id, text: w.text, bbox: w.bbox })),
            lines: []
          }
        ]
  };
}

module.exports = {
  extractOcrFromImageFile,
  buildTranscriptFromWords
};
