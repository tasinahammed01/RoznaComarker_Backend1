'use strict';
// HTML for the whole-assignment report PDF. It renders ONLY the fields of the report payload built by assignmentReport.service.js (the same
// object the JSON endpoint returns), so the PDF numbers are the page numbers. Every text is escaped. Self-contained: the Rubrilo logo is
// embedded (read from the same asset the feedback PDF uses, never written), charts are inline SVG from the shared geometry, no network.
// Section order follows the page: KPIs, (AI summary, Stage 4), insights, score distribution, submissions over time, rubric, errors, students.
const fs = require('fs');
const path = require('path');
const { columnChartGeometry, roundedTopBarPath } = require('./assignmentReportChartGeometry');
const { safeTimeZone } = require('../services/assignmentReport.service');

const LOGO_DATA_URI = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'rubrilo-logo-horizontal-fullcolor@512w.png')).toString('base64')}`;
const MAX_PDF_ROWS = 500;
const ERRORS_NOTE = 'Counts are from the AI analysis and may include items you removed.';
const SUMMARY_LABEL = 'AI-generated summary. Please review before sharing.';
// Common mistakes: the page's wording (assignment-report.ts), so the PDF says exactly what the page says.
const COMMON_MISTAKES_NOTE = 'Based on the corrections students can see. Corrections you removed are not counted.';
const COMMON_MISTAKES_EMPTY = { not_enough_students: 'Not enough submissions yet to find common mistakes', none_shared: 'No mistake was shared by 2 or more students.' };
const COMMON_MISTAKES_PARTIAL = 'Some edited essays were left out of this section.';
const CHART = { width: 600, height: 220 };
// The app's theme colours (styles.css) and its category edge colours (constants/category-palette.ts): the same as the page.
const COLOR = { primary: '#008081', navy: '#203864', title: '#14264d', text: '#374151', muted: '#6b7280', border: '#e5e7eb' };
const CATEGORY_EDGE = { CONTENT: '#B45309', ORGANIZATION: '#0369A1', GRAMMAR: '#15803D', VOCABULARY: '#7E22CE', MECHANICS: '#A16207' };
const SOURCE_LABELS = { class: 'Class', guest: 'Guest', teacher_upload: 'Teacher upload' };
const NOT_SCORED_DETAIL = { FAILED: 'Assessment failed', BLOCKED: 'Blocked', STALE: 'Out of date', PARTIAL: 'Incomplete' };

const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const pctText = value => (num(value) === null ? '—' : `${value}%`);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function formatDate(iso, timeZone, withTime = false) {
  const date = iso instanceof Date ? iso : new Date(iso);
  if (!Number.isFinite(date.getTime())) return 'Not set';
  const options = { month: 'short', day: 'numeric', year: 'numeric', timeZone, ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}) };
  try { return new Intl.DateTimeFormat('en-US', options).format(date); } catch { return date.toISOString().slice(0, 10); }
}

/** The page's status label for a student row (statuses are words, never a 0 score). */
function statusOf(s) {
  if (s.assessment === 'in_progress') return { label: 'In progress', detail: null, tone: 'progress' };
  if (s.assessment === 'not_scored' || num(s.score) === null) return { label: 'Not scored', detail: NOT_SCORED_DETAIL[String(s.notScoredReason)] || null, tone: 'unscored' };
  if (s.band === 'on_track') return { label: 'On track', detail: null, tone: 'good' };
  if (s.band === 'needs_revision') return { label: 'Needs revision', detail: null, tone: 'warning' };
  return { label: 'Needs attention', detail: null, tone: 'critical' };
}

function columnChart(points, { label, valueName, categoryName, color, showValues }) {
  const g = columnChartGeometry(points, CHART);
  const total = g.bars.reduce((sum, b) => sum + b.value, 0);
  const parts = [];
  for (const tick of g.ticks) {
    parts.push(`<line class="grid" x1="${g.plotLeft}" x2="${g.plotRight}" y1="${tick.y}" y2="${tick.y}"/>`,
      `<text class="tick" x="${g.plotLeft - 6}" y="${tick.y + 4}" text-anchor="end">${tick.value}</text>`);
  }
  for (const bar of g.bars) {
    const d = roundedTopBarPath(bar);
    if (d) parts.push(`<path class="bar" d="${d}" fill="${color}"/>`);
    if (showValues && bar.value > 0) parts.push(`<text class="value" x="${bar.centerX}" y="${bar.y - 6}" text-anchor="middle">${bar.value}</text>`);
    if (bar.showLabel) parts.push(`<text class="label" x="${bar.centerX}" y="${g.plotBottom + 18}" text-anchor="middle">${esc(bar.label)}</text>`);
  }
  parts.push(`<line class="baseline" x1="${g.plotLeft}" x2="${g.plotRight}" y1="${g.plotBottom}" y2="${g.plotBottom}"/>`);
  const aria = `${label}: ${total} ${valueName} in ${g.bars.length} groups`;
  return `<svg class="chart" viewBox="0 0 ${CHART.width} ${CHART.height}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="${esc(aria)}">${parts.join('')}</svg>`
    + `<p class="sr">${esc(categoryName)}: ${points.map(p => `${esc(p.label)} ${p.value}`).join(', ')}</p>`;
}

function barList(items, emptyText) {
  if (!items.length) return `<p class="muted">${esc(emptyText)}</p>`;
  return `<div class="bars">${items.map(item => {
    const width = Math.max(0, Math.min(100, num(item.percent) ?? 0));
    const marker = item.marker === 'strongest' ? '<span class="marker strongest">Strongest</span>'
      : item.marker === 'weakest' ? '<span class="marker weakest">Weakest</span>' : '';
    return `<div class="bar-row"><div class="bar-head"><span class="bar-label">${esc(item.label)}</span><span class="bar-value">${esc(item.valueText)}</span>${marker}</div>`
      + `<div class="track"><div class="fill" style="width:${width}%;background:${item.color || COLOR.primary}"></div></div></div>`;
  }).join('')}</div>`;
}

// The page shows the first 3 examples of a type (it offers the other 2 on request); the PDF shows the same first 3.
const PDF_EXAMPLES = 3;
/**
 * The student's sentence with the mistakes marked ('err') or with the corrections in their place ('fix'); "…" where the sentence was cut
 * and between two parts of a long sentence. Every text escaped.
 */
function sentenceHtml(sentence, mode) {
  const parts = sentence.parts.map(p => (p?.gap ? ' … ' : p?.error ? (mode === 'err' ? `<mark class="err">${esc(p.text)}</mark>`
    : (p.corrected ? `<mark class="fix">${esc(p.corrected)}</mark>` : '')) : esc(p?.text))).join('');
  return (sentence.cutStart ? '… ' : '') + parts + (sentence.cutEnd ? '…' : '');
}
const hasSentence = e => Boolean(e?.sentence && Array.isArray(e.sentence.parts) && e.sentence.parts.some(p => p?.error));
/** One example: the sentence (as written, then corrected) when there is one, else the word pair; then the reason. */
function exampleHtml(e) {
  const change = hasSentence(e)
    ? '<p class="sent"><span class="lab">Student wrote</span> ' + sentenceHtml(e.sentence, 'err') + '</p>'
      + (e.sentence.parts.some(p => p?.error && p.corrected) ? '<p class="sent"><span class="lab">Corrected</span> ' + sentenceHtml(e.sentence, 'fix') + '</p>' : '')
    : '<p class="change"><del>' + esc(e?.original) + '</del>'
      + (e?.corrected ? '<span class="arrow" aria-hidden="true"> → </span><ins>' + esc(e.corrected) + '</ins>' : '') + '</p>';
  return '<li class="example">' + change + (e?.explanation ? '<p class="why">' + esc(e.explanation) + '</p>' : '') + '</li>';
}

/** Common mistakes: one block per type at least 2 students made ("4 of 6 students", a bar, up to 3 examples), or the empty state. */
function commonMistakesSection(section) {
  if (!section || typeof section !== 'object') return '';
  const common = (Array.isArray(section.types) ? section.types : []).filter(t => t && t.isCommon === true);
  const empty = COMMON_MISTAKES_EMPTY[section.state] || (common.length ? '' : COMMON_MISTAKES_EMPTY.none_shared);
  const blocks = common.map(t => {
    const students = num(t.studentCount) ?? 0, total = num(t.totalStudents) ?? 0;
    const width = total > 0 ? Math.round((students / total) * 100) : 0;
    const examples = (Array.isArray(t.examples) ? t.examples : []).slice(0, PDF_EXAMPLES).map(exampleHtml).join('');
    return '<div class="mistake"><div class="bar-head"><span class="bar-label">' + esc(t.typeCode + ' · ' + t.label) + '</span><span class="bar-value">'
      + esc(students + ' of ' + total + ' students') + '</span></div><div class="track"><div class="fill" style="width:' + width + '%;background:' + (CATEGORY_EDGE[t.category] || COLOR.primary) + '"></div></div>'
      + (examples ? '<ul class="examples">' + examples + '</ul>' : '') + '</div>';
  }).join('');
  return '<section class="panel common" data-section="common-mistakes"><h2>Common mistakes</h2><p class="note">' + esc(COMMON_MISTAKES_NOTE) + '</p>'
    + (section.partial === true ? '<p class="note">' + esc(COMMON_MISTAKES_PARTIAL) + '</p>' : '')
    + (empty ? '<p class="muted">' + esc(empty) + '</p>' : blocks) + '</section>';
}

function studentsTable(students) {
  const ordered = [...students.filter(s => s.needsAttention), ...students.filter(s => !s.needsAttention)];
  const shown = ordered.slice(0, MAX_PDF_ROWS);
  const grouped = ordered.some(s => s.needsAttention);
  const rows = [];
  let group = null;
  for (const s of shown) {
    if (grouped && s.needsAttention !== group) {
      group = s.needsAttention;
      rows.push(`<tr class="group"><th colspan="5">${s.needsAttention ? 'Needs attention' : 'Other students'}</th></tr>`);
    }
    const status = statusOf(s);
    rows.push(`<tr class="row${s.needsAttention ? ' attention' : ''}">`
      + `<td><span class="name">${esc(s.name)}</span><span class="source">${esc(SOURCE_LABELS[s.source] || 'Class')}</span></td>`
      + `<td><span class="status ${status.tone}">${esc(status.label)}</span>${status.detail ? `<span class="detail">${esc(status.detail)}</span>` : ''}</td>`
      + `<td class="score">${num(s.score) === null ? '—' : `${s.score}%`}</td>`
      + `<td>${s.isLate ? '<span class="late">Late</span>' : '<span class="muted">On time</span>'}</td>`
      + `<td>${s.reviewed ? '<span class="done">Reviewed</span>' : '<span class="muted">Not reviewed</span>'}</td></tr>`);
  }
  const more = ordered.length - shown.length;
  return `<table class="students"><thead><tr><th>Name</th><th>Status</th><th>Score</th><th>Late</th><th>Reviewed</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
    + (more > 0 ? `<p class="more">and ${more} more ${more === 1 ? 'student' : 'students'} not shown in this PDF.</p>` : '');
}

const STYLE = `@page{size:A4;margin:18mm 12mm 16mm}*{box-sizing:border-box}html,body{margin:0}
main{padding:0 .6mm}
body{font:9.5pt/1.4 Arial,Helvetica,sans-serif;color:${COLOR.text};-webkit-print-color-adjust:exact;print-color-adjust:exact}
.brand{display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid ${COLOR.primary};padding-bottom:3mm;margin-bottom:4mm}
.brand img{display:block;height:10mm;width:auto}.brand .generated{color:${COLOR.muted};font-size:8pt;text-align:right}
.eyebrow{margin:0 0 1mm;color:${COLOR.primary};font-size:8pt;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0 0 3mm;color:${COLOR.title};font-size:20pt;line-height:1.15;overflow-wrap:anywhere}
.meta{display:flex;flex-wrap:wrap;gap:2mm 9mm;margin:0 0 4mm}.meta dt{color:${COLOR.muted};font-size:7pt;font-weight:700;text-transform:uppercase;letter-spacing:.04em}
.meta dd{margin:.5mm 0 0;color:${COLOR.navy};font-weight:700;overflow-wrap:anywhere}
.notice{margin:0 0 3mm;padding:2.5mm 3.5mm;border:1px solid #fde68a;border-radius:2mm;background:#fffbeb;color:#78350f;break-inside:avoid}
.notice.muted{border-color:#dbe3e9;background:#f8fafb;color:${COLOR.text}}
h2{margin:0 0 1mm;color:${COLOR.title};font-size:12pt;break-after:avoid;page-break-after:avoid}h3{margin:3mm 0 1.5mm;color:${COLOR.navy};font-size:9.5pt;break-after:avoid}
.sub{margin:0 0 2.5mm;color:${COLOR.muted};font-size:8pt}
.kpis{display:grid;grid-template-columns:repeat(5,1fr);gap:2mm;margin-bottom:4mm}
.kpi,.panel{break-inside:avoid;page-break-inside:avoid}
.kpi{padding:2.5mm 3mm;border:1px solid #e2e8ee;border-radius:2mm;background:#fff}
.kpi span{display:block;color:${COLOR.muted};font-size:7.5pt;font-weight:700}.kpi strong{display:block;color:${COLOR.title};font-size:15pt;line-height:1.2}
.kpi small{display:block;color:${COLOR.muted};font-size:6.5pt}
.panel{margin:0 0 4mm;padding:3.5mm 4mm;border:1px solid ${COLOR.border};border-radius:3mm;background:#fff}
.insights{margin:0;padding-left:5mm}.insights li{margin:.8mm 0}
.chart{display:block;width:100%;height:auto}.chart .grid{stroke:#e7e7e7;stroke-width:1}.chart .baseline{stroke:#cbd5e1;stroke-width:1}
.chart .tick,.chart .label{fill:${COLOR.muted};font-size:11px}.chart .value{fill:${COLOR.text};font-size:12px;font-weight:700}
.hidden-chart{margin:0;padding:3mm;border:1px dashed #cbd5e1;border-radius:2mm;background:#f8fafb;color:${COLOR.muted}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
.bars{display:flex;flex-direction:column;gap:2.2mm}.bar-row{break-inside:avoid}.bar-head{display:flex;align-items:baseline;gap:2mm;margin-bottom:.8mm}
.bar-label{flex:1 1 auto;font-weight:700;overflow-wrap:anywhere}.bar-value{color:${COLOR.navy};font-weight:700}
.marker{padding:.2mm 1.8mm;border-radius:3mm;font-size:7pt;font-weight:700}.marker.strongest{background:#e6f4f4;color:#0f5f60}.marker.weakest{background:#fff4e5;color:#8a4b00}
.marker.strongest::before{content:"\\25B2\\00A0"}.marker.weakest::before{content:"\\25BC\\00A0"}
.track{height:2.2mm;border-radius:2mm;background:#e8eef2;overflow:hidden}.fill{height:100%;border-radius:0 1mm 1mm 0}
.note{margin:0 0 2mm;color:${COLOR.muted};font-size:8pt}.muted{color:${COLOR.muted}}
.summary{border-left:4px solid ${COLOR.primary};background:#f3f9f9}.summary ul{margin:0 0 1mm;padding-left:5mm}.summary li{margin:.6mm 0}
.summary-label{margin:0 0 2mm;color:${COLOR.muted};font-size:7.5pt;font-style:italic}.summary-headline{margin:0 0 1mm;color:${COLOR.title};font-weight:700}
.summary-caution{margin:2mm 0 0;color:${COLOR.muted};font-size:8pt}
table.students{width:100%;border-collapse:collapse;font-size:8.5pt}
thead{display:table-header-group}
tr{break-inside:avoid;page-break-inside:avoid}
th,td{padding:1.6mm 2mm;border-bottom:1px solid #edf1f4;text-align:left;vertical-align:top}
thead th{background:#f3f7f7;color:${COLOR.navy};font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em}
tr.group th{background:#f8fafb;color:${COLOR.title};font-size:7.5pt;text-transform:uppercase;letter-spacing:.04em}
tr.attention td:first-child{box-shadow:inset 1mm 0 0 #ee4e4e}
.name{display:block;font-weight:700;overflow-wrap:anywhere}.source,.detail{display:block;color:${COLOR.muted};font-size:7.5pt}
.score{font-weight:700;color:${COLOR.title};white-space:nowrap}
.status{display:inline-block;padding:.3mm 2mm;border-radius:3mm;font-size:7.5pt;font-weight:700;white-space:nowrap}
.status.good{background:#dcfce7;color:#166534}.status.warning{background:#fef3c7;color:#92400e}.status.critical{background:#fee2e2;color:#991b1b}
.status.unscored{background:#f1f5f9;color:#334155}.status.progress{background:#e0f2fe;color:#075985}
.late{color:#92400e;font-weight:700}.done{color:#136c6d;font-weight:700}.more{margin:2mm 0 0;color:${COLOR.muted}}
.empty{padding:10mm;border:1px solid ${COLOR.border};border-radius:3mm;text-align:center}
.panel.common{break-inside:auto;page-break-inside:auto}.mistake{margin:0 0 3mm;break-inside:avoid;page-break-inside:avoid}
.examples{list-style:none;margin:1.5mm 0 0;padding:0}.example{margin:0 0 1.2mm;padding-left:3mm;border-left:2px solid ${COLOR.border}}
.change{margin:0;font-size:8.5pt}.change del{color:${COLOR.muted}}.change ins{text-decoration:none;font-weight:700;color:${COLOR.title}}.why{margin:.3mm 0 0;color:${COLOR.muted};font-size:8pt}
.sent{margin:0 0 .4mm;font-size:8.5pt;overflow-wrap:anywhere}.sent .lab{display:inline-block;min-width:22mm;color:${COLOR.muted};font-size:7pt;text-transform:uppercase;letter-spacing:.03em}
mark.err{background:#fde8e8;color:#b42318;text-decoration:line-through;padding:0 .4mm;border-radius:.6mm}
mark.fix{background:#e3f5ec;color:#0f6b46;font-weight:700;padding:0 .4mm;border-radius:.6mm}`;

/**
 * The report as a self-contained HTML document for the PDF renderer.
 * options.generatedAt: Date of generation (shown in the report's time zone). options.summary: { text } only when the Stage 4 summary is
 * current (its fingerprint matches the data); otherwise null and the section is not rendered at all.
 */
function renderAssignmentReportHtml(report, { generatedAt = new Date(), summary = null } = {}) {
  const timeZone = safeTimeZone(report.timeZone);
  const { assignment, counts, scores, rubric, errors, timeline, smallData } = report;
  const out = [];
  out.push(`<header class="brand"><img src="${LOGO_DATA_URI}" width="512" height="164" alt="Rubrilo">`
    + `<div class="generated">Rubrilo assignment report<br>Generated ${esc(formatDate(generatedAt, timeZone, true))} (${esc(timeZone)})</div></header>`);
  out.push(`<p class="eyebrow">Assignment report</p><h1>${esc(assignment.title)}</h1><dl class="meta">`
    + `<div><dt>Class</dt><dd>${esc(assignment.className || 'Not set')}</dd></div>`
    + `<div><dt>Due date</dt><dd>${esc(assignment.deadline ? formatDate(assignment.deadline, timeZone) : 'Not set')}</dd></div>`
    + `<div><dt>Submissions</dt><dd>${esc(`${plural(counts.total, 'submission', 'submissions')}: ${counts.bySource.class} class, ${counts.bySource.guest} guest, ${counts.bySource.teacherUpload} teacher upload · ${counts.reviewed} reviewed`)}</dd></div></dl>`);
  if (counts.capped) out.push('<p class="notice">Only the first part of the submissions is included in this report, because this assignment has a very large number of submissions.</p>');
  if (counts.skippedRows > 0) out.push(`<p class="notice muted">${counts.skippedRows} ${counts.skippedRows === 1 ? 'record could not be read and is' : 'records could not be read and are'} not included.</p>`);

  if (!counts.total) {
    out.push('<section class="empty"><h2>No submissions yet</h2><p>The report fills in as students submit their work.</p></section>');
  } else {
    const kpis = [['Total submissions', counts.total], ['Scored', counts.scored], ['Average', pctText(scores.average)], ['Median', pctText(scores.median)],
      ['Highest', pctText(scores.highest)], ['Lowest', pctText(scores.lowest)], ['Needs revision', pctText(scores.needsRevisionPct), 'Scored under 80%'],
      ['Late', counts.late], ['Not scored', counts.notScored]];
    out.push(`<section><h2>Key numbers</h2><div class="kpis">${kpis.map(([label, value, hint]) =>
      `<div class="kpi"><span>${esc(label)}</span> <strong>${esc(value)}</strong>${hint ? ` <small>${esc(hint)}</small>` : ''}</div>`).join('')}</div></section>`);
    if (counts.scored === 0) out.push('<p class="notice muted">No scored submissions yet. Scores, the score distribution and rubric averages appear once assessments finish.</p>');
    if (summary && typeof summary.headline === 'string' && summary.headline.trim()) {
      const list = items => (Array.isArray(items) && items.length ? `<ul>${items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : '');
      out.push(`<section class="panel summary" data-section="summary"><h2>AI summary</h2><p class="summary-label">${esc(SUMMARY_LABEL)}</p>`
        + `<p class="summary-headline">${esc(summary.headline.trim())}</p>`
        + (summary.findings?.length ? `<h3>Key findings</h3>${list(summary.findings)}` : '')
        + (summary.nextSteps?.length ? `<h3>Suggested next steps</h3>${list(summary.nextSteps)}` : '')
        + (summary.caution ? `<p class="summary-caution">${esc(summary.caution)}</p>` : '') + '</section>');
    }
    if (report.insights?.length) out.push(`<section class="panel"><h2>Insights</h2><ul class="insights">${report.insights.map(i => `<li>${esc(i.text)}</li>`).join('')}</ul></section>`);
    if (counts.scored > 0) {
      out.push('<section class="panel"><h2>Score distribution</h2><p class="sub">Scored submissions per score band (%)</p>'
        + (smallData.distributionHidden ? '<p class="hidden-chart">Not enough scored submissions to show a fair distribution (at least 3 are needed).</p>'
          : columnChart(scores.bands.map(b => ({ label: b.label, value: b.count })), { label: 'Score distribution', valueName: 'submissions', categoryName: 'Score band', color: COLOR.primary, showValues: true }))
        + '</section>');
    }
    const weekly = timeline.granularity === 'week';
    const dayLabel = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
    out.push(`<section class="panel"><h2>Submissions over time</h2><p class="sub">${weekly ? 'Per week (week starting)' : 'Per day'}, in ${esc(timeZone)}</p>`
      + (smallData.timelineHidden ? '<p class="hidden-chart">Not enough submissions to show a trend (at least 3 are needed).</p>'
        : columnChart(timeline.points.map(p => ({ label: dayLabel.format(new Date(`${p.date}T00:00:00Z`)), value: p.count })),
          { label: weekly ? 'Submissions per week' : 'Submissions per day', valueName: 'submissions', categoryName: weekly ? 'Week starting' : 'Day', color: COLOR.navy, showValues: false }))
      + '</section>');
    if (counts.scored > 0) {
      out.push(`<section class="panel"><h2>${rubric.kind === 'custom' ? 'Rubric criteria' : 'Rubric categories'}</h2><p class="sub">Average across scored submissions</p>`
        + barList(rubric.criteria.map(c => ({ label: c.label, percent: c.averagePct, valueText: `${c.averagePct}%`,
          marker: c.key === rubric.strongestKey ? 'strongest' : c.key === rubric.weakestKey ? 'weakest' : null })), 'No rubric scores yet.')
        + '</section>');
    }
    out.push(`<section class="panel"><h2>Most common errors</h2><p class="note">${esc(ERRORS_NOTE)}</p><h3>By category</h3>`
      + barList(errors.total > 0 ? errors.categories.map(c => ({ label: c.label, percent: c.pct, valueText: `${c.count} (${c.pct}%)`, color: CATEGORY_EDGE[c.key] })) : [],
        'No corrections recorded yet.')
      + (errors.symbols.length ? `<h3>Top correction types</h3>${barList(errors.symbols.map(s => ({ label: `${s.symbol} · ${s.label}`, percent: s.pct,
        valueText: `${s.count} (${s.pct}%)`, color: CATEGORY_EDGE[s.category] })), '')}` : '')
      + '</section>');
    out.push(commonMistakesSection(report.commonMistakes));
    out.push(`<section><h2>Students</h2><p class="sub">${plural(report.students.length, 'student', 'students')}. Students who need attention are listed first.</p>${studentsTable(report.students)}</section>`);
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Rubrilo assignment report</title><style>${STYLE}</style></head>`
    + `<body><main>${out.join('')}</main><script>window.__REPORT_READY__=true</script></body></html>`;
}

/** A safe ASCII slug of the title (no path or header characters), at most 60 characters; 'assignment' when nothing is left. */
function slugifyTitle(title) {
  let slug = String(title ?? '').normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (slug.length > 60) {
    const cut = slug.slice(0, 61);
    const boundary = cut.lastIndexOf('-');
    slug = boundary >= 30 ? cut.slice(0, boundary) : slug.slice(0, 60);   // end on a whole word when one is close enough
  }
  return slug.replace(/-+$/g, '') || 'assignment';
}
/** Rubrilo-report-<slug>-<YYYY-MM-DD>.pdf, the date in the teacher's (validated) time zone. */
function reportPdfFilename(title, date = new Date(), timeZone = 'UTC') {
  let day;
  try { day = new Intl.DateTimeFormat('en-CA', { timeZone: safeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit' }).format(date); }
  catch { day = new Date().toISOString().slice(0, 10); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) day = new Date().toISOString().slice(0, 10);
  return `Rubrilo-report-${slugifyTitle(title)}-${day}.pdf`;
}

module.exports = { renderAssignmentReportHtml, reportPdfFilename, slugifyTitle, ERRORS_NOTE, SUMMARY_LABEL, COMMON_MISTAKES_NOTE, MAX_PDF_ROWS };
