const path = require('path');
const fs = require('fs');

const File = require('../models/File');

const visionOcr = require('./visionOcr.service');

function toAbsoluteStoredPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  return path.join(__dirname, '..', '..', storedPath);
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
  runOcrAndPersist
};
