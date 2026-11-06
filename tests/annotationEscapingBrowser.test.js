'use strict';
// Opt-in browser run (ANNOTATION_BROWSER_QA=1): teacher-entered text that looks like markup, rendered by the real Angular build for the
// student and for the teacher. Nothing may execute (no window.__xss, no dialog), no element may be injected, and the text must show
// literally. Same harness as annotationBrowser.test.js. Synthetic text only.
const FRONT_PORT = 4397;
process.env.JWT_SECRET = 'annotation-escaping-browser-secret';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-escaping-browser-' + process.pid;
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const File = require('../src/models/File');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, rerunOcr } = require('./helpers/annotationFixture');
const { annotationApi, manualValue } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const evidence = process.env.ANNOTATION_QA_OUT || path.resolve(__dirname, '../../output/annotation-qa');
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const WORDS = ['I', 'goes', '<script>window.__xss=1</script>', 'to', '<img/src=x/onerror=window.__xss=2>', 'the', '"><svg/onload=window.__xss=3>', 'park',
  '&lt;b&gt;&amp;&#60;i&#62;', 'now'];
const CASES = [
  { word: WORDS[2], symbol: 'ART', category: 'GRAMMAR', message: '<script>window.__xss=4</script>', suggestedText: '<script>alert(1)</script>' },
  { word: WORDS[4], symbol: 'WC', category: 'VOCABULARY', message: '<img src=x onerror="window.__xss=5">', suggestedText: '<img src=x onerror=window.__xss=6>' },
  { word: WORDS[6], symbol: 'P', category: 'MECHANICS', message: '"><svg onload=window.__xss=7>', suggestedText: "'><svg onload=window.__xss=8>" },
  { word: WORDS[8], symbol: 'SP', category: 'MECHANICS', message: '&lt;b&gt; &amp; &#60;i&#62; &quot;', suggestedText: '&lt;u&gt;&#x3C;s&#x3E;' },
];

(process.env.ANNOTATION_BROWSER_QA === '1' ? test : test.skip)('markup-like teacher text renders as plain text for student and teacher', async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  const fixture = await seedAnnotationFixture({ uploadRoot });
  const express = require('express');
  const build = path.resolve(__dirname, '../../RoznaComarker/dist/rozna-comarker-fe/browser');
  const frontend = express();
  frontend.use(express.static(build));
  frontend.get(/.*/, (_req, res) => res.sendFile(path.join(build, 'index.html')));
  const listen = (server, port, host) => new Promise((resolve, reject) => { const l = server.listen(port, host, () => resolve(l)); l.on('error', reject); });
  const api = await listen(app, 0, '127.0.0.1');
  const site = await listen(frontend, FRONT_PORT, '127.0.0.1');
  const browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
  fs.mkdirSync(evidence, { recursive: true });
  const report = { views: {} };
  try {
    const stored = '00000000-0000-4000-8000-0000000000f1.png';     // the server only serves UUID-named stored files
    fs.renameSync(path.join(uploadRoot, 'submissions', `${fixture.IDS.fileRegistered}.png`), path.join(uploadRoot, 'submissions', stored));
    await File.updateOne({ _id: fixture.IDS.fileRegistered }, { $set: { filename: stored, path: `${path.basename(uploadRoot)}/submissions/${stored}`, url: `/uploads/submissions/${stored}` } });
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { fileUrl: `/uploads/submissions/${stored}`, fileUrls: [`/uploads/submissions/${stored}`] } });
    await rerunOcr({ submissionId: fixture.IDS.registered, words: WORDS, specs: [[1, 'AGR', 'GRAMMAR', 'go', 'Use "go".']] });
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { fileUrl: `/uploads/submissions/${stored}`, fileUrls: [`/uploads/submissions/${stored}`] } });
    const doc = await Submission.findById(fixture.IDS.registered).lean();
    const teacherApi = annotationApi(app, fixture.teacher);
    for (const c of CASES) {
      const res = await teacherApi.act(fixture.IDS.registered, { action: 'add', value: manualValue(doc, c.word, { symbol: c.symbol, category: c.category, message: c.message, suggestedText: c.suggestedText }) });
      expect({ word: c.word, status: res.status }).toEqual({ word: c.word, status: 200 });
    }

    async function open(label, jwt, url, readySelector) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1366, height: 1000 });
      await page.evaluateOnNewDocument(token => { localStorage.setItem('backend_jwt', token); }, jwt);
      const dialogs = [], pageErrors = [];
      page.on('dialog', async dialog => { dialogs.push(dialog.type()); await dialog.dismiss(); });
      page.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 200)));
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/') || target.pathname.startsWith('/uploads/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(readySelector, { timeout: 60000 });
      await page.waitForFunction(() => /Grammar\s+18/.test(document.body.innerText), { timeout: 60000 });
      // Open the transcript panel (the corrections and their tooltips are rendered inside it).
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /Transcribed Text/i.test(b.textContent))?.click());
      await page.waitForSelector('app-tokenized-transcript .correction-highlight', { timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 2000));
      // Hover every highlighted word: its tooltip is the only place the teacher's message and suggestion are shown.
      const tooltips = [], words = [];
      for (const handle of await page.$$('app-tokenized-transcript .correction-highlight')) {
        words.push(await handle.evaluate(el => el.getAttribute('aria-label') || '')); await handle.hover(); await new Promise(resolve => setTimeout(resolve, 250));
        tooltips.push(await page.$eval('.transcript-tooltip', el => el.textContent.replace(/[ \t\r\f]+/g, ' ').trim()));
      }
      await page.screenshot({ path: path.join(evidence, `escaping-${label}.png`), fullPage: true });
      const result = await page.evaluate(() => ({
        xss: window.__xss ?? null,
        // The app's own stylesheet link carries onload="this.media='all'"; it is the only expected element with such an attribute.
        injected: [...document.querySelectorAll('[onerror],[onload],[onclick],[onmouseover]')].filter(el => !(el.tagName === 'LINK' && el.rel === 'stylesheet')).length,
        injectedInTranscript: document.querySelectorAll('app-tokenized-transcript script, app-tokenized-transcript svg, app-tokenized-transcript img, app-tokenized-transcript [onerror], app-tokenized-transcript [onload]').length,
      }));
      await context.close();
      return { ...result, transcript: words.join(' | '), tooltips, dialogs, pageErrors };
    }

    const base = `http://localhost:${FRONT_PORT}`;
    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const teacherJwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
    const views = {
      student: await open('student', studentJwt, `${base}/student/my-classes/detail/my-submissions/${fixture.IDS.assignment}?classId=${fixture.IDS.class}`, 'app-my-submission-page'),
      teacher: await open('teacher', teacherJwt, `${base}/teacher/my-classes/detail/student-submissions/${fixture.student._id}?classId=${fixture.IDS.class}&assignmentId=${fixture.IDS.assignment}&submissionId=${fixture.IDS.registered}`, 'app-student-submission-pages'),
    };
    report.views = views;
    for (const [name, view] of Object.entries(views)) {
      expect({ name, xss: view.xss }).toEqual({ name, xss: null });
      expect({ name, dialogs: view.dialogs }).toEqual({ name, dialogs: [] });
      expect({ name, injected: view.injected }).toEqual({ name, injected: 0 });
      expect({ name, injectedInTranscript: view.injectedInTranscript }).toEqual({ name, injectedInTranscript: 0 });
      expect({ name, pageErrors: view.pageErrors }).toEqual({ name, pageErrors: [] });
    }
    // The student sees the teacher's text literally (in the tooltips and the transcript), and the entities are not decoded.
    const student = views.student;
    const shown = [...student.tooltips, student.transcript].join(' ');
    expect(shown).toContain('<script>window.__xss=4</script>');
    expect(shown).toContain('&lt;b&gt;&amp;&#60;i&#62;');
  } finally {
    fs.writeFileSync(path.join(evidence, 'escaping-report.json'), JSON.stringify(report, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
