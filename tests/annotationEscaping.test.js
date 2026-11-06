'use strict';
// Task 6A follow-up: teacher-entered text (message, suggestion, quoted text) that looks like markup.
//   A. API payload: stored and returned verbatim as JSON text (never HTML), with nosniff.
//   B. PDF: every field is HTML-escaped in the report HTML; opened in the same headless-browser configuration the generator uses, no
//      script runs, no element is injected and no request is made; entities are not decoded; the extracted PDF text shows the markup
//      as plain text. A positive control proves the harness would notice: with deliberately unescaped HTML, JavaScript DOES run in the
//      PDF page (it is enabled), while every network request - external or local - is still blocked by the generator's interception.
// Synthetic text only.
process.env.JWT_SECRET = 'annotation-escaping-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-escaping';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.ENABLE_TEST_PDF_HTTP = 'true';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const request = require('supertest');
process.env.PDF_FEEDBACK_CACHE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'annotation-escaping-pdf-'));
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const generator = require('../src/modules/submissionFeedbackPdfGenerator');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, rerunOcr } = require('./helpers/annotationFixture');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

// Transcript words (the quoted text of a correction must equal transcript text, so the markup lives in the words themselves).
const WORDS = ['I', 'goes', '<script>window.__xss=1</script>', 'to', '<img/src=x/onerror=window.__xss=2>', 'the', '"><svg/onload=window.__xss=3>', 'park',
  '&lt;b&gt;&amp;&#60;i&#62;', 'now'];
// Teacher message and suggestion for each payload word.
const CASES = [
  { word: WORDS[2], symbol: 'ART', category: 'GRAMMAR', message: '<script>window.__xss=4</script>', suggestedText: '<script>alert(1)</script>' },
  { word: WORDS[4], symbol: 'WC', category: 'VOCABULARY', message: '<img src=x onerror="window.__xss=5">', suggestedText: '<img src=x onerror=window.__xss=6>' },
  { word: WORDS[6], symbol: 'P', category: 'MECHANICS', message: '"><svg onload=window.__xss=7>', suggestedText: "'><svg onload=window.__xss=8>" },
  { word: WORDS[8], symbol: 'SP', category: 'MECHANICS', message: '&lt;b&gt; &amp; &#60;i&#62; &quot;', suggestedText: '&lt;u&gt;&#x3C;s&#x3E;' },
];
let fixture, teacher, studentJwt, capturedViewModel, pdfBuffer, html;
const realGenerate = generator.generateSubmissionFeedbackPdf;   // captured before the spy replaces the property

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
  teacher = annotationApi(app, fixture.teacher);
  await rerunOcr({ submissionId: fixture.IDS.registered, words: WORDS, specs: [[1, 'AGR', 'GRAMMAR', 'go', 'Use "go".']] });
  const doc = await Submission.findById(fixture.IDS.registered).lean();
  for (const c of CASES) {
    const res = await teacher.act(fixture.IDS.registered, { action: 'add', value: manualValue(doc, c.word, { symbol: c.symbol, category: c.category, message: c.message, suggestedText: c.suggestedText }) });
    if (res.status !== 200) throw new Error(`add failed for ${c.word}: ${res.status} ${res.body.code}`);
  }
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  // The real download route; the generator call is observed (and still runs) to capture the report view model.
  jest.spyOn(generator, 'generateSubmissionFeedbackPdf').mockImplementation(async (viewModel, ...rest) => { capturedViewModel = viewModel; return realGenerate(viewModel, ...rest); });
  const res = await request(app).get(`/api/pdf/download/${fixture.IDS.registered}`).set('Authorization', `Bearer ${studentJwt}`)
    .buffer(true).parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  if (res.status !== 200) throw new Error(`pdf route ${res.status}`);
  pdfBuffer = res.body;
  html = renderSubmissionFeedbackReportHtml(capturedViewModel);
});
afterAll(async () => {
  jest.restoreAllMocks();
  await disconnectInMemoryMongo();
  fs.rmSync(uploadRoot, { recursive: true, force: true }); fs.rmSync(process.env.PDF_FEEDBACK_CACHE_DIR, { recursive: true, force: true });
});

describe('A. API payload', () => {
  test('text is returned verbatim as JSON text, never as HTML', async () => {
    const res = await request(app).get(`/api/submissions/${fixture.IDS.registered}/ocr-corrections`).set('Authorization', `Bearer ${studentJwt}`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/json/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    const teacherRows = res.body.data.corrections.filter(c => c.source === 'Teacher');
    expect(teacherRows).toHaveLength(CASES.length);
    for (const c of CASES) {
      const row = teacherRows.find(r => r.quotedText === c.word);
      expect({ word: c.word, message: row.message, suggestedText: row.suggestedText }).toEqual({ word: c.word, message: c.message, suggestedText: c.suggestedText });
    }
  });
});

describe('B. PDF report', () => {
  test('every teacher field is HTML-escaped in the report HTML; entities are not decoded', () => {
    expect(capturedViewModel).toBeTruthy();
    for (const c of CASES) for (const value of [c.word, c.message, c.suggestedText]) {
      if (/[<>"']/.test(value)) expect({ value, raw: html.includes(value) }).toEqual({ value, raw: false });
      expect({ value, escaped: html.includes(esc(value)) }).toEqual({ value, escaped: true });
    }
    // &lt; written by the teacher must show as "&lt;", i.e. be escaped once more, not turned into "<".
    expect(html).toContain('&amp;lt;b&amp;gt;&amp;amp;&amp;#60;i&amp;#62;');
    expect(html).not.toMatch(/<(img|svg)[^>]*(onerror|onload)/i);
  });

  async function openInGeneratorConfiguration(markup, { allowLocalProbe } = {}) {
    const browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const context = await browser.createBrowserContext(); const page = await context.newPage();
      const attempted = [], allowed = [];
      await page.setRequestInterception(true);
      // The generator's rule, verbatim: only about:blank, data: and blob: are allowed; everything else is aborted.
      page.on('request', request => { const url = request.url(); attempted.push(url);
        if (url === 'about:blank' || url.startsWith('data:') || url.startsWith('blob:')) { allowed.push(url); request.continue(); } else request.abort(); });
      await page.setContent(markup, { waitUntil: 'load' });
      await page.waitForFunction(() => window.__REPORT_READY__ === true, { timeout: 60000 });
      const dom = await page.evaluate(() => ({ xss: window.__xss ?? null, handlers: document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]').length,
        scripts: document.scripts.length, remoteImages: [...document.images].filter(i => !i.src.startsWith('data:')).length,
        svgWithHandlers: document.querySelectorAll('svg[onload]').length, javascriptEnabled: true }));
      return { dom, attempted, allowed };
    } finally { await browser.close(); }
  }

  test('opened in the generator\'s headless-browser configuration: nothing runs, nothing is injected, no request is made', async () => {
    const { dom, attempted } = await openInGeneratorConfiguration(html);
    expect(dom.xss).toBeNull();
    expect(dom.handlers).toBe(0);
    expect(dom.svgWithHandlers).toBe(0);
    expect(dom.remoteImages).toBe(0);
    expect(dom.scripts).toBe(1);                                   // only the template's own readiness script
    expect(attempted.filter(url => !/^(about:blank|data:|blob:)/.test(url))).toEqual([]);
  });

  test('positive control: with UNESCAPED markup JavaScript does run in the PDF page, but all network requests are blocked', async () => {
    const hits = []; const server = await new Promise(resolve => { const s = http.createServer((req, res) => { hits.push(req.url); res.end('x'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port;
    try {
      const evil = `<!doctype html><html><body><img src="http://127.0.0.1:${port}/img"><script src="http://127.0.0.1:${port}/script.js"></script>
        <link rel="stylesheet" href="http://127.0.0.1:${port}/css"><iframe src="http://127.0.0.1:${port}/frame"></iframe>
        <script>window.__xss = 9; fetch('http://127.0.0.1:${port}/fetch').catch(() => {}); new Image().src = 'http://127.0.0.1:${port}/beacon';
        navigator.sendBeacon && navigator.sendBeacon('http://127.0.0.1:${port}/sendbeacon'); window.__REPORT_READY__ = true;</script></body></html>`;
      const { dom, attempted, allowed } = await openInGeneratorConfiguration(evil);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(dom.xss).toBe(9);                                      // JavaScript is enabled in this page
      expect(attempted.some(url => url.includes(`127.0.0.1:${port}`))).toBe(true);   // the page tried...
      expect(allowed.some(url => url.includes(`127.0.0.1:${port}`))).toBe(false);    // ...and every attempt was aborted
      expect(hits).toEqual([]);                                     // the local server never saw a request
    } finally { server.close(); }
  });

  test('the real generator blocks the same requests while producing a PDF (end to end)', async () => {
    const hits = []; const server = await new Promise(resolve => { const s = http.createServer((req, res) => { hits.push(req.url); res.end('x'); }); s.listen(0, '127.0.0.1', () => resolve(s)); });
    const port = server.address().port; const out = path.join(os.tmpdir(), `annotation-escaping-${process.pid}.pdf`);
    try {
      const evil = `<!doctype html><html><body><p>control</p><img src="http://127.0.0.1:${port}/img"><script>fetch('http://127.0.0.1:${port}/fetch').catch(() => {}); window.__REPORT_READY__ = true;</script></body></html>`;
      await realGenerate(capturedViewModel, out, { renderHtml: () => evil }).catch(error => { if (!/uniform|A4|page/i.test(String(error.message))) throw error; });
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(hits).toEqual([]);
    } finally { server.close(); fs.rmSync(out, { force: true }); }
  });

  test('the extracted PDF text shows the teacher markup as plain text', async () => {
    const text = (await require('pdf-parse')(pdfBuffer)).text.replace(/\s+/g, ' ');
    expect(text).toContain('<script>window.__xss=1</script>');
    expect(text).toContain('&lt;b&gt;&amp;&#60;i&#62;');
    expect(text).toContain('<script>window.__xss=4</script>');
  });
});
