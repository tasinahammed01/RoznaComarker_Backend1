const fs   = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

// ─────────────────────────────────────────────────────────────────────────────
// STYLE TOKENS  (matches existing ProjectRozna palette)
// ─────────────────────────────────────────────────────────────────────────────
const STYLE = {
  colors: {
    primary:     '#008081',
    success:     '#166534',
    successBg:   '#dcfce7',
    successBd:   '#22c55e',
    error:       '#dc2626',
    errorBg:     '#fee2e2',
    errorBd:     '#ef4444',
    correctHint: '#f0fdf4',
    correctHintBd: '#86efac',
    warning:     '#f57c00',
    neutral:     '#374151',
    muted:       '#6B7280',
    border:      '#E7E7E7',
    headerFt:    '#9CA3AF',
    bg:          '#F9FAFB',
    tableHdr:    '#F3F3F3',
    altRow:      '#FAFAFA',
    white:       '#FFFFFF',
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
function ensureSpace(doc, h) {
  if (doc.y + h > doc.page.height - doc.page.margins.bottom - 28) {
    doc.addPage();
  }
}
function formatTime(seconds) {
  const s = safeNumber(seconds, 0);
  if (s <= 0) return '0s';
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PAGE HEADER + FOOTER
// ─────────────────────────────────────────────────────────────────────────────
function drawPageHeaderFooter(doc, { title, pageNumber, totalPages }) {
  const L = doc.page.margins.left;
  const W = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.save();

  doc.font('Helvetica').fontSize(9).fillColor(STYLE.colors.headerFt)
    .text(safeText(title), L, 16, { width: W, align: 'center' });
  doc.moveTo(L, 34).lineTo(L + W, 34).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();

  const footerY = doc.page.height - doc.page.margins.bottom + 6;
  const footerRuleY = doc.page.height - doc.page.margins.bottom - 8;
  doc.moveTo(L, footerRuleY).lineTo(L + W, footerRuleY).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
  const label = totalPages ? `Page ${pageNumber} of ${totalPages}` : `Page ${pageNumber}`;
  doc.font('Helvetica').fontSize(9).fillColor(STYLE.colors.headerFt)
    .text(label, L, footerY, { width: W, align: 'center' });

  doc.restore();
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT TITLE HEADER
// ─────────────────────────────────────────────────────────────────────────────
function renderDocHeader(doc, { worksheetTitle, subtitle, studentName, submittedAt, score, percentage }) {
  const L = doc.page.margins.left;
  const W = pageW(doc);

  doc.font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral)
    .text(safeText(worksheetTitle), L, doc.y, { width: W });
  doc.moveDown(0.25);

  if (subtitle) {
    doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.muted)
      .text(safeText(subtitle), L, doc.y, { width: W });
    doc.moveDown(0.25);
  }

  const metaParts = [];
  if (studentName) metaParts.push(`Student: ${safeText(studentName)}`);
  if (submittedAt)  metaParts.push(`Date: ${safeText(submittedAt)}`);
  if (metaParts.length) {
    doc.font('Helvetica').fontSize(9.5).fillColor(STYLE.colors.muted)
      .text(metaParts.join('   |   '), L, doc.y, { width: W });
    doc.moveDown(0.35);
  }

  if (score !== undefined || percentage !== undefined) {
    const pct = safeNumber(percentage, 0);
    const accent = pct >= 70 ? STYLE.colors.primary : pct >= 50 ? STYLE.colors.warning : STYLE.colors.error;
    const scoreStr = score ? `${score}  (${Math.round(pct)}%)` : `${Math.round(pct)}%`;
    doc.font('Helvetica-Bold').fontSize(13).fillColor(accent)
      .text(`Score: ${scoreStr}`, L, doc.y, { width: W });
    doc.moveDown(0.4);
  }

  doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
  doc.y += 14;
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION TITLE BAR
// ─────────────────────────────────────────────────────────────────────────────
function renderSectionTitle(doc, title) {
  ensureSpace(doc, 44);
  doc.moveDown(0.4);
  const L = doc.page.margins.left;
  const W = pageW(doc);
  const y = doc.y;
  const h = 26;

  doc.save();
  doc.roundedRect(L, y, W, h, 6).fillAndStroke(STYLE.colors.tableHdr, STYLE.colors.border);
  doc.restore();

  doc.font('Helvetica-Bold').fontSize(11).fillColor(STYLE.colors.neutral)
    .text(safeText(title), L + 12, y + 7, { width: W - 24 });
  doc.y = y + h + 10;
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
// STATS CARDS ROW
// ─────────────────────────────────────────────────────────────────────────────
function renderStatsRow(doc, stats) {
  const L     = doc.page.margins.left;
  const W     = pageW(doc);
  const n     = stats.length;
  const gap   = 12;
  const cardW = Math.floor((W - gap * (n - 1)) / n);
  const cardH = 72;

  ensureSpace(doc, cardH + 14);
  const y = doc.y;

  for (let i = 0; i < n; i++) {
    const sx = L + i * (cardW + gap);
    const { label, value } = stats[i];

    doc.save();
    doc.roundedRect(sx, y, cardW, cardH, 8).fillAndStroke(STYLE.colors.white, STYLE.colors.border);
    doc.restore();

    doc.font('Helvetica').fontSize(8).fillColor(STYLE.colors.muted)
      .text(safeText(label).toUpperCase(), sx + 8, y + 14, { width: cardW - 16, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral)
      .text(safeText(value), sx + 8, y + 34, { width: cardW - 16, align: 'center' });
  }

  doc.y = y + cardH + 14;
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

  const studentName  = safeText(data.studentName);
  const submittedAt  = safeText(data.submittedAt);
  const wsTitle      = safeText(ws.title) || 'Worksheet';
  const percentage   = safeNumber(submission.percentage,        0);
  const totalEarned  = safeNumber(submission.totalPointsEarned, 0);
  const totalPossible= safeNumber(submission.totalPointsPossible, 0);
  const scoreStr     = totalPossible > 0 ? `${totalEarned}/${totalPossible}` : undefined;

  // Build answer maps keyed by questionId
  const a3Map = {};
  const a4Map = {};
  for (const ans of (Array.isArray(submission.answers) ? submission.answers : [])) {
    if (safeText(ans.sectionId) === 'activity3') a3Map[safeText(ans.questionId)] = safeText(ans.studentAnswer);
    if (safeText(ans.sectionId) === 'activity4') a4Map[safeText(ans.questionId)] = safeText(ans.studentAnswer);
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
    });

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

    // If neither activity was included
    if (a3Questions.length === 0 && a4Sentences.length === 0) {
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
async function generateWorksheetReportPdf(data, outputPath) {
  const ws          = (data.worksheet && typeof data.worksheet === 'object') ? data.worksheet : {};
  const submissions = Array.isArray(data.submissions) ? data.submissions : [];

  const wsTitle   = safeText(ws.title) || 'Worksheet';
  const total     = submissions.length;
  const avgScore  = total > 0
    ? Math.round(submissions.reduce((s, sub) => s + safeNumber(sub.percentage, 0), 0) / total)
    : 0;
  const avgTimeSec = total > 0
    ? Math.round(submissions.reduce((s, sub) => s + safeNumber(sub.timeTaken, 0), 0) / total)
    : 0;

  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });

  const { doc, stream } = buildDoc(outputPath);

  try {
    const L = doc.page.margins.left;
    const W = pageW(doc);

    // Document title
    doc.font('Helvetica-Bold').fontSize(20).fillColor(STYLE.colors.neutral)
      .text(wsTitle, L, doc.y, { width: W });
    doc.moveDown(0.25);
    doc.font('Helvetica').fontSize(10).fillColor(STYLE.colors.muted)
      .text('Submission Report', L, doc.y, { width: W });
    doc.moveDown(0.5);
    doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).strokeColor(STYLE.colors.border).stroke();
    doc.y += 14;

    // Stats cards
    renderStatsRow(doc, [
      { icon: '👥', label: 'Total Submissions', value: String(total)             },
      { icon: '📊', label: 'Average Score',     value: `${avgScore}%`            },
      { icon: '⏱',  label: 'Average Time',      value: formatTime(avgTimeSec)   },
    ]);

    // Participant table
    if (submissions.length > 0) {
      renderSectionTitle(doc, 'Participant Results');
      const rows = submissions.map((sub) => {
        const raw    = sub.studentId;
        const name   = (raw && typeof raw === 'object')
          ? safeText(raw.displayName || raw.email)
          : safeText(raw);
        const score  = `${Math.round(safeNumber(sub.percentage, 0))}%`;
        const time   = formatTime(safeNumber(sub.timeTaken, 0));
        const date   = sub.submittedAt ? new Date(sub.submittedAt).toLocaleDateString() : '';
        const status = safeText(sub.gradingStatus).replace(/-/g, ' ') || 'completed';
        return [name, score, time, date, status];
      });

      renderParticipantTable(
        doc,
        ['Student', 'Score', 'Time', 'Date', 'Status'],
        rows,
        [188, 68, 68, 90, 101]
      );
    } else {
      doc.font('Helvetica-Oblique').fontSize(10).fillColor(STYLE.colors.muted)
        .text('No submissions yet.', L, doc.y, { width: W });
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
