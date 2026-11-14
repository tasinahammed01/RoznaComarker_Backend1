'use strict';
// GET /api/pdf/assignment-report/:id?tz= (teacher only). The data comes from the SAME loader as the JSON report (loadAssignmentReport:
// ownership 404, non-essay 409, tz validated with UTC fallback), so the PDF numbers equal the page numbers. Clients only ever get a
// fixed message and code, never an error's own message or stack; logs carry event, code and assignmentId only.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const logger = require('../utils/logger');
const { loadAssignmentReport } = require('../services/assignmentReport.service');
const { renderAssignmentReportHtml, reportPdfFilename } = require('../pdf/assignmentReportTemplate');

const RESPONSES = {
  ASSIGNMENT_NOT_FOUND: [404, 'Assignment not found'],
  ASSIGNMENT_REPORT_UNSUPPORTED: [409, 'Reports are available for essay assignments only'],
  PDF_BUSY: [503, 'The PDF service is busy. Please try again in a minute.'],
  PDF_ALREADY_RUNNING: [503, 'Your PDF is still being prepared. Please wait for it to finish.'],
  PDF_TIMEOUT: [504, 'Creating the PDF took too long. Please try again in a moment.'],
  PDF_TOO_LARGE: [413, 'This report is too large to export as a PDF.'],
  PDF_UNAVAILABLE: [501, 'PDF generation is not available in this environment.'],
  PDF_FAILED: [500, 'The PDF could not be created. Please try again.']
};
const RETRY_AFTER = { PDF_BUSY: '30', PDF_ALREADY_RUNNING: '15' };

function answer(res, code) {
  const [status, message] = RESPONSES[code] || RESPONSES.PDF_FAILED;
  if (RETRY_AFTER[code]) res.set('Retry-After', RETRY_AFTER[code]);
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ success: false, code: RESPONSES[code] ? code : 'PDF_FAILED', message });
}
const codeOf = error => {
  if (error?.code === 'ASSIGNMENT_NOT_FOUND' || error?.code === 'ASSIGNMENT_REPORT_UNSUPPORTED') return error.code;
  return ({ 503: 'PDF_BUSY', 504: 'PDF_TIMEOUT', 413: 'PDF_TOO_LARGE', 501: 'PDF_UNAVAILABLE' })[error?.statusCode] || 'PDF_FAILED';
};

// One running PDF per teacher (in this process). A second request while one renders answers 503 with Retry-After.
const running = new Set();
function onePdfPerTeacher(req, res, next) {
  const key = req.user?._id ? String(req.user._id) : null;
  if (!key) return next();
  if (running.has(key)) return answer(res, 'PDF_ALREADY_RUNNING');
  running.add(key);
  let released = false;
  const release = () => { if (!released) { released = true; running.delete(key); } };
  res.once('finish', release);
  res.once('close', release);
  return next();
}

async function downloadAssignmentReportPdf(req, res) {
  const assignmentId = String(req.params.id);
  const abortController = new AbortController();
  let budgetExpired = false;
  const budgetMs = (() => { const configured = Number(process.env.PDF_REQUEST_TIMEOUT_MS); return Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 55000; })();
  const budgetTimer = setTimeout(() => { budgetExpired = true; abortController.abort(); }, budgetMs);
  const abortRequest = () => abortController.abort();
  const abortClosedResponse = () => { if (!res.writableEnded) abortController.abort(); };
  req.once('aborted', abortRequest);
  res.once('close', abortClosedResponse);
  let outputPath = null;
  try {
    const report = await loadAssignmentReport({ teacherId: req.user?._id, assignmentId, timeZone: req.query?.tz });
    if (process.env.NODE_ENV === 'test' && process.env.ENABLE_TEST_PDF_HTTP !== 'true') return answer(res, 'PDF_UNAVAILABLE');
    const generatedAt = new Date();
    // The AI summary only when it is current (its fingerprint matches this data) and the feature is on; an out-of-date one never.
    const summary = report.summary && report.summary.enabled && report.summary.state === 'fresh' ? report.summary.current : null;
    const html = renderAssignmentReportHtml(report, { generatedAt, summary });
    const outputDir = path.join(os.tmpdir(), 'rubrilo-report-pdf');
    await fs.promises.mkdir(outputDir, { recursive: true, mode: 0o700 });
    outputPath = path.join(outputDir, `assignment-report-${crypto.randomUUID()}.pdf`);
    // Required here (not at load) so tests can replace the generator and the browser stays out of the JSON path.
    await require('../modules/assignmentReportPdfGenerator').generateAssignmentReportPdf(html, outputPath, { abortSignal: abortController.signal });
    const body = await fs.promises.readFile(outputPath);
    const filename = reportPdfFilename(report.assignment.title, generatedAt, report.timeZone);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"`, 'Content-Length': String(body.length),
      'Cache-Control': 'no-store', Pragma: 'no-cache', Expires: '0', 'X-Content-Type-Options': 'nosniff' });
    return res.status(200).end(body);
  } catch (error) {
    if (req.aborted || res.destroyed || (abortController.signal.aborted && !budgetExpired)) return undefined;   // the teacher left: nothing to send
    const code = budgetExpired ? 'PDF_TIMEOUT' : codeOf(error);
    if (code !== 'ASSIGNMENT_NOT_FOUND' && code !== 'ASSIGNMENT_REPORT_UNSUPPORTED') logger.warn({ event: 'assignment_report_pdf_failed', code, assignmentId });
    if (res.headersSent) return undefined;
    return answer(res, code);
  } finally {
    clearTimeout(budgetTimer);
    req.removeListener('aborted', abortRequest);
    res.removeListener('close', abortClosedResponse);
    if (outputPath) await fs.promises.unlink(outputPath).catch(() => {});
  }
}

module.exports = { downloadAssignmentReportPdf, onePdfPerTeacher, _test: { running, RESPONSES } };
