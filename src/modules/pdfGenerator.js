const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { fetch } = require('undici');
const sizeOf = require('image-size');

const STYLE = {
  colors: {
    headerFooter: '#333333',
    primary: '#1a73e8',
    strengths: '#2e7d32',
    improvement: '#f57c00',
    action: '#6a1b9a',
    correction: '#d32f2f',
    rule: '#D0D5DD',
    text: '#111827'
  },
  fonts: {
    headerFooter: { name: 'Helvetica-Bold', size: 12 },
    sectionTitle: { name: 'Helvetica-Bold', size: 14 },
    body: { name: 'Helvetica', size: 11 },
    mono: { name: 'Courier', size: 10 }
  },
  spacing: {
    sectionGap: 12,
    blockGap: 10
  }
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
  doc.text(title, 0, headerY, { align: 'center' });
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
  doc.text(label, 0, footerY, { align: 'center' });

  const footerMeta = formatDate(new Date());
  if (footerMeta) {
    doc.font('Helvetica').fontSize(9).fillColor(STYLE.colors.headerFooter);
    doc.text(footerMeta, doc.page.margins.left, footerY, {
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
      align: 'right'
    });
  }
  doc.restore();
}

function ensurePageSpace(doc, neededHeight) {
  if (doc.y + neededHeight > doc.page.height - 50) {
    doc.addPage();
  }
}

function drawSectionTitle(doc, title) {
  ensurePageSpace(doc, 34);
  doc.moveDown(0.6);
  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const barY = doc.y;
  doc.save();
  doc.rect(x, barY, w, 6).fill(STYLE.colors.primary);
  doc.restore();
  doc.y = barY + 10;
  doc.font(STYLE.fonts.sectionTitle.name).fontSize(STYLE.fonts.sectionTitle.size).fillColor(STYLE.colors.primary);
  doc.text(title, { width: w });
  doc.moveDown(0.4);
}

function drawKeyValue(doc, key, value) {
  const k = safeText(key);
  const v = safeText(value);
  if (!k && !v) return;
  ensurePageSpace(doc, 16);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.headerFooter).text(`${k}: `, { continued: true });
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text).text(v || '');
}

function drawBullets(doc, items) {
  const list = Array.isArray(items) ? items : [];
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No data available.');
    doc.moveDown(0.4);
    return;
  }
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
  for (const it of list) {
    const t = safeText(it);
    if (!t) continue;
    ensurePageSpace(doc, 18);
    doc.text(`- ${t}`,
      {
        width: doc.page.width - doc.page.margins.left - doc.page.margins.right
      });
  }
  doc.moveDown(0.4);
}

function drawParagraph(doc, text) {
  const t = safeText(text);
  if (!t) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No data available.');
    doc.moveDown(0.4);
    return;
  }
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
  doc.text(t, {
    width: doc.page.width - doc.page.margins.left - doc.page.margins.right
  });
  doc.moveDown(0.6);
}

function drawTextBox(doc, { text, fontName, fontSize, textColor, backgroundColor, borderColor, padding = 10, italic = false }) {
  const t = safeText(text);
  if (!t) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No data available.');
    doc.moveDown(0.4);
    return;
  }

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.save();
  doc.font(fontName).fontSize(fontSize);
  const textHeight = doc.heightOfString(t, { width: w - padding * 2 });
  const h = textHeight + padding * 2;
  ensurePageSpace(doc, h + 6);
  const y = doc.y;
  doc.roundedRect(x, y, w, h, 8).fillAndStroke(backgroundColor, borderColor);
  doc.fillColor(textColor);
  doc.font(italic ? 'Helvetica-Oblique' : fontName).fontSize(fontSize);
  doc.text(t, x + padding, y + padding, { width: w - padding * 2 });
  doc.restore();
  doc.y = y + h + 6;
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

function drawTranscriptBoxWithCorrections(doc, { text, corrections }) {
  const t = safeText(text);
  if (!t) {
    drawTextBox(doc, {
      text: '',
      fontName: STYLE.fonts.mono.name,
      fontSize: STYLE.fonts.mono.size,
      textColor: STYLE.colors.text,
      backgroundColor: '#F9FAFB',
      borderColor: '#E5E7EB',
      padding: 10,
      italic: false
    });
    return;
  }

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const padding = 10;

  const normalized = buildNonOverlappingCorrections(t, corrections);
  doc.save();
  doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size);
  const baseHeight = doc.heightOfString(t, { width: w - padding * 2 });
  const h = baseHeight + padding * 2;
  ensurePageSpace(doc, h + 6);
  const y = doc.y;
  doc.roundedRect(x, y, w, h, 8).fillAndStroke('#F9FAFB', '#E5E7EB');

  let cursor = 0;
  doc.fillColor(STYLE.colors.text);
  doc.font(STYLE.fonts.mono.name).fontSize(STYLE.fonts.mono.size);
  doc.x = x + padding;
  doc.y = y + padding;

  for (const c of normalized) {
    const before = t.slice(cursor, c.start);
    if (before) {
      doc.fillColor(STYLE.colors.text);
      doc.text(before, { width: w - padding * 2, continued: true });
    }

    const original = t.slice(c.start, c.end);
    if (original) {
      doc.fillColor(STYLE.colors.correction);
      doc.text(original, { width: w - padding * 2, continued: true, strike: true });
    }

    if (c.replacement) {
      doc.fillColor(STYLE.colors.correction);
      doc.text(c.replacement, { width: w - padding * 2, continued: true });
    }

    cursor = c.end;
  }

  const after = t.slice(cursor);
  if (after) {
    doc.fillColor(STYLE.colors.text);
    doc.text(after, { width: w - padding * 2 });
  } else {
    doc.text('', { width: w - padding * 2 });
  }

  doc.restore();
  doc.y = y + h + 6;
}

function drawGradeBadge(doc, overallScoreText) {
  const scoreNum = safeNumber(String(overallScoreText).split('/')[0], NaN);
  const pct = Number.isFinite(scoreNum) ? scoreNum : NaN;
  let bg = '#FEE2E2';
  let fg = '#991B1B';
  if (Number.isFinite(pct) && pct >= 80) {
    bg = '#DCFCE7';
    fg = '#166534';
  } else if (Number.isFinite(pct) && pct >= 60) {
    bg = '#FEF9C3';
    fg = '#854D0E';
  }

  const x = doc.page.margins.left;
  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  ensurePageSpace(doc, 78);

  const y = doc.y;
  doc.save();
  doc.roundedRect(x, y, w, 68, 12).fillAndStroke('#FFFFFF', '#E5E7EB');
  doc.font('Helvetica-Bold').fontSize(18).fillColor(STYLE.colors.text).text('Overall Grade / Score', x + 14, y + 14);

  const badgeText = safeText(overallScoreText) || 'N/A';
  const badgeW = Math.min(180, doc.widthOfString(badgeText, { font: 'Helvetica-Bold', size: 16 }) + 24);
  const badgeX = x + 14;
  const badgeY = y + 40;
  doc.roundedRect(badgeX, badgeY, badgeW, 22, 11).fill(bg);
  doc.font('Helvetica-Bold').fontSize(14).fillColor(fg).text(badgeText, badgeX, badgeY + 5, { width: badgeW, align: 'center' });
  doc.restore();

  doc.y = y + 68 + 10;
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
      const startChar = safeNumber(c.startChar, NaN);
      const endChar = safeNumber(c.endChar, NaN);
      return {
        page: Number.isFinite(page) ? page : 1,
        category: category || 'Quick Check',
        message,
        suggestedText,
        startChar: Number.isFinite(startChar) ? startChar : undefined,
        endChar: Number.isFinite(endChar) ? endChar : undefined
      };
    })
    .filter(Boolean);
}

function drawCorrectionsList(doc, corrections) {
  const list = Array.isArray(corrections) ? corrections : [];
  if (!list.length) return;

  const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  ensurePageSpace(doc, 22);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.correction).text('Corrections', { width: w });
  doc.moveDown(0.2);

  for (const c of list.slice(0, 30)) {
    const left = `${c.category}: ${c.message}`;
    ensurePageSpace(doc, 16);
    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.correction);
    doc.text(`- ${left}`, { width: w });
    if (c.suggestedText) {
      ensurePageSpace(doc, 14);
      doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
      doc.text(`  -> ${c.suggestedText}`, { width: w });
    }
  }
  doc.moveDown(0.5);
}

async function drawImagesSection(doc, images) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No images attached.');
    doc.moveDown(0.6);
    return;
  }

  for (let i = 0; i < list.length; i += 1) {
    const img = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const url = safeText(img.url || img.path || img.imageUrl);
    if (!url) continue;

    const buf = await tryFetchImageBuffer(url);
    if (!buf) {
      ensurePageSpace(doc, 18);
      doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text(`Image ${i + 1}: unable to load`);
      doc.moveDown(0.4);
      continue;
    }

    let dims;
    try {
      dims = sizeOf(buf);
    } catch {
      dims = null;
    }

    const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const maxHeight = 300;

    ensurePageSpace(doc, maxHeight + 120);
    doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.text).text(`Submission Image ${i + 1}`, { width: availableWidth });
    doc.moveDown(0.4);

    const options = { fit: [availableWidth, maxHeight], align: 'center', valign: 'top' };
    // pdfkit handles jpg/png buffers.
    doc.image(buf, doc.page.margins.left, doc.y, options);

    // Best-effort spacing after image.
    const drawnHeight = dims && dims.width && dims.height
      ? Math.min(maxHeight, (availableWidth * dims.height) / dims.width)
      : maxHeight;

    doc.y += Math.min(maxHeight, Math.max(120, drawnHeight)) + 14;

    const perImageTranscript = safeText(img.transcriptText);
    const w = doc.page.width - doc.page.margins.left - doc.page.margins.right;

    doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.text).text('Transcription', { width: w });
    doc.moveDown(0.25);
    drawTextBox(doc, {
      text: perImageTranscript || 'No transcription available for this image.',
      fontName: STYLE.fonts.mono.name,
      fontSize: STYLE.fonts.mono.size,
      textColor: STYLE.colors.text,
      backgroundColor: '#F9FAFB',
      borderColor: '#E5E7EB',
      padding: 10,
      italic: false
    });

    const perImageCorrections = Array.isArray(img.corrections) ? img.corrections : [];
    if (perImageCorrections.length) {
      drawCorrectionsList(doc, perImageCorrections);
    }

    doc.moveDown(0.2);
  }
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

function drawRubric(doc, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No rubric scores available.');
    doc.moveDown(0.6);
    return;
  }

  const tableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colCriteria = Math.floor(tableWidth * 0.38);
  const colScore = Math.floor(tableWidth * 0.16);
  const colMax = Math.floor(tableWidth * 0.16);
  const colComment = tableWidth - colCriteria - colScore - colMax;
  const rowPadY = 6;
  const headerH = 22;

  const startX = doc.page.margins.left;
  ensurePageSpace(doc, headerH + 28);
  const headerY = doc.y;
  doc.save();
  doc.rect(startX, headerY, tableWidth, headerH).fill('#F3F4F6');
  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.text);
  doc.text('Criteria', startX + 8, headerY + rowPadY, { width: colCriteria - 16 });
  doc.text('Score', startX + colCriteria + 8, headerY + rowPadY, { width: colScore - 16 });
  doc.text('Max', startX + colCriteria + colScore + 8, headerY + rowPadY, { width: colMax - 16 });
  doc.text('Comment', startX + colCriteria + colScore + colMax + 8, headerY + rowPadY, { width: colComment - 16 });
  doc.restore();
  doc.y = headerY + headerH;

  for (let idx = 0; idx < list.length; idx += 1) {
    const r = list[idx] || {};
    const criteria = safeText(r.criteria || r.label);
    const score = safeNumber(r.score, NaN);
    const max = safeNumber(r.maxScore, NaN);
    const comment = safeText(r.comment);

    const scoreText = Number.isFinite(score) ? String(Math.round(score * 10) / 10) : '';
    const maxText = Number.isFinite(max) ? String(Math.round(max * 10) / 10) : '';
    const rowTextHeight = Math.max(
      doc.heightOfString(criteria || ' ', { width: colCriteria - 16 }),
      doc.heightOfString(comment || ' ', { width: colComment - 16 })
    );
    const rowH = Math.max(22, rowTextHeight + rowPadY * 2);

    ensurePageSpace(doc, rowH + 8);
    const y = doc.y;
    const fill = idx % 2 === 0 ? '#ffffff' : '#f5f5f5';
    doc.save();
    doc.rect(startX, y, tableWidth, rowH).fill(fill);
    doc.rect(startX, y, tableWidth, rowH).strokeColor('#E5E7EB').lineWidth(1).stroke();
    doc.restore();

    doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
    doc.text(criteria, startX + 8, y + rowPadY, { width: colCriteria - 16 });

    let scoreColor = STYLE.colors.text;
    if (Number.isFinite(score) && Number.isFinite(max) && max > 0) {
      const ratio = score / max;
      if (ratio < 0.4) scoreColor = '#B91C1C';
      else if (ratio < 0.7) scoreColor = '#A16207';
      else scoreColor = '#166534';
    }
    doc.fillColor(scoreColor);
    doc.text(scoreText, startX + colCriteria + 8, y + rowPadY, { width: colScore - 16 });
    doc.fillColor(STYLE.colors.text);
    doc.text(maxText, startX + colCriteria + colScore + 8, y + rowPadY, { width: colMax - 16 });
    doc.text(comment, startX + colCriteria + colScore + colMax + 8, y + rowPadY, { width: colComment - 16 });

    doc.y = y + rowH;
  }

  doc.moveDown(0.8);
}

function drawAiPerCategory(doc, rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No AI category-level feedback available.');
    doc.moveDown(0.6);
    return;
  }

  for (const r of list) {
    ensurePageSpace(doc, 44);
    const category = safeText(r.category) || 'Category';
    const score = safeText(r.scoreText);
    const message = safeText(r.message);
    doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.text).text(score ? `${category} (${score})` : category);
    doc.moveDown(0.2);
    drawParagraph(doc, message);
  }
}

function drawRubricDesigner(doc, rubricDesigner) {
  const rd = rubricDesigner && typeof rubricDesigner === 'object' ? rubricDesigner : null;
  if (!rd) {
    doc.font('Helvetica-Oblique').fontSize(11).fillColor('#6B7280').text('No rubric designer details available.');
    doc.moveDown(0.6);
    return;
  }

  const title = safeText(rd.title);
  const levels = Array.isArray(rd.levels) ? rd.levels : [];
  const criteria = Array.isArray(rd.criteria) ? rd.criteria : [];

  if (title) {
    doc.font('Helvetica-Bold').fontSize(12).fillColor(STYLE.colors.text).text(title);
    doc.moveDown(0.3);
  }

  ensurePageSpace(doc, 28);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.text).text(`Levels (${levels.length})`);
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
  if (!levels.length) {
    doc.font('Helvetica-Oblique').fillColor('#6B7280').text('No levels defined.');
  } else {
    for (const lvl of levels) {
      const label = safeText(lvl && (lvl.label || lvl.name || lvl.title));
      const score = safeText(lvl && (lvl.score || lvl.points));
      ensurePageSpace(doc, 16);
      doc.text(`- ${label || 'Level'}${score ? ` (${score})` : ''}`);
    }
  }
  doc.moveDown(0.6);

  ensurePageSpace(doc, 28);
  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.text).text(`Criteria (${criteria.length})`);
  doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
  if (!criteria.length) {
    doc.font('Helvetica-Oblique').fillColor('#6B7280').text('No criteria defined.');
  } else {
    for (const c of criteria) {
      const name = safeText(c && (c.name || c.title || c.criteria));
      const desc = safeText(c && (c.description || c.desc));
      ensurePageSpace(doc, 28);
      doc.font('Helvetica-Bold').fillColor(STYLE.colors.text).text(name || 'Criterion');
      if (desc) {
        doc.font(STYLE.fonts.body.name).fillColor(STYLE.colors.text).text(desc);
      }
      doc.moveDown(0.3);
    }
  }
  doc.moveDown(0.6);
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

  const title = 'Submission Feedback';
  const studentName = safeText(header.studentName);
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

    try {
      doc.save();
      doc.fillColor('#ECEFF3').opacity(0.12);
      doc.rotate(-20, { origin: [doc.page.width / 2, doc.page.height / 2] });
      doc.font('Helvetica-Bold').fontSize(72);
      doc.text('Confidential', 0, doc.page.height / 2 - 60, { align: 'center' });
      doc.restore();

      doc.moveDown(0.8);
      drawGradeBadge(doc, overallBlock.overallText);
      drawKeyValue(doc, 'Student', studentName || '');
      drawKeyValue(doc, 'Date', dateText || '');
      drawKeyValue(doc, 'Submission ID', submissionId || '');
      doc.moveDown(0.6);

      // Images (optional)
      drawSectionTitle(doc, 'Submission Images + Transcription');
      // eslint-disable-next-line promise/prefer-await-to-callbacks
      (async () => {
        const imagesWithCorrections = images.map((img, idx) => {
          const pageNumber = idx + 1;
          const perPage = issues.filter((c) => Number(c.page) === pageNumber);
          return { ...(img && typeof img === 'object' ? img : {}), corrections: perPage };
        });

        await drawImagesSection(doc, imagesWithCorrections);

        if (issues.length) {
          drawSectionTitle(doc, 'AI Corrections (Detected Issues)');
          for (const c of issues.slice(0, 80)) {
            ensurePageSpace(doc, 18);
            doc.font(STYLE.fonts.body.name).fontSize(STYLE.fonts.body.size).fillColor(STYLE.colors.text);
            doc.text(`- ${c.category}: ${c.message}${c.suggestedText ? ` (Suggestion: ${c.suggestedText})` : ''}`, {
              width: doc.page.width - doc.page.margins.left - doc.page.margins.right
            });
          }
          doc.moveDown(0.6);
        }

        // Strengths
        drawSectionTitle(doc, 'Strengths');
        drawTextBox(doc, {
          text: strengths.length ? strengths.map((s) => `- ${s}`).join('\n') : '',
          fontName: STYLE.fonts.body.name,
          fontSize: STYLE.fonts.body.size,
          textColor: STYLE.colors.text,
          backgroundColor: '#E8F5E9',
          borderColor: STYLE.colors.strengths,
          padding: 10,
          italic: false
        });

        // Areas for improvement
        drawSectionTitle(doc, 'Areas for Improvement');
        drawTextBox(doc, {
          text: areasForImprovement.length ? areasForImprovement.map((s) => `- ${s}`).join('\n') : '',
          fontName: STYLE.fonts.body.name,
          fontSize: STYLE.fonts.body.size,
          textColor: STYLE.colors.text,
          backgroundColor: '#FFF3E0',
          borderColor: STYLE.colors.improvement,
          padding: 10,
          italic: false
        });

        // Action steps
        drawSectionTitle(doc, 'Action Steps');
        drawTextBox(doc, {
          text: actionSteps.length ? actionSteps.map((s) => `- ${s}`).join('\n') : '',
          fontName: STYLE.fonts.body.name,
          fontSize: STYLE.fonts.body.size,
          textColor: STYLE.colors.text,
          backgroundColor: '#F3E5F5',
          borderColor: STYLE.colors.action,
          padding: 10,
          italic: false
        });

        // Rubric
        drawSectionTitle(doc, 'Rubric');
        drawRubric(doc, rubricRows);

        drawSectionTitle(doc, 'Rubric Details');
        drawRubricDesigner(doc, submissionFeedback && submissionFeedback.rubricDesigner);

        // Teacher feedback
        drawSectionTitle(doc, 'Teacher Comments');
        drawTextBox(doc, {
          text: teacherComment,
          fontName: STYLE.fonts.body.name,
          fontSize: STYLE.fonts.body.size,
          textColor: STYLE.colors.text,
          backgroundColor: '#F5F5F5',
          borderColor: '#E5E7EB',
          padding: 12,
          italic: true
        });

        // AI feedback
        drawSectionTitle(doc, 'AI Feedback (Overall)');
        drawParagraph(doc, aiOverallComments);

        drawSectionTitle(doc, 'AI Feedback (By Category)');
        drawAiPerCategory(doc, aiPerCategoryRows);

        // Transcript (optional)
        drawSectionTitle(doc, 'Submission Text (Transcript/OCR)');
        drawTranscriptBoxWithCorrections(doc, {
          text: transcriptText,
          corrections: issues
        });

        // Add header/footer after all pages are generated (avoids recursion).
        const range = doc.bufferedPageRange();
        const totalPages = range.count;
        for (let i = range.start; i < range.start + range.count; i += 1) {
          doc.switchToPage(i);
          drawHeaderFooterForPage(doc, {
            title,
            pageNumber: i - range.start + 1,
            totalPages
          });
        }

        doc.end();
      })().catch((e) => {
        try {
          doc.end();
        } catch {
          // ignore
        }
        reject(e);
      });
    } catch (e) {
      try {
        doc.end();
      } catch {
        // ignore
      }
      reject(e);
    }

    stream.on('finish', () => resolve(outputPath));
    stream.on('error', (err) => reject(err));
  });
}

module.exports = {
  generatePdf
};
