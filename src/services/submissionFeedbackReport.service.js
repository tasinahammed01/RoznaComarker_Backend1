'use strict';

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { createCanvas } = require('canvas');
const { buildCanonicalSubmissionTranscript } = require('../utils/ocrTranscriptNormalizer');
const { buildSubmissionFeedbackReportViewModel } = require('../pdf/sample/submissionFeedbackReportViewModel');
const { resolveTeacherComments } = require('./teacherComments.service');
const { getOfficialCorrectionLegend } = require('./correctionLegendCatalog.service');
const { ApiError } = require('../middlewares/error.middleware');
const logger = require('../utils/logger');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf' };
const objectId = (value) => String(value?._id || value || '');
const limit = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
const PDF_ASSET_DEFAULTS = Object.freeze({ maxWidth: 1900, maxHeight: 2700, jpegQuality: 85,
  maxAssetBytes: 6 * 1024 * 1024, maxTotalEmbeddedBytes: 12 * 1024 * 1024 });
const abortError = () => new ApiError(499, 'PDF request was cancelled.');
const throwIfAborted = (signal) => { if (signal?.aborted) throw abortError(); };
const withTimeout = (promise, ms, message, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { try { onTimeout?.(); } catch { /* best effort */ } reject(new ApiError(504, message)); }, ms);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

function safeFilePath(file) {
  const uploadsRoot = path.resolve(__dirname, '..', '..', (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads');
  const raw = String(file?.path || '').trim(); if (!raw) return null;
  const candidate = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(__dirname, '..', '..', raw);
  if (!(candidate === uploadsRoot || candidate.startsWith(`${uploadsRoot}${path.sep}`))) return null;
  try { const realRoot = fs.realpathSync(uploadsRoot); const realCandidate = fs.realpathSync(candidate); return realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`) ? realCandidate : null; } catch { return null; }
}

function assetConfig() {
  return {
    maxWidth: limit('PDF_ASSET_MAX_WIDTH', PDF_ASSET_DEFAULTS.maxWidth),
    maxHeight: limit('PDF_ASSET_MAX_HEIGHT', PDF_ASSET_DEFAULTS.maxHeight),
    jpegQuality: Math.min(100, limit('PDF_ASSET_JPEG_QUALITY', PDF_ASSET_DEFAULTS.jpegQuality)),
    maxAssetBytes: limit('PDF_MAX_EMBEDDED_ASSET_BYTES', PDF_ASSET_DEFAULTS.maxAssetBytes),
    maxTotalEmbeddedBytes: limit('PDF_MAX_TOTAL_EMBEDDED_ASSET_BYTES', PDF_ASSET_DEFAULTS.maxTotalEmbeddedBytes)
  };
}

async function optimizeImageBuffer(buffer, options = {}) {
  const signal = options.signal; throwIfAborted(signal);
  const config = options.config || assetConfig();
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata(); throwIfAborted(signal);
  if ((metadata.width || 0) > limit('PDF_MAX_IMAGE_DIMENSION', 12000)
    || (metadata.height || 0) > limit('PDF_MAX_IMAGE_DIMENSION', 12000)) {
    throw new ApiError(413, 'An uploaded image exceeds the safe dimensions.');
  }
  const transformer = sharp(buffer, { failOn: 'error' }).rotate()
    .resize({ width: config.maxWidth, height: config.maxHeight, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: config.jpegQuality, progressive: true, mozjpeg: true, chromaSubsampling: '4:4:4' });
  const cancel = () => transformer.destroy(abortError());
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const { data, info } = await transformer.toBuffer({ resolveWithObject: true });
    throwIfAborted(signal);
    if (data.length > config.maxAssetBytes) throw new ApiError(413, 'A normalized report image remains too large.');
    return {
      buffer: data, mime: 'image/jpeg', width: info.width, height: info.height,
      sourceWidth: metadata.width || 0, sourceHeight: metadata.height || 0,
      sourceOrientation: metadata.orientation || 1,
      exifRotationApplied: Number(metadata.orientation || 1) !== 1
    };
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

async function rasterPdf(buffer, options = {}) {
  const signal = options.signal; const config = options.config || assetConfig();
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const document = await pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise; const pages = [];
  if (document.numPages > limit('PDF_MAX_UPLOADED_PAGES', 20)) throw new ApiError(413, 'The uploaded document contains too many pages for a report.');
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    throwIfAborted(signal);
    const page = await document.getPage(pageNumber); const viewport = page.getViewport({ scale: 1.6 }); const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    if (canvas.width > limit('PDF_MAX_IMAGE_DIMENSION', 12000) || canvas.height > limit('PDF_MAX_IMAGE_DIMENSION', 12000)) throw new ApiError(413, 'An uploaded page exceeds the safe image dimensions.');
    const renderTask = page.render({ canvasContext: canvas.getContext('2d'), viewport });
    const cancel = () => renderTask.cancel();
    signal?.addEventListener('abort', cancel, { once: true });
    try { await renderTask.promise; } finally { signal?.removeEventListener('abort', cancel); }
    const normalized = await optimizeImageBuffer(canvas.toBuffer('image/png'), { signal, config });
    pages.push({ pageNumber, ...normalized });
  }
  return pages;
}

async function resolvePersistedPageAssets(files, options = {}) {
  const signal = options.signal; const config = assetConfig(); const byPageKey = {}; const metadataByPageKey = {}; const metrics = [];
  let totalEmbeddedBytes = 0; let candidateCount = 0;
  const addAsset = ({ fileId, pageNumber, normalized, file, sourceBytes, sourceMime, durationMs }) => {
    const dataUrl = `data:${normalized.mime};base64,${normalized.buffer.toString('base64')}`;
    const embeddedBytes = Buffer.byteLength(dataUrl);
    if (totalEmbeddedBytes + embeddedBytes > config.maxTotalEmbeddedBytes) throw new ApiError(413, 'The submitted report images are too large to embed safely.');
    totalEmbeddedBytes += embeddedBytes;
    const key = `${fileId}:${pageNumber}`; byPageKey[key] = dataUrl;
    metadataByPageKey[key] = { width: normalized.width, height: normalized.height,
      sourceWidth: normalized.sourceWidth, sourceHeight: normalized.sourceHeight,
      fileName: file.originalName || file.filename, fileType: sourceMime };
    const metric = { fileId, pageNumber, originalMime: sourceMime, originalBytes: sourceBytes,
      originalWidth: normalized.sourceWidth, originalHeight: normalized.sourceHeight,
      exifRotationApplied: normalized.exifRotationApplied, normalizedMime: normalized.mime,
      normalizedWidth: normalized.width, normalizedHeight: normalized.height,
      normalizedBytes: normalized.buffer.length, dataUrlBytes: embeddedBytes, durationMs };
    metrics.push(metric);
    logger.metric({ event: 'pdf_asset_normalized', submissionId: options.submissionId || null, ...metric });
  };
  for (const file of files) {
    throwIfAborted(signal);
    const fileId = objectId(file); const safePath = safeFilePath(file); if (!fileId || !safePath) continue;
    let buffer; try { buffer = await fs.promises.readFile(safePath); } catch { continue; }
    if (buffer.length > limit('PDF_MAX_DECODED_ASSET_BYTES', 25 * 1024 * 1024)) throw new ApiError(413, 'An uploaded file is too large for report rendering.');
    const extension = path.extname(String(file.originalName || file.filename || safePath)).toLowerCase(); const mime = MIME[extension]; if (!mime) continue;
    candidateCount += 1;
    if (mime === 'application/pdf') {
      try {
        const startedAt = Date.now(); const pages = await rasterPdf(buffer, { signal, config });
        pages.forEach((page) => addAsset({ fileId, pageNumber: page.pageNumber, normalized: page,
          file, sourceBytes: buffer.length, sourceMime: mime, durationMs: Date.now() - startedAt }));
      } catch (error) { if (error instanceof ApiError) throw error; /* page-level fallback is intentional */ }
    } else {
      try {
        const startedAt = Date.now(); const normalized = await optimizeImageBuffer(buffer, { signal, config });
        addAsset({ fileId, pageNumber: 1, normalized, file, sourceBytes: buffer.length,
          sourceMime: mime, durationMs: Date.now() - startedAt });
      } catch (error) { if (error instanceof ApiError) throw error; /* page-level fallback is intentional */ }
    }
  }
  if (candidateCount && !Object.keys(byPageKey).length) throw new ApiError(422, 'Submitted images could not be prepared for the report.');
  return { byPageKey, metadataByPageKey, metrics, totalEmbeddedBytes };
}

function safeDiagnostics(submission, transcriptPages, corrections, submittedPages) {
  const groups = {};
  corrections.forEach((correction) => { const key = `${correction.source || 'UNKNOWN'}|${correction.category || 'UNKNOWN'}|${objectId(correction.fileId)}|${Number(correction.page || 1)}`; groups[key] = (groups[key] || 0) + 1; });
  return { uploadedFileIds: (submission.files || []).map(objectId), transcriptPages: transcriptPages.map((page) => ({ fileId: objectId(page.fileId), pageNumber: Number(page.pageNumber) })), correctionGroups: groups, withWordIds: corrections.filter((c) => Array.isArray(c.wordIds) && c.wordIds.length).length, withBboxList: corrections.filter((c) => Array.isArray(c.bboxList) && c.bboxList.length).length, withGlobalOffsets: corrections.filter((c) => Number.isFinite(Number(c.startChar)) && Number.isFinite(Number(c.endChar))).length, assignedPerPage: submittedPages.map((page) => ({ fileId: page.fileId, pageNumber: page.pageNumber, count: page.corrections.length })) };
}

async function buildPersistedSubmissionFeedbackReport({ submission, submissionFeedback, feedback, identity, generatedAt, abortSignal }) {
  const startedAt = Date.now(); const canonical = buildCanonicalSubmissionTranscript(submission); const normalizedAt = Date.now(); const files = Array.isArray(submission.files) && submission.files.length ? submission.files : submission.file ? [submission.file] : [];
  if (canonical.pages.length > limit('PDF_MAX_UPLOADED_PAGES', 20)) throw new ApiError(413, 'This submission contains too many pages for a single report.');
  if (canonical.text.length > limit('PDF_MAX_TRANSCRIPT_CHARACTERS', 1000000)) throw new ApiError(413, 'The submission transcript is too large for report rendering.');
  if (!canonical.pages.length && ['pending', 'processing'].includes(String(submission.ocrStatus || ''))) throw new ApiError(409, 'Submission OCR is still processing.');
  if (!canonical.pages.length) throw new ApiError(409, 'A canonical transcript is not available for this submission.');
  const persistedCorrections = Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [];
  if (!persistedCorrections.length && ['pending', 'processing'].includes(String(submission.correctionStatus || ''))) throw new ApiError(409, 'Submission corrections are still processing.');
  if (!persistedCorrections.length && submission.correctionStatus === 'failed') throw new ApiError(409, 'Submission correction analysis is unavailable.');
  const assetAbortController = new AbortController();
  const relayAbort = () => assetAbortController.abort();
  if (abortSignal?.aborted) relayAbort(); else abortSignal?.addEventListener('abort', relayAbort, { once: true });
  let assets;
  try {
    assets = await withTimeout(resolvePersistedPageAssets(files, {
      signal: assetAbortController.signal, submissionId: objectId(submission)
    }), limit('PDF_ASSET_TIMEOUT_MS', 30000), 'Submission asset preparation timed out.',
    () => assetAbortController.abort());
  } finally {
    abortSignal?.removeEventListener('abort', relayAbort);
  }
  const assetsAt = Date.now(); throwIfAborted(abortSignal);
  const transcriptPages = canonical.pages.map((page) => ({ ...page, ...(assets.metadataByPageKey[`${objectId(page.fileId)}:${Number(page.pageNumber)}`] || {}) }));
  const feedbackObject = submissionFeedback?.toObject ? submissionFeedback.toObject() : { ...(submissionFeedback || {}) }; const teacherObject = feedback?.toObject ? feedback.toObject() : { ...(feedback || {}) };
  const teacherComments = resolveTeacherComments({ submissionFeedback: feedbackObject, legacyFeedback: teacherObject });
  const vm = buildSubmissionFeedbackReportViewModel({ generatedAt, identity, legend: getOfficialCorrectionLegend(), submission: { ...(submission.toObject ? submission.toObject() : submission), files: files.map(objectId), canonicalText: canonical.text, transcriptPages, imageDataByPageKey: assets.byPageKey }, evaluation: { ...feedbackObject, status: submission.evaluationStatus }, feedback: { ...feedbackObject, teacherComments, overrideReason: teacherObject.overrideReason } });
  return { viewModel: vm, diagnostics: { ...safeDiagnostics(submission, transcriptPages, Array.isArray(submission.writingCorrections) ? submission.writingCorrections : [], vm.submittedPages), missingAssetCount: vm.submittedPages.filter((page) => !page.imageDataUrl).length,
    assetMetrics: assets.metrics, totalEmbeddedAssetBytes: assets.totalEmbeddedBytes },
    timings: { normalizationMs: normalizedAt - startedAt, assetResolutionMs: assetsAt - normalizedAt, viewModelMs: Date.now() - assetsAt, totalMs: Date.now() - startedAt } };
}

module.exports = { safeFilePath, resolvePersistedPageAssets, buildPersistedSubmissionFeedbackReport,
  _test: { rasterPdf, optimizeImageBuffer, assetConfig, throwIfAborted } };
