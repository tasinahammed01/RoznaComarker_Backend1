'use strict';
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const File = require('../models/File');

const VERSION = 'pdf-200dpi-v1';
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function failure(code, message, retryable = false) {
  return Object.assign(new Error(message), { code, safeMessage: message, retryable });
}
// One raster worker at a time per process. OCR pages are also processed serially.
let rasterQueue = Promise.resolve();
function rasterize(buffer) {
  const run = () => new Promise((resolve, reject) => {
    const worker = new Worker(path.join(__dirname, 'pdfSubmissionRaster.worker.js'), {
      workerData: { buffer }, resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    let done = false;
    const finish = (error, pages) => {
      if (done) return;
      done = true; clearTimeout(timer); void worker.terminate();
      if (error) reject(error); else resolve(pages.map(p => ({ ...p, buffer: Buffer.from(p.buffer) })));
    };
    const timer = setTimeout(() => finish(failure('OCR_PDF_TIMEOUT', 'PDF processing timed out. Please retry.', true)), 90000);
    worker.once('message', result => {
      if (!result.error) return finish(null, result.pages);
      const { name, status } = result.error;
      finish(name === 'PasswordException' ? failure('OCR_PDF_PASSWORD', 'This PDF is password protected. Please upload an unlocked copy.')
        : status === 413 ? failure('OCR_PDF_LIMIT', 'This PDF exceeds the supported page or image-size limit (maximum 20 pages).')
          : failure('OCR_PDF_INVALID', 'Unable to read this PDF. Please upload a valid, unlocked PDF.'));
    });
    worker.once('error', () => finish(failure('OCR_PDF_RASTER_FAILED', 'PDF pages could not be prepared. Please retry.', true)));
    worker.once('exit', () => { if (!done) finish(failure('OCR_PDF_RASTER_FAILED', 'PDF processing stopped. Please retry.', true)); });
  });
  let expired = false;
  let queueTimer;
  const queueDeadline = new Promise((_, reject) => {
    queueTimer = setTimeout(() => { expired = true;
      reject(failure('OCR_PDF_BUSY', 'PDF processing is busy. Please retry.', true));
    }, 120000);
  });
  const start = () => {
    clearTimeout(queueTimer);
    if (expired) throw failure('OCR_PDF_BUSY', 'PDF processing is busy. Please retry.', true);
    return run();
  };
  const pending = rasterQueue.then(start, start);
  rasterQueue = pending.catch(() => {});
  return Promise.race([pending, queueDeadline]).finally(() => clearTimeout(queueTimer));
}

async function preparePdfPages(absolutePath, sourceFile, options = {}) {
  const assertCurrent = async () => {
    if (options.isCurrentJob && !(await options.isCurrentJob())) throw failure('OCR_JOB_SUPERSEDED', 'This assessment has been replaced.');
  };
  await assertCurrent();
  const stat = await fs.stat(absolutePath);
  const configuredSize = Number(process.env.MAX_FILE_SIZE);
  const sizeLimit = Number.isFinite(configuredSize) && configuredSize > 0 ? configuredSize : 10 * 1024 * 1024;
  if (stat.size > sizeLimit) throw failure('OCR_PDF_TOO_LARGE', 'The PDF exceeds the upload size limit.');
  const buffer = await fs.readFile(absolutePath);
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw failure('OCR_PDF_INVALID', 'Unable to read this PDF. Its file signature is invalid.');
  const sourceHash = digest(buffer);
  const uploadsRoot = path.resolve(__dirname, '../..', process.env.UPLOAD_BASE_PATH || 'uploads');
  const directory = path.join(uploadsRoot, 'submissions');
  if (sourceFile?._id) {
    const cached = await File.find({ sourceFileId: sourceFile._id, sourceHash, rasterizationVersion: VERSION }).sort({ pageNumber: 1 }).lean();
    if (cached.length && cached.length === cached[0].sourcePageCount && cached.every((p, i) => p.pageNumber === i + 1)) {
      const pages = await Promise.all(cached.map(async p => {
        if (!/^[a-f0-9-]{36}\.jpg$/.test(p.filename)) return null;
        const bytes = await fs.readFile(path.join(directory, p.filename)).catch(() => null);
        return bytes && digest(bytes) === p.rasterHash ? { buffer: bytes, pageNumber: p.pageNumber, width: p.width, height: p.height,
          derivedImageFileId: p._id, pageImageUrl: p.url, rasterHash: p.rasterHash, rasterizationVersion: VERSION } : null;
      }));
      if (pages.every(Boolean)) return pages;
    }
  }
  const pages = await rasterize(buffer);
  await assertCurrent();
  if (!sourceFile?._id) return pages;
  await fs.mkdir(directory, { recursive: true });
  for (const page of pages) {
    await assertCurrent();
    const key = digest(`${sourceFile._id}:${sourceHash}:${VERSION}:${page.pageNumber}`);
    const filename = `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20, 32)}.jpg`;
    const destination = path.join(directory, filename);
    // A process kill can interrupt an atomic write before its finally handler.
    // Only expired temporary siblings of this deterministic derived asset are removed.
    const expiredBefore = Date.now() - 10 * 60 * 1000;
    for (const entry of await fs.readdir(directory)) {
      if (!entry.startsWith(filename + '.') || !/\.[a-f0-9-]{36}\.tmp$/.test(entry)) continue;
      const candidate = path.join(directory, entry);
      const metadata = await fs.stat(candidate).catch(() => null);
      if (metadata && metadata.mtimeMs < expiredBefore) await fs.unlink(candidate).catch(() => {});
    }
    const temporary = destination + '.' + crypto.randomUUID() + '.tmp';
    try { await fs.writeFile(temporary, page.buffer); await fs.rename(temporary, destination); }
    finally { await fs.unlink(temporary).catch(() => {}); }
    const _id = key.slice(0, 24);
    const url = `/files/submissions/${filename}`;
    const rasterHash = digest(page.buffer);
    try { await File.updateOne({ _id }, { $setOnInsert: { originalName: `PDF page ${page.pageNumber}.jpg`, filename,
      path: destination, url, uploadedBy: sourceFile.uploadedBy, role: sourceFile.role, type: 'submissions',
      sizeBytes: page.buffer.length, sourceFileId: sourceFile._id, sourceHash, sourcePageCount: pages.length,
      pageNumber: page.pageNumber, width: page.width, height: page.height, rasterHash, rasterizationVersion: VERSION } }, { upsert: true }); }
    catch (error) {
      if (error.code !== 11000 || !(await File.exists({ _id, sourceFileId: sourceFile._id, rasterHash }))) throw error;
    }
    Object.assign(page, { derivedImageFileId: _id, pageImageUrl: url, rasterHash, rasterizationVersion: VERSION });
  }
  return pages;
}
module.exports = { preparePdfPages, rasterize, VERSION, digest };
