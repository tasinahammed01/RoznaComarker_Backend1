const puppeteer = require('puppeteer');

const { fetch } = require('undici');

const os = require('os');
const fs = require('fs');
const path = require('path');

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function tryFetchAsDataUri(url) {
  const u = typeof url === 'string' ? url.trim() : '';
  if (!u) return '';
  if (u.startsWith('data:')) return u;
  if (!/^https?:\/\//i.test(u)) return '';

  try {
    const res = await fetch(u);
    if (!res || !res.ok) return '';
    const ct = res.headers.get('content-type') || 'application/octet-stream';
    const ab = await res.arrayBuffer();
    const b64 = Buffer.from(ab).toString('base64');
    return `data:${ct};base64,${b64}`;
  } catch {
    return '';
  }
}

function getUploadsRoot() {
  const basePath = (process.env.UPLOAD_BASE_PATH || 'uploads').trim() || 'uploads';
  return path.join(__dirname, '..', '..', basePath);
}

function guessMimeTypeFromFilename(filename) {
  const ext = String(path.extname(String(filename || '')).toLowerCase());
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'application/octet-stream';
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

  // Support URLs like:
  // /uploads/submissions/<file>
  // /uploads/assignments/<file>
  // /uploads/feedback/<file>
  // (keep it strict to avoid reading arbitrary paths)
  const m = String(pathname).match(/^\/uploads\/(assignments|submissions|feedback)\/([^/?#]+)$/i);
  if (!m) return null;
  return { folder: m[1].toLowerCase(), filename: m[2] };
}

async function tryReadUploadsFileAsDataUri(urlOrPath) {
  const parts = extractUploadsPath(urlOrPath);
  if (!parts) return '';

  const uploadsRoot = getUploadsRoot();
  const abs = path.join(uploadsRoot, parts.folder, parts.filename);

  try {
    const buf = await fs.promises.readFile(abs);
    if (!buf || !buf.length) return '';
    const ct = guessMimeTypeFromFilename(parts.filename);
    const b64 = Buffer.from(buf).toString('base64');
    return `data:${ct};base64,${b64}`;
  } catch {
    return '';
  }
}

async function waitForImages(page) {
  try {
    await page.evaluate(async () => {
      const imgs = Array.from(document.images || []);
      await Promise.all(
        imgs.map((img) =>
          img.complete
            ? Promise.resolve()
            : new Promise((resolve) => {
                const done = () => resolve();
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
              })
        )
      );
    });
  } catch {
    // ignore
  }
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
      const startRaw = i && (i.startChar ?? i.start);
      const endRaw = i && (i.endChar ?? i.end);

      const start = typeof startRaw === 'number' ? startRaw : Number(startRaw);
      const end = typeof endRaw === 'number' ? endRaw : Number(endRaw);
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
    const border = escapeHtml(issue.color || '#FFC107');
    const bg = toRgba(issue.color, 0.14);

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

function clampPct(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(100, v));
}

function normalizeAnnotationPoint(a) {
  if (!a || typeof a !== 'object') return null;
  const xRaw = a.x;
  const yRaw = a.y;
  const xNum = typeof xRaw === 'number' ? xRaw : Number(xRaw);
  const yNum = typeof yRaw === 'number' ? yRaw : Number(yRaw);
  if (!Number.isFinite(xNum) || !Number.isFinite(yNum)) return null;

  // Stored annotations vary by implementation; support either:
  // - normalized [0..1]
  // - percent [0..100]
  // - pixel coordinates (best-effort, treated as percent if plausible)
  const xPct = xNum <= 1 ? xNum * 100 : (xNum <= 100 ? xNum : 50);
  const yPct = yNum <= 1 ? yNum * 100 : (yNum <= 100 ? yNum : 50);

  const comment = String(a.comment || '').trim();
  return {
    x: clampPct(xPct),
    y: clampPct(yPct),
    comment
  };
}

function pickTeacherComments(feedback) {
  if (!feedback) return '';
  const tc = feedback.teacherComments;
  if (typeof tc === 'string' && tc.trim().length) return tc.trim();
  const tf = feedback.textFeedback;
  if (typeof tf === 'string' && tf.trim().length) return tf.trim();
  return '';
}

function buildRubricRows(feedback) {
  const fb = feedback && typeof feedback === 'object' ? feedback : {};
  const overridden = fb.overriddenScores && typeof fb.overriddenScores === 'object' ? fb.overriddenScores : null;
  const aiScores = fb.aiFeedback && fb.aiFeedback.rubricScores && typeof fb.aiFeedback.rubricScores === 'object' ? fb.aiFeedback.rubricScores : null;

  const submissionRubric = fb.rubricScores && typeof fb.rubricScores === 'object' ? fb.rubricScores : null;

  const rows = [];

  if (overridden) {
    const labels = {
      grammarScore: 'Grammar',
      structureScore: 'Structure',
      contentScore: 'Content',
      vocabularyScore: 'Vocabulary',
      taskAchievementScore: 'Task Achievement',
      overallScore: 'Overall'
    };

    for (const [k, label] of Object.entries(labels)) {
      if (typeof overridden[k] === 'undefined') continue;
      const n = safeNumber(overridden[k], NaN);
      if (!Number.isFinite(n)) continue;
      rows.push({ label, value: `${Math.round(n * 10) / 10}/100`, source: 'Teacher override' });
    }

    return rows;
  }

  if (submissionRubric) {
    const labels = {
      CONTENT: 'Content',
      ORGANIZATION: 'Organization',
      GRAMMAR: 'Grammar',
      VOCABULARY: 'Vocabulary',
      MECHANICS: 'Mechanics'
    };
    for (const [k, label] of Object.entries(labels)) {
      const item = submissionRubric[k];
      const n = safeNumber(item && item.score, NaN);
      const max = safeNumber(item && item.maxScore, 5);
      if (!Number.isFinite(n)) continue;
      rows.push({ label, value: `${Math.round(n * 10) / 10}/${Math.round(max * 10) / 10}`, source: 'Submission' });
    }
    return rows;
  }

  if (aiScores) {
    const labels = {
      CONTENT: 'Content',
      ORGANIZATION: 'Organization',
      GRAMMAR: 'Grammar',
      VOCABULARY: 'Vocabulary',
      MECHANICS: 'Mechanics'
    };
    for (const [k, label] of Object.entries(labels)) {
      const n = safeNumber(aiScores[k], NaN);
      if (!Number.isFinite(n)) continue;
      rows.push({ label, value: `${Math.round(n * 10) / 10}/5`, source: 'AI' });
    }
    return rows;
  }

  return rows;
}

function scoreSummaryFromSubmissionFeedback(submissionFeedback) {
  const overall = safeNumber(submissionFeedback && submissionFeedback.overallScore, NaN);
  if (!Number.isFinite(overall)) return null;
  const grade = submissionFeedback && typeof submissionFeedback.grade === 'string' ? submissionFeedback.grade : '';
  const raw = `${Math.round(overall * 10) / 10}/100`;
  const label = grade && grade.trim().length ? grade.trim() : scoreLabel(overall, 100).label;
  return { raw, label, note: 'From submission feedback' };
}

function normalizeStringList(value, maxItems) {
  const arr = Array.isArray(value) ? value : [];
  const out = [];
  for (const it of arr) {
    const t = typeof it === 'string' ? it.trim() : String(it || '').trim();
    if (!t) continue;
    out.push(t);
    if (typeof maxItems === 'number' && out.length >= maxItems) break;
  }
  return out;
}

function buildAiBlocksFromSubmissionFeedback(submissionFeedback) {
  const detailed = submissionFeedback && submissionFeedback.detailedFeedback && typeof submissionFeedback.detailedFeedback === 'object'
    ? submissionFeedback.detailedFeedback
    : {};
  const ai = submissionFeedback && submissionFeedback.aiFeedback && typeof submissionFeedback.aiFeedback === 'object'
    ? submissionFeedback.aiFeedback
    : {};

  const strengths = normalizeStringList(detailed.strengths, 5);
  const areas = normalizeStringList(detailed.areasForImprovement, 5);
  const steps = normalizeStringList(detailed.actionSteps, 8);

  const overallComments = typeof ai.overallComments === 'string' ? ai.overallComments.trim() : '';
  const perCategory = Array.isArray(ai.perCategory) ? ai.perCategory : [];

  const perCategoryRows = perCategory
    .map((c) => {
      if (!c || typeof c !== 'object') return null;
      const category = String(c.category || '').trim();
      const message = String(c.message || '').trim();
      const scoreOutOf5 = safeNumber(c.scoreOutOf5, NaN);
      if (!category && !message && !Number.isFinite(scoreOutOf5)) return null;
      const scoreText = Number.isFinite(scoreOutOf5) ? `${Math.round(scoreOutOf5 * 10) / 10}/5` : '';
      return { category, message, scoreText };
    })
    .filter(Boolean);

  return {
    strengths,
    areas,
    steps,
    overallComments,
    perCategoryRows
  };
}

function buildHtml({ header, imageUrl, transcriptHtml, scoreSummary, stats, detailedIssues, teacherFeedback, actionSteps, rubricRows, overrideReason, imageAnnotations, submissionFeedbackBlocks }) {
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

  const overrideReasonBlock = overrideReason && String(overrideReason).trim()
    ? `<div class="teacher-feedback">${escapeHtml(String(overrideReason))}</div>`
    : `<div class="teacher-feedback empty">No override reason provided.</div>`;

  const rubricTable = (Array.isArray(rubricRows) ? rubricRows : []).length
    ? `
      <table>
        <thead><tr><th>Rubric</th><th>Score</th><th>Source</th></tr></thead>
        <tbody>
          ${(rubricRows || []).map((r) => `<tr><td>${escapeHtml(r.label)}</td><td>${escapeHtml(r.value)}</td><td>${escapeHtml(r.source)}</td></tr>`).join('')}
        </tbody>
      </table>
    `.trim()
    : `<div class="empty">No rubric scores available.</div>`;

  const strengthsBlock = submissionFeedbackBlocks && Array.isArray(submissionFeedbackBlocks.strengths) && submissionFeedbackBlocks.strengths.length
    ? `<ol>${submissionFeedbackBlocks.strengths.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : `<div class="empty">No strengths available.</div>`;

  const areasBlock = submissionFeedbackBlocks && Array.isArray(submissionFeedbackBlocks.areas) && submissionFeedbackBlocks.areas.length
    ? `<ol>${submissionFeedbackBlocks.areas.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : `<div class="empty">No areas for improvement available.</div>`;

  const aiStepsBlock = submissionFeedbackBlocks && Array.isArray(submissionFeedbackBlocks.steps) && submissionFeedbackBlocks.steps.length
    ? `<ol>${submissionFeedbackBlocks.steps.map((s) => `<li>${escapeHtml(s)}</li>`).join('')}</ol>`
    : `<div class="empty">No action steps available.</div>`;

  const aiOverallCommentsBlock = submissionFeedbackBlocks && typeof submissionFeedbackBlocks.overallComments === 'string' && submissionFeedbackBlocks.overallComments.trim().length
    ? `<div class="teacher-feedback">${escapeHtml(submissionFeedbackBlocks.overallComments)}</div>`
    : `<div class="teacher-feedback empty">No AI overall comments available.</div>`;

  const aiPerCategoryTable = submissionFeedbackBlocks && Array.isArray(submissionFeedbackBlocks.perCategoryRows) && submissionFeedbackBlocks.perCategoryRows.length
    ? `
      <table>
        <thead><tr><th>Category</th><th>Score</th><th>Feedback</th></tr></thead>
        <tbody>
          ${submissionFeedbackBlocks.perCategoryRows.map((r) => `<tr><td>${escapeHtml(r.category || '')}</td><td>${escapeHtml(r.scoreText || '')}</td><td>${escapeHtml(r.message || '')}</td></tr>`).join('')}
        </tbody>
      </table>
    `.trim()
    : `<div class="empty">No AI per-category feedback available.</div>`;

  const imgBlock = imageUrl
    ? `
      <div class="image-wrap">
        <img class="essay-image" src="${escapeHtml(imageUrl)}" alt="Original submission" />
        ${(Array.isArray(imageAnnotations) ? imageAnnotations : []).map((a) => {
          const left = clampPct(a.x);
          const top = clampPct(a.y);
          const idx = escapeHtml(String(a.index));
          return `<div class="img-marker" style="left:${left}%; top:${top}%;">${idx}</div>`;
        }).join('')}
      </div>
    `.trim()
    : `<div class="empty">Original image not available.</div>`;

  const imageAnnotationsList = (Array.isArray(imageAnnotations) ? imageAnnotations : []).length
    ? `
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Image Annotations</div>
        <ol>
          ${(imageAnnotations || []).map((a) => `<li><strong>#${escapeHtml(String(a.index))}:</strong> ${escapeHtml(String(a.comment || ''))}</li>`).join('')}
        </ol>
      </div>
    `.trim()
    : `<div class="card"><div style="font-weight:700; margin-bottom:6px;">Image Annotations</div><div class="empty">No image annotations available.</div></div>`;

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
    .image-wrap { position: relative; }
    .img-marker { position: absolute; transform: translate(-50%, -50%); width: 22px; height: 22px; border-radius: 999px; background: rgba(239, 68, 68, 0.95); color: #fff; font-weight: 900; font-size: 11px; display:flex; align-items:center; justify-content:center; border: 2px solid #fff; box-shadow: 0 1px 0 rgba(2,6,23,0.2); }
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
        <div style="font-weight:700; margin-bottom:6px;">AI Overall Comments</div>
        ${aiOverallCommentsBlock}
      </div>
      <div style="height:10px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Rubric Scores</div>
        ${rubricTable}
      </div>
      <div style="height:10px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">AI Per-Category Feedback</div>
        ${aiPerCategoryTable}
      </div>
      <div style="height:10px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Override Reason</div>
        ${overrideReasonBlock}
      </div>
      <div style="height:10px"></div>
      <div class="grid">
        <div class="card">
          <div style="font-weight:700; margin-bottom:6px;">Strengths</div>
          ${strengthsBlock}
        </div>
        <div class="card">
          <div style="font-weight:700; margin-bottom:6px;">Areas for Improvement</div>
          ${areasBlock}
        </div>
      </div>
      <div style="height:10px"></div>
      <div class="card">
        <div style="font-weight:700; margin-bottom:6px;">Action Steps</div>
        ${aiStepsBlock}
      </div>
      <div style="height:10px"></div>
      ${imageAnnotationsList}
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

async function renderSubmissionPdf({ header, imageUrl, transcriptText, issues, feedback, submissionFeedback }) {
  const stats = computeCorrectionStats(issues);
  const actionSteps = buildActionSteps(stats);
  const transcriptHtml = transcriptText && String(transcriptText).trim()
    ? buildWritingCorrectionsHtml(String(transcriptText), issues)
    : '';

  const rawImageUrl = typeof imageUrl === 'string' ? imageUrl.trim() : '';
  if (rawImageUrl && rawImageUrl.startsWith('/uploads')) {
    const base = (process.env.BASE_URL || '').trim().replace(/\/+$/, '');
    if (base) {
      imageUrl = `${base}${rawImageUrl}`;
    }
  }

  let score = safeNumber(feedback && feedback.score, NaN);
  let maxScore = safeNumber(feedback && feedback.maxScore, NaN);
  let scoreSummary = scoreLabel(score, maxScore);

  const sbScoreSummary = scoreSummaryFromSubmissionFeedback(submissionFeedback);
  if (sbScoreSummary) {
    scoreSummary = sbScoreSummary;
  }

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

  let embedded = await tryFetchAsDataUri(imageUrl);
  if (!embedded) {
    embedded = await tryReadUploadsFileAsDataUri(imageUrl);
  }

  const rubricRows = buildRubricRows(submissionFeedback || feedback);
  const overrideReason = feedback && typeof feedback.overrideReason === 'string' ? feedback.overrideReason : '';
  const teacherFeedback = pickTeacherComments(feedback);
  const rawAnnotations = feedback && Array.isArray(feedback.annotations) ? feedback.annotations : [];
  const imageAnnotations = rawAnnotations
    .map((a) => normalizeAnnotationPoint(a))
    .filter(Boolean)
    .map((a, idx) => ({ ...a, index: idx + 1 }))
    .filter((a) => a.comment && String(a.comment).trim().length);

  const submissionFeedbackBlocks = buildAiBlocksFromSubmissionFeedback(submissionFeedback);

  const html = buildHtml({
    header: {
      ...header,
      date: header && header.date ? header.date : formatDate(new Date())
    },
    imageUrl: embedded || imageUrl,
    transcriptHtml,
    scoreSummary,
    stats,
    detailedIssues: issues,
    teacherFeedback,
    actionSteps,
    rubricRows,
    overrideReason,
    imageAnnotations,
    submissionFeedbackBlocks
  });

  const userDataDir = (process.env.PUPPETEER_USER_DATA_DIR && String(process.env.PUPPETEER_USER_DATA_DIR).trim())
    ? String(process.env.PUPPETEER_USER_DATA_DIR).trim()
    : path.join(os.tmpdir(), 'puppeteer');

  try {
    await fs.promises.mkdir(userDataDir, { recursive: true });
  } catch {
    // ignore; puppeteer will throw a more descriptive error if it cannot use this dir
  }

  const browser = await puppeteer.launch({
    headless: true,
    userDataDir,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });

    await waitForImages(page);

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
