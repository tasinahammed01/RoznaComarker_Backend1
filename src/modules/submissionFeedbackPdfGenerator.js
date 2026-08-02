'use strict';

const fs = require('fs');
const path = require('path');
const { renderSubmissionFeedbackReportHtml } = require('../pdf/submissionFeedbackReportTemplate');
const logger = require('../utils/logger');
const { ApiError } = require('../middlewares/error.middleware');
const browserManager = require('../services/pdfBrowserManager.service');
const { PDFDocument } = require('pdf-lib');

const A4_PORTRAIT_POINTS = Object.freeze({ width: 595.28, height: 841.89 });
function assertUniformA4Portrait(pdfDocument, tolerance = 1) {
  for (const [index, page] of pdfDocument.getPages().entries()) {
    const size = page.getSize();
    const rotation = ((Number(page.getRotation()?.angle) || 0) % 360 + 360) % 360;
    if (Math.abs(size.width - A4_PORTRAIT_POINTS.width) > tolerance
      || Math.abs(size.height - A4_PORTRAIT_POINTS.height) > tolerance || rotation !== 0) {
      throw new ApiError(500, `Generated PDF page ${index + 1} is not A4 portrait.`);
    }
  }
}

const positiveEnv = (name, fallback) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback; };
const timeout = (promise, ms, message, onTimeout) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => { try { onTimeout?.(); } catch { /* best effort */ } reject(new ApiError(504, message)); }, ms);
  Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
});

async function generateSubmissionFeedbackPdf(viewModel, outputPath, options = {}) {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return browserManager.withRenderSlot(async (limits) => {
    const startedAt = Date.now(); let context; let page; let cancelled = false;
    const submittedPageCount = Array.isArray(viewModel?.submittedPages) ? viewModel.submittedPages.length : 0;
    const imageResourceCount = Array.isArray(viewModel?.submittedPages)
      ? viewModel.submittedPages.filter((item) => Boolean(item?.imageDataUrl)).length : 0;
    const stage = (name, stageStartedAt, extra = {}) => logger.metric({ event: 'pdf_render_stage', stage: name,
      elapsedMs: Date.now() - stageStartedAt, submittedPageCount, imageResourceCount, ...extra });
    const cancelRender = () => {
      if (cancelled) return; cancelled = true;
      if (context) void context.close().catch(() => {});
      else if (page) void page.close().catch(() => {});
    };
    const abortListener = () => cancelRender();
    options.abortSignal?.addEventListener('abort', abortListener, { once: true });
    const render = async () => {
      const htmlStartedAt = Date.now(); const htmlRenderer = typeof options.renderHtml === 'function'
        ? options.renderHtml : renderSubmissionFeedbackReportHtml;
      const html = htmlRenderer(viewModel); const htmlBytes = Buffer.byteLength(html);
      stage('html_generation', htmlStartedAt, { htmlCharacters: html.length });
      if (htmlBytes > positiveEnv('PDF_MAX_HTML_BYTES', 12 * 1024 * 1024)) throw new ApiError(413, 'The report is too large to render safely.');
      if (options.debugHtmlPath) await fs.promises.writeFile(options.debugHtmlPath, html, 'utf8');
      if (options.abortSignal?.aborted) throw new ApiError(499, 'PDF request was cancelled.');
      const browserStartedAt = Date.now(); const browser = await browserManager.getBrowser(); const browserAcquisitionMs = Date.now() - browserStartedAt;
      stage('browser_acquisition', browserStartedAt);
      const pageStartedAt = Date.now(); context = await browser.createBrowserContext(); page = await context.newPage();
      stage('new_page_creation', pageStartedAt);
      await page.setRequestInterception(true); page.on('request', (request) => { const url = request.url(); if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) request.continue(); else request.abort(); });
      const contentStartedAt = Date.now(); await timeout(page.setContent(html, { waitUntil: 'load' }), limits.pageReadyTimeoutMs, 'PDF page setup timed out.', cancelRender);
      const setContentMs = Date.now() - contentStartedAt;
      stage('page_set_content', contentStartedAt);
      const reportReadyStartedAt = Date.now(); await timeout(page.waitForFunction(() => window.__REPORT_READY__ === true), limits.pageReadyTimeoutMs, 'PDF report readiness timed out.', cancelRender);
      const reportReadyMs = Date.now() - reportReadyStartedAt;
      stage('application_page_ready', reportReadyStartedAt);
      const fontsStartedAt = Date.now(); await timeout(page.evaluate(async () => { await document.fonts.ready; }), limits.pageReadyTimeoutMs, 'PDF font loading timed out.', cancelRender);
      const fontReadinessMs = Date.now() - fontsStartedAt;
      stage('fonts_ready', fontsStartedAt);
      const imagesStartedAt = Date.now(); await timeout(page.evaluate(async () => { await Promise.all([...document.images].map((image) => image.decode().catch(() => { image.removeAttribute('src'); image.alt = 'Submitted image unavailable'; }))); }), limits.imageLoadTimeoutMs, 'PDF image loading timed out.', cancelRender);
      const imageDecodingMs = Date.now() - imagesStartedAt;
      stage('image_loading', imagesStartedAt);
      if (options.abortSignal?.aborted) throw new ApiError(499, 'PDF request was cancelled.');
      const pdfStartedAt = Date.now(); await timeout(page.pdf({ path: outputPath, format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true,
        headerTemplate: '<div style="width:100%;margin:0 14mm;font:7pt Arial;color:#738392;border-bottom:1px solid #dfe6ea;padding-bottom:1mm"><b style="color:#087f83">ROZNAHUB</b> &nbsp;/&nbsp; Submission Feedback Report</div>',
        footerTemplate: '<div style="width:100%;margin:0 14mm;font:7pt Arial;color:#738392;border-top:1px solid #dfe6ea;padding-top:1mm;display:flex;justify-content:space-between"><span>Confidential academic feedback</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>' }),
        limits.renderTimeoutMs, 'PDF document rendering timed out.', cancelRender);
      const pdfMs = Date.now() - pdfStartedAt;
      stage('page_pdf', pdfStartedAt);
      const pdfBytes = await fs.promises.readFile(outputPath); const bytes = pdfBytes.length; const renderedDocument = await PDFDocument.load(pdfBytes);
      assertUniformA4Portrait(renderedDocument); const generatedPageCount = renderedDocument.getPageCount();
      logger.metric({ event: 'pdf_render_completed', durationMs: Date.now() - startedAt,
        htmlBytes, htmlGenerationMs: contentStartedAt - htmlStartedAt, browserAcquisitionMs,
        setContentMs, reportReadyMs, fontReadinessMs, imageDecodingMs, pdfMs,
        submittedPageCount: viewModel.submittedPages.length, generatedPageCount,
        missingAssetCount: viewModel.submittedPages.filter((item) => !item.imageDataUrl).length, bytes,
        memoryRssBytes: process.memoryUsage().rss }); return outputPath;
    };
    try { return await timeout(render(), limits.renderTimeoutMs, 'PDF generation timed out.', cancelRender); }
    catch (error) { await fs.promises.unlink(outputPath).catch(() => {}); if (error.statusCode === 504) browserManager.recordTimeout(); logger.metric({ event: 'pdf_render_failed', durationMs: Date.now() - startedAt, statusCode: error.statusCode || 500 }); throw error; }
    finally {
      options.abortSignal?.removeEventListener('abort', abortListener);
      const closeStartedAt = Date.now();
      if (context) await context.close().catch(() => {}); else if (page) await page.close().catch(() => {});
      stage('page_context_close', closeStartedAt);
    }
  });
}

module.exports = { A4_PORTRAIT_POINTS, assertUniformA4Portrait, generateSubmissionFeedbackPdf };
