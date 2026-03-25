const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { fetch } = require('undici');
const sizeOf = require('image-size');

const STYLE = {
  colors: {
    headerFooter: '#666666',
    primary: '#1a73e8',
    success: '#2e7d32',
    warning: '#f57c00',
    error: '#d32f2f',
    neutral: '#333333',
    rule: '#D0D5DD',
    text: '#111827',
    cardBorder: '#E5E7EB',
    tableHeaderBg: '#F3F4F6',
    tableAltRowBg: '#FAFAFA',
    pageBg: '#FFFFFF'
  },
  fonts: {
    title: { name: 'Helvetica-Bold', size: 18 },
    sectionTitle: { name: 'Helvetica-Bold', size: 14 },
    body: { name: 'Helvetica', size: 10.5 },
    meta: { name: 'Helvetica', size: 9 },
    headerFooter: { name: 'Helvetica', size: 9 },
    mono: { name: 'Courier', size: 10.5 }
  },
  spacing: {
    sectionGap: 14,
    blockGap: 10,
    cardPadding: 12
  }
};

function renderScoreAndStatisticsRow(doc, { overallBlock, statRows }) {
  const pageX = doc.page.margins.left;
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const gap = 14;
  const cardW = Math.floor((pageW - gap) / 2);
  const cardH = 120;

  ensurePageSpace(doc, cardH + 12);
  const y = doc.y;

  const overallScoreText = safeText(overallBlock && overallBlock.overallText);
  const grade = safeText(overallBlock && overallBlock.gradeText) || 'N/A';
  const g = grade.toUpperCase();
  let accent = STYLE.colors.error;
  if (g === 'A') accent = STYLE.colors.success;
  else if (g === 'B' || g === 'C') accent = STYLE.colors.warning;

  const leftX = pageX;
  doc.save();
  doc.roundedRect(leftX, y, cardW, cardH, 12).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(leftX, y, 8, cardH).fill(accent);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.neutral).text('Overall Score', leftX + 16, y + 14, { width: cardW - 32 });
  doc.font('Helvetica-Bold').fontSize(32).fillColor(accent).text(g, leftX + 16, y + 42);
  doc.font('Helvetica-Bold').fontSize(16).fillColor(STYLE.colors.neutral).text(overallScoreText || 'N/A', leftX + 70, y + 56, { width: cardW - 86 });
  if (overallBlock && overallBlock.note) {
    doc.font(STYLE.fonts.meta.name).fontSize(STYLE.fonts.meta.size).fillColor(STYLE.colors.headerFooter).text(safeText(overallBlock.note), leftX + 16, y + 92, { width: cardW - 32 });
  }

  const rightX = leftX + cardW + gap;
  doc.save();
  doc.roundedRect(rightX, y, cardW, cardH, 12).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(rightX, y, 8, cardH).fill(STYLE.colors.primary);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.neutral).text('Correction Statistics', rightX + 16, y + 14, { width: cardW - 32 });

  const tableX = rightX + 16;
  const tableY = y + 38;
  const tableW = cardW - 32;
  const rows = Array.isArray(statRows) ? statRows.slice(0, 7) : [];
  const rowH = 16;

  doc.save();
  doc.rect(tableX, tableY, tableW, rowH).fill(STYLE.colors.tableHeaderBg);
  doc.rect(tableX, tableY, tableW, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(10).fillColor(STYLE.colors.neutral);
  doc.text('Category', tableX + 6, tableY + 4, { width: Math.floor(tableW * 0.68) - 12 });
  doc.text('Count', tableX + Math.floor(tableW * 0.68) + 6, tableY + 4, { width: Math.floor(tableW * 0.32) - 12 });

  doc.font(STYLE.fonts.body.name).fontSize(10).fillColor(STYLE.colors.text);
  for (let i = 0; i < rows.length; i += 1) {
    const ry = tableY + rowH + i * rowH;
    const fill = i % 2 === 0 ? '#FFFFFF' : STYLE.colors.tableAltRowBg;
    doc.save();
    doc.rect(tableX, ry, tableW, rowH).fill(fill);
    doc.rect(tableX, ry, tableW, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
    doc.restore();
    const colSplit = Math.floor(tableW * 0.68);
    doc.save();
    doc.moveTo(tableX + colSplit, ry).lineTo(tableX + colSplit, ry + rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
    doc.restore();
    doc.text(safeText(rows[i][0]), tableX + 6, ry + 4, { width: colSplit - 12 });
    doc.text(safeText(rows[i][1]), tableX + colSplit + 6, ry + 4, { width: tableW - colSplit - 12 });
  }

  doc.y = y + cardH + 12;
}

const CORRECTION_COLOR = {
  SP: '#d32f2f', // Spelling - red
  GR: '#f57c00', // Grammar - orange
  CK: '#1a73e8', // Other - blue
  ORGANIZATION: '#2e7d32', // green
  CONTENT: '#6a1b9a', // purple
  VOCABULARY: '#00695c', // teal
  MECHANICS: '#c62828' // red
};

function safeText(value) {
  const s = typeof value === 'string' ? value : (value == null ? '' : String(value));
  return s.trim();
}

function safeNumber(value, fallback = NaN) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function normalizeStringList(value, maxItems) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (const it of arr) {
    const t = safeText(it);
    if (!t) continue;
    out.push(t);
    if (typeof maxItems === 'number' && out.length >= maxItems) break;
  }
  return out;
}

function adaptCorrectionsToLocalText(localText, corrections, fullText) {
  const local = typeof localText === 'string' ? localText : '';
  const full = typeof fullText === 'string' ? fullText : '';
  const list = Array.isArray(corrections) ? corrections : [];

  if (!local.trim() || !list.length) return [];

  const out = [];
  let cursor = 0;
  for (const c of list) {
    const s = typeof c?.startChar === 'number' ? c.startChar : Number(c?.startChar);
    const e = typeof c?.endChar === 'number' ? c.endChar : Number(c?.endChar);
    const symbol = safeText(c?.symbol) || 'CK';
    const suggestedText = safeText(c?.suggestedText);
    const message = safeText(c?.message);

    const badText = (Number.isFinite(s) && Number.isFinite(e) && e > s && s >= 0 && e <= full.length)
      ? full.slice(s, e)
      : '';

    if (!badText) continue;

    const idx = local.indexOf(badText, cursor);
    if (idx < 0) continue;

    out.push({
      symbol,
      message,
      suggestedText,
      startChar: idx,
      endChar: idx + badText.length,
      word: badText
    });
    cursor = idx + badText.length;
  }

  return out;
}

function getUploadsRoot() {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.join(__dirname, '..', '..', basePath);
}

function extractUploadsPath(urlOrPath) {
  const raw = typeof urlOrPath === 'string' ? urlOrPath.trim() : '';
  if (!raw) return null;

  let pathname = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      pathname = new URL(raw).pathname;
    }
  } catch {
    pathname = raw;
  }

  // Keep it strict to avoid reading arbitrary paths.
  const m = String(pathname).match(/^\/uploads\/(assignments|submissions|feedback)\/([^/?#]+)$/i);
  if (!m) return null;
  return { folder: m[1].toLowerCase(), filename: m[2] };
}

async function tryReadUploadsFileBuffer(urlOrPath) {
  const parts = extractUploadsPath(urlOrPath);
  if (!parts) return null;

  const uploadsRoot = getUploadsRoot();
  const abs = path.join(uploadsRoot, parts.folder, parts.filename);
  try {
    const buf = await fs.promises.readFile(abs);
    return buf && buf.length ? buf : null;
  } catch {
    return null;
  }
}

async function tryFetchImageBuffer(urlOrPath) {
  const u = typeof urlOrPath === 'string' ? urlOrPath.trim() : '';
  if (!u) return null;

  if (/^https?:\/\//i.test(u)) {
    try {
      const res = await fetch(u);
      if (!res || !res.ok) return null;
      const ab = await res.arrayBuffer();
      const buf = Buffer.from(ab);
      return buf && buf.length ? buf : null;
    } catch {
      return null;
    }
  }

  return await tryReadUploadsFileBuffer(u);
}

function pickTeacherComments(feedback) {
  if (!feedback) return '';
  const tc = feedback.teacherComments;
  if (typeof tc === 'string' && tc.trim().length) return tc.trim();
  const tf = feedback.textFeedback;
  if (typeof tf === 'string' && tf.trim().length) return tf.trim();
  return '';
}

function buildRubricRows(submissionFeedbackOrFeedback) {
  const fb = submissionFeedbackOrFeedback && typeof submissionFeedbackOrFeedback === 'object' ? submissionFeedbackOrFeedback : {};

  // Preferred structure: SubmissionFeedback.rubricScores (CONTENT/ORGANIZATION/GRAMMAR/VOCABULARY/MECHANICS)
  const rubricScores = fb.rubricScores && typeof fb.rubricScores === 'object' ? fb.rubricScores : null;
  const rows = [];
  if (rubricScores) {
    const labels = {
      CONTENT: 'Content',
      ORGANIZATION: 'Organization',
      GRAMMAR: 'Grammar',
      VOCABULARY: 'Vocabulary',
      MECHANICS: 'Mechanics'
    };
    for (const [k, label] of Object.entries(labels)) {
      const item = rubricScores[k];
      const score = safeNumber(item && item.score, NaN);
      const maxScore = safeNumber(item && item.maxScore, NaN);
      if (!Number.isFinite(score)) continue;
      const max = Number.isFinite(maxScore) ? maxScore : 5;
      const comment = safeText(item && (item.comment || item.notes || item.feedback));
      rows.push({ criteria: label, score, maxScore: max, comment });
    }
  }
  return rows;
}

function getOverallScoreBlock({ feedback, submissionFeedback }) {
  const overall = safeNumber(submissionFeedback && submissionFeedback.overallScore, NaN);
  const grade = safeText(submissionFeedback && submissionFeedback.grade);
  if (Number.isFinite(overall)) {
    return {
      overallText: `${Math.round(overall * 10) / 10}/100`,
      gradeText: grade || 'N/A',
      note: 'From submission feedback'
    };
  }

  const score = safeNumber(feedback && feedback.score, NaN);
  const maxScore = safeNumber(feedback && feedback.maxScore, NaN);
  if (Number.isFinite(score) && Number.isFinite(maxScore) && maxScore > 0) {
    const pct = (score / maxScore) * 100;
    let letter = 'F';
    if (pct >= 90) letter = 'A';
    else if (pct >= 80) letter = 'B';
    else if (pct >= 70) letter = 'C';
    else if (pct >= 60) letter = 'D';
    return {
      overallText: `${Math.round(score * 10) / 10}/${Math.round(maxScore * 10) / 10}`,
      gradeText: letter,
      note: `Approx. ${Math.round(pct)}%`
    };
  }

  return {
    overallText: 'N/A',
    gradeText: 'N/A',
    note: ''
  };
}

function getHeaderFooterMetrics(doc) {
  // Reserve consistent vertical space for header/footer so content never overlaps.
  return {
    headerY: 18,
    headerRuleY: 36,
    footerRuleY: doc.page.height - doc.page.margins.bottom - 10,
    footerY: doc.page.height - doc.page.margins.bottom + 12
  };
}

function drawHeaderFooterForPage(doc, { title, pageNumber, totalPages }) {
  const { headerY, headerRuleY, footerRuleY, footerY } = getHeaderFooterMetrics(doc);

  doc.save();
  // Header (centered)
  doc.font(STYLE.fonts.headerFooter.name).fontSize(STYLE.fonts.headerFooter.size).fillColor(STYLE.colors.headerFooter);
  doc.text(title, 50, headerY, {
    width: doc.page.width - 100,
    align: 'center'
  });
  doc.moveTo(doc.page.margins.left, headerRuleY)
    .lineTo(doc.page.width - doc.page.margins.right, headerRuleY)
    .lineWidth(1)
    .strokeColor(STYLE.colors.rule)
    .stroke();

  // Footer (centered page number)
  const label = totalPages
    ? `Page ${pageNumber} of ${totalPages}`
    : `Page ${pageNumber}`;
  doc.moveTo(doc.page.margins.left, footerRuleY)
    .lineTo(doc.page.width - doc.page.margins.right, footerRuleY)
    .lineWidth(1)
    .strokeColor(STYLE.colors.rule)
    .stroke();
  doc.font(STYLE.fonts.headerFooter.name).fontSize(STYLE.fonts.headerFooter.size).fillColor(STYLE.colors.headerFooter);
  doc.text(label, 50, doc.page.height - 30, {
    width: doc.page.width - 100,
    align: 'center'
  });
  doc.restore();
}

function ensurePageSpace(doc, neededHeight) {
  const footerSafeY = doc.page.height - doc.page.margins.bottom - 24;
  if (doc.y + neededHeight > footerSafeY) {
    doc.addPage();
  }
}

function renderNumberedSectionTitle(doc, number, title) {
  ensurePageSpace(doc, 50);
  doc.moveDown(0.5);
  
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  const h = 28;
  
  // Light grey rounded background
  doc.save();
  doc.roundedRect(x, y, w, h, 8).fillAndStroke('#F3F4F6', STYLE.colors.cardBorder);
  doc.restore();
  
  // Number badge
  doc.save();
  doc.roundedRect(x + 8, y + 4, 20, 20, 4).fill(STYLE.colors.primary);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#FFFFFF');
  doc.text(String(number), x + 8, y + 7, { width: 20, align: 'center' });
  
  // Title text
  doc.font('Helvetica-Bold').fontSize(14).fillColor(STYLE.colors.neutral);
  doc.text(safeText(title), x + 36, y + 7, { width: w - 48 });
  
  doc.y = y + h + 10;
}

function renderText(doc, text, { fontName, fontSize, color, width } = {}) {
  doc.font(fontName || STYLE.fonts.body.name);
  doc.fontSize(fontSize || STYLE.fonts.body.size);
  doc.fillColor(color || STYLE.colors.text);
  doc.text(safeText(text), {
    width: width || (doc.page.width - doc.page.margins.left - doc.page.margins.right)
  });
}

function renderKeyValueRow(doc, key, value) {
  const k = safeText(key);
  const v = safeText(value);
  if (!k && !v) return;
  ensurePageSpace(doc, 16);
  doc.font('Helvetica-Bold')
    .fontSize(STYLE.fonts.body.size)
    .fillColor(STYLE.colors.neutral)
    .text(`${k}: `, { continued: true });
  doc.font(STYLE.fonts.body.name)
    .fontSize(STYLE.fonts.body.size)
    .fillColor(STYLE.colors.text)
    .text(v || '');
}

function renderCard(doc, title, items, color) {
  const list = Array.isArray(items) ? items : [];
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const padding = STYLE.spacing.cardPadding;

  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size);
  const bulletText = list.length
    ? list.map((t) => `- ${safeText(t)}`).filter(Boolean).join('\n')
    : 'No data available.';

  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size);
  const titleH = doc.heightOfString(safeText(title), { width: w - padding * 2 });
  const bodyH = doc.heightOfString(bulletText, { width: w - padding * 2 });
  const h = padding + titleH + 6 + bodyH + padding;

  ensurePageSpace(doc, h + 10);
  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, h, 10).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(x, y, 6, h).fill(color || STYLE.colors.primary);
  doc.restore();

  doc.font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(STYLE.colors.neutral)
    .text(safeText(title), x + padding + 6, y + padding, { width: w - padding * 2 - 6 });

  doc.font(STYLE.fonts.body.name)
    .fontSize(STYLE.fonts.body.size)
    .fillColor(STYLE.colors.text)
    .text(bulletText, x + padding + 6, y + padding + titleH + 6, { width: w - padding * 2 - 6 });

  doc.y = y + h + 10;
}

function buildNonOverlappingCorrections(text, corrections) {
  const t = typeof text === 'string' ? text : '';
  const list = Array.isArray(corrections) ? corrections : [];
  const usable = list
    .map((c) => {
      if (!c) return null;
      const s = typeof c.startChar === 'number' ? c.startChar : Number(c.startChar);
      const e = typeof c.endChar === 'number' ? c.endChar : Number(c.endChar);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
      if (s < 0 || e > t.length) return null;
      const replacement = safeText(c.suggestedText);
      const message = safeText(c.message);
      return { start: s, end: e, replacement, message };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const out = [];
  let cursor = 0;
  for (const c of usable) {
    if (c.start < cursor) continue;
    out.push(c);
    cursor = c.end;
  }
  return out;
}

function tokensFromTextAndCorrections(text, corrections) {
  const t = typeof text === 'string' ? text : '';
  const normalized = buildNonOverlappingCorrections(t, corrections);
  const out = [];
  let cursor = 0;

  for (const c of normalized) {
    if (c.start > cursor) {
      out.push({ text: t.slice(cursor, c.start), type: 'normal' });
    }

    const bad = t.slice(c.start, c.end);
    if (bad) {
      const type = safeText(c.symbol || c.type || 'CK') || 'CK';
      out.push({
        text: bad,
        type,
        suggestion: safeText(c.suggestedText || c.replacement || c.suggestion || '')
      });
    }
    cursor = c.end;
  }

  if (cursor < t.length) {
    out.push({ text: t.slice(cursor), type: 'normal' });
  }

  return out.filter((x) => x && typeof x.text === 'string' && x.text.length);
}

function renderTokensLineWrapped(doc, tokens, { width }) {
  const w = width || (doc.page.width - doc.page.margins.left - doc.page.margins.right);
  const list = Array.isArray(tokens) ? tokens : [];
  const startX = doc.x;
  const startY = doc.y;
  let x = startX;
  let y = startY;
  const lineHeight = STYLE.fonts.mono.size * 1.4;
  const spaceWidth = doc.widthOfString(' ');
  const badgeWidth = 22;
  const badgeHeight = 14;
  const bgPadding = 2;

  for (const token of list) {
    const type = safeText(token.type) || 'normal';
    const text = typeof token.text === 'string' ? token.text : '';

    if (!text) continue;

    if (type === 'normal') {
      doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size).fillColor('#000000');
      const words = text.split(/(\s+)/);
      for (const word of words) {
        if (!word) continue;
        const wordWidth = doc.widthOfString(word);
        if (x + wordWidth > startX + w && x > startX) {
          x = startX;
          y += lineHeight;
        }
        doc.text(word, x, y, { continued: false });
        x += wordWidth;
      }
      continue;
    }

    // Error token - draw with background, underline, and symbol badge
    const color = CORRECTION_COLOR[type] || STYLE.colors.primary;
    const words = text.split(/(\s+)/).filter(s => s && !/^\s+$/.test(s));

    for (const word of words) {
      if (!word) continue;

      doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size);
      const wordWidth = doc.widthOfString(word);
      const totalWidth = wordWidth + badgeWidth + spaceWidth * 2;

      // Check if we need to wrap to next line
      if (x + totalWidth > startX + w && x > startX) {
        x = startX;
        y += lineHeight;
      }

      // Draw background highlight
      doc.save();
      doc.fillColor(color + '33'); // Add transparency (20% opacity hex)
      doc.rect(x - bgPadding, y - bgPadding, wordWidth + bgPadding * 2, lineHeight).fill();
      doc.restore();

      // Draw underline
      doc.save();
      doc.strokeColor(color);
      doc.lineWidth(1);
      doc.moveTo(x, y + STYLE.fonts.mono.size + 1).lineTo(x + wordWidth, y + STYLE.fonts.mono.size + 1).stroke();
      doc.restore();

      // Draw the word text
      doc.fillColor('#000000');
      doc.text(word, x, y, { continued: false });

      // Draw symbol badge
      const badgeX = x + wordWidth + spaceWidth;
      doc.save();
      doc.roundedRect(badgeX, y + 1, badgeWidth, badgeHeight, 3).fillAndStroke(color, color);
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(8).fillColor('#FFFFFF');
      doc.text(type, badgeX, y + 3, { width: badgeWidth, align: 'center' });

      x += totalWidth;
    }
  }

  doc.x = startX;
  doc.y = y + lineHeight;
}

function renderScoreCard(doc, data) {
  const overallScore = safeNumber(data && data.overallScore, NaN);
  const grade = safeText(data && data.grade) || 'N/A';
  const scoreText = Number.isFinite(overallScore) ? `${Math.round(overallScore * 10) / 10} / 100` : 'N/A';

  const g = grade.toUpperCase();
  let accent = STYLE.colors.error;
  if (g === 'A') accent = STYLE.colors.success;
  else if (g === 'B' || g === 'C') accent = STYLE.colors.warning;

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const h = 90;

  ensurePageSpace(doc, h + 10);
  const y = doc.y;

  doc.save();
  doc.roundedRect(x, y, w, h, 12).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(x, y, 8, h).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.neutral).text('Overall Score', x + 18, y + 14);
  doc.font('Helvetica-Bold').fontSize(34).fillColor(accent).text(g, x + 18, y + 34, { continued: false });
  doc.font('Helvetica-Bold').fontSize(18).fillColor(STYLE.colors.neutral).text(scoreText, x + 70, y + 46);

  doc.y = y + h + 10;
}

function normalizeCorrections(issues) {
  const list = Array.isArray(issues) ? issues : [];
  return list
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const page = safeNumber(c.page, NaN);
      const category = safeText(c.category || c.groupLabel || c.groupKey);
      const message = safeText(c.message);
      const suggestedText = safeText(c.suggestedText);
      const symbol = safeText(c.symbol) || 'CK';
      const startChar = safeNumber(c.startChar, NaN);
      const endChar = safeNumber(c.endChar, NaN);
      return {
        page: Number.isFinite(page) ? page : 1,
        category: category || 'Quick Check',
        symbol,
        message,
        suggestedText,
        startChar: Number.isFinite(startChar) ? startChar : undefined,
        endChar: Number.isFinite(endChar) ? endChar : undefined
      };
    })
    .filter(Boolean);
}

function renderTable(doc, headers, rows, { columnWidths } = {}) {
  const safeHeaders = Array.isArray(headers) ? headers.map((h) => safeText(h)) : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const x = doc.page.margins.left;
  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const cols = safeHeaders.length;
  if (!cols) return;

  const widths = Array.isArray(columnWidths) && columnWidths.length === cols
    ? columnWidths
    : Array.from({ length: cols }).map(() => Math.floor(tableWidth / cols));
  const normalizedWidths = widths.map((w) => Math.max(60, Number(w) || 0));
  const totalW = normalizedWidths.reduce((a, b) => a + b, 0);
  const scale = totalW > tableWidth ? (tableWidth / totalW) : 1;
  const colW = normalizedWidths.map((w) => Math.floor(w * scale));

  const padX = 8;
  const padY = 6;
  const headerH = 22;

  ensurePageSpace(doc, headerH + 10);
  const headerY = doc.y;

  doc.save();
  doc.rect(x, headerY, tableWidth, headerH).fill(STYLE.colors.tableHeaderBg);
  doc.rect(x, headerY, tableWidth, headerH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral);
  let cx = x;
  for (let i = 0; i < cols; i += 1) {
    doc.text(safeHeaders[i], cx + padX, headerY + padY, { width: colW[i] - padX * 2 });
    cx += colW[i];
  }
  doc.y = headerY + headerH;

  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
  for (let r = 0; r < safeRows.length; r += 1) {
    const row = safeRows[r];
    const cells = Array.isArray(row) ? row : safeHeaders.map((h) => safeText(row && row[h]));

    const cellHeights = cells.map((cell, idx) => doc.heightOfString(safeText(cell), { width: colW[idx] - padX * 2 }));
    const rowH = Math.max(22, Math.max(...cellHeights) + padY * 2);
    ensurePageSpace(doc, rowH + 6);
    const y = doc.y;

    const fill = r % 2 === 0 ? '#FFFFFF' : STYLE.colors.tableAltRowBg;
    doc.save();
    doc.rect(x, y, tableWidth, rowH).fill(fill);
    doc.rect(x, y, tableWidth, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();

    let xLine = x;
    for (let i = 1; i < cols; i += 1) {
      xLine += colW[i - 1];
      doc.moveTo(xLine, y).lineTo(xLine, y + rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
    }
    doc.restore();

    let xText = x;
    for (let i = 0; i < cols; i += 1) {
      doc.fillColor(STYLE.colors.text);
      doc.text(safeText(cells[i]), xText + padX, y + padY, { width: colW[i] - padX * 2 });
      xText += colW[i];
    }

    doc.y = y + rowH;
  }

  doc.moveDown(0.8);
}

async function renderImageSection(doc, image, index) {
  const urlOrPath = safeText(image && (image.url || image.path || image.imageUrl));
  
  if (!urlOrPath) {
    ensurePageSpace(doc, 30);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.headerFooter);
    doc.text('Image unavailable.');
    doc.moveDown(0.6);
    return;
  }
  
  const buf = await tryFetchImageBuffer(urlOrPath);
  if (!buf) {
    ensurePageSpace(doc, 30);
    doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.headerFooter);
    doc.text('Image unavailable.');
    doc.moveDown(0.6);
    return;
  }
  
  // Calculate image dimensions to fit within page width
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const maxImageHeight = 280;
  
  let dims;
  try {
    dims = sizeOf(buf);
  } catch {
    dims = null;
  }
  
  ensurePageSpace(doc, maxImageHeight + 20);
  
  // Add border around image
  const imgX = doc.page.margins.left;
  const imgY = doc.y;
  
  doc.save();
  doc.roundedRect(imgX - 2, imgY - 2, availableWidth + 4, maxImageHeight + 4, 4)
    .strokeColor(STYLE.colors.cardBorder)
    .lineWidth(1)
    .stroke();
  doc.restore();
  
  // Render image with proper scaling
  doc.image(buf, {
    fit: [availableWidth, maxImageHeight],
    align: 'center',
    valign: 'center'
  });
  
  // Calculate actual rendered height
  const drawnHeight = dims && dims.width && dims.height
    ? Math.min(maxImageHeight, (availableWidth * dims.height) / dims.width)
    : maxImageHeight;
    
  doc.y += Math.min(maxImageHeight, Math.max(120, drawnHeight)) + 20;
}

function renderTranscribedTextSection(doc, transcription, corrections) {
  const transcriptText = safeText(transcription);
  const perImageCorrections = Array.isArray(corrections) ? corrections : [];
  
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const boxX = doc.page.margins.left;
  const boxW = availableWidth;
  const padding = 12;
  
  // Create tokens from text and corrections
  const tokens = tokensFromTextAndCorrections(
    transcriptText || 'No transcription available for this image.',
    perImageCorrections
  );
  
  // Calculate required height for the text box
  doc.save();
  doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size);
  const estimatedHeight = doc.heightOfString(transcriptText || 'No transcription available.', {
    width: boxW - padding * 2
  });
  const boxH = Math.max(80, estimatedHeight + padding * 2 + 16);
  doc.restore();
  
  ensurePageSpace(doc, boxH + 20);
  
  // Text box background
  const boxY = doc.y;
  doc.save();
  doc.roundedRect(boxX, boxY, boxW, boxH, 10).fillAndStroke('#F9FAFB', STYLE.colors.cardBorder);
  doc.restore();
  
  // Render tokens with line wrapping and highlighting
  doc.x = boxX + padding;
  doc.y = boxY + padding;
  renderTokensLineWrapped(doc, tokens, { width: boxW - padding * 2 });
  
  doc.y = boxY + boxH + 15;
}

function renderDetectedIssues(doc, issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) {
    renderText(doc, 'No issues detected.', { fontName: 'Helvetica-Oblique', color: STYLE.colors.headerFooter });
    doc.moveDown(0.4);
    return;
  }

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const badgeSize = 18;
  const pad = 10;

  for (const issue of list.slice(0, 120)) {
    ensurePageSpace(doc, 70);
    const symbol = safeText(issue.symbol) || 'CK';
    const title = symbol === 'SP' ? 'Spelling' : symbol === 'GR' ? 'Grammar' : 'Other';
    const color = CORRECTION_COLOR[symbol] || STYLE.colors.primary;
    const word = safeText(issue.word || issue.originalText || issue.text);
    const message = safeText(issue.message);
    const suggestion = safeText(issue.suggestedText);

    const bodyLines = [];
    if (message) bodyLines.push(message);
    if (word) bodyLines.push(`Word: ${word}`);
    if (suggestion) bodyLines.push(`Suggestion: ${suggestion}`);
    const bodyText = bodyLines.length ? bodyLines.join('\n') : 'No details available.';

    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size);
    const titleH = doc.heightOfString(`${title}`, { width: w - pad * 2 - badgeSize - 10 });
    const bodyH = doc.heightOfString(bodyText, { width: w - pad * 2 - badgeSize - 10 });
    const h = Math.max(52, pad + titleH + 4 + bodyH + pad);

    ensurePageSpace(doc, h + 8);
    const y = doc.y;

    doc.save();
    doc.roundedRect(x, y, w, h, 10).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
    doc.restore();

    const badgeX = x + pad;
    const badgeY = y + pad;
    doc.save();
    doc.circle(badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize / 2)
      .fillAndStroke('#FFFFFF', color);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(color)
      .text(symbol, badgeX, badgeY + 4, { width: badgeSize, align: 'center' });

    const textX = badgeX + badgeSize + 10;
    doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
      .text(title, textX, y + pad, { width: w - (textX - x) - pad });
    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text)
      .text(bodyText, textX, y + pad + titleH + 4, { width: w - (textX - x) - pad });

    doc.y = y + h + 10;
  }
}

function renderMainHeader(doc, data) {
  const pageX = doc.page.margins.left;
  const pageW = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const y = doc.y;
  
  // Left side: Title and student info
  doc.font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral);
  doc.text('Submission Feedback Report', pageX, y, { width: pageW * 0.6 });
  
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.headerFooter);
  doc.text(`Student: ${safeText(data.studentEmail)}`, pageX, doc.y);
  doc.text(`Submission ID: ${safeText(data.submissionId)}`, pageX, doc.y);
  doc.text(`Date: ${safeText(data.date)}`, pageX, doc.y);
  
  // Right side: Score box
  const scoreBoxWidth = 140;
  const scoreBoxHeight = 70;
  const scoreX = pageX + pageW - scoreBoxWidth;
  const scoreY = y;
  
  const grade = safeText(data.grade) || 'N/A';
  const scoreText = data.overallScore ? `${Math.round(data.overallScore * 10) / 10}/100` : 'N/A';
  
  // Grade color
  const g = grade.toUpperCase();
  let accent = STYLE.colors.error;
  if (g === 'A') accent = STYLE.colors.success;
  else if (g === 'B' || g === 'C') accent = STYLE.colors.warning;
  
  // Score box background
  doc.save();
  doc.roundedRect(scoreX, scoreY, scoreBoxWidth, scoreBoxHeight, 8).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(scoreX, scoreY, 6, scoreBoxHeight).fill(accent);
  doc.restore();
  
  // Grade and score text
  doc.font('Helvetica-Bold').fontSize(36).fillColor(accent);
  doc.text(grade, scoreX + 16, scoreY + 12);
  
  doc.font('Helvetica-Bold').fontSize(14).fillColor(STYLE.colors.neutral);
  doc.text(scoreText, scoreX + 16, scoreY + 45);
  
  doc.y = y + scoreBoxHeight + 20;
  
  // Separator line
  doc.moveTo(pageX, doc.y)
    .lineTo(pageX + pageW, doc.y)
    .lineWidth(1)
    .strokeColor(STYLE.colors.rule)
    .stroke();
  
  doc.y += 15;
}

function buildFeedbackBlocks({ submissionFeedback, feedback }) {
  const detailed = submissionFeedback && submissionFeedback.detailedFeedback && typeof submissionFeedback.detailedFeedback === 'object'
    ? submissionFeedback.detailedFeedback
    : {};
  const ai = submissionFeedback && submissionFeedback.aiFeedback && typeof submissionFeedback.aiFeedback === 'object'
    ? submissionFeedback.aiFeedback
    : {};

  const strengths = normalizeStringList(detailed.strengths, 12);
  const areasForImprovement = normalizeStringList(detailed.areasForImprovement, 12);
  const actionSteps = normalizeStringList(detailed.actionSteps, 20);

  const aiOverallComments = safeText(ai.overallComments);
  const aiPerCategory = Array.isArray(ai.perCategory) ? ai.perCategory : [];
  const aiPerCategoryRows = aiPerCategory
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const category = safeText(c.category);
      const message = safeText(c.message);
      const scoreText = Number.isFinite(safeNumber(c.scoreOutOf5, NaN)) ? `${Math.round(Number(c.scoreOutOf5) * 10) / 10}/5` : '';
      if (!category && !message && !scoreText) return null;
      return { category, message, scoreText };
    })
    .filter(Boolean);

  const teacherComment = pickTeacherComments(feedback);

  return {
    strengths,
    areasForImprovement,
    actionSteps,
    aiOverallComments,
    aiPerCategoryRows,
    teacherComment
  };
}

function buildStatisticsRows({ issues, submissionFeedback }) {
  const rows = [];
  const stats = submissionFeedback && submissionFeedback.correctionStats && typeof submissionFeedback.correctionStats === 'object'
    ? submissionFeedback.correctionStats
    : null;

  if (stats) {
    const mapping = [
      ['Content', stats.content],
      ['Grammar', stats.grammar],
      ['Organization', stats.organization],
      ['Vocabulary', stats.vocabulary],
      ['Mechanics', stats.mechanics]
    ];
    for (const [label, count] of mapping) {
      rows.push([label, String(Number(count) || 0)]);
    }
  }

  const list = Array.isArray(issues) ? issues : [];
  if (list.length) {
    const byType = { SP: 0, GR: 0, CK: 0 };
    for (const it of list) {
      const s = safeText(it.symbol) || 'CK';
      if (s === 'SP') byType.SP += 1;
      else if (s === 'GR') byType.GR += 1;
      else byType.CK += 1;
    }
    rows.push(['Spelling (SP)', String(byType.SP)]);
    rows.push(['Grammar (GR)', String(byType.GR)]);
    rows.push(['Other (CK)', String(byType.CK)]);
    rows.push(['Total Issues', String(list.length)]);
  }

  return rows;
}

/**
 * Generates a professional multi-page PDF for a submission feedback payload.
 *
 * Notes:
 * - Uses pdfkit only (no Chromium dependency)
 * - Writes to disk at outputPath and resolves with the saved path
 * - Caller is responsible for deleting the file after download if desired
 */
async function generatePdf(submissionData, outputPath) {
  const data = submissionData && typeof submissionData === 'object' ? submissionData : {};

  // Normalized fields expected from controller (backward-compatible with previous renderSubmissionPdf inputs).
  const header = data.header && typeof data.header === 'object' ? data.header : {};
  const feedback = data.feedback && typeof data.feedback === 'object' ? data.feedback : null;
  const submissionFeedback = data.submissionFeedback && typeof data.submissionFeedback === 'object' ? data.submissionFeedback : null;
  const transcriptText = safeText(data.transcriptText);
  const images = Array.isArray(data.images) ? data.images : [];
  const issues = normalizeCorrections(data.issues);

  const { strengths, areasForImprovement, actionSteps, aiOverallComments, aiPerCategoryRows, teacherComment } = buildFeedbackBlocks({
    submissionFeedback,
    feedback
  });

  const rubricRows = buildRubricRows(submissionFeedback || feedback);
  const overallBlock = getOverallScoreBlock({ feedback, submissionFeedback });

  const title = 'Submission Feedback Report';
  const studentEmail = safeText(header.studentName);
  const submissionId = safeText(header.submissionId);
  const dateText = safeText(header.date) || formatDate(new Date());

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  // PDF generation steps:
  // 1) Create PDFDocument and pipe to a file stream
  // 2) Add a header/footer on every page
  // 3) Render sections with spacing checks to support multi-page overflow
  // 4) Finalize document and resolve when file stream finishes
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      margins: {
        top: 50,
        bottom: 50,
        left: 40,
        right: 40
      }
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const render = async () => {
      // Main Header with title and score
      const headerData = {
        studentEmail,
        submissionId,
        date: dateText,
        overallScore: overallBlock?.overallScore,
        grade: overallBlock?.gradeText
      };

      renderMainHeader(doc, headerData);
      
      // Section 1: Original Image
      renderNumberedSectionTitle(doc, 1, 'Original Image');
      if (!images.length) {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.headerFooter);
        doc.text('No images attached.');
        doc.moveDown(0.6);
      } else {
        for (let i = 0; i < images.length; i += 1) {
          const img = images[i] && typeof images[i] === 'object' ? images[i] : {};
          // eslint-disable-next-line no-await-in-loop
          await renderImageSection(doc, img, i);
        }
      }

      // Section 2: Transcribed Text with highlights
      renderNumberedSectionTitle(doc, 2, 'Transcribed Text (with highlights)');
      if (!images.length) {
        renderTranscribedTextSection(doc, transcriptText, issues);
      } else {
        for (let i = 0; i < images.length; i += 1) {
          const img = images[i] && typeof images[i] === 'object' ? images[i] : {};
          const pageNumber = i + 1;
          const perPageIssues = issues.filter((c) => Number(c.page) === pageNumber);
          // eslint-disable-next-line no-await-in-loop
          await renderTranscribedTextSection(doc, img.transcriptText || '', perPageIssues);
        }
      }

      // Section 3: Score & Statistics
      renderNumberedSectionTitle(doc, 3, 'Score & Statistics');
      const statRows = buildStatisticsRows({ issues, submissionFeedback });
      renderScoreAndStatisticsRow(doc, {
        overallBlock,
        statRows
      });

      // Section 4: Detailed Feedback
      renderNumberedSectionTitle(doc, 4, 'Detailed Feedback');
      
      // Teacher Comments
      doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.neutral);
      doc.text('Teacher Comments');
      doc.moveDown(0.3);
      if (teacherComment) {
        doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.text);
        doc.text(teacherComment, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      } else {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.headerFooter);
        doc.text('No comments provided');
      }
      doc.moveDown(0.8);
      
      // AI Comments
      doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.neutral);
      doc.text('AI Comments');
      doc.moveDown(0.3);
      if (aiOverallComments) {
        doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.text);
        doc.text(aiOverallComments, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      } else {
        doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.headerFooter);
        doc.text('No AI comments available');
      }
      doc.moveDown(0.8);

      // Section 5: Rubric Table
      renderNumberedSectionTitle(doc, 5, 'Rubric Scores');
      const rubricTableRows = rubricRows.map((r) => ([
        safeText(r.criteria),
        String(Number.isFinite(r.score) ? Math.round(r.score * 10) / 10 : ''),
        String(Number.isFinite(r.maxScore) ? Math.round(r.maxScore * 10) / 10 : ''),
        safeText(r.comment)
      ]));
      renderTable(doc, ['Criteria', 'Score', 'Max Score', 'Comment'], rubricTableRows, {
        columnWidths: [170, 80, 90, 160]
      });

      // Optional: AI Per Category (if data exists)
      if (aiPerCategoryRows.length > 0) {
        renderNumberedSectionTitle(doc, 6, 'AI Per Category Feedback');
        const aiRows = aiPerCategoryRows.map((r) => ([
          safeText(r.category),
          safeText(r.scoreText),
          safeText(r.message)
        ]));
        renderTable(doc, ['Category', 'Score', 'Feedback'], aiRows, {
          columnWidths: [140, 70, 290]
        });
      }

      // Optional: Strengths/Improvements (if data exists)
      if (strengths.length || areasForImprovement.length || actionSteps.length) {
        renderNumberedSectionTitle(doc, aiPerCategoryRows.length > 0 ? 7 : 6, 'Strengths / Areas for Improvement');
        renderCard(doc, 'Strengths', strengths, STYLE.colors.success);
        renderCard(doc, 'Areas for Improvement', areasForImprovement, STYLE.colors.warning);
        renderCard(doc, 'Action Steps', actionSteps, '#6a1b9a');
      }

      // Optional: Detected Issues (if data exists)
      if (issues.length > 0) {
        const sectionNum = 6 + (aiPerCategoryRows.length > 0 ? 1 : 0) + (strengths.length || areasForImprovement.length || actionSteps.length ? 1 : 0);
        renderNumberedSectionTitle(doc, sectionNum, 'Detected Issues');
        renderDetectedIssues(doc, issues);
      }

      // Add header/footer to all pages
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        drawHeaderFooterForPage(doc, {
          title,
          pageNumber: i + 1,
          totalPages: range.count
        });
      }
    };

    render()
      .then(() => doc.end())
      .catch((err) => {
        try {
          console.error('[PDF ERROR]', {
            submissionId,
            message: err && err.message ? err.message : String(err),
            stack: err && err.stack ? err.stack : undefined
          });
        } catch {
          // ignore
        }
        try {
          doc.end();
        } catch {
          // ignore
        }
        reject(new Error(`PDF generation failed: ${err && err.message ? err.message : String(err)}`));
      });

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', (err) => reject(err));
  });
}

module.exports = {
  generatePdf
};
