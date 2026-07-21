'use strict';

const fs = require('fs');
const path = require('path');
const { renderSubmissionFeedbackReportHtml } = require('../pdf/submissionFeedbackReportTemplate');
const logger = require('../utils/logger');
const { ApiError } = require('../middlewares/error.middleware');
const browserManager = require('../services/pdfBrowserManager.service');
const { PDFDocument } = require('pdf-lib');

const positiveEnv = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
const timeout = (promise, ms, message) => new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new ApiError(504, message)), ms); Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); }); });

async function generateSubmissionFeedbackPdf(viewModel, outputPath, options = {}) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return browserManager.withRenderSlot(async (limits) => {
    const startedAt = Date.now(); let context; let page;
    const render = async () => {
      const htmlStartedAt = Date.now(); const html = renderSubmissionFeedbackReportHtml(viewModel); const htmlBytes = Buffer.byteLength(html);
      if (htmlBytes > positiveEnv('PDF_MAX_HTML_BYTES', 12 * 1024 * 1024)) throw new ApiError(413, 'The report is too large to render safely.');
      if (options.debugHtmlPath) await fs.promises.writeFile(options.debugHtmlPath, html, 'utf8');
      const browser = await browserManager.getBrowser(); context = await browser.createBrowserContext(); page = await context.newPage();
      await page.setRequestInterception(true); page.on('request', (request) => { const url = request.url(); if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) request.continue(); else request.abort(); });
      const contentStartedAt = Date.now(); await timeout(page.setContent(html, { waitUntil: 'load' }), limits.pageReadyTimeoutMs, 'PDF page setup timed out.');
      await timeout(page.waitForFunction(() => window.__REPORT_READY__ === true), limits.pageReadyTimeoutMs, 'PDF report readiness timed out.');
      const readyStartedAt = Date.now(); await timeout(page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode().catch(() => { image.removeAttribute('src'); image.alt = 'Submitted image unavailable'; }))); }), limits.imageLoadTimeoutMs, 'PDF image loading timed out.');
      if (options.abortSignal?.aborted) throw new ApiError(499, 'PDF request was cancelled.');
      const pdfStartedAt = Date.now(); await page.pdf({ path: outputPath, format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
        headerTemplate: '<div style="width:100%;margin:0 14mm;font:7pt Arial;color:#738392;border-bottom:1px solid #dfe6ea;padding-bottom:1mm"><b style="color:#087f83">ROZNAHUB</b> &nbsp;/&nbsp; Submission Feedback Report</div>',
        footerTemplate: '<div style="width:100%;margin:0 14mm;font:7pt Arial;color:#738392;border-top:1px solid #dfe6ea;padding-top:1mm;display:flex;justify-content:space-between"><span>Confidential academic feedback</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>' });
      const pdfBytes = await fs.promises.readFile(outputPath); const bytes = pdfBytes.length; const generatedPageCount = (await PDFDocument.load(pdfBytes)).getPageCount(); logger.metric({ event: 'pdf_render_completed', durationMs: Date.now() - startedAt, htmlMs: contentStartedAt - htmlStartedAt, setContentMs: readyStartedAt - contentStartedAt, readinessMs: pdfStartedAt - readyStartedAt, pdfMs: Date.now() - pdfStartedAt, submittedPageCount: viewModel.submittedPages.length, generatedPageCount, missingAssetCount: viewModel.submittedPages.filter((item) => !item.imageDataUrl).length, bytes }); return outputPath;
    };
    try { return await timeout(render(), limits.renderTimeoutMs, 'PDF generation timed out.'); }
    catch (error) { await fs.promises.unlink(outputPath).catch(() => {}); if (error.statusCode === 504) browserManager.recordTimeout(); logger.metric({ event: 'pdf_render_failed', durationMs: Date.now() - startedAt, statusCode: error.statusCode || 500 }); throw error; }
    finally { if (context) await context.close().catch(() => {}); else if (page) await page.close().catch(() => {}); }
  });
}

module.exports = { generateSubmissionFeedbackPdf };
