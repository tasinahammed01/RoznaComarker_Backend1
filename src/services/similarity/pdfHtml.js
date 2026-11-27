'use strict';
// The teacher-only similarity PDF as HTML, built from the same view the page shows (views.js), so the saved exclusions and the server's
// percentages apply. Every text is escaped. Each highlight carries its source number as text (colour is never the only signal). No provider
// name appears (the PDF may be shared). The renderer waits for window.__REPORT_READY__.

const COLORS = Object.freeze(['#f8c9c9', '#c9dff8', '#cdeccf', '#f8e2c0', '#e3d1f5', '#c8eeee', '#f5d0e6', '#e6e6b8']);
const escapeHtml = value => String(value ?? '').replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;')
  .replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
const colorOf = number => COLORS[(Math.max(1, number) - 1) % COLORS.length];
const pct = value => `${value}%`;
const dateOf = value => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10); };

/**
 * Display only: a single line break (the handwriting's line ends) becomes a space of the same length; a paragraph break (a blank line, also
 * with spaces or a carriage return on it) and the page separator stay. Same length, so the highlight offsets are unchanged. The same rule as
 * the teacher page (frontend utils/similarity-display.ts flowText).
 */
function flowText(text) {
  const t = typeof text === 'string' ? text : '';
  const out = t.split('');
  const blank = c => c === ' ' || c === '\t' || c === '\r';
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== '\n') continue;
    let j = i - 1; while (j >= 0 && blank(t[j])) j--;
    let k = i + 1; while (k < t.length && blank(t[k])) k++;
    if ((j >= 0 && t[j] === '\n') || (k < t.length && t[k] === '\n')) continue;
    out[i] = ' ';
    if (i > 0 && t[i - 1] === '\r') out[i - 1] = ' ';
  }
  return out.join('');
}

function essayHtml(view, numberOf) {
  const text = flowText(String(view.text || ''));
  let out = '';
  let at = 0;
  for (const h of (view.highlights || []).slice().sort((a, b) => a.start - b.start)) {
    const n = numberOf.get(h.sourceId);
    if (!n || h.start < at || h.end > text.length) continue;
    out += escapeHtml(text.slice(at, h.start));
    out += `<mark class="m${n}" style="background:${colorOf(n)}">${escapeHtml(text.slice(h.start, h.end))}<sup>${n}</sup></mark>`;
    at = h.end;
  }
  return (out + escapeHtml(text.slice(at))).replace(/\f/gu, '').replace(/\n/gu, '<br>');
}

const sourceLine = s => `<li data-number="${s.number ?? ''}"><span class="badge" style="background:${s.number ? colorOf(s.number) : '#eee'}">${s.number ?? '&ndash;'}</span>`
  + ` <b>${escapeHtml(s.label)}</b>${s.title ? ` &middot; ${escapeHtml(s.title)}` : ''}${s.url ? `<br><span class="url">${escapeHtml(s.url)}</span>` : ''}`
  + `<span class="pct">${s.percent === null || s.percent === undefined ? '' : pct(s.percent)}</span></li>`;

/** view: the teacher view of a completed (or expired) report. { generatedAt, title } -> a whole HTML document. */
function renderSimilarityHtml(view, { generatedAt = new Date(), title = '' } = {}) {
  const sources = view.sources || [];
  const counted = sources.filter(s => s.number);
  const numberOf = new Map(counted.map(s => [s.sourceId, s.number]));
  const notCompared = sources.filter(s => !s.excluded && !s.compared);
  const excluded = sources.filter(s => s.excluded);
  const notes = [];
  if (view.outdated) notes.push('The essay changed after this check. Run a new check for an up-to-date report.');
  if (view.state === 'expired' || view.external?.state === 'expired') notes.push('The internet check did not finish; this report shows the comparison with other Rubrilo essays only.');
  if (view.external?.state === 'failed') notes.push('The internet check could not be completed; this report shows the comparison with other Rubrilo essays only.');
  const list = (heading, items) => (items.length ? `<h2>${heading}</h2><ul class="sources">${items.map(sourceLine).join('')}</ul>` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Similarity Report</title><style>
@page { size: A4 portrait; margin: 18mm 12mm 16mm; }
body { font: 10pt/1.5 Arial, sans-serif; color: #1d2a33; }
h1 { font-size: 16pt; margin: 0 0 2mm; } h2 { font-size: 11pt; margin: 6mm 0 2mm; }
.overall { font-size: 28pt; font-weight: bold; color: #087f83; } .meta { color: #5a6b77; font-size: 9pt; }
.note { background: #fff6e0; border: 1px solid #f0d9a0; padding: 2mm 3mm; margin: 2mm 0; }
ul.sources { list-style: none; padding: 0; margin: 0; } ul.sources li { padding: 1.5mm 0; border-bottom: 1px solid #e6ecef; position: relative; padding-right: 16mm; }
.badge { display: inline-block; min-width: 5mm; text-align: center; border-radius: 1mm; font-weight: bold; border: 1px solid #9aa9b3; }
.pct { position: absolute; right: 0; top: 1.5mm; font-weight: bold; } .url { color: #5a6b77; font-size: 8pt; word-break: break-all; }
.essay { border: 1px solid #dfe6ea; padding: 4mm; white-space: normal; } mark { border-bottom: 1px solid #6b7b86; } sup { font-size: 6.5pt; font-weight: bold; }
</style></head><body>
<h1>Similarity Report</h1>
<div class="meta">${title ? `${escapeHtml(title)} &middot; ` : ''}Checked ${escapeHtml(dateOf(view.checkedAt))} &middot; Generated ${escapeHtml(dateOf(generatedAt))}</div>
<p><span class="overall">${pct(view.overallPercent)}</span> of the essay matches other text (${escapeHtml(view.matchedWords)} of ${escapeHtml(view.totalWords)} words; each word counted once).</p>
${notes.map(n => `<div class="note">${escapeHtml(n)}</div>`).join('')}
${counted.length ? list('Sources', counted) : '<p>No matching text was found.</p>'}
${list('Found but not compared', notCompared)}
${list('Excluded by the teacher', excluded)}
<h2>Essay</h2><div class="essay">${essayHtml(view, numberOf)}</div>
<p class="meta">Similarity shows where words match other text. It is not, on its own, evidence of copying: check each match and its source.</p>
<script>window.__REPORT_READY__ = true;</script>
</body></html>`;
}

module.exports = { renderSimilarityHtml, escapeHtml, flowText };
