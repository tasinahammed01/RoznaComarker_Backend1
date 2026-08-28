'use strict';

const fs = require('fs');
const path = require('path');
const { PDFDocument } = require('pdf-lib');
const browserManager = require('../services/pdfBrowserManager.service');
const { renderStudentWorksheetResultHtml } = require('../pdf/studentWorksheetResultTemplate');
const { buildStudentWorksheetReportViewModel } = require('./worksheetPdfGenerator');
const { assertUniformA4Portrait } = require('./submissionFeedbackPdfGenerator');
const logger = require('../utils/logger');

function buildStudentWorksheetPdfViewModel(data) {
  const base = buildStudentWorksheetReportViewModel(data);
  const worksheet = data.worksheet || {};
  const sectionOrder = [...new Set(base.questions.map((question) => question.sectionId))];
  const instructionsBySection = {};
  if (Array.isArray(worksheet.activities) && worksheet.activities.length) {
    const typeMap = { ordering: 'activity1', dragDrop: 'activity1', sorting: 'activity1', classification: 'activity2', multipleChoice: 'activity3', fillBlanks: 'activity4', 'fill-blanks': 'activity4', matching: 'activity5', trueFalse: 'activity6', 'true-false': 'activity6' };
    worksheet.activities.forEach((activity) => { const id = typeMap[String(activity?.type || '')]; if (id) instructionsBySection[id] = activity.instructions || activity.data?.instructions || ''; });
  }
  for (let index = 1; index <= 6; index += 1) {
    const id = `activity${index}`;
    if (!instructionsBySection[id]) instructionsBySection[id] = worksheet[id]?.instructions || '';
  }
  const sections = sectionOrder.map((sectionId) => {
    const items = base.questions.filter((question) => question.sectionId === sectionId);
    const performance = base.sectionPerformance.find((item) => item.sectionId === sectionId);
    return { sectionId, type: items[0]?.type || '', title: items[0]?.section || '', instructions: instructionsBySection[sectionId], correct: performance?.correct ?? items.filter((item) => item.isCorrect).length, total: performance?.total ?? items.length, items };
  });
  return { ...base, description: String(worksheet.description || ''), sections, totalGradable: base.questions.length };
}

async function generateStudentWorksheetResultPdf(data, outputPath) {
  const model = buildStudentWorksheetPdfViewModel(data);
  if (model.possible > 0 && model.totalGradable === 0) throw new Error(`Student worksheet PDF mapping failed: expected ${model.possible} items but resolved 0.`);
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  return browserManager.withRenderSlot(async () => {
    const startedAt = Date.now();
    const browser = await browserManager.getBrowser();
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await page.setRequestInterception(true);
      page.on('request', (request) => request.url() === 'about:blank' || request.url().startsWith('data:') ? request.continue() : request.abort());
      const html = renderStudentWorksheetResultHtml(model);
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForSelector('[data-pdf-ready="true"]');
      await page.waitForFunction((count) => window.__REPORT_READY__ === true && document.querySelectorAll('[data-question-id]').length === count, {}, model.totalGradable);
      await page.evaluate(async () => { await document.fonts.ready; await Promise.all([...document.images].map((image) => image.decode().catch(() => {}))); });
      await page.pdf({ path: outputPath, format: 'A4', preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>', footerTemplate: '<div style="width:100%;margin:0 11mm;font:7pt Arial;color:#94a3b8;display:flex;justify-content:space-between"><span>Generated worksheet result</span><span>Page <span class="pageNumber"></span> / <span class="totalPages"></span></span></div>' });
      const bytes = await fs.promises.readFile(outputPath);
      const document = await PDFDocument.load(bytes);
      assertUniformA4Portrait(document);
      logger.metric({ event: 'student_worksheet_pdf_rendered', pageCount: document.getPageCount(), questionCount: model.totalGradable, durationMs: Date.now() - startedAt, bytes: bytes.length });
      return outputPath;
    } catch (error) {
      await fs.promises.unlink(outputPath).catch(() => {});
      throw error;
    } finally {
      await context.close().catch(() => {});
    }
  });
}

module.exports = { buildStudentWorksheetPdfViewModel, generateStudentWorksheetResultPdf };
