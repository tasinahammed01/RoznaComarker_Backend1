const path = require('path');

const mammoth = require('mammoth');
const xlsx = require('xlsx');

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function normalizeNewlines(text) {
  const raw = safeString(text);
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function getExtensionFromUploadedFile(file) {
  const name = safeString(file && file.originalname).toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return ext;
}

function isSupportedExtension(ext) {
  return ['.docx', '.xlsx', '.pdf'].includes(String(ext || '').toLowerCase());
}

async function extractTextFromDocxBuffer(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeNewlines(result && result.value ? result.value : '');
}

function extractTextFromXlsxBuffer(buffer) {
  const wb = xlsx.read(buffer, { type: 'buffer', cellDates: true });
  const lines = [];

  for (const sheetName of wb.SheetNames || []) {
    const ws = wb.Sheets[sheetName];
    if (!ws) continue;

    const rows = xlsx.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    lines.push(`# Sheet: ${sheetName}`);
    for (const row of rows || []) {
      if (!Array.isArray(row)) continue;
      const cleaned = row.map((c) => safeString(c).trim()).filter((x) => x.length);
      if (cleaned.length) {
        lines.push(cleaned.join(' | '));
      }
    }
    lines.push('');
  }

  return normalizeNewlines(lines.join('\n'));
}

async function extractTextFromPdfBuffer(buffer) {
  const pdfParse = require('pdf-parse');
  const result = await pdfParse(buffer);
  return normalizeNewlines(result && result.text ? result.text : '');
}

async function extractRubricTextFromUploadedFile(file) {
  const f = file && typeof file === 'object' ? file : null;
  if (!f || !f.buffer) {
    const err = new Error('file is required');
    err.statusCode = 400;
    throw err;
  }

  const ext = getExtensionFromUploadedFile(f);
  if (!isSupportedExtension(ext)) {
    const err = new Error('Unsupported file type. Only DOCX, XLSX, and PDF are allowed.');
    err.statusCode = 400;
    throw err;
  }

  try {
    if (ext === '.docx') {
      return await extractTextFromDocxBuffer(f.buffer);
    }
    if (ext === '.xlsx') {
      return extractTextFromXlsxBuffer(f.buffer);
    }
    if (ext === '.pdf') {
      return await extractTextFromPdfBuffer(f.buffer);
    }

    const err = new Error('Unsupported file type');
    err.statusCode = 400;
    throw err;
  } catch (e) {
    const msg = e && typeof e === 'object' && e.message ? String(e.message) : 'Failed to extract text from rubric file';
    const err = new Error(msg);
    err.statusCode = 422;
    throw err;
  }
}

module.exports = {
  extractRubricTextFromUploadedFile,
  getExtensionFromUploadedFile,
  isSupportedExtension
};
