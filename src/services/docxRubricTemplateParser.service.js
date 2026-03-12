const mammoth = require('mammoth');
const cheerio = require('cheerio');

class RubricDocxTemplateError extends Error {
  constructor(message, statusCode = 422) {
    super(message);
    this.name = 'RubricDocxTemplateError';
    this.statusCode = statusCode;
  }
}

function safeString(v) {
  return typeof v === 'string' ? v : (v == null ? '' : String(v));
}

function normalizeCellText(text) {
  const raw = safeString(text)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const lines = raw
    .split('\n')
    .map((l) => safeString(l).replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 0);
  return lines.join('\n').trim();
}

function looksNumericBand(s) {
  const t = normalizeCellText(s);
  if (!t) return false;
  if (/^\d+(?:\.\d+)?$/.test(t)) return true;
  if (/^\d+(?:\.\d+)?\s*(?:-|–|—|to)\s*\d+(?:\.\d+)?$/i.test(t)) return true;
  return false;
}

function inferLevelMaxPoints(levelTitles) {
  const parsed = levelTitles.map((t) => {
    const s = normalizeCellText(t);
    if (!s) return null;
    const m = s.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
    if (!m) return null;
    const n = Number(m[1]);
    return Number.isFinite(n) ? n : null;
  });

  const any = parsed.some((x) => x != null);
  if (!any) {
    return levelTitles.map((_, i) => i + 1);
  }

  return parsed.map((x, i) => {
    if (x == null) return i + 1;
    const rounded = Math.round(x);
    return Number.isFinite(rounded) ? Math.max(0, rounded) : i + 1;
  });
}

function extractTableMatrix($table, $) {
  const rows = [];
  const pendingRowSpans = []; // [{ col, remaining, text }]

  const trs = $table.find('tr').toArray();
  for (const tr of trs) {
    const out = [];

    // prefill any pending rowspans for this row
    for (let i = 0; i < pendingRowSpans.length; i += 1) {
      const p = pendingRowSpans[i];
      if (!p || p.remaining <= 0) continue;
      out[p.col] = p.text;
      p.remaining -= 1;
    }

    // remove completed rowspans
    for (let i = pendingRowSpans.length - 1; i >= 0; i -= 1) {
      const p = pendingRowSpans[i];
      if (!p || p.remaining <= 0) pendingRowSpans.splice(i, 1);
    }

    const tds = $(tr).find('th,td').toArray();
    let col = 0;
    for (const td of tds) {
      while (typeof out[col] !== 'undefined') col += 1;

      const $td = $(td);
      const text = normalizeCellText($td.text());
      const colspanRaw = $td.attr('colspan');
      const rowspanRaw = $td.attr('rowspan');
      const colspan = Math.max(1, Number(colspanRaw) || 1);
      const rowspan = Math.max(1, Number(rowspanRaw) || 1);

      for (let c = 0; c < colspan; c += 1) {
        out[col + c] = text;
        if (rowspan > 1) {
          pendingRowSpans.push({ col: col + c, remaining: rowspan - 1, text });
        }
      }

      col += colspan;
    }

    // trim trailing empties
    while (out.length && !normalizeCellText(out[out.length - 1])) out.pop();
    if (out.length) rows.push(out);
  }

  return rows;
}

function parseScoreLikeCell(text) {
  const s = normalizeCellText(text);
  if (!s) return null;
  // pick the last number in the cell (handles ranges like 0-2)
  const m = s.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.round(n));
}

function looksLikeScoreRow(row, levelCount) {
  const r = Array.isArray(row) ? row : [];
  if (r.length < 1 + Math.max(2, levelCount)) return false;
  const first = normalizeCellText(r[0]).toLowerCase();
  const isScoreLabel = first === 'score' || first === 'scores' || first === 'points';
  const scoreCells = r.slice(1).map(parseScoreLikeCell).filter((x) => x != null);
  if (isScoreLabel && scoreCells.length >= Math.min(levelCount, 2)) return true;
  // unlabeled score row: first cell empty + mostly numeric cells
  const firstEmpty = !normalizeCellText(r[0]);
  if (!firstEmpty) return false;
  return scoreCells.length >= Math.min(levelCount, 2);
}

function pickHeaderRowIndex(matrix) {
  if (!Array.isArray(matrix) || !matrix.length) return 0;

  for (let i = 0; i < Math.min(3, matrix.length); i += 1) {
    const row = matrix[i] || [];
    const first = normalizeCellText(row[0]).toLowerCase();
    if (first === 'criteria') return i;
    if (row.some((c) => normalizeCellText(c).toLowerCase() === 'criteria')) return i;
  }

  return 0;
}

function parseRubricDesignerFromDocxTemplate(params) {
  const buffer = params && params.buffer;
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new RubricDocxTemplateError('Invalid DOCX file: empty buffer', 400);
  }

  const title = normalizeCellText(params && params.title);

  return mammoth
    .convertToHtml({ buffer })
    .then(({ value }) => {
      const html = safeString(value);
      const $ = cheerio.load(html);

      const allCriteria = [];
      let levels = null;

      $('table').each((_, el) => {
        const matrix = extractTableMatrix($(el), $);
        if (!matrix.length) return;

        const maxCols = Math.max(...matrix.map((r) => (Array.isArray(r) ? r.length : 0)));
        if (maxCols < 3) return;

        const headerRowIdx = pickHeaderRowIndex(matrix);
        const headerRow = matrix[headerRowIdx] || [];
        const rawLevelTitles = headerRow.slice(1).map(normalizeCellText).filter((x) => x.length > 0);
        if (rawLevelTitles.length < 2) return;

        // detect a score row immediately below the header (if present)
        const nextRow = matrix[headerRowIdx + 1] || [];
        const hasScoreRow = looksLikeScoreRow(nextRow, rawLevelTitles.length);
        const scoreValues = hasScoreRow
          ? nextRow.slice(1, 1 + rawLevelTitles.length).map(parseScoreLikeCell)
          : null;

        if (!levels) {
          const inferredPoints = inferLevelMaxPoints(rawLevelTitles);
          levels = rawLevelTitles.map((t, i) => {
            const fromRow = Array.isArray(scoreValues) ? scoreValues[i] : null;
            const maxPoints = fromRow != null ? fromRow : inferredPoints[i];
            return { title: t, maxPoints };
          });
        }

        const startRow = hasScoreRow ? headerRowIdx + 2 : headerRowIdx + 1;
        for (let r = startRow; r < matrix.length; r += 1) {
          const row = matrix[r] || [];
          const critTitle = normalizeCellText(row[0]);
          if (!critTitle) continue;
          const low = critTitle.toLowerCase();
          if (low === 'score') continue;
          if (looksNumericBand(critTitle)) continue;

          const cells = [];
          for (let c = 0; c < levels.length; c += 1) {
            cells.push(normalizeCellText(row[1 + c]));
          }

          if (!cells.some((x) => x.length > 0)) continue;

          allCriteria.push({ title: critTitle, cells });
        }
      });

      if (!levels || !Array.isArray(levels) || levels.length < 2) {
        throw new RubricDocxTemplateError('Invalid rubric DOCX template: could not detect level columns. Please ensure the first row contains the rubric levels.', 422);
      }

      if (!allCriteria.length) {
        throw new RubricDocxTemplateError('Invalid rubric DOCX template: could not detect any criteria rows.', 422);
      }

      return {
        title: title || 'Rubric',
        levels,
        criteria: allCriteria
      };
    })
    .catch((err) => {
      if (err instanceof RubricDocxTemplateError) throw err;
      const msg = err && typeof err === 'object' ? safeString(err.message) : '';
      throw new RubricDocxTemplateError(msg || 'Invalid DOCX rubric template');
    });
}

module.exports = {
  RubricDocxTemplateError,
  parseRubricDesignerFromDocxTemplate
};
