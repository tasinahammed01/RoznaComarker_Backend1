const path = require('path');
const fs = require('fs');

const File = require('../models/File');

const logger = require('../utils/logger');

const visionOcr = require('./visionOcr.service');

function toAbsoluteStoredPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  return path.join(__dirname, '..', '..', storedPath);
}

async function runOcrAndPersistForFiles({ fileIds, targetDoc }) {
  const ids = Array.isArray(fileIds) ? fileIds.filter(Boolean) : [];
  const first = ids.length ? ids[0] : null;
  if (!first) {
    return {
      ocrText: targetDoc && typeof targetDoc.ocrText === 'string' ? targetDoc.ocrText : '',
      ocrStatus: targetDoc && typeof targetDoc.ocrStatus === 'string' ? targetDoc.ocrStatus : 'pending'
    };
  }

  if (!targetDoc) {
    throw new Error('Missing target doc');
  }

  targetDoc.ocrStatus = 'pending';
  targetDoc.ocrError = undefined;
  targetDoc.ocrUpdatedAt = new Date();
  await targetDoc.save();

  const ocrPages = [];
  const perFileTexts = [];
  let legacyFirstOcrText = '';
  let legacyFirstOcrWords = [];

  let attempted = 0;
  let processed = 0;

  for (let i = 0; i < ids.length; i++) {
    const fileId = ids[i];
    if (!fileId) continue;

    attempted += 1;

    const fileDoc = await File.findById(fileId);
    if (!fileDoc || !fileDoc.path) {
      logger.warn({
        message: 'OCR skipped: file doc not found or missing path',
        fileId: String(fileId)
      });
      continue;
    }

    const absolute = toAbsoluteStoredPath(fileDoc.path);
    if (!absolute) {
      logger.warn({
        message: 'OCR skipped: invalid stored path',
        fileId: String(fileId),
        storedPath: fileDoc.path
      });
      continue;
    }

    if (!fs.existsSync(absolute)) {
      logger.error({
        message: 'OCR skipped: uploaded file not found on disk',
        fileId: String(fileId),
        storedPath: fileDoc.path,
        absolutePath: absolute,
        cwd: process.cwd()
      });
      continue;
    }

    const ocr = await visionOcr.extractOcrFromImageFile(absolute);
    const text = ocr && (ocr.transcriptText || ocr.fullText) ? String(ocr.transcriptText || ocr.fullText) : '';
    const words = toStoredOcrWords(ocr && Array.isArray(ocr.words) ? ocr.words : []);

    processed += 1;

    if (i === 0) {
      legacyFirstOcrText = text;
      legacyFirstOcrWords = words;
    }

    perFileTexts.push(text);

    const pages = (ocr && Array.isArray(ocr.pages) ? ocr.pages : [])
      .map((p) => {
        const pageNumber = typeof p?.pageNumber === 'number' ? p.pageNumber : Number(p?.pageNumber);
        const n = Number.isFinite(pageNumber) ? pageNumber : 1;

        const pageWords = Array.isArray(p?.words)
          ? p.words
              .map((w) => {
                const t = typeof w?.text === 'string' ? w.text : '';
                const bbox = w?.bbox && typeof w.bbox === 'object' ? w.bbox : null;
                if (!t || !bbox) return null;
                const x = Number(bbox.x);
                const y = Number(bbox.y);
                const ww = Number(bbox.w);
                const hh = Number(bbox.h);
                if (![x, y, ww, hh].every((v) => Number.isFinite(v))) return null;
                return {
                  text: t,
                  page: n,
                  bbox: {
                    x0: x,
                    y0: y,
                    x1: x + ww,
                    y1: y + hh
                  }
                };
              })
              .filter(Boolean)
          : [];

        return {
          fileId,
          pageNumber: n,
          text: text,
          words: pageWords
        };
      })
      .filter(Boolean);

    if (pages.length) {
      ocrPages.push(...pages);
    } else {
      ocrPages.push({
        fileId,
        pageNumber: 1,
        text,
        words
      });
    }
  }

  if (!processed || !ocrPages.length) {
    const msg =
      attempted && !processed
        ? 'OCR failed: uploaded file(s) not found on disk. Check UPLOAD_BASE_PATH, working directory, and filesystem permissions on the VPS.'
        : 'OCR failed: no OCR pages were produced. Check OCR credentials/dependencies and file validity.';

    logger.error({
      message: 'OCR failed for all uploaded files',
      attempted,
      processed,
      fileIds: ids.map((x) => String(x))
    });

    targetDoc.ocrStatus = 'failed';
    targetDoc.ocrError = msg;
    targetDoc.ocrUpdatedAt = new Date();
    await targetDoc.save();

    return {
      ocrText: targetDoc.ocrText || '',
      ocrStatus: targetDoc.ocrStatus,
      ocrError: targetDoc.ocrError
    };
  }

  targetDoc.ocrStatus = 'completed';
  targetDoc.ocrText = legacyFirstOcrText;
  targetDoc.ocrData = { words: legacyFirstOcrWords };
  targetDoc.ocrPages = ocrPages;
  targetDoc.combinedOcrText = perFileTexts
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
  targetDoc.ocrError = undefined;
  targetDoc.ocrUpdatedAt = new Date();
  await targetDoc.save();

  return {
    ocrText: targetDoc.ocrText,
    ocrStatus: targetDoc.ocrStatus
  };
}

function toStoredOcrWords(words) {
  const list = Array.isArray(words) ? words : [];
  return list
    .map((w) => {
      const text = typeof w.text === 'string' ? w.text : '';
      const page = typeof w.page === 'number' ? w.page : Number(w.page);
      const bbox = w && w.bbox && typeof w.bbox === 'object' ? w.bbox : null;
      if (!text || !Number.isFinite(page) || !bbox) return null;

      const x0 = Number(bbox.x);
      const y0 = Number(bbox.y);
      const wPct = Number(bbox.w);
      const hPct = Number(bbox.h);
      if (![x0, y0, wPct, hPct].every((n) => Number.isFinite(n))) return null;

      return {
        text,
        page,
        bbox: {
          x0,
          y0,
          x1: x0 + wPct,
          y1: y0 + hPct
        }
      };
    })
    .filter(Boolean);
}

async function runOcrAndPersist({ fileId, targetDoc }) {
  if (!fileId) {
    throw new Error('Missing file id');
  }
  if (!targetDoc) {
    throw new Error('Missing target doc');
  }

  targetDoc.ocrStatus = 'pending';
  targetDoc.ocrError = undefined;
  await targetDoc.save();

  try {
    const fileDoc = await File.findById(fileId);
    if (!fileDoc || !fileDoc.path) {
      throw new Error('File not found');
    }

    const absolute = toAbsoluteStoredPath(fileDoc.path);
    if (!absolute) {
      throw new Error('Invalid file path');
    }

    if (!fs.existsSync(absolute)) {
      throw new Error(`Uploaded file not found on disk at: ${absolute}`);
    }

    const ocr = await visionOcr.extractOcrFromImageFile(absolute);

    targetDoc.ocrStatus = 'completed';
    targetDoc.ocrText = ocr && (ocr.transcriptText || ocr.fullText) ? String(ocr.transcriptText || ocr.fullText) : '';
    targetDoc.ocrError = undefined;
    targetDoc.ocrUpdatedAt = new Date();

    targetDoc.ocrData = {
      words: toStoredOcrWords(ocr.words || [])
    };

    await targetDoc.save();

    return {
      ocrText: targetDoc.ocrText,
      ocrStatus: targetDoc.ocrStatus
    };
  } catch (err) {
    targetDoc.ocrStatus = 'failed';
    targetDoc.ocrError = err && err.message ? String(err.message) : 'OCR failed';
    targetDoc.ocrUpdatedAt = new Date();
    await targetDoc.save();

    return {
      ocrText: targetDoc.ocrText || '',
      ocrStatus: targetDoc.ocrStatus,
      ocrError: targetDoc.ocrError
    };
  }
}

module.exports = {
  runOcrAndPersist,
  runOcrAndPersistForFiles
};
