'use strict';
// Submission Feedback Report page layout in a real browser: synthetic two-page submissions are rendered by the production template
// and generator (headless Chrome), and every PDF page is measured with pdfjs (how far down the body text reaches, and where our
// synthetic marker tokens land). Guards: the cover (with its "Current data status" strip) stays on page 1; a revision guidance item
// or a feedback card is never split across pages; no near-empty text page. The submitted-page image pages keep their own page, so a
// correction-notes continuation right before the next image page is allowed to be short. Skipped when Chrome is not installed.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { layoutViewModel } = require('./helpers/feedbackPdfLayoutFixture');

const chromeAvailable = (() => { try { return fs.existsSync(require('puppeteer').executablePath()); } catch { return false; } })();
const describeWithChrome = chromeAvailable ? describe : describe.skip;
jest.setTimeout(120000);

const MM = 72 / 25.4, MARGIN_MM = 14, MIN_FILL = 0.25;
let dir, generator;

beforeAll(() => {
  const logger = require('../src/utils/logger');
  for (const key of Object.keys(logger)) if (typeof logger[key] === 'function') jest.spyOn(logger, key).mockImplementation(() => {});
  generator = require('../src/modules/submissionFeedbackPdfGenerator');
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-page-layout-'));
});
afterAll(async () => {
  try { await require('../src/services/pdfBrowserManager.service').shutdown?.(); } catch { /* best effort */ }
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

/** Render and measure: per page, the share of the body height used by text, the body text, and the page kind. */
async function render(name, vm) {
  const file = path.join(dir, `${name}.pdf`);
  await generator.generateSubmissionFeedbackPdf(vm, file);
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), disableFontFace: true }).promise;
  const pages = [];
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n), height = page.getViewport({ scale: 1 }).height, top = height - MARGIN_MM * MM;
    const body = (await page.getTextContent()).items.filter(i => i.str.trim() && i.transform[5] < top && i.transform[5] > MARGIN_MM * MM);
    const text = body.map(i => i.str).join(' ');
    const lowest = body.length ? Math.min(...body.map(i => i.transform[5])) : top;
    const evidence = text.includes('SUBMITTED DOCUMENT EVIDENCE'), notes = text.includes('correction notes');
    pages.push({ number: n, text, fill: (top - lowest) / (height - 2 * MARGIN_MM * MM),
      kind: evidence ? 'evidence' : notes ? 'notes-continuation' : /Errors:/u.test(text) && /Submitted Page \d/u.test(text) ? 'image' : 'text' });
  }
  return pages;
}
const pageOf = (pages, token) => pages.filter(p => new RegExp(`\\b${token}\\b`, 'u').test(p.text)).map(p => p.number);
const nearlyEmpty = pages => pages.filter((p, i) => i < pages.length - 1 && p.kind !== 'image' && p.fill < MIN_FILL
  && !(p.kind === 'notes-continuation' && pages[i + 1]?.kind === 'image')).map(p => `p${p.number} ${p.kind} fill ${p.fill.toFixed(2)}`);

describeWithChrome('Submission Feedback Report page layout (real browser)', () => {
  test('the cover and its data status strip stay on page 1 (longest brief, many short lines, very long identity values)', async () => {
    for (const [name, brief] of [['long-brief', 6000], ['short-lines-brief', { lines: 120, perLine: 2 }], ['spill-brief', 1300]]) {
      const pages = await render(name, layoutViewModel({ brief, worstCover: true }));
      expect({ name, statusOnPages: pageOf(pages, 'Current data status') }).toEqual({ name, statusOnPages: [1] });
      expect({ name, secondPage: pages[1].kind }).toEqual({ name, secondPage: 'image' });
      // The full brief follows after Overall Feedback: its first and last words are in the report, after the cover.
      const heading = pages.filter(p => p.text.includes('Assignment description')).map(p => p.number);
      expect({ name, heading: heading.length, endAfterCover: pageOf(pages, 'BEND').every(n => n >= heading[0] && n > 1) })
        .toEqual({ name, heading: 1, endAfterCover: true });
      expect({ name, hasEnd: pageOf(pages, 'BEND').length > 0, overallBefore: Math.max(...pageOf(pages, 'TEND')) <= heading[0] })
        .toEqual({ name, hasEnd: true, overallBefore: true });
      expect({ name, nearlyEmpty: nearlyEmpty(pages) }).toEqual({ name, nearlyEmpty: [] });
    }
  });

  test('the "Assignment description" heading stays with the first lines of the brief', async () => {
    // 92 and 104 words put the heading at the very bottom of a page (measured: without the keep-with rules the heading is left
    // alone there and the text starts on the next page); 60 and 300 are ordinary positions.
    for (const teacherWords of [60, 92, 104, 300]) {
      const pages = await render(`heading-${teacherWords}`, layoutViewModel({ brief: 3000, teacherWords }));
      const heading = pages.filter(p => p.text.includes('Assignment description')).map(p => p.number);
      const firstLines = pageOf(pages, 'BSTART').filter(n => n > 1);
      expect({ teacherWords, heading, firstLines }).toEqual({ teacherWords, heading: firstLines, firstLines });
    }
  });

  test('a revision guidance item and a feedback card are never split across pages', async () => {
    // The action-step length that put the last item's reason line alone on the final page before the fix.
    for (const actionWords of [60, 80, 100]) {
      const vm = layoutViewModel({ notes: [12, 8], cards: 5, cardWords: [actionWords, 60], actions: 5, actionWords: 30 });
      const pages = await render(`actions-${actionWords}`, vm);
      for (let k = 0; k < 5; k += 1) expect({ actionWords, item: k, pages: [...pageOf(pages, `RSTART${k}`), ...pageOf(pages, `REND${k}`)] })
        .toEqual({ actionWords, item: k, pages: [pageOf(pages, `RSTART${k}`)[0], pageOf(pages, `RSTART${k}`)[0]] });
      for (const card of ['A0', 'A1', 'A2', 'A3', 'A4', 'S0']) expect({ actionWords, card, pages: [...pageOf(pages, `QSTART${card}`), ...pageOf(pages, `QEND${card}`)] })
        .toEqual({ actionWords, card, pages: [pageOf(pages, `QSTART${card}`)[0], pageOf(pages, `QSTART${card}`)[0]] });
      expect({ actionWords, nearlyEmpty: nearlyEmpty(pages) }).toEqual({ actionWords, nearlyEmpty: [] });
    }
  });

  test('the submitted-page image pages keep their own page (notes that run over are allowed before the next image)', async () => {
    const pages = await render('long-notes', layoutViewModel({ notes: [26, 9], cards: 3 }));
    expect(pages.filter(p => p.kind === 'image').map(p => p.number)).toEqual([2, 5]);
    expect(pages[3].kind).toBe('notes-continuation');
    expect(nearlyEmpty(pages)).toEqual([]);
  });
});
