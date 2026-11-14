'use strict';
// Teacher-only whole-assignment report and its AI summary. Ownership answers 404 (never 403) to anyone who is not the assignment's teacher.
// Clients only ever get a fixed message and code; logs carry ids and codes only.
const logger = require('../utils/logger');
const { loadAssignmentReport } = require('../services/assignmentReport.service');
const { generateAssignmentSummary } = require('../services/assignmentReportSummary.service');

const MESSAGES = {
  ASSIGNMENT_NOT_FOUND: 'Assignment not found',
  ASSIGNMENT_REPORT_UNSUPPORTED: 'Reports are available for essay assignments only',
  SUMMARY_DISABLED: 'Summaries are not available.',
  SUMMARY_NOT_ENOUGH_DATA: 'A summary needs at least 3 scored submissions.',
  SUMMARY_DAILY_LIMIT: 'The daily summary limit for this assignment has been reached. Please try again tomorrow.'
};
const KNOWN_STATUS = new Set([404, 409, 422, 429]);

function failed(req, res, error, event, code, message) {
  if (KNOWN_STATUS.has(error?.statusCode) && MESSAGES[error.code]) {
    return res.status(error.statusCode).json({ success: false, code: error.code, message: MESSAGES[error.code] });
  }
  logger.error({ event, code, assignmentId: String(req.params?.id || '').slice(0, 24),
    errorName: String(error?.name || 'Error').slice(0, 40), errorCode: error?.code ? String(error.code).slice(0, 40) : null });
  return res.status(500).json({ success: false, code, message });
}

async function getAssignmentReport(req, res) {
  try {
    const report = await loadAssignmentReport({ teacherId: req.user?._id, assignmentId: req.params.id, timeZone: req.query?.tz });
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, message: 'OK', data: report });
  } catch (error) {
    return failed(req, res, error, 'assignment_report_failed', 'ASSIGNMENT_REPORT_FAILED', 'The report could not be built. Please try again.');
  }
}

async function postAssignmentSummary(req, res) {
  try {
    const data = await generateAssignmentSummary({ teacherId: req.user?._id, assignmentId: req.params.id });
    res.set('Cache-Control', 'private, no-store');
    return res.status(200).json({ success: true, message: 'OK', data });
  } catch (error) {
    return failed(req, res, error, 'assignment_report_summary_failed', 'SUMMARY_FAILED', 'The summary could not be created. Please try again.');
  }
}

module.exports = { getAssignmentReport, postAssignmentSummary };
