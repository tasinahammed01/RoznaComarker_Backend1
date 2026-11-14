'use strict';
// Assignment report PDF (Stage 3): the HTML builder and the filename, tested directly (no browser). Synthetic data only.
const fs = require('fs');
const path = require('path');
const { renderAssignmentReportHtml, reportPdfFilename, slugifyTitle, ERRORS_NOTE, MAX_PDF_ROWS } = require('../src/pdf/assignmentReportTemplate');
const geometry = require('../src/pdf/assignmentReportChartGeometry');

function student(i, extra = {}) {
  return { submissionId: `5f${String(i).padStart(22, '0')}`, name: `Student ${i}`, source: 'class', score: 70 + (i % 20), band: 'needs_revision',
    assessment: 'scored', notScoredReason: null, reviewed: i % 2 === 0, topIssue: null, submittedAt: '2026-11-12T09:00:00.000Z', isLate: false,
    draftNumber: 1, needsAttention: false, attentionReasons: [], ...extra };
}
function report(overrides = {}) {
  return {
    version: 'assignment-report-v1', generatedAt: '2026-11-14T10:00:00.000Z', timeZone: 'Asia/Dhaka',
    assignment: { id: '5f0000000000000000000001', title: 'Persuasive essay', className: 'Writing 7B', deadline: '2026-11-20T00:00:00.000Z', writingType: 'Persuasive' },
    counts: { total: 5, bySource: { class: 3, guest: 1, teacherUpload: 1 }, scored: 3, inProgress: 1, notScored: 1, reviewed: 1, late: 1, skippedRows: 0, capped: false },
    scores: { average: 68.7, median: 66, highest: 85, lowest: 55, onTrack: 1, needsRevision: 1, needsAttention: 1, needsRevisionPct: 67, needsAttentionPct: 33, reviewedPct: 20,
      bands: [[0, 49, 0], [50, 59, 1], [60, 69, 1], [70, 79, 0], [80, 89, 1], [90, 100, 0]].map(([min, max, count]) => ({ key: `${min}-${max}`, label: `${min}-${max}`, min, max, count })) },
    rubric: { kind: 'builtin', strongestKey: 'CONTENT', weakestKey: 'GRAMMAR', criteria: [
      { key: 'CONTENT', label: 'Content', averagePct: 80, count: 3 }, { key: 'GRAMMAR', label: 'Grammar', averagePct: 60, count: 3 }] },
    errors: { basis: 'ai_analysis', total: 7, symbolTotal: 7, submissionsWithCorrections: 2, categories: [
      { key: 'CONTENT', label: 'Content', color: '#FFD6A5', count: 0, pct: 0 }, { key: 'ORGANIZATION', label: 'Organization', color: null, count: 0, pct: 0 },
      { key: 'GRAMMAR', label: 'Grammar', color: null, count: 4, pct: 57 }, { key: 'VOCABULARY', label: 'Vocabulary', color: null, count: 1, pct: 14 },
      { key: 'MECHANICS', label: 'Mechanics', color: null, count: 2, pct: 29 }],
      symbols: [{ symbol: 'AGR', label: 'Agreement', category: 'GRAMMAR', count: 3, pct: 43 }] },
    timeline: { granularity: 'day', points: [{ date: '2026-11-10', count: 1 }, { date: '2026-11-11', count: 0 }, { date: '2026-11-12', count: 4 }] },
    students: [student(1, { name: 'Gus Guest', source: 'guest', score: 55, band: 'needs_attention', needsAttention: true, attentionReasons: ['LOW_SCORE'] }),
      student(2, { name: 'Fay Failed', reviewed: false, score: null, band: null, assessment: 'not_scored', notScoredReason: 'FAILED', needsAttention: true, attentionReasons: ['NOT_SCORED'] }),
      student(3, { name: 'Uma Upload', source: 'teacher_upload', score: 66, isLate: true }),
      student(4, { name: 'Ana Ray', score: 85, band: 'on_track', reviewed: true }),
      student(5, { name: 'Pat Pending', score: null, band: null, assessment: 'in_progress' })],
    insights: [{ code: 'AVERAGE', text: 'The average score is 68.7% across 3 scored submissions.' }],
    smallData: { distributionHidden: false, timelineHidden: false },
    ...overrides
  };
}
const NOW = new Date('2026-11-14T20:30:00.000Z');
const html = (r = report(), options = {}) => renderAssignmentReportHtml(r, { generatedAt: NOW, ...options });
const textOf = h => h.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('assignment report PDF HTML', () => {
  test('header: logo, title, class, due date and generated date in the teacher\'s time zone', () => {
    const h = html();
    expect(h).toMatch(/<img[^>]+src="data:image\/png;base64,[A-Za-z0-9+/=]{100,}"[^>]+alt="Rubrilo"/);
    const t = textOf(h);
    expect(t).toContain('Persuasive essay');
    expect(t).toContain('Writing 7B');
    expect(t).toContain('Nov 20, 2026');
    // 20:30 UTC is 02:30 on the 15th in Dhaka (UTC+6).
    expect(t).toMatch(/Generated Nov 15, 2026, 2:30\sAM \(Asia\/Dhaka\)/);
    expect(t).toContain('Rubrilo');
    expect(h).not.toMatch(/rozna/i);
  });

  test('sections follow the page order and show the same numbers as the payload', () => {
    const t = textOf(html());
    const order = ['Key numbers', 'Insights', 'Score distribution', 'Submissions over time', 'Rubric categories', 'Most common errors', 'Students'].map(s => t.indexOf(s));
    expect(order.every(i => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    for (const kpi of ['Total submissions 5', 'Scored 3', 'Average 68.7%', 'Median 66%', 'Highest 85%', 'Lowest 55%', 'Needs revision 67%', 'Late 1', 'Not scored 1'])
      expect(t).toContain(kpi);
    expect(t).toContain('The average score is 68.7% across 3 scored submissions.');
    expect(t).toContain(ERRORS_NOTE);
    expect(ERRORS_NOTE).toBe('Counts are from the AI analysis and may include items you removed.');
    expect(t).toMatch(/Content 80% Strongest/);
    expect(t).toMatch(/Grammar 60% Weakest/);
  });

  test('charts are inline SVG built from the shared geometry; small data hides them like the page', () => {
    const h = html();
    const svgs = h.match(/<svg[^>]*class="chart"[\s\S]*?<\/svg>/g);
    expect(svgs).toHaveLength(2);
    const expected = geometry.columnChartGeometry(report().scores.bands.map(b => ({ label: b.label, value: b.count })), { width: 600, height: 220 });
    for (const bar of expected.bars.filter(b => b.height > 0)) expect(svgs[0]).toContain(`d="${geometry.roundedTopBarPath(bar)}"`);
    expect(svgs[0]).toMatch(/viewBox="0 0 600 220"/);
    expect(svgs[0]).toMatch(/role="img"/);
    const small = html(report({ smallData: { distributionHidden: true, timelineHidden: true } }));
    expect(small.match(/<svg[^>]*class="chart"/g)).toBeNull();
    expect(textOf(small)).toContain('Not enough scored submissions to show a fair distribution (at least 3 are needed).');
    expect(textOf(small)).toContain('Not enough submissions to show a trend (at least 3 are needed).');
  });

  test('capped and skipped notices; no-scores and no-submissions states', () => {
    const r = report(); r.counts = { ...r.counts, capped: true, skippedRows: 2 };
    const t = textOf(html(r));
    expect(t).toContain('Only the first part of the submissions is included in this report');
    expect(t).toContain('2 records could not be read and are not included.');
    const unscored = report({ scores: { ...report().scores, average: null, median: null, highest: null, lowest: null, needsRevisionPct: null } });
    unscored.counts = { ...unscored.counts, scored: 0 };
    const ut = textOf(html(unscored));
    expect(ut).toContain('No scored submissions yet.');
    expect(ut).not.toContain('Score distribution');
    const empty = report({ students: [] }); empty.counts = { ...empty.counts, total: 0, scored: 0 };
    const et = textOf(html(empty));
    expect(et).toContain('No submissions yet');
    expect(et).not.toContain('Students');
  });

  test('students: needs-attention group first, labelled statuses (never 0), repeated header, rows never split, capped at 500 with "and N more"', () => {
    const h = html();
    const t = textOf(h);
    expect(t.indexOf('Needs attention')).toBeLessThan(t.indexOf('Gus Guest'));
    expect(t.indexOf('Fay Failed')).toBeLessThan(t.indexOf('Other students'));
    expect(t).toMatch(/Fay Failed Class Not scored Assessment failed — On time Not reviewed/);
    expect(t).toMatch(/Pat Pending Class In progress — On time Not reviewed/);
    expect(t).toMatch(/Uma Upload Teacher upload Needs revision 66% Late/);
    expect(h).toMatch(/thead\{display:table-header-group\}/);
    expect(h).toMatch(/tr\{break-inside:avoid;page-break-inside:avoid\}/);
    expect(h).toMatch(/\.kpi,\.panel\{[^}]*break-inside:avoid/);
    const many = report({ students: Array.from({ length: MAX_PDF_ROWS + 37 }, (_, i) => student(i + 10)) });
    const mh = html(many);
    expect((mh.match(/<tr class="row/g) || []).length).toBe(MAX_PDF_ROWS);
    expect(textOf(mh)).toContain('and 37 more students not shown in this PDF.');
  });

  test('the AI summary section is reserved: absent without a summary object, rendered when given one', () => {
    expect(textOf(html())).not.toContain('AI summary');
    expect(html()).not.toContain('data-section="summary"');
    const withSummary = html(report(), { summary: { headline: 'Overall the class did well <b>bold</b>.', findings: ['Grammar is 57% of 7 corrections.', 'Content is strongest.', 'One more.'],
      nextSteps: ['Teach agreement.', 'Model evidence.'], caution: 'Counts come from the AI analysis.' } });
    expect(withSummary).toContain('data-section="summary"');
    expect(withSummary).toContain('Overall the class did well &lt;b&gt;bold&lt;/b&gt;.');
    const t = textOf(withSummary);
    expect(t).toContain('AI-generated summary. Please review before sharing.');
    expect(t).toContain('Key findings Grammar is 57% of 7 corrections.');
    expect(t).toContain('Suggested next steps Teach agreement. Model evidence.');
    // The summary sits after the key numbers and before the insights, as on the page.
    expect(t.indexOf('Key numbers')).toBeLessThan(t.indexOf('AI summary'));
    expect(t.indexOf('AI summary')).toBeLessThan(t.indexOf('Insights'));
    expect(html(report(), { summary: { headline: '   ' } })).not.toContain('data-section="summary"');
  });

  test('only payload fields are rendered and everything is escaped: no email, comment or OCR text even if a caller adds them', () => {
    const hostile = report();
    hostile.students = hostile.students.map(s => ({ ...s, email: 'kid@example.com', comment: 'SECRET TEACHER COMMENT', ocrText: 'SECRET OCR TEXT' }));
    hostile.students[0].name = '<script>alert(1)</script>';
    hostile.assignment.title = 'Essay <img src=x onerror=alert(1)>';
    hostile.teacherEmail = 'teacher@example.com';
    hostile.insights.push({ code: 'X', text: 'A & B < C' });
    const h = html(hostile);
    expect(h).not.toContain('@example.com');
    expect(h).not.toContain('SECRET');
    expect(h).not.toContain('<script>alert');
    expect(h).not.toMatch(/<img src=x/);
    expect(h).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(h).toContain('A &amp; B &lt; C');
    expect(h).not.toMatch(/rozna/i);
  });

  test('the page is self-contained: no external URL, script only sets the ready flag', () => {
    const h = html();
    expect(h).not.toMatch(/(?:src|href)="https?:/);
    expect(h).not.toMatch(/@import|url\(http/);
    expect(h.match(/<script>[\s\S]*?<\/script>/g)).toEqual(['<script>window.__REPORT_READY__=true</script>']);
  });
});

describe('PDF filename', () => {
  test('Rubrilo-report-<slug>-<YYYY-MM-DD>.pdf in the teacher\'s time zone', () => {
    expect(reportPdfFilename('Persuasive essay', NOW, 'Asia/Dhaka')).toBe('Rubrilo-report-persuasive-essay-2026-11-15.pdf');
    expect(reportPdfFilename('Persuasive essay', NOW, 'UTC')).toBe('Rubrilo-report-persuasive-essay-2026-11-14.pdf');
  });
  test('unsafe, path, unicode and empty titles become safe ASCII', () => {
    expect(slugifyTitle('../../etc/passwd')).toBe('etc-passwd');
    expect(slugifyTitle('C:\\Windows\\system32')).toBe('c-windows-system32');
    expect(slugifyTitle('Café crème: naïve "essay"')).toBe('cafe-creme-naive-essay');
    expect(slugifyTitle('日本語のタイトル')).toBe('assignment');
    expect(slugifyTitle('')).toBe('assignment');
    expect(slugifyTitle(null)).toBe('assignment');
    expect(slugifyTitle('a'.repeat(200))).toHaveLength(60);
    expect(slugifyTitle('Persuasive essay: Should school start later? (Term 2 final draft)')).toBe('persuasive-essay-should-school-start-later-term-2-final');
    expect(slugifyTitle('Essay\r\nContent-Type: x')).toBe('essay-content-type-x');
    const name = reportPdfFilename('"quoted"; filename=evil.exe', NOW, 'Not/AZone');
    expect(name).toBe('Rubrilo-report-quoted-filename-evil-exe-2026-11-14.pdf');
    expect(name).toMatch(/^[A-Za-z0-9.-]+$/);
  });
});

describe('chart geometry: backend port equals the frontend', () => {
  const golden = require('./fixtures/reportChartGeometry.golden.cjs');
  const r = n => Math.round(n * 1000) / 1000;
  const shape = g => ({ maxValue: g.maxValue,
    bars: g.bars.map(b => ({ x: r(b.x), y: r(b.y), width: r(b.width), height: r(b.height), showLabel: b.showLabel, path: geometry.roundedTopBarPath(b) })),
    ticks: g.ticks.map(t => ({ value: t.value, y: r(t.y) })) });

  test.each(Object.keys(golden.cases))('golden case %s (generated from the frontend source)', (name) => {
    const { points, ...expected } = golden.cases[name];
    expect(shape(geometry.columnChartGeometry(points, golden.size))).toEqual(expected);
  });

  const frontend = path.resolve(__dirname, '../../RoznaComarker');
  const tsFile = path.join(frontend, 'src/app/components/teacher/assignment-report-charts/report-chart-geometry.ts');
  const available = fs.existsSync(tsFile) && fs.existsSync(path.join(frontend, 'node_modules', 'typescript'));
  (available ? test : test.skip)('direct comparison with the frontend source in the sibling repo', () => {
    const ts = require(path.join(frontend, 'node_modules', 'typescript'));
    const js = ts.transpileModule(fs.readFileSync(tsFile, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    new Function('module', 'exports', js)(mod, mod.exports);
    for (const { points } of Object.values(golden.cases)) {
      const fe = mod.exports.columnChartGeometry(points, golden.size), be = geometry.columnChartGeometry(points, golden.size);
      expect(be).toEqual(fe);
      expect(be.bars.map(b => geometry.roundedTopBarPath(b))).toEqual(fe.bars.map(b => mod.exports.roundedTopBarPath(b)));
    }
  });
});
