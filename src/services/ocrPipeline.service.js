const path = require('path');
const fs = require('fs');

const File = require('../models/File');
const Assignment = require('../models/assignment.model');

const logger = require('../utils/logger');

const visionOcr = require('./visionOcr.service');
const { normalizeOcrTranscript, buildCanonicalSubmissionTranscript,
  assessCanonicalTranscriptQuality } = require('../utils/ocrTranscriptNormalizer');
const canonicalCorrectionsPipeline = require('./canonicalCorrectionsPipeline.service');

function toAbsoluteStoredPath(storedPath) {
  if (!storedPath || typeof storedPath !== 'string') return null;
  const root = path.resolve(__dirname, '..', '..');
  const resolved = path.resolve(root, storedPath);
  return resolved === root || resolved.startsWith(`${root}${path.sep}`) ? resolved : null;
}

function safeOcrFailure(error, fallbackCode = 'OCR_PROVIDER_FAILED') {
  const code = typeof error?.code === 'string' && /^OCR_[A-Z0-9_]+$/u.test(error.code)
    ? error.code : fallbackCode;
  return { code, message: String(error?.safeMessage || 'OCR could not process this file.').slice(0, 300),
    retryable: error?.retryable === true };
}

async function runOcrAndPersistForFiles({ fileIds, targetDoc, jobId }) {
  const ocrStartedAt = Date.now();
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

  const ownership = { _id: targetDoc._id, ocrJobId: jobId,
    ...(targetDoc.analysisLeaseOwner ? { analysisLeaseOwner: targetDoc.analysisLeaseOwner } : {}) };
  const isCurrentJob = async () => !jobId || Boolean(await targetDoc.constructor.exists(ownership));
  const saveCurrentJob = async () => {
    if (!jobId) {
      await targetDoc.save();
      return true;
    }
    const values = targetDoc.toObject({ depopulate: true });
    delete values._id;
    delete values.__v;
    const persisted = await targetDoc.constructor.updateOne(
      ownership,
      { $set: values }
    );
    return persisted.modifiedCount === 1 || persisted.matchedCount === 1;
  };
  if (!(await isCurrentJob())) return { ocrStatus: 'superseded' };
  if (!jobId) {
    targetDoc.ocrStatus = 'pending';
    targetDoc.ocrError = undefined;
    targetDoc.ocrUpdatedAt = new Date();
    if (!(await saveCurrentJob())) return { ocrStatus: 'superseded' };
  }

  const attempted = ids.length;
  let reservedPages = 0;
  const reservePages = count => {
    reservedPages += count;
    if (reservedPages > 20) throw Object.assign(new Error('A submission supports at most 20 pages.'), {
      code: 'OCR_PDF_LIMIT', safeMessage: 'The submission exceeds the supported page limit (maximum 20 pages).'
    });
  };
  const processFile = async (fileId, fileOrder) => {

    const fileDoc = await File.findById(fileId);
    if (!fileDoc || !fileDoc.path) {
      logger.warn({
        message: 'OCR skipped: file doc not found or missing path',
        fileId: String(fileId)
      });
      return { ok: false, fileId, fileOrder, failure: {
        code: 'OCR_FILE_NOT_FOUND', message: 'The uploaded file record is unavailable.', retryable: false
      } };
    }

    const absolute = toAbsoluteStoredPath(fileDoc.path);
    if (!absolute) {
      logger.warn({
        message: 'OCR skipped: invalid stored path',
        fileId: String(fileId),
        storedPath: fileDoc.path
      });
      return { ok: false, fileId, fileOrder, failure: {
        code: 'OCR_FILE_NOT_FOUND', message: 'The uploaded file path is invalid.', retryable: false
      } };
    }

    if (!fs.existsSync(absolute)) {
      logger.error({
        message: 'OCR skipped: uploaded file not found on disk',
        fileId: String(fileId),
        storedPath: fileDoc.path
      });
      return { ok: false, fileId, fileOrder, failure: {
        code: 'OCR_FILE_NOT_FOUND', message: 'The uploaded file is unavailable on the server.', retryable: false
      } };
    }

    let ocr;
    try {
      ocr = await visionOcr.extractOcrFromImageFile(absolute, { sourceFile: fileDoc, isCurrentJob, reservePages });
    } catch (err) {
      const failure = safeOcrFailure(err);
      logger.error({
        message: 'OCR provider failed for uploaded file',
        fileId: String(fileId),
        errorCode: failure.code,
        retryable: failure.retryable
      });
      return { ok: false, fileId, fileOrder, failure: { ...failure, isPdf: path.extname(absolute).toLowerCase() === '.pdf' } };
    }
    const rawText = ocr && (ocr.fullText || ocr.transcriptText) ? String(ocr.fullText || ocr.transcriptText) : '';
    // Vision's native full text owns semantic reading order. Word geometry is
    // retained for annotation mapping and must never replace this text.
    const text = normalizeOcrTranscript(ocr && (ocr.fullText || ocr.transcriptText));
    const words = toStoredOcrWords(ocr && Array.isArray(ocr.words) ? ocr.words : []);

    const pages = (ocr && Array.isArray(ocr.pages) ? ocr.pages : [])
      .map((p, pageIndex) => {
        const pageNumber = typeof p?.pageNumber === 'number' ? p.pageNumber : Number(p?.pageNumber);
        const n = Number.isFinite(pageNumber) ? pageNumber : 1;

        let wordIndex = 0;
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
                wordIndex += 1;
                return {
                  id: `word_${String(fileId)}_${n}_${wordIndex}`,
                  text: t,
                  page: n,
                  paragraphIndex: Number.isFinite(Number(w?.paragraphIndex)) ? Number(w.paragraphIndex) : undefined,
                  confidence: Number.isFinite(Number(w?.confidence)) ? Number(w.confidence) : undefined,
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
          fileOrder,
          pageNumber: n,
          pageIndex,
          text: typeof p?.text === 'string' ? normalizeOcrTranscript(p.text) : text,
          rawText: typeof p?.rawText === 'string' ? p.rawText : rawText,
          width: p.width, height: p.height,
          derivedImageFileId: p.derivedImageFileId, pageImageUrl: p.pageImageUrl,
          rasterHash: p.rasterHash, rasterizationVersion: p.rasterizationVersion,
          words: pageWords
        };
      })
      .filter(Boolean);

    return { ok: true, fileId, fileOrder, text, rawText, words, pages: pages.length ? pages : [{
        fileId,
        fileOrder,
        pageNumber: 1,
        pageIndex: 0,
        text,
        rawText,
        words
      }] };
  };
  const results = new Array(ids.length);
  let nextFile = 0;
  await Promise.all(Array.from({ length: Math.min(2, ids.length) }, async () => {
    while (nextFile < ids.length) {
      const index = nextFile++;
      results[index] = await processFile(ids[index], index);
    }
  }));
  const completedResults = results.filter(result => result?.ok).sort((a, b) => a.fileOrder - b.fileOrder);
  const failures = results.filter(result => result && !result.ok).map(result => ({
    fileId: String(result.fileId), fileOrder: result.fileOrder, ...result.failure
  })).sort((a, b) => a.fileOrder - b.fileOrder);
  const processed = completedResults.length;
  const ocrPages = completedResults.flatMap((result) => result.pages)
    .sort((a, b) => a.fileOrder - b.fileOrder || a.pageIndex - b.pageIndex);
  const perFileTexts = completedResults.map((result) => result.text);
  const perFileRawTexts = completedResults.map((result) => result.rawText);
  const firstResult = completedResults.find((result) => result.fileOrder === 0);
  const legacyFirstOcrText = firstResult?.text || '';
  const legacyFirstRawOcrText = firstResult?.rawText || '';
  const legacyFirstOcrWords = firstResult?.words || [];

  if (!processed || !ocrPages.length || failures.some(failure => failure.isPdf || failure.code === 'OCR_PDF_LIMIT')) {
    const primaryFailure = failures[0] || { code: 'OCR_TEXT_EMPTY', message: 'OCR produced no readable text.' };
    const msg = primaryFailure.message;

    logger.error({
      message: 'OCR failed for all uploaded files',
      attempted,
      processed,
      fileIds: ids.map((x) => String(x))
    });

    if (!(await isCurrentJob())) return { ocrStatus: 'superseded' };
    targetDoc.ocrStatus = 'failed';
    targetDoc.ocrError = msg;
    targetDoc.ocrErrorCode = primaryFailure.code;
    targetDoc.ocrFailures = failures;
    targetDoc.ocrUpdatedAt = new Date();
    if (!(await saveCurrentJob())) return { ocrStatus: 'superseded' };

    return {
      ocrText: targetDoc.ocrText || '',
      ocrStatus: targetDoc.ocrStatus,
      ocrError: targetDoc.ocrError
    };
  }

  if (!(await isCurrentJob())) return { ocrStatus: 'superseded' };
  targetDoc.ocrText = legacyFirstOcrText;
  targetDoc.ocrErrorCode = undefined;
  targetDoc.ocrError = undefined;
  targetDoc.rawOcrText = legacyFirstRawOcrText;
  targetDoc.ocrData = { words: legacyFirstOcrWords };
  targetDoc.ocrPages = ocrPages;
  targetDoc.combinedOcrText = perFileTexts
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
  targetDoc.rawCombinedOcrText = perFileRawTexts
    .map((t) => (typeof t === 'string' ? t.trim() : ''))
    .filter(Boolean)
    .join('\n\n');
  targetDoc.ocrFailures = failures;
  const canonicalTranscript = buildCanonicalSubmissionTranscript(targetDoc);
  const transcriptQuality = assessCanonicalTranscriptQuality(canonicalTranscript);
  if (!transcriptQuality.reliable) {
    if (transcriptQuality.code === 'OCR_READING_ORDER_UNRELIABLE' && canonicalTranscript.text.trim()) {
      targetDoc.ocrStatus = 'completed';
      targetDoc.ocrErrorCode = 'OCR_LAYOUT_DEGRADED';
      targetDoc.ocrError = 'Transcription completed, but some image annotations may be unavailable.';
      targetDoc.ocrUpdatedAt = new Date();
      if (!(await saveCurrentJob())) return { ocrStatus: 'superseded' };
      logger.warn({ message: 'OCR annotation geometry degraded; authoritative text retained',
        submissionId: String(targetDoc._id), errorCode: 'OCR_LAYOUT_DEGRADED',
        pages: transcriptQuality.diagnostics });
    } else {
    targetDoc.ocrStatus = 'failed';
    targetDoc.ocrErrorCode = transcriptQuality.code || 'OCR_TEXT_EMPTY';
    targetDoc.ocrError = transcriptQuality.code === 'OCR_READING_ORDER_UNRELIABLE'
      ? 'OCR_READING_ORDER_UNRELIABLE: The photographed page reading order could not be verified. Please retry OCR or upload a clearer image.'
      : 'OCR failed to produce readable text. Please retry OCR or upload a clearer image.';
    targetDoc.ocrUpdatedAt = new Date();
    if (!(await saveCurrentJob())) return { ocrStatus: 'superseded' };
    logger.warn({ message: 'OCR transcript quality gate failed', submissionId: String(targetDoc._id),
      errorCode: transcriptQuality.code, pages: transcriptQuality.diagnostics.map((item) => ({
        fileId: item.fileId, pageNumber: item.pageNumber, mappedWords: item.mappedWords,
        totalWords: item.totalWords, alignmentRatio: item.alignmentRatio })) });
    return { ocrText: targetDoc.ocrText || '', ocrStatus: 'failed', ocrError: targetDoc.ocrError };
    }
  }
  targetDoc.ocrStatus = 'completed';
  if (!targetDoc.ocrErrorCode && failures.length) {
    targetDoc.ocrErrorCode = 'OCR_PARTIAL';
    targetDoc.ocrError = 'Transcription completed for some files; one or more files could not be read.';
  } else if (!targetDoc.ocrErrorCode) {
    targetDoc.ocrError = undefined;
  }
  targetDoc.ocrUpdatedAt = new Date();
  if (!(await saveCurrentJob())) return { ocrStatus: 'superseded' };
  logger.info({ message: 'Assessment pipeline timing', submissionId: String(targetDoc._id),
    stage: 'ocrReadyAt', timestamp: new Date().toISOString(), durationMs: Date.now() - ocrStartedAt,
    provider: 'google_vision', model: null, pageCount: ocrPages.length, fileCount: processed });
  try {
    const assignmentDoc = targetDoc.assignment ? await Assignment.findById(targetDoc.assignment).lean().catch(() => null) : null;
    await canonicalCorrectionsPipeline.generateAndPersist(targetDoc, { assignment: assignmentDoc ? {
      title: assignmentDoc.title || '', description: assignmentDoc.description || assignmentDoc.instructions || '',
      rubric: assignmentDoc.rubric || null, rubrics: assignmentDoc.rubrics || null
    } : {} });
  } catch (err) {
    logger.error({ message: 'Canonical correction generation failed after OCR', error: err?.message || err });
  }

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
        confidence: Number.isFinite(Number(w.confidence)) ? Number(w.confidence) : undefined,
        paragraphIndex: Number.isFinite(Number(w.paragraphIndex)) ? Number(w.paragraphIndex) : undefined,
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
  const ocrStartedAt = Date.now();
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
    targetDoc.rawOcrText = ocr && (ocr.fullText || ocr.transcriptText) ? String(ocr.fullText || ocr.transcriptText) : '';
    targetDoc.ocrText = normalizeOcrTranscript(ocr && (ocr.transcriptText || ocr.fullText));
    targetDoc.ocrError = undefined;
    targetDoc.ocrUpdatedAt = new Date();

    targetDoc.ocrData = {
      words: toStoredOcrWords(ocr.words || [])
    };

    await targetDoc.save();
    logger.info({ message: 'Assessment pipeline timing', submissionId: String(targetDoc._id),
      stage: 'ocrReadyAt', timestamp: new Date().toISOString(), durationMs: Date.now() - ocrStartedAt,
      provider: 'google_vision', model: null, pageCount: 1, fileCount: 1 });

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
