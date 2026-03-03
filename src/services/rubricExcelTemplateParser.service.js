const XLSX = require('xlsx');

class RubricExcelTemplateError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'RubricExcelTemplateError';
    this.statusCode = statusCode;
  }
}

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function normalizeHeaderCell(v) {
  return safeString(v).trim().toLowerCase();
}

function parseScoreCell(v) {
  const n = typeof v === 'number' ? v : Number(safeString(v).trim());
  if (!Number.isFinite(n)) return null;
  return n;
}

function parseRubricDesignerFromExcelTemplate(params) {
  const buffer = params && params.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new RubricExcelTemplateError('Invalid Excel file: empty buffer', 400);
  }

  let wb;
  try {
    wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  } catch {
    throw new RubricExcelTemplateError('Invalid Excel file: failed to read workbook');
  }

  const sheetName = Array.isArray(wb.SheetNames) && wb.SheetNames.length ? wb.SheetNames[0] : null;
  if (!sheetName) {
    throw new RubricExcelTemplateError('Invalid Excel file: workbook has no sheets');
  }

  const ws = wb.Sheets[sheetName];
  if (!ws) {
    throw new RubricExcelTemplateError('Invalid Excel file: missing first worksheet');
  }

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' });
  const r1 = Array.isArray(rows) && rows.length >= 1 ? rows[0] : null;
  const r2 = Array.isArray(rows) && rows.length >= 2 ? rows[1] : null;

  if (!Array.isArray(r1) || !Array.isArray(r2)) {
    throw new RubricExcelTemplateError('Invalid rubric template: Row 1 and Row 2 must exist');
  }

  if (normalizeHeaderCell(r1[0]) !== 'criteria') {
    throw new RubricExcelTemplateError('Invalid rubric template: A1 must be "Criteria"');
  }

  if (normalizeHeaderCell(r2[0]) !== 'score') {
    throw new RubricExcelTemplateError('Invalid rubric template: A2 must be "Score"');
  }

  const levelTitles = r1.slice(1).map((x) => safeString(x).trim()).filter((x) => x.length > 0);
  if (!levelTitles.length) {
    throw new RubricExcelTemplateError('Invalid rubric template: Row 1 must contain level titles in columns B+');
  }

  const rawScores = r2.slice(1, 1 + levelTitles.length);
  if (rawScores.length !== levelTitles.length) {
    throw new RubricExcelTemplateError('Invalid rubric template: Row 2 must contain a score for each level title');
  }

  const levelScores = rawScores.map((x, idx) => {
    const n = parseScoreCell(x);
    if (n == null) {
      throw new RubricExcelTemplateError(`Invalid rubric template: score in column ${String.fromCharCode(66 + idx)}2 must be numeric`);
    }
    return n;
  });

  const levels = levelTitles.map((title, i) => ({ title, maxPoints: levelScores[i] }));

  const criteriaRows = [];
  for (let i = 2; i < rows.length; i += 1) {
    const row = Array.isArray(rows[i]) ? rows[i] : [];
    const title = safeString(row[0]).trim();
    if (!title) continue;

    const cells = [];
    for (let j = 0; j < levels.length; j += 1) {
      cells.push(safeString(row[1 + j]).trim());
    }

    criteriaRows.push({ title, cells });
  }

  if (!criteriaRows.length) {
    throw new RubricExcelTemplateError('Invalid rubric template: at least one criteria row is required (Row 3+)');
  }

  return {
    title: safeString(params && params.title).trim() || `Rubric: ${sheetName}`,
    levels,
    criteria: criteriaRows
  };
}

module.exports = {
  RubricExcelTemplateError,
  parseRubricDesignerFromExcelTemplate
};
