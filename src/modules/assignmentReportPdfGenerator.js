'use strict';
// Renders the assignment report HTML to an A4 PDF with the shared Puppeteer browser manager (same render slot, queue, limits and 503
// when busy as the feedback PDF) and the same cancel pattern: a timeout or a request abort closes the browser context and removes any
// partial output. Imports only; the feedback PDF generator and its fingerprinted files are not modified.
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { ApiError } = require('../middlewares/error.middleware');
const browserManager = require('../services/pdfBrowserManager.service');
const { PDFDocument } = require('pdf-lib');
const { assertUniformA4Portrait } = require('./submissionFeedbackPdfGenerator');

const positiveEnv = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
const cancellationError = () => new ApiError(499, 'PDF request was cancelled.');
const throwIfAborted = signal => { if (signal?.aborted) throw cancellationError(); };
const timeout = (promise, ms, message, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { try { onTimeout?.(); } catch { /* best effort */ } reject(new ApiError(504, message)); }, ms);
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

const HEADER = '<div style="width:100%;margin:0 12mm;font:7pt Arial;color:#738392;border-bottom:1px solid #dfe6ea;padding-bottom:1mm">'
  + '<b style="color:#087f83">RUBRILO</b> &nbsp;/&nbsp; Assignment Report</div>';
const FOOTER = '<div style="width:100%;margin:0 12mm;font:7pt Arial;color:#738392;border-top:1px solid #dfe6ea;padding-top:1mm;display:flex;justify-content:space-between">'
  + '<span>Rubrilo &middot; Teacher report, confidential</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>';

/** html -> outputPath (A4). Resolves { path, pageCount }; rejects with an ApiError (413 too large, 499 cancelled, 503 busy, 504 timeout). */
async function generateAssignmentReportPdf(html, outputPath, { abortSignal } = {}) {
  const htmlBytes = Buffer.byteLength(String(html || ''));
  if (htmlBytes > positiveEnv('PDF_MAX_HTML_BYTES', 12 * 1024 * 1024)) throw new ApiError(413, 'The report is too large to render safely.');
  throwIfAborted(abortSignal);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return browserManager.withRenderSlot(async (limits) => {
    const startedAt = Date.now(); let context; let page; let cancelled = false;
    const cancelRender = () => {
      if (cancelled) return; cancelled = true;
      if (context) void context.close().catch(() => {});
      else if (page) void page.close().catch(() => {});
    };
    const abortListener = () => cancelRender();
    abortSignal?.addEventListener('abort', abortListener, { once: true });
    const render = async () => {
      throwIfAborted(abortSignal);
      const browser = await browserManager.getBrowser();
      throwIfAborted(abortSignal);
      context = await browser.createBrowserContext(); page = await context.newPage();
      throwIfAborted(abortSignal);
      await page.setRequestInterception(true);
      page.on('request', (request) => { const url = request.url(); if (url === 'about:blank' || url.startsWith('data:')) request.continue(); else request.abort(); });
      await timeout(page.setContent(html, { waitUntil: 'load' }), limits.pageReadyTimeoutMs, 'PDF page setup timed out.', cancelRender);
      await timeout(page.waitForFunction(() => window.__REPORT_READY__ === true), limits.pageReadyTimeoutMs, 'PDF report readiness timed out.', cancelRender);
      await timeout(page.evaluate(async () => { await document.fonts.ready; }), limits.pageReadyTimeoutMs, 'PDF font loading timed out.', cancelRender);
      throwIfAborted(abortSignal);
      await timeout(page.pdf({ path: outputPath, format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
        headerTemplate: HEADER, footerTemplate: FOOTER }), limits.renderTimeoutMs, 'PDF document rendering timed out.', cancelRender);
      throwIfAborted(abortSignal);
      const rendered = await PDFDocument.load(await fs.promises.readFile(outputPath));
      assertUniformA4Portrait(rendered);
      const pageCount = rendered.getPageCount();
      logger.metric({ event: 'assignment_report_pdf_rendered', durationMs: Date.now() - startedAt, htmlBytes, pageCount });
      return { path: outputPath, pageCount };
    };
    try { return await timeout(render(), limits.renderTimeoutMs, 'PDF generation timed out.', cancelRender); }
    catch (error) {
      await fs.promises.unlink(outputPath).catch(() => {});
      const controlled = abortSignal?.aborted ? cancellationError() : error;
      if (controlled.statusCode === 504) browserManager.recordTimeout();
      throw controlled;
    } finally {
      abortSignal?.removeEventListener('abort', abortListener);
      if (context) await context.close().catch(() => {}); else if (page) await page.close().catch(() => {});
    }
  });
}

module.exports = { generateAssignmentReportPdf };
