const fs   = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { getActivityType } = require('../config/activityTypes.config');

// ─────────────────────────────────────────────────────────────────────────────
// STYLE TOKENS  (matches existing ProjectRozna palette)
// ─────────────────────────────────────────────────────────────────────────────
const STYLE = {
  colors: {
    primary:     '#008081',
    primaryDark: '#136C6D',
    success:     '#166534',
    successBg:   '#dcfce7',
    successBd:   '#22c55e',
    error:       '#dc2626',
    errorBg:     '#fee2e2',
    errorBd:     '#ef4444',
    correctHint: '#f0fdf4',
    correctHintBd: '#86efac',
    warning:     '#f57c00',
    warningBg:   '#fef3c7',
    warningBd:   '#fbbf24',
    info:        '#203864',
    infoBg:      '#dbeafe',
    infoBd:      '#3b82f6',
    neutral:     '#374151',
    muted:       '#6B7280',
    border:      '#E7E7E7',
    headerFt:    '#9CA3AF',
    bg:          '#F9FAFB',
    tableHdr:    '#F3F3F3',
    altRow:      '#FAFAFA',
    white:       '#FFFFFF',
  },
  fonts: {
    main:       'Helvetica',
    bold:       'Helvetica-Bold',
    italic:     'Helvetica-Oblique',
  },
  sizes: {
    xl: 20,
    lg: 16,
    md: 13,
    base: 11,
    sm: 10,
    xs: 9,
    xxs: 8.5,
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radius: {
    sm: 4,
    md: 8,
    lg: 12,
    xl: 16,
  },
};

const OPTION_LETTERS = ['A', 'B', 'C', 'D'];

// ─────────────────────────────────────────────────────────────────────────────
// SMALL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────
function safeText(v) {
  return (typeof v === 'string' ? v : v == null ? '' : String(v)).trim();
}
function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}
function pageW(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function ensureSpace(doc, h, forceNewPage = false) {
  const footerSpace = 60;
  const available = doc.page.height - doc.page.margins.bottom - footerSpace - doc.y;
  if (forceNewPage || available < h) {
    doc.addPage();
  }
}

function formatTime(seconds) {
  const s = safeNumber(seconds, 0);
  if (s <= 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const remMin = m % 60;
    return `${h}h ${remMin}m`;
  }
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return 'N/A';
  }
}

function formatDateTime(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    const d = new Date(dateStr);
    return d.toLocaleString('en-US', { 
      year: 'numeric', 
      month: 'short', 
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    return 'N/A';
  }
}

function getScoreColor(score) {
  const pct = safeNumber(score, 0);
  if (pct >= 70) return STYLE.colors.success;
  if (pct >= 50) return STYLE.colors.warning;
  return STYLE.colors.error;
}

function getScoreBadge(score) {
  const pct = safeNumber(score, 0);
  if (pct >= 90) return { label: 'Excellent', color: STYLE.colors.success };
  if (pct >= 70) return { label: 'Good', color: STYLE.colors.success };
  if (pct >= 50) return { label: 'Satisfactory', color: STYLE.colors.warning };
  if (pct >= 30) return { label: 'Needs Improvement', color: STYLE.colors.error };
  return { label: 'Critical', color: STYLE.colors.error };
}

function na(v) {
  const t = safeText(v);
  return t ? t : 'N/A';
}

// ─────────────────────────────────────────────────────────────────────────────
// REUSABLE PDF COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a performance badge with label and color
 */
function renderBadge(doc, x, y, text, bgColor, textColor = STYLE.colors.white) {
  const padding = { x: 12, y: 6 };
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xs);
  const textW = doc.widthOfString(text);
  const badgeW = textW + padding.x * 2;
  const badgeH = 22;
  
  doc.save();
  doc.roundedRect(x, y, badgeW, badgeH, STYLE.radius.sm).fill(bgColor);
  doc.restore();
  
  doc.fillColor(textColor).text(text, x + padding.x, y + padding.y - 1);
  return badgeW;
}

/**
 * Renders an enhanced progress bar with percentage label
 */
function renderProgressBar(doc, x, y, w, h, pct, color, showLabel = true) {
  doc.save();
  doc.roundedRect(x, y, w, h, h / 2).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
  const fillW = Math.max(0, Math.min(w, Math.round(w * pct / 100)));
  if (fillW > 0) {
    doc.roundedRect(x, y, fillW, h, h / 2).fill(color || STYLE.colors.primary);
  }
  doc.restore();
  
  if (showLabel) {
    doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.neutral);
    const label = `${Math.round(pct)}%`;
    const labelW = doc.widthOfString(label);
    doc.text(label, x + w - labelW, y + 2, { width: labelW });
  }
}

/**
 * Renders a stat card with icon, label, value, and optional trend
 */
function renderStatCard(doc, x, y, w, h, { label, value, icon, trend, color }) {
  const padding = STYLE.spacing.md;
  const iconSize = 24;
  
  doc.save();
  doc.roundedRect(x, y, w, h, STYLE.radius.lg).fillAndStroke(STYLE.colors.white, STYLE.colors.border);
  doc.restore();
  
  // Icon (if provided)
  if (icon) {
    doc.font(STYLE.fonts.main).fontSize(16).fillColor(color || STYLE.colors.primary);
    doc.text(icon, x + padding, y + padding, { width: iconSize, height: iconSize });
  }
  
  const contentX = icon ? x + padding + iconSize + STYLE.spacing.sm : x + padding;
  
  // Label
  doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted)
    .text(safeText(label).toUpperCase(), contentX, y + padding + 2, { width: w - padding * 2 });
  
  // Value
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.lg).fillColor(STYLE.colors.neutral)
    .text(safeText(value), contentX, y + padding + 16, { width: w - padding * 2 });
  
  // Trend (if provided)
  if (trend) {
    const trendColor = trend >= 0 ? STYLE.colors.success : STYLE.colors.error;
    const trendIcon = trend >= 0 ? '↑' : '↓';
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(trendColor)
      .text(`${trendIcon} ${Math.abs(trend)}%`, contentX, y + padding + 38, { width: w - padding * 2 });
  }
  
  return h + STYLE.spacing.md;
}

/**
 * Renders a section card with title and content
 */
function renderSectionCard(doc, title, renderContent, options = {}) {
  const { collapsible = false, defaultOpen = true } = options;
  const L = doc.page.margins.left;
  const W = pageW(doc);
  const padding = STYLE.spacing.lg;
  
  ensureSpace(doc, 80);
  const startY = doc.y;
  
  // Card background
  doc.save();
  doc.roundedRect(L, startY, W, 40, STYLE.radius.md).fillAndStroke(STYLE.colors.bg, STYLE.colors.border);
  doc.restore();
  
  // Title
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral)
    .text(safeText(title), L + padding, startY + 12, { width: W - padding * 2 });
  
  doc.y = startY + 40 + STYLE.spacing.sm;
  
  // Render content
  if (renderContent) {
    renderContent(doc, L + padding, W - padding * 2);
  }
  
  doc.y += STYLE.spacing.lg;
}

/**
 * Renders a mini table with headers and rows
 */
function renderMiniTable(doc, headers, rows, options = {}) {
  const { columnWidths, showBorders = true, alternateRows = true } = options;
  const L = doc.page.margins.left;
  const W = pageW(doc);
  const colW = columnWidths || headers.map(() => W / headers.length);
  
  const rowH = 28;
  const headerH = 32;
  
  // Header row
  ensureSpace(doc, headerH + 10);
  const headerY = doc.y;
  
  doc.save();
  doc.rect(L, headerY, W, headerH).fill(STYLE.colors.tableHdr);
  if (showBorders) {
    doc.rect(L, headerY, W, headerH).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
  }
  doc.restore();
  
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.neutral);
  let cx = L + STYLE.spacing.sm;
  headers.forEach((header, i) => {
    doc.text(safeText(header), cx, headerY + 10, { width: colW[i] - STYLE.spacing.sm * 2 });
    cx += colW[i];
  });
  
  doc.y = headerY + headerH;
  
  // Data rows
  rows.forEach((row, rowIndex) => {
    ensureSpace(doc, rowH + 4);
    const rowY = doc.y;
    
    if (alternateRows && rowIndex % 2 === 1) {
      doc.save();
      doc.rect(L, rowY, W, rowH).fill(STYLE.colors.altRow);
      doc.restore();
    }
    
    if (showBorders) {
      doc.save();
      doc.rect(L, rowY, W, rowH).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
      doc.restore();
    }
    
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.neutral);
    cx = L + STYLE.spacing.sm;
    row.forEach((cell, i) => {
      doc.text(safeText(cell), cx, rowY + 8, { width: colW[i] - STYLE.spacing.sm * 2 });
      cx += colW[i];
    });
    
    doc.y = rowY + rowH;
  });
  
  doc.y += STYLE.spacing.md;
}

function titleizeId(v) {
  const s = safeText(v);
  if (!s) return '';
  return s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(w => (w ? w[0].toUpperCase() + w.slice(1) : ''))
    .join(' ');
}

function formatDifficulty(v) {
  const t = safeText(v);
  if (!t) return '';
  if (t === 'easy') return 'Easy';
  if (t === 'medium') return 'Medium';
  if (t === 'hard') return 'Hard';
  return t;
}

function getWorksheetTypeLabel(ws) {
  const types = new Set();

  const activities = Array.isArray(ws && ws.activities) ? ws.activities : [];
  for (const act of activities) {
    const id = safeText(act && act.type);
    if (id) types.add(id);
  }

  if (types.size === 0) {
    const legacy = [
      { key: 'activity1', label: 'Drag & Drop', exists: !!(ws && ws.activity1 && Array.isArray(ws.activity1.items) && ws.activity1.items.length) },
      { key: 'activity2', label: 'Classification', exists: !!(ws && ws.activity2 && Array.isArray(ws.activity2.items) && ws.activity2.items.length) },
      { key: 'activity3', label: 'Multiple Choice', exists: !!(ws && ws.activity3 && Array.isArray(ws.activity3.questions) && ws.activity3.questions.length) },
      { key: 'activity4', label: 'Fill in the Blanks', exists: !!(ws && ws.activity4 && Array.isArray(ws.activity4.sentences) && ws.activity4.sentences.length) },
      { key: 'activity5', label: 'Matching Pairs', exists: !!(ws && ws.activity5 && Array.isArray(ws.activity5.pairs) && ws.activity5.pairs.length) },
      { key: 'activity6', label: 'True / False', exists: !!(ws && ws.activity6 && Array.isArray(ws.activity6.questions) && ws.activity6.questions.length) },
    ].filter(x => x.exists);

    if (legacy.length === 0) return 'N/A';
    if (legacy.length > 1) return 'Mixed';
    return legacy[0].label;
  }

  if (types.size > 1) return 'Mixed';

  const onlyType = Array.from(types)[0];
  const cfg = getActivityType(onlyType);
  return safeText(cfg && cfg.label) || titleizeId(onlyType) || 'N/A';
}

function countFillBlankBlanks(activityData) {
  const sentences = Array.isArray(activityData && activityData.sentences) ? activityData.sentences : [];
  let blanks = 0;
  for (const s of sentences) {
    const parts = Array.isArray(s && s.parts) ? s.parts : [];
    for (const p of parts) {
      if (safeText(p && p.type) === 'blank') blanks++;
    }
  }
  return blanks;
}

function countQuestionsByActivityType(typeId, activityData) {
  const data = (activityData && typeof activityData === 'object') ? activityData : {};
  switch (safeText(typeId)) {
    case 'ordering':
    case 'classification':
    case 'dragDrop':
    case 'sorting':
      return Array.isArray(data.items) ? data.items.length : 0;
    case 'multipleChoice':
    case 'trueFalse':
    case 'shortAnswer':
      return Array.isArray(data.questions) ? data.questions.length : 0;
    case 'fillBlanks': {
      const blankCount = countFillBlankBlanks(data);
      if (blankCount > 0) return blankCount;
      return Array.isArray(data.sentences) ? data.sentences.length : 0;
    }
    case 'matching':
      return Array.isArray(data.pairs) ? data.pairs.length : 0;
    case 'labeling':
      return Array.isArray(data.labels) ? data.labels.length : 0;
    case 'wordSearch':
      return Array.isArray(data.words) ? data.words.length : 0;
    case 'crossword':
      return Array.isArray(data.words) ? data.words.length : 0;
    default:
      return (Array.isArray(data.questions) ? data.questions.length : 0)
        + (Array.isArray(data.items) ? data.items.length : 0)
        + (Array.isArray(data.pairs) ? data.pairs.length : 0)
        + (Array.isArray(data.words) ? data.words.length : 0)
        + (Array.isArray(data.labels) ? data.labels.length : 0)
        + (Array.isArray(data.sentences) ? data.sentences.length : 0);
  }
}

function getWorksheetTotalQuestions(ws) {
  const activities = Array.isArray(ws && ws.activities) ? ws.activities : [];
  if (activities.length > 0) {
    let total = 0;
    for (const act of activities) {
      total += countQuestionsByActivityType(act && act.type, act && act.data);
    }
    return total;
  }

  let total = 0;
  let any = false;

  if (ws && ws.activity1 && Array.isArray(ws.activity1.items)) { any = true; total += ws.activity1.items.length; }
  if (ws && ws.activity2 && Array.isArray(ws.activity2.items)) { any = true; total += ws.activity2.items.length; }
  if (ws && ws.activity3 && Array.isArray(ws.activity3.questions)) { any = true; total += ws.activity3.questions.length; }
  if (ws && ws.activity4) {
    const a4 = ws.activity4;
    const blankCount = countFillBlankBlanks(a4);
    const sentencesCount = Array.isArray(a4.sentences) ? a4.sentences.length : 0;
    if (blankCount > 0 || sentencesCount > 0) {
      any = true;
      total += blankCount > 0 ? blankCount : sentencesCount;
    }
  }
  if (ws && ws.activity5 && Array.isArray(ws.activity5.pairs)) { any = true; total += ws.activity5.pairs.length; }
  if (ws && ws.activity6 && Array.isArray(ws.activity6.questions)) { any = true; total += ws.activity6.questions.length; }

  return any ? total : null;
}

function renderWorksheetDetailsCard(doc, { title, subject, cefrLevel, gradeCategory, gradeLevel, difficulty, worksheetType, totalQuestions, assignmentDate, dueDate, teacherName, language }) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  const padding = STYLE.spacing.lg;
  const colGap = STYLE.spacing.lg;
  const innerX = L + padding;
  const innerW = W - padding * 2;
  const colW = Math.floor((innerW - colGap) / 2);

  const leftItems = [
    { label: 'Worksheet Title', value: na(title) },
    { label: 'Subject', value: na(subject) },
    { label: 'CEFR Level', value: na(cefrLevel) },
    { label: 'Grade Category', value: na(gradeCategory) },
    { label: 'Assignment Date', value: formatDate(assignmentDate) },
  ];
  const rightItems = [
    { label: 'Worksheet Type', value: na(worksheetType) },
    { label: 'Grade Level', value: na(gradeLevel) },
    { label: 'Difficulty', value: formatDifficulty(difficulty) },
    { label: 'Language', value: na(language) },
    { label: 'Due Date', value: formatDate(dueDate) },
  ];
  
  if (teacherName) {
    rightItems.push({ label: 'Teacher', value: na(teacherName) });
  }

  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base);
  const headerH = doc.heightOfString('Worksheet Details', { width: innerW });

  const labelSize = STYLE.sizes.xxs;
  const valueSize = STYLE.sizes.sm;
  const itemGap = STYLE.spacing.sm;
  const labelGap = 2;

  const measureItemH = (item) => {
    doc.font(STYLE.fonts.main).fontSize(labelSize);
    const lh = doc.heightOfString(safeText(item.label), { width: colW });
    doc.font(STYLE.fonts.bold).fontSize(valueSize);
    const vh = doc.heightOfString(safeText(item.value), { width: colW });
    return lh + labelGap + vh + itemGap;
  };

  let leftContentH = 0;
  let rightContentH = 0;
  leftItems.forEach((it) => { leftContentH += measureItemH(it); });
  rightItems.forEach((it) => { rightContentH += measureItemH(it); });
  const colContentH = Math.max(leftContentH, rightContentH);
  const cardH = padding + headerH + STYLE.spacing.sm + colContentH + padding - itemGap;

  ensureSpace(doc, cardH + STYLE.spacing.md);

  const startY = doc.y;

  doc.save();
  doc.roundedRect(L, startY, W, cardH, STYLE.radius.md).fillAndStroke(STYLE.colors.bg, STYLE.colors.border);
  doc.restore();

  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral)
    .text('Worksheet Details', innerX, startY + padding, { width: innerW });

  const dividerY = startY + padding + headerH + STYLE.spacing.sm;
  doc.moveTo(innerX, dividerY).lineTo(innerX + innerW, dividerY)
    .lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();

  const drawItem = (x, y, item) => {
    doc.font(STYLE.fonts.main).fontSize(labelSize).fillColor(STYLE.colors.muted)
      .text(safeText(item.label), x, y, { width: colW });
    const labelH = doc.heightOfString(safeText(item.label), { width: colW });
    const vy = y + labelH + labelGap;
    doc.font(STYLE.fonts.bold).fontSize(valueSize).fillColor(STYLE.colors.neutral)
      .text(safeText(item.value), x, vy, { width: colW });
    const valueH = doc.heightOfString(safeText(item.value), { width: colW });
    return vy + valueH + itemGap;
  };

  let curLeftY = startY + padding + headerH + STYLE.spacing.sm;
  let curRightY = curLeftY;

  for (const it of leftItems) curLeftY = drawItem(innerX, curLeftY, it);
  for (const it of rightItems) curRightY = drawItem(innerX + colW + colGap, curRightY, it);

  doc.y = startY + cardH + STYLE.spacing.lg;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENHANCED PAGE HEADER + FOOTER
// ─────────────────────────────────────────────────────────────────────────────
function drawPageHeaderFooter(doc, { title, subtitle, pageNumber, totalPages, showBranding = true }) {
  const L = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();

  // Header background
  doc.rect(L, 0, W, 50).fill(STYLE.colors.white);
  doc.moveTo(L, 50).lineTo(L + W, 50).lineWidth(1).strokeColor(STYLE.colors.border).stroke();

  // Branding/logo placeholder (left)
  if (showBranding) {
    doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.primary);
    doc.text('Rozna', L, 18);
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.muted);
    doc.text('Education Platform', L, 32);
  }

  // Title and subtitle (center)
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral);
  doc.text(safeText(title), L, 18, { width: W, align: 'center' });
  
  if (subtitle) {
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.muted);
    doc.text(safeText(subtitle), L, 34, { width: W, align: 'center' });
  }

  // Page number (right)
  const pageLabel = totalPages ? `${pageNumber}/${totalPages}` : String(pageNumber);
  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.headerFt);
  doc.text(pageLabel, L, 24, { width: W, align: 'right' });

  doc.restore();

  // Footer
  const footerY = doc.page.height - doc.page.margins.bottom - 30;
  doc.save();
  doc.moveTo(L, footerY).lineTo(L + W, footerY).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
  doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.headerFt);
  const generatedDate = formatDate(new Date());
  doc.text(`Generated on ${generatedDate} • Rozna Education Platform`, L, footerY + 10, { width: W, align: 'center' });
  doc.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// UNIFIED DOCUMENT TITLE HEADER (used by both teacher and student PDFs)
// ─────────────────────────────────────────────────────────────────────────────
function renderDocHeader(doc, { worksheetTitle, subtitle, studentName, submittedAt, score, percentage, worksheetMeta, showScore = true }) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xl).fillColor(STYLE.colors.neutral)
    .text(safeText(worksheetTitle), L, doc.y, { width: W });
  doc.moveDown(0.25);

  if (subtitle) {
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.muted)
      .text(safeText(subtitle), L, doc.y, { width: W });
    doc.moveDown(0.25);
  }

  // Worksheet metadata (CEFR, grade, subject, etc.) - structured row with icons
  if (worksheetMeta) {
    ensureSpace(doc, 60);
    const metaY = doc.y;
    const metaH = 50;

    // Green metadata box background
    doc.save();
    doc.roundedRect(L, metaY, W, metaH, STYLE.radius.md).fill(STYLE.colors.primary);
    doc.restore();

    // Metadata row with 4 columns
    const colGap = STYLE.spacing.lg;
    const colW = (W - colGap * 3) / 4;
    const startX = L + STYLE.spacing.lg;
    const startY = metaY + STYLE.spacing.sm;

    const metaItems = [
      { icon: '📚', label: 'Subject', value: safeText(worksheetMeta.subject) || '—' },
      { icon: '🎯', label: 'CEFR', value: safeText(worksheetMeta.cefrLevel) || '—' },
      { icon: '🏫', label: 'Grade', value: safeText(worksheetMeta.gradeLevel) || '—' },
      { icon: '⚡', label: 'Difficulty', value: formatDifficulty(worksheetMeta.difficulty) || '—' },
    ];

    doc.font(STYLE.fonts.main);
    let colX = startX;
    metaItems.forEach((item, i) => {
      // Icon
      doc.fontSize(14).fillColor(STYLE.colors.white);
      doc.text(item.icon, colX, startY, { width: colW });

      // Label (uppercase, small, opacity)
      doc.fontSize(9).fillColor('rgba(255,255,255,0.75)');
      doc.text(item.label.toUpperCase(), colX, startY + 18, { width: colW });

      // Value (larger, bold, white)
      doc.font(STYLE.fonts.bold).fontSize(13).fillColor(STYLE.colors.white);
      doc.text(item.value, colX, startY + 30, { width: colW });

      colX += colW + colGap;
    });

    // Deadline row below metadata
    const deadline = worksheetMeta.assignmentDeadline || worksheetMeta.deadline;
    if (deadline) {
      const deadlineY = metaY + metaH + STYLE.spacing.sm;
      const isPast = new Date(deadline) < new Date();
      const deadlineColor = isPast ? STYLE.colors.error : STYLE.colors.white;
      const deadlineText = `📅 Due: ${formatDate(deadline)}`;

      doc.font(STYLE.fonts.main).fontSize(11).fillColor(deadlineColor);
      doc.text(deadlineText, L, deadlineY, { width: W });
      doc.moveDown(0.35);
    } else {
      doc.moveDown(0.35);
    }

    // Divider line
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(1).strokeColor('rgba(255,255,255,0.2)').stroke();
    doc.y += STYLE.spacing.lg;
  }

  const metaParts = [];
  if (studentName) metaParts.push(`Student: ${safeText(studentName)}`);
  if (submittedAt)  metaParts.push(`Submitted: ${formatDateTime(submittedAt)}`);
  if (metaParts.length) {
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.muted)
      .text(metaParts.join('   |   '), L, doc.y, { width: W });
    doc.moveDown(0.35);
  }

  if (showScore && (score !== undefined || percentage !== undefined)) {
    const pct = safeNumber(percentage, 0);
    const accent = getScoreColor(pct);
    const badge = getScoreBadge(pct);
    const scoreStr = score ? `${score} pts (${Math.round(pct)}%)` : `${Math.round(pct)}%`;
    
    // Score with badge
    const scoreY = doc.y;
    doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.md).fillColor(accent)
      .text(`Score: ${scoreStr}`, L, scoreY, { width: W - 100 });
    
    // Performance badge
    if (badge) {
      renderBadge(doc, L + W - badge.label.length * 25, scoreY - 2, badge.label, badge.color);
    }
    
    doc.moveDown(0.5);
  }

  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
  doc.y += STYLE.spacing.lg;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION TITLE BAR
// ─────────────────────────────────────────────────────────────────────────────
function renderSectionTitle(doc, title, badge = null) {
  ensureSpace(doc, 50);
  const L = doc.page.margins.left;
  const W = pageW(doc);
  const y = doc.y;
  const h = 36;

  doc.save();
  doc.roundedRect(L, y, W, h, STYLE.radius.md).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
  doc.restore();

  doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral)
    .text(safeText(title), L + STYLE.spacing.lg, y + 10, { width: W - STYLE.spacing.lg * 2 });
  
  if (badge) {
    const badgeW = renderBadge(doc, L + W - badge.text.length * 20 - STYLE.spacing.lg, y + 7, badge.text, badge.color);
  }
  
  doc.y = y + h + STYLE.spacing.md;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 3 — MCQ
// ─────────────────────────────────────────────────────────────────────────────
function renderMcqQuestions(doc, questions, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  for (let qi = 0; qi < questions.length; qi++) {
    const q           = questions[qi];
    const studentAns  = safeText(answerMap && answerMap[q.id]);
    const correctAns  = safeText(q.correctAnswer);
    const isCorrect   = studentAns.length > 0 && studentAns === correctAns;
    const notAnswered = !studentAns;

    ensureSpace(doc, 88);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(`${qi + 1}. ${safeText(q.text)}`, L, doc.y, { width: W });
    doc.moveDown(0.3);

    const options = Array.isArray(q.options) ? q.options : [];
    for (let oi = 0; oi < options.length; oi++) {
      const opt    = safeText(options[oi]);
      const letter = OPTION_LETTERS[oi] || String(oi + 1);
      const isSelected    = opt === studentAns;
      const isCorrectOpt  = opt === correctAns;

      let bg, fg, bd;
      if (isSelected && isCorrect) {
        bg = STYLE.colors.successBg; fg = STYLE.colors.success; bd = STYLE.colors.successBd;
      } else if (isSelected && !isCorrect) {
        bg = STYLE.colors.errorBg;   fg = STYLE.colors.error;   bd = STYLE.colors.errorBd;
      } else if (isCorrectOpt && !notAnswered) {
        bg = STYLE.colors.correctHint; fg = STYLE.colors.success; bd = STYLE.colors.correctHintBd;
      } else {
        bg = STYLE.colors.white; fg = STYLE.colors.neutral; bd = STYLE.colors.border;
      }

      ensureSpace(doc, 26);
      const optY = doc.y;
      const optH = 22;
      doc.save();
      doc.roundedRect(L + 18, optY, W - 18, optH, 4).fillAndStroke(bg, bd);
      doc.restore();

      const marker = isSelected ? (isCorrect ? '✓ ' : '✗ ') : '  ';
      doc.font(isSelected ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(fg)
        .text(`${marker}${letter}. ${opt}`, L + 26, optY + 6, { width: W - 34 });
      doc.y = optY + optH + 4;
    }

    if (notAnswered) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.warning)
        .text(`Not answered. Correct: ${correctAns}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    } else if (!isCorrect) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.primary)
        .text(`Correct answer: ${correctAns}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    }

    doc.moveDown(0.7);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 1 — DRAG & DROP
// ─────────────────────────────────────────────────────────────────────────────
function renderDragDrop(doc, activity, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  const items = Array.isArray(activity && activity.items) ? activity.items : [];
  if (items.length === 0) return;

  ensureSpace(doc, 44);
  renderSectionTitle(doc, safeText(activity.title) || 'Activity 1: Drag and Drop');

  if (activity.instructions) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
      .text(safeText(activity.instructions), L, doc.y, { width: W });
    doc.moveDown(0.5);
  }

  // Render items with student answers
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemId = safeText(item.id);
    const studentAns = safeText(answerMap && answerMap[itemId]);
    const correctOrder = safeNumber(item.correctOrder, 0);
    const isCorrect = studentAns === itemId && studentAns.length > 0;

    ensureSpace(doc, 30);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(`${i + 1}. Item ${itemId}`, L, doc.y, { width: W });
    doc.moveDown(0.2);

    const bg = isCorrect ? STYLE.colors.successBg : (studentAns ? STYLE.colors.errorBg : STYLE.colors.tableHdr);
    const fg = isCorrect ? STYLE.colors.success : (studentAns ? STYLE.colors.error : STYLE.colors.muted);
    const bd = isCorrect ? STYLE.colors.successBd : (studentAns ? STYLE.colors.errorBd : STYLE.colors.border);

    doc.save();
    doc.roundedRect(L + 18, doc.y, W - 18, 20, 4).fillAndStroke(bg, bd);
    doc.restore();

    const displayText = studentAns ? `Student placed at position: ${studentAns}` : 'Not answered';
    doc.font('Helvetica').fontSize(10).fillColor(fg)
      .text(displayText, L + 26, doc.y + 6, { width: W - 34 });
    doc.y += 24;

    if (!isCorrect && studentAns) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.primary)
        .text(`Correct position: ${correctOrder}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    }

    doc.moveDown(0.4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 2 — CLASSIFICATION
// ─────────────────────────────────────────────────────────────────────────────
function renderClassification(doc, activity, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  const items = Array.isArray(activity && activity.items) ? activity.items : [];
  if (items.length === 0) return;

  ensureSpace(doc, 44);
  renderSectionTitle(doc, safeText(activity.title) || 'Activity 2: Classification');

  if (activity.instructions) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
      .text(safeText(activity.instructions), L, doc.y, { width: W });
    doc.moveDown(0.5);
  }

  // Render items with student answers
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemId = safeText(item.id);
    const studentAns = safeText(answerMap && answerMap[itemId]);
    const correctCat = safeText(item.correctCategory);
    const isCorrect = studentAns.length > 0 && studentAns.toLowerCase() === correctCat.toLowerCase();

    ensureSpace(doc, 30);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(`${i + 1}. Item ${itemId}`, L, doc.y, { width: W });
    doc.moveDown(0.2);

    const bg = isCorrect ? STYLE.colors.successBg : (studentAns ? STYLE.colors.errorBg : STYLE.colors.tableHdr);
    const fg = isCorrect ? STYLE.colors.success : (studentAns ? STYLE.colors.error : STYLE.colors.muted);
    const bd = isCorrect ? STYLE.colors.successBd : (studentAns ? STYLE.colors.errorBd : STYLE.colors.border);

    doc.save();
    doc.roundedRect(L + 18, doc.y, W - 18, 20, 4).fillAndStroke(bg, bd);
    doc.restore();

    const displayText = studentAns ? `Student classified as: ${studentAns}` : 'Not answered';
    doc.font('Helvetica').fontSize(10).fillColor(fg)
      .text(displayText, L + 26, doc.y + 6, { width: W - 34 });
    doc.y += 24;

    if (!isCorrect && studentAns) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.primary)
        .text(`Correct category: ${correctCat}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    }

    doc.moveDown(0.4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 4 — FILL-IN-THE-BLANKS
// ─────────────────────────────────────────────────────────────────────────────
function renderFillInBlanks(doc, sentences, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    const parts    = Array.isArray(sentence.parts) ? sentence.parts : [];

    ensureSpace(doc, 40);
    const startY = doc.y;

    let lineX = L + 22;
    let lineY = startY;
    const maxX = L + W;

    doc.font('Helvetica-Bold').fontSize(10).fillColor(STYLE.colors.neutral)
      .text(`${si + 1}.`, L, lineY, { width: 18 });

    doc.font('Helvetica').fontSize(10);

    for (const part of parts) {
      if (part.type === 'text') {
        const t  = safeText(part.value);
        if (!t) continue;
        const tw = doc.widthOfString(t);
        if (lineX + tw > maxX + 2) {
          lineY += 18;
          lineX  = L + 22;
          doc.y  = lineY;
        }
        doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.neutral)
          .text(t, lineX, lineY, { lineBreak: false });
        lineX += tw + 2;

      } else if (part.type === 'blank') {
        const studentAns = safeText(answerMap && answerMap[part.blankId]);
        const correctAns = safeText(part.correctAnswer);
        const answered   = studentAns.length > 0;
        const isCorrect  = answered && studentAns.toLowerCase() === correctAns.toLowerCase();

        const display = answered ? studentAns : '______';
        doc.font('Helvetica-Bold').fontSize(10);
        const bw = Math.max(64, doc.widthOfString(display) + 14);

        if (lineX + bw > maxX + 2) {
          lineY += 18;
          lineX  = L + 22;
          doc.y  = lineY;
        }

        let bg, fg, bd;
        if (!answered) {
          bg = STYLE.colors.tableHdr; fg = STYLE.colors.muted; bd = STYLE.colors.border;
        } else if (isCorrect) {
          bg = STYLE.colors.successBg; fg = STYLE.colors.success; bd = STYLE.colors.successBd;
        } else {
          bg = STYLE.colors.errorBg; fg = STYLE.colors.error; bd = STYLE.colors.errorBd;
        }

        const boxY = lineY - 2;
        doc.save();
        doc.roundedRect(lineX, boxY, bw, 17, 3).fillAndStroke(bg, bd);
        doc.restore();

        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(fg)
          .text(display, lineX + 5, lineY, { width: bw - 10, lineBreak: false });
        lineX += bw + 3;

        if (answered && !isCorrect) {
          const hint = `(${correctAns})`;
          doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(STYLE.colors.primary);
          const hw = doc.widthOfString(hint);
          if (lineX + hw > maxX + 2) {
            lineY += 18;
            lineX  = L + 22;
          }
          doc.text(hint, lineX, lineY, { lineBreak: false });
          lineX += hw + 4;
        }
        doc.font('Helvetica').fontSize(10);
      }
    }

    doc.y = lineY + 18;
    doc.moveDown(0.6);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 5 — MATCHING PAIRS
// ─────────────────────────────────────────────────────────────────────────────
function renderMatchingPairs(doc, activity, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  const pairs = Array.isArray(activity && activity.pairs) ? activity.pairs : [];
  if (pairs.length === 0) return;

  ensureSpace(doc, 44);
  renderSectionTitle(doc, safeText(activity.title) || 'Activity 5: Matching Pairs');

  if (activity.instructions) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
      .text(safeText(activity.instructions), L, doc.y, { width: W });
    doc.moveDown(0.5);
  }

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    const pairId = safeText(pair.id);
    const studentAns = safeText(answerMap && answerMap[pairId]);
    const leftItem = safeText(pair.leftItem?.text || pair.leftItem);
    const rightItem = safeText(pair.rightItem?.text || pair.rightItem);
    
    const answered = studentAns.length > 0;
    const isCorrect = answered && studentAns === rightItem;

    ensureSpace(doc, 36);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(`${i + 1}. Match:`, L, doc.y, { width: W });
    doc.moveDown(0.2);

    const itemY = doc.y;
    const itemW = (W - 36 - STYLE.spacing.md) / 2;

    // Left item
    doc.save();
    doc.roundedRect(L, itemY, itemW, 24, STYLE.radius.sm).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
    doc.restore();
    doc.font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.neutral)
      .text(leftItem, L + STYLE.spacing.sm, itemY + 8, { width: itemW - STYLE.spacing.sm * 2 });

    // Arrow
    doc.font('Helvetica').fontSize(14).fillColor(STYLE.colors.muted)
      .text('→', L + itemW + STYLE.spacing.sm / 2, itemY + 6, { width: STYLE.spacing.md });

    // Right item (student's answer or placeholder)
    const rightY = itemY;
    let bg, fg, bd;
    if (!answered) {
      bg = STYLE.colors.tableHdr; fg = STYLE.colors.muted; bd = STYLE.colors.border;
    } else if (isCorrect) {
      bg = STYLE.colors.successBg; fg = STYLE.colors.success; bd = STYLE.colors.successBd;
    } else {
      bg = STYLE.colors.errorBg; fg = STYLE.colors.error; bd = STYLE.colors.errorBd;
    }

    const display = answered ? studentAns : 'Your answer';
    doc.save();
    doc.roundedRect(L + itemW + STYLE.spacing.md, rightY, itemW, 24, STYLE.radius.sm).fillAndStroke(bg, bd);
    doc.restore();
    doc.font(answered ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor(fg)
      .text(display, L + itemW + STYLE.spacing.md + STYLE.spacing.sm, rightY + 8, { width: itemW - STYLE.spacing.sm * 2 });

    doc.y = rightY + 28;

    if (!isCorrect && answered) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.primary)
        .text(`Correct match: ${rightItem}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    } else if (!answered) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.warning)
        .text('Not answered', L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    }

    doc.moveDown(0.3);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVITY 6 — TRUE / FALSE
// ─────────────────────────────────────────────────────────────────────────────
function renderTrueFalse(doc, activity, answerMap) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  const questions = Array.isArray(activity && activity.questions) ? activity.questions : [];
  if (questions.length === 0) return;

  ensureSpace(doc, 44);
  renderSectionTitle(doc, safeText(activity.title) || 'Activity 6: True / False');

  if (activity.instructions) {
    doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
      .text(safeText(activity.instructions), L, doc.y, { width: W });
    doc.moveDown(0.5);
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const qId = safeText(q.id);
    const studentAns = answerMap && answerMap[qId];
    const correctAns = q.correctAnswer; // boolean
    
    const answered = studentAns !== undefined && studentAns !== null && studentAns !== '';
    const studentBool = answered ? (String(studentAns).toLowerCase() === 'true') : null;
    const isCorrect = answered && (studentBool === correctAns);

    ensureSpace(doc, 50);

    doc.font('Helvetica-Bold').fontSize(10.5).fillColor(STYLE.colors.neutral)
      .text(`${i + 1}. ${safeText(q.text)}`, L, doc.y, { width: W });
    doc.moveDown(0.3);

    const btnY = doc.y;
    const btnW = 80;
    const btnH = 26;
    const gap = STYLE.spacing.md;

    // True button
    const trueSelected = studentBool === true;
    const trueCorrect = correctAns === true;
    let trueBg, trueFg, trueBd;
    if (!answered) {
      trueBg = STYLE.colors.white; trueFg = STYLE.colors.neutral; trueBd = STYLE.colors.border;
    } else if (trueSelected && trueCorrect) {
      trueBg = STYLE.colors.successBg; trueFg = STYLE.colors.success; trueBd = STYLE.colors.successBd;
    } else if (trueSelected && !trueCorrect) {
      trueBg = STYLE.colors.errorBg; trueFg = STYLE.colors.error; trueBd = STYLE.colors.errorBd;
    } else if (!trueSelected && trueCorrect) {
      trueBg = STYLE.colors.correctHint; trueFg = STYLE.colors.success; trueBd = STYLE.colors.correctHintBd;
    } else {
      trueBg = STYLE.colors.white; trueFg = STYLE.colors.neutral; trueBd = STYLE.colors.border;
    }

    doc.save();
    doc.roundedRect(L, btnY, btnW, btnH, STYLE.radius.sm).fillAndStroke(trueBg, trueBd);
    doc.restore();
    doc.font(trueSelected ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(trueFg)
      .text('True', L + STYLE.spacing.sm, btnY + 8, { width: btnW - STYLE.spacing.sm * 2 });

    // False button
    const falseSelected = studentBool === false;
    const falseCorrect = correctAns === false;
    let falseBg, falseFg, falseBd;
    if (!answered) {
      falseBg = STYLE.colors.white; falseFg = STYLE.colors.neutral; falseBd = STYLE.colors.border;
    } else if (falseSelected && falseCorrect) {
      falseBg = STYLE.colors.successBg; falseFg = STYLE.colors.success; falseBd = STYLE.colors.successBd;
    } else if (falseSelected && !falseCorrect) {
      falseBg = STYLE.colors.errorBg; falseFg = STYLE.colors.error; falseBd = STYLE.colors.errorBd;
    } else if (!falseSelected && falseCorrect) {
      falseBg = STYLE.colors.correctHint; falseFg = STYLE.colors.success; falseBd = STYLE.colors.correctHintBd;
    } else {
      falseBg = STYLE.colors.white; falseFg = STYLE.colors.neutral; falseBd = STYLE.colors.border;
    }

    doc.save();
    doc.roundedRect(L + btnW + gap, btnY, btnW, btnH, STYLE.radius.sm).fillAndStroke(falseBg, falseBd);
    doc.restore();
    doc.font(falseSelected ? 'Helvetica-Bold' : 'Helvetica').fontSize(10).fillColor(falseFg)
      .text('False', L + btnW + gap + STYLE.spacing.sm, btnY + 8, { width: btnW - STYLE.spacing.sm * 2 });

    doc.y = btnY + btnH + 8;

    if (!answered) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.warning)
        .text('Not answered', L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    } else if (!isCorrect) {
      doc.font('Helvetica-Oblique').fontSize(9).fillColor(STYLE.colors.primary)
        .text(`Correct answer: ${correctAns ? 'True' : 'False'}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.3);
    }

    if (q.explanation) {
      doc.font('Helvetica-Oblique').fontSize(8.5).fillColor(STYLE.colors.muted)
        .text(`Explanation: ${safeText(q.explanation)}`, L + 18, doc.y, { width: W - 18 });
      doc.moveDown(0.4);
    }

    doc.moveDown(0.4);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// STATS CARDS ROW
// ─────────────────────────────────────────────────────────────────────────────
function renderStatsRow(doc, stats) {
  const L     = doc.page.margins.left;
  const W     = pageW(doc);
  const n     = stats.length;
  const gap   = STYLE.spacing.md;
  const cardW = Math.floor((W - gap * (n - 1)) / n);
  const cardH = 85;

  ensureSpace(doc, cardH + STYLE.spacing.lg);
  const y = doc.y;

  for (let i = 0; i < n; i++) {
    const sx = L + i * (cardW + gap);
    const { label, value, icon, color, trend } = stats[i];

    renderStatCard(doc, sx, y, cardW, cardH, { label, value, icon, color, trend });
  }

  doc.y = y + cardH + STYLE.spacing.lg;
}

// ─────────────────────────────────────────────────────────────────────────────
// PARTICIPANT TABLE
// ─────────────────────────────────────────────────────────────────────────────
function renderParticipantTable(doc, headers, rows, columnWidths) {
  const L  = doc.page.margins.left;
  const W  = pageW(doc);
  const cw = columnWidths || headers.map(() => Math.floor(W / headers.length));

  const total = cw.reduce((a, b) => a + b, 0);
  const scale = total > W ? W / total : 1;
  const scaledCw = cw.map(w => Math.floor(w * scale));

  const padX = 8;
  const padY = 5;
  const hdrH = 24;

  ensureSpace(doc, hdrH + 10);
  const hy = doc.y;

  doc.save();
  doc.rect(L, hy, W, hdrH).fill(STYLE.colors.tableHdr);
  doc.rect(L, hy, W, hdrH).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(9.5).fillColor(STYLE.colors.neutral);
  let cx = L;
  for (let i = 0; i < headers.length; i++) {
    doc.text(headers[i], cx + padX, hy + padY, { width: scaledCw[i] - padX * 2 });
    cx += scaledCw[i];
  }
  doc.y = hy + hdrH;

  for (let r = 0; r < rows.length; r++) {
    const cells = Array.isArray(rows[r]) ? rows[r] : [];
    const cellH = cells.map((cell, i) =>
      doc.font('Helvetica').fontSize(9.5)
        .heightOfString(safeText(cell), { width: scaledCw[i] - padX * 2 })
    );
    const rowH = Math.max(24, Math.max(...cellH.filter(Number.isFinite), 0) + padY * 2);

    ensureSpace(doc, rowH + 4);
    const ry = doc.y;

    doc.save();
    doc.rect(L, ry, W, rowH).fill(r % 2 === 0 ? STYLE.colors.white : STYLE.colors.altRow);
    doc.rect(L, ry, W, rowH).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
    let lx = L;
    for (let i = 1; i < headers.length; i++) {
      lx += scaledCw[i - 1];
      doc.moveTo(lx, ry).lineTo(lx, ry + rowH)
        .strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
    }
    doc.restore();

    let tx = L;
    doc.font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.neutral);
    for (let i = 0; i < cells.length; i++) {
      doc.text(safeText(cells[i]), tx + padX, ry + padY, { width: scaledCw[i] - padX * 2 });
      tx += scaledCw[i];
    }
    doc.y = ry + rowH;
  }
  doc.moveDown(0.6);
}

// ─────────────────────────────────────────────────────────────────────────────
// SHARED: build + pipe PDFDocument
// ─────────────────────────────────────────────────────────────────────────────
function buildDoc(outputPath) {
  const doc    = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 50, bottom: 50, left: 40, right: 40 } });
  const stream = fs.createWriteStream(outputPath);
  doc.pipe(stream);
  return { doc, stream };
}

function finalizeDoc(doc, stream, headerTitle, outputPath) {
  return new Promise((resolve, reject) => {
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      drawPageHeaderFooter(doc, { title: headerTitle, pageNumber: i + 1, totalPages: range.count });
    }
    doc.end();
    stream.on('finish', () => resolve(outputPath));
    stream.on('error',  reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT 1: Individual student worksheet submission PDF
// ─────────────────────────────────────────────────────────────────────────────
async function generateWorksheetSubmissionPdf(data, outputPath) {
  const ws         = (data.worksheet  && typeof data.worksheet  === 'object') ? data.worksheet  : {};
  const submission = (data.submission && typeof data.submission === 'object') ? data.submission : {};
  const assignment = (data.assignment && typeof data.assignment === 'object') ? data.assignment : {};

  const studentName  = safeText(data.studentName);
  const submittedAt  = safeText(data.submittedAt);
  const wsTitle      = safeText(ws.title) || 'Worksheet';
  const percentage   = safeNumber(submission.percentage,        0);
  const totalEarned  = safeNumber(submission.totalPointsEarned, 0);
  const totalPossible= safeNumber(submission.totalPointsPossible, 0);
  const scoreStr     = totalPossible > 0 ? `${totalEarned}/${totalPossible}` : undefined;
  const timeTaken    = safeNumber(submission.timeTaken, 0);

  // Build answer maps keyed by questionId
  const a1Map = {};
  const a2Map = {};
  const a3Map = {};
  const a4Map = {};
  const a5Map = {};
  const a6Map = {};
  for (const ans of (Array.isArray(submission.answers) ? submission.answers : [])) {
    const sectionId = safeText(ans.sectionId);
    const questionId = safeText(ans.questionId);
    const studentAnswer = safeText(ans.studentAnswer);
    if (sectionId === 'activity1') a1Map[questionId] = studentAnswer;
    if (sectionId === 'activity2') a2Map[questionId] = studentAnswer;
    if (sectionId === 'activity3') a3Map[questionId] = studentAnswer;
    if (sectionId === 'activity4') a4Map[questionId] = studentAnswer;
    if (sectionId === 'activity5') a5Map[questionId] = studentAnswer;
    if (sectionId === 'activity6') a6Map[questionId] = studentAnswer;
  }

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const { doc, stream } = buildDoc(outputPath);

  try {
    renderDocHeader(doc, {
      worksheetTitle: wsTitle,
      subtitle:       safeText(ws.description) || undefined,
      studentName,
      submittedAt,
      score:          scoreStr,
      percentage,
      worksheetMeta: {
        subject: ws.subject,
        cefrLevel: ws.cefrLevel,
        gradeLevel: ws.gradeLevel,
        gradeCategory: ws.gradeCategory,
        difficulty: ws.difficulty,
      },
    });
    
    // Performance summary card for student
    const L = doc.page.margins.left;
    const W = pageW(doc);
    
    ensureSpace(doc, 100);
    const summaryY = doc.y;
    
    // Summary card background
    doc.save();
    doc.roundedRect(L, summaryY, W, 80, STYLE.radius.lg).fillAndStroke(STYLE.colors.bg, STYLE.colors.border);
    doc.restore();
    
    doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral);
    doc.text('Performance Summary', L + STYLE.spacing.lg, summaryY + STYLE.spacing.md, { width: W - STYLE.spacing.lg * 2 });
    
    // Summary stats
    const summaryStats = [
      { label: 'Score', value: `${Math.round(percentage)}%`, color: getScoreColor(percentage) },
      { label: 'Points', value: `${totalEarned}/${totalPossible}`, color: STYLE.colors.neutral },
      { label: 'Time', value: formatTime(timeTaken), color: STYLE.colors.info },
      { label: 'Status', value: submission.isLate ? 'Late' : 'On Time', color: submission.isLate ? STYLE.colors.error : STYLE.colors.success },
    ];
    
    const statW = (W - STYLE.spacing.lg * 2 - STYLE.spacing.md * 3) / 4;
    let sx = L + STYLE.spacing.lg;
    summaryStats.forEach(stat => {
      doc.save();
      doc.roundedRect(sx, summaryY + 36, statW, 32, STYLE.radius.sm).fillAndStroke(STYLE.colors.white, STYLE.colors.border);
      doc.restore();
      
      doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted);
      doc.text(stat.label, sx + STYLE.spacing.sm, summaryY + 42, { width: statW - STYLE.spacing.sm * 2 });
      
      doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(stat.color);
      doc.text(stat.value, sx + STYLE.spacing.sm, summaryY + 54, { width: statW - STYLE.spacing.sm * 2 });
      
      sx += statW + STYLE.spacing.md;
    });
    
    doc.y = summaryY + 80 + STYLE.spacing.lg;

    // ── Section-wise Performance Summary ─────────────────────────────────────
    const sectionSummary = [];
    const ACTIVITY_LABELS = {
      activity1: 'Drag & Drop',
      activity2: 'Classification',
      activity3: 'Multiple Choice',
      activity4: 'Fill in the Blanks',
      activity5: 'Matching Pairs',
      activity6: 'True / False',
    };

    // Calculate per-section performance
    const sectionStats = {};
    (Array.isArray(submission.answers) ? submission.answers : []).forEach(ans => {
      const sid = safeText(ans.sectionId);
      if (!sectionStats[sid]) {
        sectionStats[sid] = { correct: 0, total: 0, attempted: 0 };
      }
      sectionStats[sid].total++;
      if (ans.isCorrect) sectionStats[sid].correct++;
      if (ans.studentAnswer && ans.studentAnswer.trim()) {
        sectionStats[sid].attempted++;
      }
    });

    Object.entries(sectionStats).forEach(([sid, stats]) => {
      if (stats.total > 0) {
        const accuracy = Math.round((stats.correct / stats.total) * 100);
        const completion = Math.round((stats.attempted / stats.total) * 100);
        sectionSummary.push({
          label: ACTIVITY_LABELS[sid] || titleizeId(sid),
          accuracy,
          completion,
          correct: stats.correct,
          total: stats.total,
        });
      }
    });

    if (sectionSummary.length > 0) {
      ensureSpace(doc, 120);
      const sectionY = doc.y;

      // Section summary card
      doc.save();
      doc.roundedRect(L, sectionY, W, 100, STYLE.radius.lg).fillAndStroke(STYLE.colors.bg, STYLE.colors.border);
      doc.restore();

      doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral);
      doc.text('Section Performance', L + STYLE.spacing.lg, sectionY + STYLE.spacing.md, { width: W - STYLE.spacing.lg * 2 });

      const numSections = sectionSummary.length;
      const sectionCardW = (W - STYLE.spacing.lg * 2 - STYLE.spacing.md * (numSections - 1)) / numSections;
      let sx = L + STYLE.spacing.lg;

      sectionSummary.forEach(section => {
        const cardY = sectionY + 36;
        doc.save();
        doc.roundedRect(sx, cardY, sectionCardW, 56, STYLE.radius.md).fillAndStroke(STYLE.colors.white, STYLE.colors.border);
        doc.restore();

        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted);
        doc.text(section.label, sx + STYLE.spacing.sm, cardY + 8, { width: sectionCardW - STYLE.spacing.sm * 2 });

        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.lg).fillColor(getScoreColor(section.accuracy));
        doc.text(`${section.accuracy}%`, sx + STYLE.spacing.sm, cardY + 20, { width: sectionCardW - STYLE.spacing.sm * 2 });

        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted);
        doc.text(`${section.correct}/${section.total} correct`, sx + STYLE.spacing.sm, cardY + 36, { width: sectionCardW - STYLE.spacing.sm * 2 });

        // Completion bar
        const barW = sectionCardW - STYLE.spacing.sm * 2;
        const barH = 6;
        const barY = cardY + 46;
        doc.save();
        doc.roundedRect(sx + STYLE.spacing.sm, barY, barW, barH, 3).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
        const fillW = Math.max(0, Math.min(barW, Math.round(barW * section.completion / 100)));
        if (fillW > 0) {
          doc.roundedRect(sx + STYLE.spacing.sm, barY, fillW, barH, 3).fill(STYLE.colors.primary);
        }
        doc.restore();

        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted);
        doc.text(`${section.completion}% completed`, sx + STYLE.spacing.sm, barY + 10, { width: sectionCardW - STYLE.spacing.sm * 2 });

        sx += sectionCardW + STYLE.spacing.md;
      });

      doc.y = sectionY + 100 + STYLE.spacing.lg;
    }

    // ── Question-by-Question Review Table ─────────────────────────────────────
    const reviewRows = [];
    (Array.isArray(submission.answers) ? submission.answers : []).forEach(ans => {
      const sid = safeText(ans.sectionId);
      const sectionLabel = ACTIVITY_LABELS[sid] || titleizeId(sid);
      const studentAns = safeText(ans.studentAnswer);
      const isCorrect = ans.isCorrect;
      
      reviewRows.push([
        sectionLabel,
        safeText(ans.questionId || `Q${reviewRows.length + 1}`),
        studentAns || 'Not answered',
        isCorrect ? '✓ Correct' : '✗ Wrong',
      ]);
    });

    if (reviewRows.length > 0) {
      renderSectionTitle(doc, 'Question Review', { text: `${reviewRows.length} Questions`, color: STYLE.colors.info });
      
      const reviewColW = [100, 80, W - 260, 80];
      renderMiniTable(doc, ['Section', 'Question', 'Your Answer', 'Result'], reviewRows, { columnWidths: reviewColW });
      doc.y += STYLE.spacing.lg;
    }

    // Activity 1 — Drag & Drop
    const a1 = ws.activity1;
    if (a1 && (a1.items || []).length > 0) {
      renderDragDrop(doc, a1, a1Map);
    }

    // Activity 2 — Classification
    const a2 = ws.activity2;
    if (a2 && (a2.items || []).length > 0) {
      renderClassification(doc, a2, a2Map);
    }

    // Activity 3 — MCQ
    const a3 = ws.activity3;
    const a3Questions = Array.isArray(a3 && a3.questions) ? a3.questions : [];
    if (a3Questions.length > 0) {
      renderSectionTitle(doc, safeText(a3.title) || 'Activity 3: Quick Quiz');
      if (a3.instructions) {
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
          .text(safeText(a3.instructions), doc.page.margins.left, doc.y, { width: pageW(doc) });
        doc.moveDown(0.5);
      }
      renderMcqQuestions(doc, a3Questions, a3Map);
    }

    // Activity 4 — Fill in the blanks
    const a4 = ws.activity4;
    const a4Sentences = Array.isArray(a4 && a4.sentences) ? a4.sentences : [];
    if (a4Sentences.length > 0) {
      renderSectionTitle(doc, safeText(a4.title) || 'Activity 4: Fill in the Blanks');
      const wordBank = Array.isArray(a4.wordBank) ? a4.wordBank : [];
      if (wordBank.length) {
        const L = doc.page.margins.left;
        const W = pageW(doc);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(STYLE.colors.neutral)
          .text('Word Bank:', L, doc.y, { width: W });
        doc.moveDown(0.2);
        doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.muted)
          .text(wordBank.join('   •   '), L, doc.y, { width: W });
        doc.moveDown(0.7);
      }
      if (a4.instructions) {
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor(STYLE.colors.muted)
          .text(safeText(a4.instructions), doc.page.margins.left, doc.y, { width: pageW(doc) });
        doc.moveDown(0.5);
      }
      renderFillInBlanks(doc, a4Sentences, a4Map);
    }

    // Activity 5 — Matching Pairs
    const a5 = ws.activity5;
    if (a5 && (a5.pairs || []).length > 0) {
      renderMatchingPairs(doc, a5, a5Map);
    }

    // Activity 6 — True / False
    const a6 = ws.activity6;
    const a6Questions = Array.isArray(a6 && a6.questions) ? a6.questions : [];
    if (a6Questions.length > 0) {
      renderTrueFalse(doc, a6, a6Map);
    }

    // If no activities were included
    const hasActivities = (a1 && a1.items?.length > 0) || (a2 && a2.items?.length > 0) || a3Questions.length > 0 || a4Sentences.length > 0 || (a5 && a5.pairs?.length > 0) || a6Questions.length > 0;
    if (!hasActivities) {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.muted)
        .text('No gradable activities recorded for this submission.', doc.page.margins.left, doc.y, { width: pageW(doc) });
    }
  } catch (err) {
    try { doc.end(); } catch { /* ignore */ }
    throw err;
  }

  return finalizeDoc(doc, stream, `${wsTitle} — Student Worksheet`, outputPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT 2: Full worksheet submission report (all students)
// ─────────────────────────────────────────────────────────────────────────────

function renderProgressBar(doc, x, y, w, h, pct, color) {
  doc.save();
  doc.roundedRect(x, y, w, h, h / 2).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
  const fillW = Math.max(0, Math.min(w, Math.round(w * pct / 100)));
  if (fillW > 0) {
    doc.roundedRect(x, y, fillW, h, h / 2).fill(color || STYLE.colors.primary);
  }
  doc.restore();
}

async function generateWorksheetReportPdf(data, outputPath) {
  const ws          = (data.worksheet && typeof data.worksheet === 'object') ? data.worksheet : {};
  const submissions = Array.isArray(data.submissions) ? data.submissions : [];
  const assignment   = (data.assignment && typeof data.assignment === 'object') ? data.assignment : {};
  const teacher      = (data.teacher && typeof data.teacher === 'object') ? data.teacher : null;

  const wsTitle   = safeText(ws.title) || 'Worksheet';
  const total     = submissions.length;
  const totalAssigned = safeNumber(data.totalAssigned, total);
  const completionRate = totalAssigned > 0 ? Math.round((total / totalAssigned) * 100) : 0;

  // ── Aggregate stats ────────────────────────────────────────────────────────
  const scores    = submissions.map(s => safeNumber(s.percentage, 0));
  const avgScore  = total > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / total) : 0;
  const highScore = total > 0 ? Math.round(Math.max(...scores)) : 0;
  const lowScore  = total > 0 ? Math.round(Math.min(...scores)) : 0;
  const passCount = scores.filter(s => s >= 70).length;
  const passRate  = total > 0 ? Math.round((passCount / total) * 100) : 0;
  const lateCount = submissions.filter(s => s.isLate).length;
  const avgTimeSec = total > 0
    ? Math.round(submissions.reduce((s, sub) => s + safeNumber(sub.timeTaken, 0), 0) / total)
    : 0;
  
  // Calculate median score
  const medianScore = scores.length > 0
    ? Math.round([...scores].sort((a, b) => a - b)[Math.floor(scores.length / 2)])
    : 0;

  // Additional statistics
  const pendingStudents = Math.max(0, totalAssigned - total);
  const completedStudents = total;
  const avgAccuracy = total > 0 ? avgScore : 0; // Accuracy is essentially the same as score for worksheets

  // ── Enhanced per-activity stats with completion metrics ──────────────────
  const activityStats = {};
  submissions.forEach(sub => {
    (sub.answers || []).forEach(ans => {
      const sid = safeText(ans.sectionId) || 'unknown';
      if (!activityStats[sid]) {
        activityStats[sid] = { correct: 0, total: 0, skipped: 0, attempted: 0 };
      }
      activityStats[sid].total++;
      if (ans.isCorrect) activityStats[sid].correct++;
      if (ans.studentAnswer && ans.studentAnswer.trim()) {
        activityStats[sid].attempted++;
      } else {
        activityStats[sid].skipped++;
      }
    });
  });

  const ACTIVITY_LABELS = {
    activity1: 'Drag & Drop',
    activity2: 'Classification',
    activity3: 'Multiple Choice',
    activity4: 'Fill in the Blanks',
    activity5: 'Matching Pairs',
    activity6: 'True / False',
  };

  const activityBreakdown = Object.entries(activityStats)
    .filter(([, s]) => s.total > 0)
    .map(([sid, s]) => {
      const correctRate = s.total > 0 ? Math.round((s.correct / s.total) * 100) : 0;
      const wrongRate = s.total > 0 ? Math.round(((s.total - s.correct - s.skipped) / s.total) * 100) : 0;
      const completionRate = s.total > 0 ? Math.round((s.attempted / s.total) * 100) : 0;
      const avgScore = s.total > 0 ? Math.round((s.correct / s.attempted) * 100) : 0;
      
      // Determine difficulty based on correct rate
      let difficulty = 'Easy';
      if (correctRate < 50) difficulty = 'Hard';
      else if (correctRate < 70) difficulty = 'Medium';
      
      // Get total questions for this section from worksheet
      let totalQuestions = 0;
      if (sid === 'activity1' && ws.activity1?.items) totalQuestions = ws.activity1.items.length;
      else if (sid === 'activity2' && ws.activity2?.items) totalQuestions = ws.activity2.items.length;
      else if (sid === 'activity3' && ws.activity3?.questions) totalQuestions = ws.activity3.questions.length;
      else if (sid === 'activity4' && ws.activity4?.sentences) totalQuestions = ws.activity4.sentences.length;
      else if (sid === 'activity5' && ws.activity5?.pairs) totalQuestions = ws.activity5.pairs.length;
      else if (sid === 'activity6' && ws.activity6?.questions) totalQuestions = ws.activity6.questions.length;
      
      return {
        sectionId: sid,
        label: ACTIVITY_LABELS[sid] || titleizeId(sid),
        correctRate,
        wrongRate,
        completionRate,
        avgScore,
        difficulty,
        correct: s.correct,
        total: s.total,
        totalQuestions,
        skipped: s.skipped,
        attempted: s.attempted,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));

  // ── Find most missed questions per section ────────────────────────────────
  const sectionQuestionStats = {};
  submissions.forEach(sub => {
    (sub.answers || []).forEach(ans => {
      const sid = safeText(ans.sectionId);
      const qid = safeText(ans.questionId);
      const key = `${sid}_${qid}`;
      if (!sectionQuestionStats[key]) {
        sectionQuestionStats[key] = { sectionId: sid, questionId: qid, correct: 0, total: 0, skipped: 0 };
      }
      sectionQuestionStats[key].total++;
      if (ans.isCorrect) sectionQuestionStats[key].correct++;
      if (!ans.studentAnswer || !ans.studentAnswer.trim()) sectionQuestionStats[key].skipped++;
    });
  });
  
  // Group by section and find most missed
  const mostMissedBySection = {};
  Object.values(sectionQuestionStats).forEach(stat => {
    const missedRate = stat.total > 0 ? (stat.total - stat.correct) / stat.total : 0;
    if (!mostMissedBySection[stat.sectionId] || missedRate > mostMissedBySection[stat.sectionId].missedRate) {
      mostMissedBySection[stat.sectionId] = { ...stat, missedRate };
    }
  });

  // ── Per-student activity breakdown ────────────────────────────────────────
  const studentRows = submissions.map(sub => {
    const raw  = sub.studentId;
    const name = (raw && typeof raw === 'object')
      ? safeText(raw.displayName || raw.email) : safeText(raw);
    const overall = `${Math.round(safeNumber(sub.percentage, 0))}%`;
    const perAct  = {};
    (sub.answers || []).forEach(ans => {
      const sid = safeText(ans.sectionId);
      if (!perAct[sid]) perAct[sid] = { correct: 0, total: 0, attempted: 0 };
      perAct[sid].total++;
      if (ans.isCorrect) perAct[sid].correct++;
      if (ans.studentAnswer && ans.studentAnswer.trim()) perAct[sid].attempted++;
    });
    return { 
      name, 
      overall, 
      perAct, 
      time: formatTime(safeNumber(sub.timeTaken, 0)),
      date: sub.submittedAt ? formatDate(sub.submittedAt) : '',
      status: sub.isLate ? 'Late' : 'On Time',
      attempts: sub.attempts || 1
    };
  });

  // ── MCQ question difficulty (activity3) ──────────────────────────────────
  const mcqQuestions = Array.isArray(ws.activity3 && ws.activity3.questions)
    ? ws.activity3.questions : [];
  const mcqStats = {};
  submissions.forEach(sub => {
    (sub.answers || []).forEach(ans => {
      if (safeText(ans.sectionId) !== 'activity3') return;
      const qid = safeText(ans.questionId);
      if (!mcqStats[qid]) mcqStats[qid] = { correct: 0, total: 0, skipped: 0 };
      mcqStats[qid].total++;
      if (ans.isCorrect) mcqStats[qid].correct++;
      if (!ans.studentAnswer || !ans.studentAnswer.trim()) mcqStats[qid].skipped++;
    });
  });

  // ── T/F question difficulty (activity6) ──────────────────────────────────
  const tfQuestions = Array.isArray(ws.activity6 && ws.activity6.questions)
    ? ws.activity6.questions : [];
  const tfStats = {};
  submissions.forEach(sub => {
    (sub.answers || []).forEach(ans => {
      if (safeText(ans.sectionId) !== 'activity6') return;
      const qid = safeText(ans.questionId);
      if (!tfStats[qid]) tfStats[qid] = { correct: 0, total: 0, skipped: 0 };
      tfStats[qid].total++;
      if (ans.isCorrect) tfStats[qid].correct++;
      if (!ans.studentAnswer || !ans.studentAnswer.trim()) tfStats[qid].skipped++;
    });
  });

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const { doc, stream } = buildDoc(outputPath);

  try {
    const L = doc.page.margins.left;
    const W = pageW(doc);

    // ── COVER: title + metadata ───────────────────────────────────────────
    doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xl).fillColor(STYLE.colors.neutral)
      .text(wsTitle, L, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.muted)
      .text('Class Submission Report', L, doc.y, { width: W });
    doc.moveDown(0.25);

    const metaTags = [];
    if (ws.subject) metaTags.push(safeText(ws.subject));
    if (ws.cefrLevel) metaTags.push(`CEFR: ${safeText(ws.cefrLevel)}`);
    if (ws.gradeLevel) metaTags.push(`Grade: ${safeText(ws.gradeLevel)}`);
    if (ws.difficulty) metaTags.push(formatDifficulty(ws.difficulty));
    if (metaTags.length > 0) {
      doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.primary)
        .text(metaTags.join('  •  '), L, doc.y, { width: W });
      doc.moveDown(0.4);
    }

    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
    doc.y += STYLE.spacing.lg;

    // ── Enhanced worksheet details card ──────────────────────────────────────
    renderWorksheetDetailsCard(doc, {
      title: ws.title,
      subject: ws.subject,
      cefrLevel: ws.cefrLevel,
      gradeCategory: ws.gradeCategory,
      gradeLevel: ws.gradeLevel,
      difficulty: formatDifficulty(ws.difficulty),
      worksheetType: getWorksheetTypeLabel(ws),
      totalQuestions: getWorksheetTotalQuestions(ws),
      assignmentDate: assignment.createdAt || ws.createdAt,
      dueDate: assignment.deadline || ws.assignmentDeadline,
      teacherName: teacher ? (teacher.displayName || teacher.email) : null,
      language: ws.language,
    });

    // ── Enhanced summary stats row (12 cards with icons) ──────────────────────
    const badge = getScoreBadge(avgScore);
    renderStatsRow(doc, [
      { label: 'Total Students', value: String(totalAssigned), icon: '👥', color: STYLE.colors.info },
      { label: 'Completed', value: String(completedStudents), icon: '✓', color: STYLE.colors.success },
      { label: 'Pending', value: String(pendingStudents), icon: '⏳', color: pendingStudents > 0 ? STYLE.colors.warning : STYLE.colors.success },
      { label: 'Completion', value: `${completionRate}%`, icon: '📊', color: STYLE.colors.success },
      { label: 'Average', value: `${avgScore}%`, icon: '🎯', color: getScoreColor(avgScore) },
      { label: 'Accuracy', value: `${avgAccuracy}%`, icon: '🎯', color: getScoreColor(avgAccuracy) },
      { label: 'Median', value: `${medianScore}%`, icon: '📈', color: getScoreColor(medianScore) },
      { label: 'Highest', value: `${highScore}%`, icon: '🏆', color: STYLE.colors.success },
      { label: 'Lowest', value: `${lowScore}%`, icon: '⚠️', color: STYLE.colors.warning },
      { label: 'Pass Rate', value: `${passRate}%`, icon: '✅', color: getScoreColor(passRate) },
      { label: 'Avg Time', value: formatTime(avgTimeSec), icon: '⏱️', color: STYLE.colors.info },
      { label: 'Late', value: String(lateCount), icon: '⏰', color: lateCount > 0 ? STYLE.colors.error : STYLE.colors.success },
    ]);

    // ── Enhanced Activity Breakdown with detailed metrics ──────────────────
    if (activityBreakdown.length > 0) {
      renderSectionTitle(doc, 'Section Performance Analysis', { text: `${activityBreakdown.length} Sections`, color: STYLE.colors.primary });
      
      const labelColW = 120;
      const numCols = 6;
      const metricsColW = (W - labelColW) / numCols;
      
      // Header row
      ensureSpace(doc, 26);
      const hdrY = doc.y;
      doc.save();
      doc.rect(L, hdrY, W, 24).fill(STYLE.colors.tableHdr);
      doc.rect(L, hdrY, W, 24).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
      doc.restore();
      
      doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.muted);
      let hx = L + STYLE.spacing.sm;
      doc.text('Section', hx, hdrY + 8, { width: labelColW });
      hx += labelColW;
      doc.text('Questions', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      hx += metricsColW;
      doc.text('Correct %', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      hx += metricsColW;
      doc.text('Wrong %', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      hx += metricsColW;
      doc.text('Completion', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      hx += metricsColW;
      doc.text('Difficulty', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      hx += metricsColW;
      doc.text('Most Missed', hx, hdrY + 8, { width: metricsColW, align: 'center' });
      doc.y = hdrY + 24;
      
      for (const act of activityBreakdown) {
        ensureSpace(doc, 32);
        const rowY = doc.y;
        
        doc.save();
        doc.rect(L, rowY, W, 28).fill(rowY % 56 < 28 ? STYLE.colors.white : STYLE.colors.altRow);
        doc.rect(L, rowY, W, 28).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
        doc.restore();
        
        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.neutral);
        let cx = L + STYLE.spacing.sm;
        doc.text(act.label, cx, rowY + 8, { width: labelColW });
        cx += labelColW;
        
        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.neutral);
        doc.text(String(act.totalQuestions || act.total), cx, rowY + 8, { width: metricsColW, align: 'center' });
        cx += metricsColW;
        
        const correctColor = getScoreColor(act.correctRate);
        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(correctColor);
        doc.text(`${act.correctRate}%`, cx, rowY + 8, { width: metricsColW, align: 'center' });
        cx += metricsColW;
        
        const wrongColor = act.wrongRate > 30 ? STYLE.colors.error : STYLE.colors.warning;
        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(wrongColor);
        doc.text(`${act.wrongRate}%`, cx, rowY + 8, { width: metricsColW, align: 'center' });
        cx += metricsColW;
        
        doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.neutral);
        doc.text(`${act.completionRate}%`, cx, rowY + 8, { width: metricsColW, align: 'center' });
        cx += metricsColW;
        
        // Difficulty badge
        const diffColor = act.difficulty === 'Hard' ? STYLE.colors.error : act.difficulty === 'Medium' ? STYLE.colors.warning : STYLE.colors.success;
        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(diffColor);
        doc.text(act.difficulty, cx, rowY + 8, { width: metricsColW, align: 'center' });
        cx += metricsColW;
        
        // Most missed indicator
        const mostMissed = mostMissedBySection[act.sectionId];
        if (mostMissed && mostMissed.missedRate > 0.3) {
          doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.error);
          doc.text('High', cx, rowY + 9, { width: metricsColW, align: 'center' });
        } else {
          doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.success);
          doc.text('Low', cx, rowY + 9, { width: metricsColW, align: 'center' });
        }
        
        doc.y = rowY + 28;
      }
      doc.y += STYLE.spacing.lg;
    }

    // ── Enhanced Participant Results with status and attempts ────────────────
    if (submissions.length > 0) {
      renderSectionTitle(doc, 'Participant Results', { text: `${studentRows.length} Students`, color: STYLE.colors.primary });

      const activeSections = Object.keys(activityStats)
        .filter(sid => activityStats[sid].total > 0)
        .sort();

      const actCols = activeSections.length > 0 ? activeSections : [];
      const fixedW  = [180, 60, 60, 70, 50];  // name, score, time, date, status
      const actColW = actCols.length > 0
        ? Math.floor((W - fixedW.reduce((a, b) => a + b, 0)) / actCols.length)
        : 0;
      const headers = ['Student', 'Score', 'Time', 'Date', 'Status',
        ...actCols.map(sid => ACTIVITY_LABELS[sid] ? ACTIVITY_LABELS[sid].split('—')[0].trim() : sid)];
      const colWidths = [...fixedW, ...actCols.map(() => actColW)];

      const rows = studentRows.map(sr => {
        const actCells = actCols.map(sid => {
          const s = sr.perAct[sid];
          return s && s.total > 0 ? `${Math.round((s.correct / s.total) * 100)}%` : '—';
        });
        return [sr.name, sr.overall, sr.time, sr.date, sr.status, ...actCells];
      });

      renderParticipantTable(doc, headers, rows, colWidths);
    } else {
      doc.font(STYLE.fonts.italic).fontSize(STYLE.sizes.sm).fillColor(STYLE.colors.muted)
        .text('No submissions yet.', L, doc.y, { width: W });
    }

    // ── Enhanced Question Difficulty Analysis with skip rate ─────────────────
    const hardMcq = mcqQuestions
      .filter(q => mcqStats[q.id] && mcqStats[q.id].total > 0)
      .map(q => {
        const s = mcqStats[q.id];
        return { text: safeText(q.text), pct: Math.round((s.correct / s.total) * 100), total: s.total, skipped: s.skipped };
      })
      .sort((a, b) => a.pct - b.pct);

    const hardTf = tfQuestions
      .filter(q => tfStats[q.id] && tfStats[q.id].total > 0)
      .map(q => {
        const s = tfStats[q.id];
        return { text: safeText(q.text), pct: Math.round((s.correct / s.total) * 100), total: s.total, skipped: s.skipped };
      })
      .sort((a, b) => a.pct - b.pct);

    if (hardMcq.length > 0 || hardTf.length > 0) {
      renderSectionTitle(doc, 'Question Difficulty Analysis', { text: 'Most Challenging', color: STYLE.colors.warning });

      doc.font(STYLE.fonts.italic).fontSize(STYLE.sizes.xs).fillColor(STYLE.colors.muted)
        .text('Questions below 60% success rate are flagged as difficult. High skip rates indicate confusion.', L, doc.y, { width: W });
      doc.moveDown(0.6);

      const renderQTable = (label, questions) => {
        if (questions.length === 0) return;
        ensureSpace(doc, 32);
        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.base).fillColor(STYLE.colors.neutral)
          .text(label, L, doc.y, { width: W });
        doc.moveDown(0.3);

        const qLabelW = W - 140;
        const qPctW   = 50;
        const qSkipW  = 50;
        const qBarW   = 40;

        // column headers
        ensureSpace(doc, 24);
        const chY = doc.y;
        doc.save();
        doc.rect(L, chY, W, 22).fill(STYLE.colors.tableHdr);
        doc.rect(L, chY, W, 22).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
        doc.restore();
        
        doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.xxs).fillColor(STYLE.colors.muted);
        doc.text('Question', L + STYLE.spacing.sm, chY + 6, { width: qLabelW });
        doc.text('Skip %', L + qLabelW + STYLE.spacing.sm, chY + 6, { width: qSkipW });
        doc.text('Score', L + qLabelW + qSkipW + qBarW + STYLE.spacing.sm, chY + 6, { width: qPctW, align: 'right' });
        doc.y = chY + 22;

        questions.forEach((q, idx) => {
          const isHard = q.pct < 60;
          const skipRate = q.total > 0 ? Math.round((q.skipped / q.total) * 100) : 0;
          const barColor = q.pct >= 70 ? STYLE.colors.success : q.pct >= 50 ? STYLE.colors.warning : STYLE.colors.error;
          const rowH = Math.max(26, doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm)
            .heightOfString(q.text, { width: qLabelW - 8 }) + 12);
          ensureSpace(doc, rowH);
          const ry = doc.y;

          doc.save();
          doc.rect(L, ry, W, rowH).fill(idx % 2 === 0 ? STYLE.colors.white : STYLE.colors.altRow);
          if (isHard) {
            doc.rect(L, ry, 4, rowH).fill(STYLE.colors.error);
          }
          doc.rect(L, ry, W, rowH).strokeColor(STYLE.colors.border).lineWidth(0.5).stroke();
          doc.restore();

          doc.font(isHard ? STYLE.fonts.bold : STYLE.fonts.main).fontSize(STYLE.sizes.sm)
            .fillColor(isHard ? STYLE.colors.error : STYLE.colors.neutral)
            .text(q.text, L + 8, ry + 6, { width: qLabelW - 12 });

          // Skip rate
          doc.font(STYLE.fonts.main).fontSize(STYLE.sizes.sm).fillColor(skipRate > 30 ? STYLE.colors.warning : STYLE.colors.muted);
          doc.text(`${skipRate}%`, L + qLabelW + STYLE.spacing.sm, ry + 6, { width: qSkipW });

          // Progress bar
          renderProgressBar(doc, L + qLabelW + qSkipW, ry + (rowH - 10) / 2, qBarW - 4, 10, q.pct, barColor, false);

          // Score
          doc.font(STYLE.fonts.bold).fontSize(STYLE.sizes.sm).fillColor(barColor)
            .text(`${q.pct}%`, L + qLabelW + qSkipW + qBarW, ry + 6, { width: qPctW - 4, align: 'right' });

          doc.y = ry + rowH;
        });
        doc.moveDown(0.7);
      };

      renderQTable('Multiple Choice Questions', hardMcq.slice(0, 10));
      renderQTable('True / False Questions', hardTf.slice(0, 10));
    }

  } catch (err) {
    try { doc.end(); } catch { /* ignore */ }
    throw err;
  }

  return finalizeDoc(doc, stream, `${wsTitle} — Submission Report`, outputPath);
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT 3: Flashcard set submission report PDF
// ─────────────────────────────────────────────────────────────────────────────
async function generateFlashcardReportPdf(data, outputPath) {
  const title           = safeText(data.title) || 'Flashcard Report';
  const totalSubmissions = safeNumber(data.totalSubmissions, 0);
  const averageScore    = safeNumber(data.averageScore, 0);
  const medianTimeSec   = safeNumber(data.medianTimeTaken, 0);
  const participants    = Array.isArray(data.participants) ? data.participants : [];
  const cards           = Array.isArray(data.cards)        ? data.cards        : [];

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const { doc, stream } = buildDoc(outputPath);

  try {
    const L = doc.page.margins.left;
    const W = pageW(doc);

    doc.font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral)
      .text(title, L, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.muted)
      .text('Flashcard Submission Report', L, doc.y, { width: W });
    doc.moveDown(0.5);
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
    doc.y += 14;

    renderStatsRow(doc, [
      { icon: '👥', label: 'Total Submissions', value: String(totalSubmissions) },
      { icon: '📊', label: 'Average Score',     value: `${averageScore}%`       },
      { icon: '⏱',  label: 'Median Time',       value: formatTime(medianTimeSec) },
    ]);

    if (participants.length > 0) {
      renderSectionTitle(doc, 'Participant Results');
      const rows = participants.map((p) => [
        safeText(p.userName),
        `${Math.round(safeNumber(p.score, 0))}%`,
        formatTime(safeNumber(p.timeTaken, 0)),
        p.submittedAt ? new Date(p.submittedAt).toLocaleDateString() : '',
        safeText(p.status) || 'completed',
      ]);
      renderParticipantTable(doc, ['Participant', 'Score', 'Time', 'Date', 'Status'], rows, [188, 68, 68, 90, 101]);
    } else {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.muted)
        .text('No submissions yet.', L, doc.y, { width: W });
    }

    if (cards.length > 0) {
      renderSectionTitle(doc, 'Card Performance');
      const cardRows = cards.map((c, i) => [String(i + 1), safeText(c.front), `${safeNumber(c.correctPercentage, 0)}%`]);
      renderParticipantTable(doc, ['#', 'Card (Front)', 'Success Rate'], cardRows, [30, 388, 97]);
    }
  } catch (err) {
    try { doc.end(); } catch { /* ignore */ }
    throw err;
  }

  return finalizeDoc(doc, stream, `${title} — Flashcard Report`, outputPath);
}

module.exports = { generateWorksheetSubmissionPdf, generateWorksheetReportPdf, generateFlashcardReportPdf };
