const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { fetch } = require('undici');
const sizeOf = require('image-size');

// ─────────────────────────────────────────────────────────────────────────────
// STYLE TOKENS  (matches the target "submission-feedback__2_.pdf")
// ─────────────────────────────────────────────────────────────────────────────
const STYLE = {
  colors: {
    headerFooter: '#666666',
    primary: '#1a73e8',      // blue
    success: '#2e7d32',      // green  (grade A)
    warning: '#f57c00',      // orange (grade B/C)
    error: '#d32f2f',        // red    (grade D/F)
    neutral: '#333333',
    rule: '#D0D5DD',
    text: '#111827',
    cardBorder: '#E5E7EB',
    tableHeaderBg: '#F3F4F6',
    tableAltRowBg: '#FAFAFA',
  },
  fonts: {
    title: { name: 'Helvetica-Bold', size: 20 },
    sectionTitle: { name: 'Helvetica-Bold', size: 13 },
    body: { name: 'Helvetica', size: 10 },
    meta: { name: 'Helvetica', size: 9 },
    headerFooter: { name: 'Helvetica', size: 9 },
    mono: { name: 'Courier', size: 9.5 },
  },
  spacing: {
    sectionGap: 14,
    blockGap: 10,
    cardPadding: 12,
  },
};

// Per-correction-type colours (badge + highlight)
const CORRECTION_COLOR = {
  SP: '#d32f2f',
  GR: '#f57c00',
  CK: '#1a73e8',
  TY: '#6a1b9a',
  ST: '#00695c',
};

// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function safeText(v) {
  return (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
}
function safeNumber(v, fallback = NaN) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function formatDate(d) {
  const dt = d ? new Date(d) : null;
  if (!dt || isNaN(dt.getTime())) return '';
  return dt.toLocaleString();
}
function normalizeStringList(v, max) {
  const arr = Array.isArray(v) ? v : [];
  const out = [];
  for (const it of arr) {
    const t = safeText(it);
    if (t) { out.push(t); if (max && out.length >= max) break; }
  }
  return out;
}
function gradeAccent(grade) {
  const g = safeText(grade).toUpperCase();
  if (g === 'A') return STYLE.colors.success;
  if (g === 'B' || g === 'C') return STYLE.colors.warning;
  return STYLE.colors.error;
}
function pageContentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}
function ensureSpace(doc, h) {
  const limit = doc.page.height - doc.page.margins.bottom - 28;
  if (doc.y + h > limit) doc.addPage();
}

// ─────────────────────────────────────────────────────────────────────────────
// HEADER / FOOTER  (drawn on every page after bufferPages)
// ─────────────────────────────────────────────────────────────────────────────
function drawPageHeaderFooter(doc, { title, pageNumber, totalPages }) {
  const L = doc.page.margins.left;
  const R = doc.page.margins.right;
  const W = doc.page.width;
  const ruleColor = STYLE.colors.rule;

  doc.save();

  // ── top rule + centred title ──
  const headerY = 16;
  const ruleY = 34;
  doc
    .font(STYLE.fonts.headerFooter.name)
    .fontSize(STYLE.fonts.headerFooter.size)
    .fillColor(STYLE.colors.headerFooter)
    .text(safeText(title), L, headerY, { width: W - L - R, align: 'center' });
  doc.moveTo(L, ruleY).lineTo(W - R, ruleY).lineWidth(0.5).strokeColor(ruleColor).stroke();

  // ── bottom rule + page n of N ──
  const footerRuleY = doc.page.height - doc.page.margins.bottom - 8;
  const footerTextY = doc.page.height - doc.page.margins.bottom + 6;
  doc.moveTo(L, footerRuleY).lineTo(W - R, footerRuleY).lineWidth(0.5).strokeColor(ruleColor).stroke();
  const label = totalPages ? `Page ${pageNumber} of ${totalPages}` : `Page ${pageNumber}`;
  doc
    .font(STYLE.fonts.headerFooter.name)
    .fontSize(STYLE.fonts.headerFooter.size)
    .fillColor(STYLE.colors.headerFooter)
    .text(label, L, footerTextY, { width: W - L - R, align: 'center' });

  doc.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN PAGE HEADER  (title + student info left, grade box right)
// Matches target: bold "Submission Feedback Report", meta below, score card top-right
// ─────────────────────────────────────────────────────────────────────────────
function renderMainHeader(doc, { studentEmail, submissionId, date, grade, overallScoreText }) {
  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const y0 = doc.y;

  const accent = gradeAccent(grade);
  const gradeLabel = safeText(grade) || 'N/A';
  const scoreLabel = safeText(overallScoreText) || 'N/A';

  // Score card dimensions (top-right)
  const cardW = 130;
  const cardH = 72;
  const cardX = L + W - cardW;
  const cardY = y0;

  // ── left: title + meta ──
  const textW = W - cardW - 14;
  doc
    .font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral)
    .text('Submission Feedback Report', L, y0, { width: textW });

  doc.moveDown(0.25);
  doc
    .font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
    .text(`Student: ${safeText(studentEmail)}`, L, doc.y, { width: textW });
  doc
    .font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
    .text(`Submission ID: ${safeText(submissionId)}`, L, doc.y, { width: textW });
  doc
    .font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
    .text(`Date: ${safeText(date)}`, L, doc.y, { width: textW });

  // ── right: score card ──
  doc.save();
  doc.roundedRect(cardX, cardY, cardW, cardH, 8).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(cardX, cardY, 6, cardH).fill(accent);
  doc.restore();

  // "Overall Score" label
  doc
    .font('Helvetica').fontSize(8).fillColor(STYLE.colors.headerFooter)
    .text('Overall Score', cardX + 8, cardY + 8, { width: cardW - 14, align: 'right' });

  // Grade letter (large)
  doc
    .font('Helvetica-Bold').fontSize(36).fillColor(accent)
    .text(gradeLabel, cardX + 12, cardY + 18);

  // Score text
  doc
    .font('Helvetica-Bold').fontSize(13).fillColor(STYLE.colors.neutral)
    .text(scoreLabel, cardX + 12, cardY + 50);

  // Ensure doc.y is below both the text block and the card
  doc.y = Math.max(doc.y, cardY + cardH) + 14;

  // Horizontal rule
  doc
    .moveTo(L, doc.y).lineTo(L + W, doc.y)
    .lineWidth(0.5).strokeColor(STYLE.colors.rule).stroke();
  doc.y += 14;
}

// ─────────────────────────────────────────────────────────────────────────────
// NUMBERED SECTION TITLE
// Grey rounded bar with blue numbered badge on left, bold title text
// ─────────────────────────────────────────────────────────────────────────────
function renderSectionTitle(doc, number, title) {
  ensureSpace(doc, 50);
  doc.moveDown(0.4);

  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const y = doc.y;
  const h = 28;

  // Grey background
  doc.save();
  doc.roundedRect(L, y, W, h, 7).fillAndStroke('#F3F4F6', STYLE.colors.cardBorder);
  doc.restore();

  // Blue badge
  doc.save();
  doc.roundedRect(L + 8, y + 4, 20, 20, 4).fill(STYLE.colors.primary);
  doc.restore();
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#FFFFFF')
    .text(String(number), L + 8, y + 7, { width: 20, align: 'center' });

  // Title
  doc.font('Helvetica-Bold').fontSize(13).fillColor(STYLE.colors.neutral)
    .text(safeText(title), L + 36, y + 7, { width: W - 46 });

  doc.y = y + h + 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMAGE SECTION
// ─────────────────────────────────────────────────────────────────────────────
async function tryFetchImageBuffer(urlOrPath) {
  const u = safeText(urlOrPath);
  if (!u) return null;
  if (/^https?:\/\//i.test(u)) {
    try {
      const res = await fetch(u);
      if (!res.ok) return null;
      return Buffer.from(await res.arrayBuffer());
    } catch { return null; }
  }
  // local /uploads/… path
  const m = u.match(/^\/uploads\/(assignments|submissions|feedback)\/([^/?#]+)$/i);
  if (!m) return null;
  const abs = path.join(__dirname, '..', '..', 'uploads', m[1].toLowerCase(), m[2]);
  try { return await fs.promises.readFile(abs); } catch { return null; }
}

async function renderImageSection(doc, img) {
  const urlOrPath = safeText(img && (img.url || img.path || img.imageUrl));
  const buf = urlOrPath ? await tryFetchImageBuffer(urlOrPath) : null;
  const corrections = Array.isArray(img && img.corrections) ? img.corrections : [];

  if (!buf) {
    ensureSpace(doc, 30);
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
      .text('Image unavailable.');
    doc.moveDown(0.6);
    return;
  }

  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const maxH = 300;

  let imgW = W, imgH = maxH;
  try {
    const dims = sizeOf(buf);
    if (dims && dims.width && dims.height) {
      const ratio = dims.height / dims.width;
      imgH = Math.min(maxH, W * ratio);
      imgW = imgH / ratio;
    }
  } catch { /* ignore */ }

  ensureSpace(doc, imgH + 20);

  // Centre the image horizontally inside a bordered box
  const boxY = doc.y;
  const padX = (W - imgW) / 2;

  doc.save();
  doc.roundedRect(L, boxY, W, imgH + 12, 6)
    .strokeColor(STYLE.colors.cardBorder).lineWidth(1).stroke();
  doc.restore();

  doc.image(buf, L + padX, boxY + 6, { width: imgW, height: imgH });

  const normalizeBox = (bbox) => {
    if (!bbox || typeof bbox !== 'object') return null;
    const x = Number(bbox.x);
    const y = Number(bbox.y);
    const w = Number(bbox.w);
    const h = Number(bbox.h);
    if (![x, y, w, h].every((n) => Number.isFinite(n))) return null;
    if (w <= 0 || h <= 0) return null;
    if ([x, y, w, h].every((n) => n >= 0 && n <= 1)) {
      return { x: x * 100, y: y * 100, w: w * 100, h: h * 100 };
    }
    return { x, y, w, h };
  };

  const renderOverlayBox = (bbox, color, label) => {
    const normalized = normalizeBox(bbox);
    if (!normalized) return;

    const left = L + padX + (normalized.x / 100) * imgW;
    const top = boxY + 6 + (normalized.y / 100) * imgH;
    const width = (normalized.w / 100) * imgW;
    const height = (normalized.h / 100) * imgH;

    doc.save();
    doc.fillOpacity(0.16);
    doc.strokeOpacity(0.92);
    doc.roundedRect(left, top, width, height, 2).fillAndStroke(color, color);
    doc.restore();

    if (label) {
      const badgeW = Math.max(18, Math.min(28, doc.widthOfString(label, { font: 'Helvetica-Bold', size: 7 }) + 8));
      const badgeH = 12;
      const bx = Math.max(left, Math.min(left + width - badgeW, left));
      const by = Math.max(boxY + 6, top - badgeH - 2);
      doc.save();
      doc.roundedRect(bx, by, badgeW, badgeH, 3).fill(color);
      doc.restore();
      doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF').text(label, bx, by + 2, { width: badgeW, align: 'center' });
    }
  };

  for (const corr of corrections) {
    const symbol = safeText(corr && corr.symbol) || 'CK';
    const color = CORRECTION_COLOR[symbol] || STYLE.colors.primary;
    const boxes = Array.isArray(corr && corr.bboxList) ? corr.bboxList : [];
    for (const bbox of boxes) {
      renderOverlayBox(bbox, color, symbol);
    }
  }

  doc.y = boxY + imgH + 20;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSCRIBED TEXT WITH INLINE CORRECTION BADGES
// Matches target: monospace text, highlighted words, coloured badges
// ─────────────────────────────────────────────────────────────────────────────
function buildTokens(text, corrections) {
  const t = safeText(text);
  const list = Array.isArray(corrections) ? corrections : [];

  // Sort corrections by startChar, remove overlaps
  const sorted = list
    .map(c => {
      const s = safeNumber(c.startChar, NaN);
      const e = safeNumber(c.endChar, NaN);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null;
      return { start: s, end: e, symbol: safeText(c.symbol) || 'CK', suggestion: safeText(c.suggestedText) };
    })
    .filter(Boolean)
    .sort((a, b) => a.start - b.start);

  const clean = [];
  let cursor = 0;
  for (const c of sorted) {
    if (c.start < cursor) continue;
    clean.push(c);
    cursor = c.end;
  }

  // Build tokens
  const tokens = [];
  cursor = 0;
  for (const c of clean) {
    if (c.start > cursor) tokens.push({ type: 'normal', text: t.slice(cursor, c.start) });
    tokens.push({ type: c.symbol, text: t.slice(c.start, c.end), suggestion: c.suggestion });
    cursor = c.end;
  }
  if (cursor < t.length) tokens.push({ type: 'normal', text: t.slice(cursor) });
  return tokens.filter(t => t.text.length);
}

function renderTranscribedText(doc, text, corrections) {
  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const pad = 12;
  const boxX = L;
  const innerW = W - pad * 2;
  const lineH = STYLE.fonts.mono.size * 1.55;
  const badgeW = 22;
  const badgeH = 13;
  const spW = 4; // gap between word and badge

  const tokens = buildTokens(text || 'No transcription available.', corrections);

  // ── Pre-measure to get box height ────────────────────────────────────────
  // We'll use a two-pass approach: first measure, then draw.
  // For simplicity, estimate height then draw. If overflow, new page.
  const estimatedLines = Math.ceil(
    doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size)
      .heightOfString(safeText(text) || 'No transcription available.', { width: innerW })
    / lineH
  ) + 2;
  const estimatedH = Math.max(60, estimatedLines * lineH + pad * 2);

  ensureSpace(doc, estimatedH + 20);

  const boxY = doc.y;
  // Draw background + border (we'll know true height after rendering)
  // We draw after layout using save/restore trick is hard with pdfkit,
  // so we draw box first with estimated height then adjust
  doc.save();
  doc.roundedRect(boxX, boxY, W, estimatedH, 8)
    .fillAndStroke('#F9FAFB', STYLE.colors.cardBorder);
  doc.restore();

  // ── Render tokens word-by-word ───────────────────────────────────────────
  let x = boxX + pad;
  let y = boxY + pad;
  const maxX = boxX + W - pad;

  doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size);

  for (const token of tokens) {
    const isError = token.type !== 'normal';
    const color = isError ? (CORRECTION_COLOR[token.type] || STYLE.colors.primary) : null;

    // Split by whitespace, keeping spaces
    const pieces = token.text.split(/(\s+)/);
    for (const piece of pieces) {
      if (!piece) continue;

      if (/^\s+$/.test(piece)) {
        // whitespace: advance x, wrap if needed
        const spaceW = doc.widthOfString(' ');
        if (x + spaceW > maxX) { x = boxX + pad; y += lineH; }
        else { x += spaceW; }
        continue;
      }

      // word
      doc.font(isError ? STYLE.fonts.mono.name : STYLE.fonts.mono.name)
        .fontSize(STYLE.fonts.mono.size);
      const wordW = doc.widthOfString(piece);
      const totalW = isError ? wordW + spW + badgeW : wordW;

      if (x + totalW > maxX && x > boxX + pad) {
        x = boxX + pad;
        y += lineH;
      }

      // check page overflow mid-box
      if (y + lineH > doc.page.height - doc.page.margins.bottom - 28) {
        doc.addPage();
        y = doc.page.margins.top + 10;
        x = boxX + pad;
      }

      if (isError) {
        // highlight background
        doc.save();
        doc.rect(x - 1, y - 1, wordW + 2, STYLE.fonts.mono.size + 4)
          .fill(color + '30');
        doc.restore();
        // underline
        doc.save();
        doc.moveTo(x, y + STYLE.fonts.mono.size + 1)
          .lineTo(x + wordW, y + STYLE.fonts.mono.size + 1)
          .lineWidth(1).strokeColor(color).stroke();
        doc.restore();
      }

      // word text
      doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size)
        .fillColor(isError ? '#000000' : '#1a1a1a')
        .text(piece, x, y, { continued: false });

      if (isError) {
        // badge
        const bx = x + wordW + spW;
        doc.save();
        doc.roundedRect(bx, y, badgeW, badgeH, 3).fill(color);
        doc.restore();
        doc.font('Helvetica-Bold').fontSize(7).fillColor('#FFFFFF')
          .text(token.type, bx, y + 3, { width: badgeW, align: 'center' });
      }

      x += totalW;
    }
  }

  // Set doc.y below the box
  const trueH = Math.max(estimatedH, (y - boxY) + lineH + pad);
  doc.y = boxY + trueH + 14;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCORE & STATISTICS ROW
// Two side-by-side cards: Overall Score (left) + Correction Statistics (right)
// ─────────────────────────────────────────────────────────────────────────────
function renderScoreAndStats(doc, { overallBlock, statRows }) {
  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const gap = 12;
  const cardW = Math.floor((W - gap) / 2);
  const cardH = 130;

  ensureSpace(doc, cardH + 16);
  const y = doc.y;

  const grade = safeText(overallBlock && overallBlock.gradeText) || 'N/A';
  const scoreText = safeText(overallBlock && overallBlock.overallText) || 'N/A';
  const accent = gradeAccent(grade);

  // ── LEFT: Overall Score card ──
  const lx = L;
  doc.save();
  doc.roundedRect(lx, y, cardW, cardH, 10).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(lx, y, 7, cardH).fill(accent);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
    .text('Overall Score', lx + 16, y + 12, { width: cardW - 26 });
  doc.font('Helvetica-Bold').fontSize(38).fillColor(accent)
    .text(grade, lx + 16, y + 32);
  doc.font('Helvetica-Bold').fontSize(17).fillColor(STYLE.colors.neutral)
    .text(scoreText, lx + 16, y + 76, { width: cardW - 26 });
  if (overallBlock && overallBlock.note) {
    doc.font('Helvetica').fontSize(8.5).fillColor(STYLE.colors.headerFooter)
      .text(safeText(overallBlock.note), lx + 16, y + 100, { width: cardW - 26 });
  }

  // ── RIGHT: Correction Statistics card ──
  const rx = L + cardW + gap;
  const rows = Array.isArray(statRows) ? statRows : [];
  const rowH = 16;
  const tableY = y + 38;
  const tableW = cardW - 24;
  const tableX = rx + 12;

  doc.save();
  doc.roundedRect(rx, y, cardW, cardH, 10).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(rx, y, 7, cardH).fill(STYLE.colors.primary);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
    .text('Correction Statistics', rx + 16, y + 12, { width: cardW - 26 });

  // Table header
  doc.save();
  doc.rect(tableX, tableY, tableW, rowH).fill(STYLE.colors.tableHeaderBg);
  doc.rect(tableX, tableY, tableW, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
  doc.restore();
  const col1W = Math.floor(tableW * 0.68);
  doc.font('Helvetica-Bold').fontSize(9).fillColor(STYLE.colors.neutral)
    .text('Category', tableX + 5, tableY + 4, { width: col1W - 10 });
  doc.font('Helvetica-Bold').fontSize(9).fillColor(STYLE.colors.neutral)
    .text('Count', tableX + col1W + 5, tableY + 4, { width: tableW - col1W - 10 });

  // Table rows
  rows.slice(0, 6).forEach((row, i) => {
    const ry = tableY + rowH + i * rowH;
    const fill = i % 2 === 0 ? '#FFFFFF' : STYLE.colors.tableAltRowBg;
    doc.save();
    doc.rect(tableX, ry, tableW, rowH).fill(fill);
    doc.rect(tableX, ry, tableW, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
    let lx = tableX;
    for (let i = 1; i < 2; i++) {
      lx += col1W;
      doc.moveTo(lx, ry).lineTo(lx, ry + rowH)
        .strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
    }
    doc.restore();
    doc.font('Helvetica').fontSize(9).fillColor(STYLE.colors.text)
      .text(safeText(row[0]), tableX + 5, ry + 4, { width: col1W - 10 });
    doc.font('Helvetica').fontSize(9).fillColor(STYLE.colors.text)
      .text(safeText(row[1]), tableX + col1W + 5, ry + 4, { width: tableW - col1W - 10 });
  });

  doc.y = y + cardH + 14;
}

// ─────────────────────────────────────────────────────────────────────────────
// RUBRIC TABLE
// ─────────────────────────────────────────────────────────────────────────────
function renderTable(doc, headers, rows, { columnWidths } = {}) {
  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const cols = headers.length;
  if (!cols) return;

  const widths = (Array.isArray(columnWidths) && columnWidths.length === cols)
    ? columnWidths
    : headers.map(() => Math.floor(W / cols));

  const total = widths.reduce((a, b) => a + b, 0);
  const scale = total > W ? W / total : 1;
  const cw = widths.map(w => Math.floor(w * scale));
  const padX = 8;
  const padY = 5;
  const hdrH = 22;

  ensureSpace(doc, hdrH + 10);
  const hy = doc.y;

  doc.save();
  doc.rect(L, hy, W, hdrH).fill(STYLE.colors.tableHeaderBg);
  doc.rect(L, hy, W, hdrH).strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(STYLE.colors.neutral);
  let cx = L;
  for (let i = 0; i < cols; i++) {
    doc.text(headers[i], cx + padX, hy + padY, { width: cw[i] - padX * 2 });
    cx += cw[i];
  }
  doc.y = hy + hdrH;

  for (let r = 0; r < rows.length; r++) {
    const cells = Array.isArray(rows[r]) ? rows[r] : [];
    const cellH = cells.map((cell, i) =>
      doc.font('Helvetica').fontSize(9.5)
        .heightOfString(safeText(cell), { width: cw[i] - padX * 2 })
    );
    const rowH = Math.max(22, Math.max(...cellH) + padY * 2);

    ensureSpace(doc, rowH + 4);
    const ry = doc.y;

    doc.save();
    doc.rect(L, ry, W, rowH).fill(r % 2 === 0 ? '#FFFFFF' : STYLE.colors.tableAltRowBg);
    doc.rect(L, ry, W, rowH).strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
    let lx = L;
    for (let i = 1; i < cols; i++) {
      lx += cw[i - 1];
      doc.moveTo(lx, ry).lineTo(lx, ry + rowH)
        .strokeColor(STYLE.colors.cardBorder).lineWidth(0.5).stroke();
    }
    doc.restore();

    let tx = L;
    doc.font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.text);
    for (let i = 0; i < cols; i++) {
      doc.text(safeText(cells[i]), tx + padX, ry + padY, { width: cw[i] - padX * 2 });
      tx += cw[i];
    }
    doc.y = ry + rowH;
  }
  doc.moveDown(0.6);
}

// ─────────────────────────────────────────────────────────────────────────────
// CARD  (Strengths / Improvements / Action Steps)
// ─────────────────────────────────────────────────────────────────────────────
function renderCard(doc, title, items, color) {
  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const pad = STYLE.spacing.cardPadding;
  const list = Array.isArray(items) ? items : [];

  const bodyText = list.length
    ? list.map(t => `- ${safeText(t)}`).join('\n')
    : 'No data available.';

  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size);
  const titleH = doc.heightOfString(safeText(title), { width: W - pad * 2 - 6 });
  const bodyH = doc.heightOfString(bodyText, { width: W - pad * 2 - 6 });
  const h = pad + titleH + 6 + bodyH + pad;

  ensureSpace(doc, h + 10);
  const y = doc.y;

  doc.save();
  doc.roundedRect(L, y, W, h, 8).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
  doc.rect(L, y, 5, h).fill(color || STYLE.colors.primary);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
    .text(safeText(title), L + pad + 5, y + pad, { width: W - pad * 2 - 5 });
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text)
    .text(bodyText, L + pad + 5, y + pad + titleH + 6, { width: W - pad * 2 - 5 });

  doc.y = y + h + 10;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTED ISSUES LIST
// ─────────────────────────────────────────────────────────────────────────────
function renderDetectedIssues(doc, issues) {
  const list = Array.isArray(issues) ? issues : [];
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
      .text('No issues detected.');
    doc.moveDown(0.4);
    return;
  }

  const L = doc.page.margins.left;
  const W = pageContentWidth(doc);
  const badge = 20;
  const pad = 10;

  for (const issue of list.slice(0, 120)) {
    const symbol = safeText(issue.symbol) || 'CK';
    const color = CORRECTION_COLOR[symbol] || STYLE.colors.primary;
    const typeLabel = symbol === 'SP' ? 'Spelling' : symbol === 'GR' ? 'Grammar'
      : symbol === 'TY' ? 'Typography' : symbol === 'ST' ? 'Style' : 'Other';
    const message = safeText(issue.message);
    const suggestion = safeText(issue.suggestedText);

    const lines = [];
    if (message) lines.push(message);
    if (suggestion) lines.push(`Suggestion: ${suggestion}`);
    const bodyText = lines.join('\n') || 'No details.';

    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size);
    const titleH = doc.heightOfString(typeLabel, { width: W - pad * 2 - badge - 10 });
    const bodyH = doc.heightOfString(bodyText, { width: W - pad * 2 - badge - 10 });
    const h = Math.max(52, pad + titleH + 4 + bodyH + pad);

    ensureSpace(doc, h + 8);
    const y = doc.y;

    doc.save();
    doc.roundedRect(L, y, W, h, 8).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
    doc.restore();

    // circular badge
    doc.save();
    doc.circle(L + pad + badge / 2, y + pad + badge / 2, badge / 2)
      .fillAndStroke('#FFFFFF', color);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(8).fillColor(color)
      .text(symbol, L + pad, y + pad + 5, { width: badge, align: 'center' });

    const tx = L + pad + badge + 10;
    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(typeLabel, tx, y + pad, { width: W - (tx - L) - pad });
    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text)
      .text(bodyText, tx, y + pad + titleH + 4, { width: W - (tx - L) - pad });

    doc.y = y + h + 8;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function normalizeCorrections(issues) {
  return (Array.isArray(issues) ? issues : [])
    .map(c => {
      if (!c || typeof c !== 'object') return null;
      return {
        page: safeNumber(c.page, 1),
        symbol: safeText(c.symbol) || 'CK',
        message: safeText(c.message),
        suggestedText: safeText(c.suggestedText),
        startChar: safeNumber(c.startChar, NaN),
        endChar: safeNumber(c.endChar, NaN),
        word: safeText(c.word || c.originalText || c.text),
        bboxList: Array.isArray(c.bboxList)
          ? c.bboxList.map((b) => ({
              x: safeNumber(b && b.x, NaN),
              y: safeNumber(b && b.y, NaN),
              w: safeNumber(b && b.w, NaN),
              h: safeNumber(b && b.h, NaN)
            })).filter((b) => [b.x, b.y, b.w, b.h].every((n) => Number.isFinite(n) && n >= 0))
          : []
      };
    })
    .filter(Boolean);
}

function buildRubricRows(fb) {
  const rs = fb && fb.rubricScores;
  if (!rs) return [];
  const labels = { CONTENT: 'Content', ORGANIZATION: 'Organization', GRAMMAR: 'Grammar', VOCABULARY: 'Vocabulary', MECHANICS: 'Mechanics' };
  return Object.entries(labels)
    .map(([k, label]) => {
      const item = rs[k];
      const score = safeNumber(item && item.score, NaN);
      if (!Number.isFinite(score)) return null;
      const max = safeNumber(item && item.maxScore, 5);
      const comment = safeText(item && (item.comment || item.notes || item.feedback));
      return { criteria: label, score, maxScore: max, comment };
    })
    .filter(Boolean);
}

function getOverallScoreBlock({ feedback, submissionFeedback }) {
  const overall = safeNumber(submissionFeedback && submissionFeedback.overallScore, NaN);
  const grade = safeText(submissionFeedback && submissionFeedback.grade);
  if (Number.isFinite(overall)) {
    return { overallText: `${Math.round(overall * 10) / 10}/100`, gradeText: grade || 'N/A', note: 'From submission feedback' };
  }
  const score = safeNumber(feedback && feedback.score, NaN);
  const maxScore = safeNumber(feedback && feedback.maxScore, NaN);
  if (Number.isFinite(score) && maxScore > 0) {
    const pct = (score / maxScore) * 100;
    const letter = pct >= 90 ? 'A' : pct >= 80 ? 'B' : pct >= 70 ? 'C' : pct >= 60 ? 'D' : 'F';
    return { overallText: `${Math.round(score * 10) / 10}/${Math.round(maxScore * 10) / 10}`, gradeText: letter, note: `Approx. ${Math.round(pct)}%` };
  }
  return { overallText: 'N/A', gradeText: 'N/A', note: '' };
}

function buildStatRows({ issues, submissionFeedback }) {
  const rows = [];
  const stats = submissionFeedback && submissionFeedback.correctionStats;
  if (stats) {
    [['Content', stats.content], ['Grammar', stats.grammar], ['Organization', stats.organization],
    ['Vocabulary', stats.vocabulary], ['Mechanics', stats.mechanics]]
      .forEach(([label, count]) => rows.push([label, String(Number(count) || 0)]));
  }
  const list = Array.isArray(issues) ? issues : [];
  if (list.length) {
    const by = { SP: 0, GR: 0, CK: 0 };
    list.forEach(it => {
      const s = safeText(it.symbol) || 'CK';
      if (s === 'SP') by.SP++; else if (s === 'GR') by.GR++; else by.CK++;
    });
    rows.push(['Spelling (SP)', String(by.SP)]);
    rows.push(['Grammar (GR)', String(by.GR)]);
    rows.push(['Other (CK)', String(by.CK)]);
    rows.push(['Total Issues', String(list.length)]);
  }
  return rows;
}

function pickTeacherComments(fb) {
  if (!fb) return '';
  return safeText(fb.teacherComments) || safeText(fb.textFeedback) || '';
}

function buildFeedbackBlocks({ submissionFeedback, feedback }) {
  const detailed = (submissionFeedback && submissionFeedback.detailedFeedback) || {};
  const ai = (submissionFeedback && submissionFeedback.aiFeedback) || {};
  const strengths = normalizeStringList(detailed.strengths, 12);
  const areasForImprovement = normalizeStringList(detailed.areasForImprovement, 12);
  const actionSteps = normalizeStringList(detailed.actionSteps, 20);
  const aiOverallComments = safeText(ai.overallComments);
  const aiPerCategoryRows = (Array.isArray(ai.perCategory) ? ai.perCategory : [])
    .map(c => {
      if (!c) return null;
      const category = safeText(c.category);
      const message = safeText(c.message);
      const scoreText = Number.isFinite(safeNumber(c.scoreOutOf5, NaN)) ? `${Math.round(Number(c.scoreOutOf5) * 10) / 10}/5` : '';
      if (!category && !message && !scoreText) return null;
      return { category, message, scoreText };
    })
    .filter(Boolean);
  return { strengths, areasForImprovement, actionSteps, aiOverallComments, aiPerCategoryRows, teacherComment: pickTeacherComments(feedback) };
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN EXPORT
// ─────────────────────────────────────────────────────────────────────────────
async function generatePdf(submissionData, outputPath) {
  const data = submissionData && typeof submissionData === 'object' ? submissionData : {};
  const header = (data.header && typeof data.header === 'object') ? data.header : {};
  const feedback = (data.feedback && typeof data.feedback === 'object') ? data.feedback : null;
  const submissionFeedback = (data.submissionFeedback && typeof data.submissionFeedback === 'object') ? data.submissionFeedback : null;
  const transcriptText = safeText(data.transcriptText);
  const images = Array.isArray(data.images) ? data.images : [];
  const issues = normalizeCorrections(data.issues);

  const { strengths, areasForImprovement, actionSteps, aiOverallComments, aiPerCategoryRows, teacherComment } =
    buildFeedbackBlocks({ submissionFeedback, feedback });

  const rubricRows = buildRubricRows(submissionFeedback || feedback);
  const overallBlock = getOverallScoreBlock({ feedback, submissionFeedback });

  const title = 'Submission Feedback Report';
  const studentEmail = safeText(header.studentEmail || header.studentName);
  const submissionId = safeText(header.submissionId);
  const dateText = safeText(header.date) || formatDate(new Date());
  const grade = safeText(overallBlock.gradeText);
  const overallScoreText = safeText(overallBlock.overallText);

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      bufferPages: true,
      margins: { top: 50, bottom: 50, left: 40, right: 40 },
    });

    const stream = fs.createWriteStream(outputPath);
    doc.pipe(stream);

    const render = async () => {
      // ── Main Header ──────────────────────────────────────────────────────
      renderMainHeader(doc, { studentEmail, submissionId, date: dateText, grade, overallScoreText });

      // ── Paired image + transcription sections ────────────────────────────
      // Layout: Image 1 → Transcription 1 → Image 2 → Transcription 2 → …
      if (images.length === 0) {
        // fallback: no images
        renderSectionTitle(doc, 1, 'Original Image');
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.headerFooter)
          .text('No images attached.');
        doc.moveDown(0.6);

        renderSectionTitle(doc, 2, 'Transcribed Text (with highlights)');
        renderTranscribedText(doc, transcriptText, issues);

        renderAfterPairSections(doc, {
          startNum: 3, overallBlock, issues, submissionFeedback,
          feedback,
          teacherComment, aiOverallComments, rubricRows, aiPerCategoryRows,
          strengths, areasForImprovement, actionSteps,
        });

      } else {
        // One pair per image
        for (let i = 0; i < images.length; i++) {
          const img = (images[i] && typeof images[i] === 'object') ? images[i] : {};
          const pageNum = i + 1;
          const imgSecNum = i * 2 + 1;
          const txtSecNum = i * 2 + 2;

          const imgLabel = images.length > 1 ? `Original Image ${pageNum}` : 'Original Image';
          const txtLabel = images.length > 1
            ? `Transcribed Text ${pageNum} (with highlights)`
            : 'Transcribed Text (with highlights)';

          renderSectionTitle(doc, imgSecNum, imgLabel);
          await renderImageSection(doc, {
            ...img,
            corrections: issues.filter(c => Number(c.page) === pageNum)
          });

          renderSectionTitle(doc, txtSecNum, txtLabel);

          const perPageIssues = Array.isArray(img.corrections)
            ? img.corrections
            : issues.filter(c => Number(c.page) === pageNum);
          const imgTranscript = safeText(img.transcriptText || img.transcription || img.text);
          renderTranscribedText(doc, imgTranscript, perPageIssues);
        }

        renderAfterPairSections(doc, {
          startNum: images.length * 2 + 1,
          overallBlock, issues, submissionFeedback,
          feedback, // Pass feedback into the image-based PDF rendering branch
          teacherComment, aiOverallComments, rubricRows, aiPerCategoryRows,
          strengths, areasForImprovement, actionSteps,
        });
      }

      // ── Header / footer on every buffered page ──────────────────────────
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i++) {
        doc.switchToPage(range.start + i);
        drawPageHeaderFooter(doc, { title, pageNumber: i + 1, totalPages: range.count });
      }
    };

    render()
      .then(() => doc.end())
      .catch(err => {
        try { console.error('[PDF ERROR]', err); } catch { /* ignore */ }
        try { doc.end(); } catch { /* ignore */ }
        reject(new Error(`PDF generation failed: ${err?.message ?? String(err)}`));
      });

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', err => reject(err));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTIONS AFTER THE IMAGE/TRANSCRIPTION PAIRS
// ─────────────────────────────────────────────────────────────────────────────
function renderAfterPairSections(doc, {
  startNum, overallBlock, issues, submissionFeedback, feedback,
  teacherComment, aiOverallComments, rubricRows, aiPerCategoryRows,
  strengths, areasForImprovement, actionSteps,
}) {
  let n = startNum;

  // Score & Statistics
  renderSectionTitle(doc, n++, 'Score & Statistics');

  renderScoreAndStats(doc, {
    overallBlock,
    statRows: buildStatRows({ issues, submissionFeedback }),
  });

  // Detailed Feedback
  renderSectionTitle(doc, n++, 'Detailed Feedback & Suggestions');

  const renderTextCard = (title, text, emptyText) => {
    const body = safeText(text) || emptyText;
    const L = doc.page.margins.left;
    const W = pageContentWidth(doc);
    const pad = STYLE.spacing.cardPadding;
    doc.font('Helvetica-Bold').fontSize(11);
    const titleH = doc.heightOfString(safeText(title), { width: W - pad * 2 - 5 });
    doc.font('Helvetica').fontSize(9.5);
    const bodyH = doc.heightOfString(body, { width: W - pad * 2 - 5 });
    const h = pad + titleH + 6 + bodyH + pad;
    ensureSpace(doc, h + 6);
    const y = doc.y;
    doc.save();
    doc.roundedRect(L, y, W, h, 8).fillAndStroke('#FFFFFF', STYLE.colors.cardBorder);
    doc.rect(L, y, 5, h).fill(STYLE.colors.primary);
    doc.restore();
    doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
      .text(safeText(title), L + pad + 5, y + pad, { width: W - pad * 2 - 5 });
    doc.font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.text)
      .text(body, L + pad + 5, y + pad + titleH + 6, { width: W - pad * 2 - 5 });
    doc.y = y + h + 10;
  };

  renderTextCard('Teacher Comments', teacherComment, 'No teacher comments provided.');
  renderTextCard('AI Overall Comments', aiOverallComments, 'No AI overall comments available.');

  // Rubric Scores
  renderSectionTitle(doc, n++, 'Rubric Scores');

  renderTable(
    doc,
    ['Criteria', 'Score', 'Max Score', 'Comment'],
    rubricRows.map(r => [
      safeText(r.criteria),
      Number.isFinite(r.score) ? String(Math.round(r.score * 10) / 10) : '',
      Number.isFinite(r.maxScore) ? String(Math.round(r.maxScore * 10) / 10) : '',
      safeText(r.comment),
    ]),
    { columnWidths: [170, 70, 80, 180] }
  );

  // AI Per-Category (optional)
  if (aiPerCategoryRows.length > 0) {
    renderSectionTitle(doc, n++, 'AI Per-Category Feedback');
    renderTable(
      doc,
      ['Category', 'Score', 'Feedback'],
      aiPerCategoryRows.map(r => [safeText(r.category), safeText(r.scoreText), safeText(r.message)]),
      { columnWidths: [130, 65, 305] }
    );
  }

  renderTextCard(
    'Override Reason',
    feedback && feedback.overrideReason,
    'No override reason provided.'
  );

  // Strengths / Areas (optional)
  if (strengths.length || areasForImprovement.length || actionSteps.length) {
    renderSectionTitle(doc, n++, 'Strengths / Areas for Improvement');
    renderCard(doc, 'Strengths', strengths, STYLE.colors.success);
    renderCard(doc, 'Areas for Improvement', areasForImprovement, STYLE.colors.warning);
    renderCard(doc, 'Action Steps', actionSteps, '#6a1b9a');
  }

  const imageAnnotationLines = Array.isArray(feedback && feedback.annotations)
    ? feedback.annotations
        .map((a) => {
          const page = safeText(a && a.page);
          const comment = safeText(a && a.comment);
          const x = Number(a && a.x);
          const y = Number(a && a.y);
          if (!comment) return null;
          const meta = [page ? `Page ${page}` : '', Number.isFinite(x) && Number.isFinite(y) ? `(${Math.round(x)}, ${Math.round(y)})` : '']
            .filter(Boolean)
            .join(' ');
          return meta ? `${meta}: ${comment}` : comment;
        })
        .filter(Boolean)
    : [];

  renderTextCard(
    'Image Annotations',
    imageAnnotationLines.length ? imageAnnotationLines.join('\n') : '',
    'No image annotations available.'
  );

  // Detected Issues (optional)
  if (issues.length > 0) {
    renderSectionTitle(doc, n++, 'Detected Issues');

    renderDetectedIssues(doc, issues);
  }
}

module.exports = { generatePdf };