const puppeteer = require('puppeteer');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function toRgba(hexColor, alpha) {
  const c = String(hexColor || '').trim();
  const a = Number.isFinite(Number(alpha)) ? Number(alpha) : 0.25;

  if (!c.startsWith('#')) {
    return `rgba(255, 193, 7, ${a})`;
  }

  const hex = c.slice(1);
  const full = hex.length === 3 ? hex.split('').map((ch) => ch + ch).join('') : hex;
  if (full.length !== 6) {
    return `rgba(255, 193, 7, ${a})`;
  }

  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);

  if (![r, g, b].every((v) => Number.isFinite(v))) {
    return `rgba(255, 193, 7, ${a})`;
  }

  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

function buildWritingCorrectionsHtml(text, issues) {
  const safeText = typeof text === 'string' ? text : '';
  const list = Array.isArray(issues) ? issues : [];

  const normalized = list
    .map((i) => {
      const start = typeof i.start === 'number' ? i.start : Number(i.start);
      const end = typeof i.end === 'number' ? i.end : Number(i.end);
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
      if (start < 0 || end <= start || start >= safeText.length) return null;
      return {
        ...i,
        start: Math.max(0, Math.min(safeText.length, start)),
        end: Math.max(0, Math.min(safeText.length, end))
      };
    })
    .filter(Boolean);

  const sorted = normalized.sort((a, b) => b.start - a.start);

  let cursor = safeText.length;
  let html = '';

  for (const issue of sorted) {
    if (issue.end > cursor) {
      continue;
    }

    if (issue.end < cursor) {
      html = escapeHtml(safeText.slice(issue.end, cursor)) + html;
    }

    const snippet = safeText.slice(issue.start, issue.end);

    const symbol = escapeHtml(issue.symbol || '');
    const description = escapeHtml(issue.description || issue.message || '');
    const bg = toRgba(issue.color, 0.22);
    const border = escapeHtml(issue.color || '#FFC107');

    html =
      `<span class="correction-highlight" style="background:${bg}; border-bottom: 2px solid ${border};">` +
      `${escapeHtml(snippet)}` +
      `<span class="symbol" style="color:${border};">${symbol}</span>` +
      `<span class="tooltip"><strong style="color:${border}">${symbol}</strong><br/>${description}</span>` +
      `</span>` +
      html;

    cursor = issue.start;
  }

  if (cursor > 0) {
    html = escapeHtml(safeText.slice(0, cursor)) + html;
  }

  return html;
}

function computeCorrectionStats(issues) {
  const stats = {
    spelling: 0,
    grammar: 0,
    typography: 0,
    style: 0,
    other: 0,
    total: 0
  };

  for (const issue of Array.isArray(issues) ? issues : []) {
    const key = (issue && typeof issue.groupKey === 'string' ? issue.groupKey : 'other').toLowerCase();
    if (key in stats) {
      stats[key] += 1;
    } else {
      stats.other += 1;
    }
    stats.total += 1;
  }

  return stats;
}

function buildActionSteps(stats) {
  const items = [];
  const pairs = [
    ['spelling', 'Review spelling mistakes and re-check misspelled words.'],
    ['grammar', 'Fix grammar issues (tense, agreement, sentence structure).'],
    ['typography', 'Correct punctuation and typographical issues (quotes, commas, spacing).'],
    ['style', 'Improve writing style for clarity and conciseness.'],
    ['other', 'Review flagged sections and refine the wording.']
  ];

  const sorted = pairs
    .map(([k, text]) => ({ key: k, text, count: stats && typeof stats[k] === 'number' ? stats[k] : 0 }))
    .filter((x) => x.count > 0)
    .sort((a, b) => b.count - a.count);

  for (const s of sorted.slice(0, 5)) {
    items.push(s.text);
  }

  if (!items.length) {
    items.push('Keep practicing and re-check your writing for small improvements.');
  }

  return items;
}

function safeNumber(value, fallback = 0) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function formatDate(value) {
  const d = value ? new Date(value) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return d.toLocaleString();
}

function buildHtml({ header, imageUrl, transcriptHtml, scoreSummary, stats, detailedIssues, teacherFeedback, actionSteps }) {
  const statsRows = [
    { label: 'Spelling', value: stats.spelling, color: '#F44336' },
    { label: 'Grammar', value: stats.grammar, color: '#FF9800' },
    { label: 'Typography', value: stats.typography, color: '#9C27B0' },
    { label: 'Style', value: stats.style, color: '#2196F3' },
    { label: 'Other', value: stats.other, color: '#607D8B' },
    { label: 'Total', value: stats.total, color: '#111827' }
  ];

  const issueItems = (Array.isArray(detailedIssues) ? detailedIssues : [])
    .slice(0, 50)
    .map((i) => {
      const symbol = escapeHtml(i.symbol || '');
      const label = escapeHtml(i.groupLabel || i.groupKey || '');
      const msg = escapeHtml(i.message || i.description || '');
      const suggestion = escapeHtml(i.suggestedText || i.suggestion || '');
      const color = escapeHtml(i.color || '#FFC107');
      return `
        <div class="issue">
          <div class="issue-head">
            <span class="badge" style="background:${toRgba(color, 0.18)}; border-color:${color}; color:${color};">${symbol || 'CK'}</span>
            <div class="issue-meta">
              <div class="issue-title">${label || 'Check'}</div>
              <div class="issue-msg">${msg}</div>
              ${suggestion ? `<div class="issue-suggestion"><strong>Suggestion:</strong> ${suggestion}</div>` : ''}
            </div>
          </div>
        </div>
      `;
    })
    .join('');

  const actions = (Array.isArray(actionSteps) ? actionSteps : [])
    .map((a) => `<li>${escapeHtml(a)}</li>`)
    .join('');

  const teacherBlock = teacherFeedback && String(teacherFeedback).trim()
    ? `<div class="teacher-feedback">${escapeHtml(String(teacherFeedback))}</div>`
    : `<div class="teacher-feedback empty">No teacher comments provided.</div>`;

  const imgBlock = imageUrl
    ? `<img class="essay-image" src="${escapeHtml(imageUrl)}" alt="Original submission" />`
    : `<div class="empty">Original image not available.</div>`;

  return `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    @page { margin: 14mm 12mm; }
    html, body { padding: 0; margin: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; color: #0F172A; font-size: 12px; letter-spacing: 0.1px; }
    .page { padding: 0; }
    .header { display:flex; justify-content: space-between; align-items: flex-start; border-bottom: 1px solid #E2E8F0; padding-bottom: 12px; margin-bottom: 16px; }
    .title { font-size: 20px; font-weight: 800; margin-bottom: 4px; }
    .muted { color: #64748B; font-size: 11px; line-height: 1.35; }
    .section { margin-top: 16px; }
    .section h2 { font-size: 13px; font-weight: 800; margin: 0 0 10px; padding: 8px 10px; background: #F1F5F9; border: 1px solid #E2E8F0; border-radius: 10px; }
    .essay-image { width: 100%; max-height: 720px; object-fit: contain; border: 1px solid #E2E8F0; border-radius: 12px; padding: 8px; background: #FFFFFF; box-shadow: 0 1px 0 rgba(2,6,23,0.05); }
    .grid { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .card { border: 1px solid #E2E8F0; border-radius: 12px; padding: 12px; background: #FFFFFF; box-shadow: 0 1px 0 rgba(2,6,23,0.04); }
    .big-score { font-size: 22px; font-weight: 900; color: #0F172A; }
    table { width: 100%; border-collapse: separate; border-spacing: 0; overflow: hidden; border-radius: 10px; }
    th, td { border-bottom: 1px solid #E2E8F0; padding: 8px 10px; text-align: left; }
    th { background: #F8FAFC; color: #334155; font-weight: 700; border-top: 1px solid #E2E8F0; }
    tr td:first-child, tr th:first-child { border-left: 1px solid #E2E8F0; }
    tr td:last-child, tr th:last-child { border-right: 1px solid #E2E8F0; }
    tbody tr:last-child td { border-bottom: 1px solid #E2E8F0; }
    .transcript { white-space: pre-wrap; font-size: 12px; line-height: 1.65; }
    .correction-highlight { position: relative; padding: 0 2px; border-radius: 4px; }
    .correction-highlight .symbol { font-weight: 800; margin-left: 3px; font-size: 10px; }
    .correction-highlight .tooltip { display: none; }
    .issue { margin-bottom: 10px; padding-bottom: 10px; border-bottom: 1px dashed #E2E8F0; }
    .issue:last-child { border-bottom: none; padding-bottom: 0; }
    .issue-head { display:flex; gap: 10px; }
    .badge { display:inline-flex; align-items:center; justify-content:center; min-width: 36px; height: 22px; border: 1px solid; border-radius: 999px; font-weight: 900; font-size: 10px; }
    .issue-title { font-weight: 800; margin-bottom: 2px; color: #0F172A; }
    .issue-msg { color: #334155; }
    .issue-suggestion { color: #0F172A; margin-top: 4px; }
    .teacher-feedback { white-space: pre-wrap; line-height: 1.6; color: #0F172A; }
    .empty { color: #64748B; font-style: italic; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div>
        <div class="title">Submission Feedback Report</div>
        <div class="muted">Student: ${escapeHtml(header.studentName || '')}</div>
        <div class="muted">Submission ID: ${escapeHtml(header.submissionId || '')}</div>
        <div class="muted">Date: ${escapeHtml(header.date || '')}</div>
      </div>
      <div style="text-align:right">
        <div class="muted">Overall Score</div>
        <div class="big-score">${escapeHtml(scoreSummary.label || '')}</div>
        <div class="muted">${escapeHtml(scoreSummary.raw || '')}</div>
      </div>
    </div>

    <div class="section">
      <h2>1. Original Image</h2>
      ${imgBlock}
    </div>

    <div class="section">
      <h2>2. Transcribed Text (with highlights)</h2>
      <div class="card transcript">${transcriptHtml || '<span class="empty">No transcript available.</span>'}</div>
    </div>

    <div class="section">
      <h2>3. Score & Statistics</h2>
      <div class="grid">
        <div class="card">
          <div style="font-weight:700; margin-bottom:6px;">Overall Score</div>
          <div class="big-score">${escapeHtml(scoreSummary.raw || '')}</div>
          <div class="muted">${escapeHtml(scoreSummary.note || '')}</div>
        </div>
        <div class="card">
          <div style="font-weight:700; margin-bottom:6px;">Correction Statistics</div>
          <table>
            <thead><tr><th>Category</th><th>Count</th></tr></thead>
            <tbody>
              ${statsRows.map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(String(r.value))}</td></tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="section">
      <h2>4. Detailed Feedback & Suggestions</h2>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Teacher Comments</div>
        ${teacherBlock}
      </div>
      <div style="height:10px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Detected Issues</div>
        ${issueItems || '<div class="empty">No issues detected.</div>'}
      </div>
    </div>

    <div class="section">
      <h2>5. Action Steps for Improvement</h2>
      <div class="card">
        <ol>
          ${actions}
        </ol>
      </div>
    </div>
  </div>
</body>
</html>
  `.trim();
}

function scoreLabel(score, maxScore) {
  if (!Number.isFinite(score) || !Number.isFinite(maxScore) || maxScore <= 0) return { raw: 'N/A', label: 'N/A', note: '' };
  const pct = (score / maxScore) * 100;
  const raw = `${Math.round(score * 10) / 10}/${Math.round(maxScore * 10) / 10}`;
  let label = 'N/A';
  if (pct >= 90) label = 'A';
  else if (pct >= 80) label = 'B';
  else if (pct >= 70) label = 'C';
  else if (pct >= 60) label = 'D';
  else label = 'F';

  const note = `Approx. ${Math.round(pct)}%`; 
  return { raw, label, note };
}

function computeFallbackScoreFromStats(stats) {
  const s = stats || { spelling: 0, grammar: 0, typography: 0, style: 0, other: 0, total: 0 };
  const penalty =
    (s.spelling || 0) * 1.2 +
    (s.grammar || 0) * 1.6 +
    (s.typography || 0) * 0.8 +
    (s.style || 0) * 0.6 +
    (s.other || 0) * 0.4;

  const score = Math.max(0, Math.min(100, Math.round((100 - penalty) * 10) / 10));
  return { score, maxScore: 100 };
}

async function renderSubmissionPdf({ header, imageUrl, transcriptText, issues, feedback }) {
  const stats = computeCorrectionStats(issues);
  const actionSteps = buildActionSteps(stats);
  const transcriptHtml = transcriptText && String(transcriptText).trim()
    ? buildWritingCorrectionsHtml(String(transcriptText), issues)
    : '';

  let score = safeNumber(feedback && feedback.score, NaN);
  let maxScore = safeNumber(feedback && feedback.maxScore, NaN);
  let scoreSummary = scoreLabel(score, maxScore);

  if (scoreSummary.raw === 'N/A') {
    const fallback = computeFallbackScoreFromStats(stats);
    score = fallback.score;
    maxScore = fallback.maxScore;
    scoreSummary = scoreLabel(score, maxScore);
    scoreSummary = {
      ...scoreSummary,
      note: scoreSummary.note ? `${scoreSummary.note} (auto-estimated)` : 'Auto-estimated'
    };
  }

  const html = buildHtml({
    header: {
      ...header,
      date: header && header.date ? header.date : formatDate(new Date())
    },
    imageUrl,
    transcriptHtml,
    scoreSummary,
    stats,
    detailedIssues: issues,
    teacherFeedback: feedback && feedback.textFeedback ? feedback.textFeedback : '',
    actionSteps
  });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({
      format: 'A4',
      printBackground: true,
      margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' }
    });

    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

module.exports = {
  renderSubmissionPdf
};
