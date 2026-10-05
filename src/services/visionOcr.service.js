const path = require('path');

const fs = require('fs');



const { ImageAnnotatorClient } = require('@google-cloud/vision');

const sizeOf = require('image-size');



const logger = require('../utils/logger');
const { buildCanonicalPageFromWords } = require('../utils/ocrTranscriptNormalizer');


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

  const raw = process.env.GOOGLE_CLOUD_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;

  const resolved = resolveCredentialsPathMaybe(raw);

  if (!resolved) return null;



  if (!fs.existsSync(resolved)) {
    throw new Error(

      `Google Vision credentials file not found at: ${resolved}. ` +

        'Set GOOGLE_CLOUD_KEY_FILE to the Vision service-account JSON path.'

    );

  }



  return resolved;

}



/**

 * Google Vision client

 * Credentials are loaded automatically from:

 * process.env.GOOGLE_CLOUD_KEY_FILE (preferred) or GOOGLE_APPLICATION_CREDENTIALS

 */

let visionClient;

function getVisionClient() {
  if (visionClient) return visionClient;
  const credentialsPath = ensureGoogleCredentialsEnv();
  visionClient = credentialsPath
    ? new ImageAnnotatorClient({ keyFilename: credentialsPath })
    : new ImageAnnotatorClient();
  return visionClient;
}



/* ------------------------- helpers ------------------------- */



function clampPercent(value) {

  const n = Number(value);

  if (!Number.isFinite(n)) return 0;

  return Math.max(0, Math.min(100, n));

}



function bboxFromVertices(vertices, width, height) {

  const pts = Array.isArray(vertices) ? vertices : [];

  // Protobuf JSON omits scalar fields whose value is zero. Missing x/y on an
  // otherwise valid vertex therefore means coordinate 0, not an invalid box.
  const xs = pts.map(v => Number(v && v.x != null ? v.x : 0)).filter(Number.isFinite);

  const ys = pts.map(v => Number(v && v.y != null ? v.y : 0)).filter(Number.isFinite);



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



function buildTranscriptFromWords(words) {
  const list = Array.isArray(words)
    ? words.filter(w => w && typeof w.id === 'string')
    : [];
  const built = buildCanonicalPageFromWords(list);
  return {
    text: built.text,
    spans: built.spans.map(({ wordId, word, start, end }) => ({
      id: wordId,
      page: word.page,
      start,
      end,
      bbox: word.bbox
    }))
  };
}


/* ------------------------- main OCR ------------------------- */

class OcrProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'OcrProviderError';
    this.code = code;
    this.retryable = options.retryable === true;
    this.safeMessage = options.safeMessage || message;
    this.cause = options.cause;
  }
}

function classifyVisionError(error) {
  if (error instanceof OcrProviderError) return error;
  const status = Number(error?.code || error?.status || error?.statusCode);
  const message = String(error?.message || '').toLowerCase();
  if (status === 4 || status === 408 || status === 504 || /deadline|timed?\s*out|timeout/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_TIMEOUT', 'Google Vision OCR timed out.', {
      retryable: true, safeMessage: 'OCR provider timed out. Processing can be retried.', cause: error
    });
  }
  if (status === 8 || status === 429 || /quota|rate.?limit|resource exhausted/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_RATE_LIMITED', 'Google Vision OCR was rate limited.', {
      retryable: true, safeMessage: 'OCR provider is temporarily busy. Processing can be retried.', cause: error
    });
  }
  if ([7, 16, 401, 403].includes(status) || /credential|unauth|permission/.test(message)) {
    return new OcrProviderError('OCR_PROVIDER_AUTH', 'Google Vision OCR authentication failed.', {
      retryable: false, safeMessage: 'OCR service configuration is unavailable.', cause: error
    });
  }
  return new OcrProviderError('OCR_PROVIDER_FAILED', 'Google Vision OCR failed.', {
    retryable: status >= 500 || /network|econn|unavailable/.test(message),
    safeMessage: 'OCR provider could not process this file.', cause: error
  });
}

function requestTimeoutMs() {
  const configured = Number(process.env.GOOGLE_VISION_TIMEOUT_MS);
  return Number.isFinite(configured) && configured >= 1000 ? Math.min(configured, 120000) : 30000;
}

let activeRequests = 0;
const waitingRequests = [];
async function withOcrSlot(run) {
  if (activeRequests >= 2) await new Promise((resolve, reject) => {
    const ready = () => { clearTimeout(timer); resolve(); };
    const timer = setTimeout(() => {
      const index = waitingRequests.indexOf(ready);
      if (index >= 0) waitingRequests.splice(index, 1);
      reject(new OcrProviderError('OCR_PROVIDER_TIMEOUT', 'OCR queue timed out.', {
        retryable: true, safeMessage: 'OCR processing is busy. Please retry.'
      }));
    }, 30000);
    waitingRequests.push(ready);
  });
  else activeRequests += 1;
  try { return await run(); }
  finally {
    const next = waitingRequests.shift();
    if (next) next(); else activeRequests -= 1;
  }
}
async function detectDocument(image, dimensions, pageOffset = 0, pdfPage = false) {
  let result;
  try {
    [result] = await withOcrSlot(() => getVisionClient().documentTextDetection({ image }, {
      timeout: pdfPage ? Math.min(requestTimeoutMs(), 30000) : requestTimeoutMs(),
      ...(pdfPage ? { retry: null } : {})
    }));
  } catch (error) {
    throw classifyVisionError(error);
  }

  const annotation = result?.fullTextAnnotation || null;
  const pages = Array.isArray(annotation?.pages) ? annotation.pages : [];
  const words = [];
  const outputPages = [];
  let paragraphIndex = 0;
  for (let pIndex = 0; pIndex < Math.max(1, pages.length); pIndex += 1) {
    const page = pages[pIndex] || {};
    const pageNumber = pageOffset + pIndex + 1;
    const width = Number(page.width) || dimensions.width;
    const height = Number(page.height) || dimensions.height;
    let pageWordIndex = 0;
    const pageWords = [];
    for (const block of page.blocks || []) {
      for (const para of block.paragraphs || []) {
        paragraphIndex += 1;
        for (const word of para.words || []) {
          const text = (word.symbols || []).map(symbol => symbol?.text || '').join('').trim();
          if (!text) continue;
          const bbox = bboxFromVertices(word.boundingBox?.vertices, width, height);
          if (!bbox) continue;
          pageWordIndex += 1;
          const normalized = { id: `word_${pageNumber}_${pageWordIndex}`, page: pageNumber,
            paragraphIndex, text,
            confidence: Math.min(...(word.symbols || []).map(symbol => Number(symbol?.confidence)).filter(Number.isFinite), 1),
            bbox };
          words.push(normalized);
          pageWords.push(normalized);
        }
      }
    }
    outputPages.push({ pageNumber, width, height, words: pageWords.map(word => ({
      id: word.id, text: word.text, bbox: word.bbox, paragraphIndex: word.paragraphIndex, confidence: word.confidence
    })), lines: [] });
  }
  const { text: transcriptText, spans } = buildTranscriptFromWords(words);
  return { fullText: annotation?.text || transcriptText, transcriptText, words, spans, pages: outputPages };
}



async function extractOcrFromImageFile(absoluteFilePath, options = {}) {

  if (!absoluteFilePath || typeof absoluteFilePath !== 'string') {

    throw new Error('Missing file path');

  }



  if (!fs.existsSync(absoluteFilePath)) {

    throw new Error(`File not found: ${absoluteFilePath}`);

  }



  const ext = path.extname(absoluteFilePath).toLowerCase();

  if (ext === '.pdf') {

    let rasterized;
    try {
      rasterized = await require('./pdfSubmissionPages.service').preparePdfPages(absoluteFilePath, options.sourceFile, options);
    } catch (error) {
      if (error?.code?.startsWith('OCR_')) throw error;
      throw new OcrProviderError('OCR_UNSUPPORTED_FORMAT', 'PDF could not be rasterized for OCR.', {
        safeMessage: 'This PDF could not be read. It may be corrupt, protected, or too large.', cause: error
      });
    }
    options.reservePages?.(rasterized.length);
    const detectedPages = [];
    for (let index = 0; index < rasterized.length; index += 1) {
      if (options.isCurrentJob && !(await options.isCurrentJob())) {
        throw new OcrProviderError('OCR_JOB_SUPERSEDED', 'This assessment has been replaced.');
      }
      const page = rasterized[index];
      const detected = await detectDocument({ content: page.buffer }, {
        width: page.width, height: page.height
      }, index, true);
      // Each raster produces one canonical page, including blank pages. Never
      // copy the combined document text into every page's semantic transcript.
      const resultPage = detected.pages[0];
      Object.assign(resultPage, { text: detected.fullText, rawText: detected.fullText,
        width: page.width, height: page.height, derivedImageFileId: page.derivedImageFileId,
        pageImageUrl: page.pageImageUrl, rasterHash: page.rasterHash,
        rasterizationVersion: page.rasterizationVersion });
      detectedPages.push({ ...detected, pages: [resultPage] });
    }
    const pages = detectedPages.flatMap(result => result.pages);
    const words = detectedPages.flatMap(result => result.words);
    const fullText = detectedPages.map(result => result.fullText).filter(Boolean).join('\n\n');
    const transcriptText = detectedPages.map(result => result.transcriptText).filter(Boolean).join('\n\n');
    return { fullText, transcriptText, words, pages,
      spans: detectedPages.flatMap(result => result.spans || []) };

  }



  let dims;
  try { dims = sizeOf(absoluteFilePath); }
  catch (error) {
    throw new OcrProviderError('OCR_INVALID_IMAGE_DIMENSIONS', 'Unable to determine image dimensions.', {
      safeMessage: 'The uploaded image is corrupt or has unsupported dimensions.', cause: error
    });
  }

  const width = dims?.width;

  const height = dims?.height;



  if (!width || !height) {

    throw new OcrProviderError('OCR_INVALID_IMAGE_DIMENSIONS', 'Unable to determine image dimensions.', {
      safeMessage: 'The uploaded image is corrupt or has unsupported dimensions.'
    });

  }
  options.reservePages?.(1);
  return detectDocument({ source: { filename: absoluteFilePath } }, { width, height });

}



/* ------------------------- exports ------------------------- */



module.exports = {

  extractOcrFromImageFile,
  buildTranscriptFromWords,
  bboxFromVertices,
  classifyVisionError,
  OcrProviderError

};
