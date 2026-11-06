'use strict';
// Opt-in browser run (ANNOTATION_BROWSER_QA=1): with one hidden correction, a registered student opens their result page and the
// teacher opens the same submission in the real frontend build. No console or page errors, no failed API calls, counts consistent.
// Serves RoznaComarker/dist, rewrites /api/ to the in-process test API (same harness as the recovery browser tests).
const FRONT_PORT = 4396;
process.env.JWT_SECRET = 'annotation-browser-secret';
process.env.NODE_ENV = 'test';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-browser-' + process.pid;
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');
const { annotationApi } = require('./helpers/annotationApi');

jest.setTimeout(300000);
const evidence = process.env.ANNOTATION_QA_OUT || path.resolve(__dirname, '../../output/annotation-qa');
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const HIDDEN_MESSAGE = 'before a vowel sound';

(process.env.ANNOTATION_BROWSER_QA === '1' ? test : test.skip)('student and teacher open a submission with one hidden correction', async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  const fixture = await seedAnnotationFixture({ uploadRoot });
  const express = require('express');
  const build = path.resolve(__dirname, '../../RoznaComarker/dist/rozna-comarker-fe/browser');
  const frontend = express();
  frontend.use(express.static(build));
  frontend.get(/.*/, (_req, res) => res.sendFile(path.join(build, 'index.html')));
  const listen = (server, port, host) => new Promise((resolve, reject) => { const l = server.listen(port, host, () => resolve(l)); l.on('error', reject); });
  const api = await listen(app, 0, '127.0.0.1');
  const site = await listen(frontend, FRONT_PORT);   // both address families: the page opens "localhost", which may resolve to ::1 first
  const browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
  fs.mkdirSync(evidence, { recursive: true });
  const report = { views: {} };
  try {
    // The server only serves stored files named like a UUID; the golden fixture's names are not, so rename this run's file.
    const File = require('../src/models/File'), Submission = require('../src/models/Submission');
    const stored = '00000000-0000-4000-8000-0000000000f1.png';
    fs.renameSync(path.join(uploadRoot, 'submissions', `${fixture.IDS.fileRegistered}.png`), path.join(uploadRoot, 'submissions', stored));
    await File.updateOne({ _id: fixture.IDS.fileRegistered }, { $set: { filename: stored, path: `${path.basename(uploadRoot)}/submissions/${stored}`, url: `/uploads/submissions/${stored}` } });
    await Submission.updateOne({ _id: fixture.IDS.registered }, { $set: { fileUrl: `/uploads/submissions/${stored}`, fileUrls: [`/uploads/submissions/${stored}`] } });
    const teacherApi = annotationApi(app, fixture.teacher);
    const hidden = await teacherApi.find(fixture.IDS.registered, 'a', 'ART');
    // ANNOTATION_QA_NO_HIDE=1 renders the same pages without the hide, for a before/after comparison of the rendered text.
    const hide = process.env.ANNOTATION_QA_NO_HIDE !== '1';
    if (hide) expect((await teacherApi.act(fixture.IDS.registered, { action: 'hide', id: hidden.id })).status).toBe(200);

    async function open(label, jwt, url, readySelector) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1366, height: 1000 });
      await page.evaluateOnNewDocument(token => { localStorage.setItem('backend_jwt', token); }, jwt);
      const consoleErrors = [], pageErrors = [], failedApi = [], apiBodies = {};
      page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text().replace(/[a-f0-9]{24}/g, '<id>').slice(0, 200)); });
      page.on('pageerror', error => pageErrors.push(String(error.message).slice(0, 200)));
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/') || target.pathname.startsWith('/uploads/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      page.on('response', async res => {
        const target = new URL(res.url());
        if (!target.pathname.startsWith('/api/') && !target.pathname.includes('/uploads/')) return;
        const status = res.status();
        const key = target.pathname.replace(/[a-f0-9]{24}/g, ':id') + target.search;
        if (status >= 400) failedApi.push(`${res.request().method()} ${key} ${status}`);
        // The pages keep polling. A response that can no longer be read must not replace one that was: the leak check below would pass on nothing.
        if (status === 200 && /ocr-corrections|\/feedback\/|submissions\/(my|assignment)/.test(target.pathname)) { const body = await res.json().catch(() => null); if (body) apiBodies[key] = body; }
      });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForSelector(readySelector, { timeout: 60000 });
      // Wait for the evaluation and the correction legend to render (the pages keep polling, so network-idle never comes), then settle.
      await page.waitForFunction(() => /Grammar\s+18/.test(document.body.innerText) && /AGR/.test(document.body.innerText), { timeout: 60000 });
      await new Promise(resolve => setTimeout(resolve, 3000));
      const firstText = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      // The transcript and its corrections sit behind this toggle on both pages.
      await page.evaluate(() => [...document.querySelectorAll('button')].find(b => /Transcribed Text/i.test(b.textContent))?.click());
      await new Promise(resolve => setTimeout(resolve, 4000));
      await page.screenshot({ path: path.join(evidence, `${label}.png`), fullPage: true });
      const text = (await page.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
      fs.writeFileSync(path.join(evidence, `${label}.txt`), `--- before toggle\n${firstText}\n--- after toggle\n${text}\n`);
      await context.close();
      return { text, consoleErrors, pageErrors, failedApi, apiBodies };
    }

    const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
    const teacherJwt = signTestJwt({ id: fixture.teacher._id, role: 'teacher', firebaseUid: fixture.teacher.firebaseUid });
    const base = `http://localhost:${FRONT_PORT}`;
    const student = await open('student-result', studentJwt, `${base}/student/my-classes/detail/my-submissions/${fixture.IDS.assignment}?classId=${fixture.IDS.class}`, 'app-my-submission-page');
    const teacher = await open('teacher-submission', teacherJwt, `${base}/teacher/my-classes/detail/student-submissions/${fixture.student._id}?classId=${fixture.IDS.class}&assignmentId=${fixture.IDS.assignment}&submissionId=${fixture.IDS.registered}`, 'app-student-submission-pages');

    for (const [name, view] of Object.entries({ student, teacher })) {
      const stats = Object.entries(view.apiBodies).flatMap(([key, body]) => {
        const data = body?.data; const list = Array.isArray(data) ? data.find(item => String(item._id) === String(fixture.IDS.registered)) : data;
        const s = list?.statistics || list?.correctionStatistics;
        return s ? [[key, `grammar ${s.grammar}, mechanics ${s.mechanics}, total ${s.total}`]] : [];
      });
      report.views[name] = { consoleErrors: view.consoleErrors, pageErrors: view.pageErrors, failedApi: view.failedApi, apiBodiesSeen: Object.keys(view.apiBodies), statistics: stats,
        textShowsHiddenMessage: view.text.includes(HIDDEN_MESSAGE), textLength: view.text.length };
    }
    // Console errors: ignore only the blocked third-party fonts/analytics that the harness aborts on purpose.
    // Also allowed: GET /api/subscription/me answers 500 for this fixture teacher (billing code, untouched by 6A) and the console line it causes.
    const relevant = errors => errors.filter(e => !/ERR_FAILED|net::|Failed to load resource|fonts\.|googleapis|gstatic|getMySubscription/i.test(e));
    for (const name of ['student', 'teacher']) report.views[name].failedApi = report.views[name].failedApi.filter(call => call !== 'GET /api/subscription/me 500');
    report.views.student.relevantConsoleErrors = relevant(student.consoleErrors);
    report.views.teacher.relevantConsoleErrors = relevant(teacher.consoleErrors);
    for (const name of ['student', 'teacher']) {
      expect({ name, pageErrors: report.views[name].pageErrors }).toEqual({ name, pageErrors: [] });
      expect({ name, errors: report.views[name].relevantConsoleErrors }).toEqual({ name, errors: [] });
      expect({ name, failedApi: report.views[name].failedApi }).toEqual({ name, failedApi: [] });
      if (hide) expect({ name, hiddenShown: report.views[name].textShowsHiddenMessage }).toEqual({ name, hiddenShown: false });
      for (const [, statsLine] of report.views[name].statistics) expect(statsLine).toBe(hide ? 'grammar 2, mechanics 2, total 4' : 'grammar 3, mechanics 2, total 5');
      expect(report.views[name].statistics.length).toBeGreaterThan(0);
    }
    // The student's correction API bodies never contain the hidden correction.
    // The teacher's list also has the guest's submission: same words, so the same deterministic correction id, and nothing hidden there. Only this
    // submission's row counts; every other body is checked whole. The row must be there, or the check would pass on nothing.
    if (hide) {
      expect(JSON.stringify(student.apiBodies)).not.toContain(hidden.id);
      const thisSubmission = Object.fromEntries(Object.entries(teacher.apiBodies).map(([key, body]) => [key, Array.isArray(body?.data) ? body.data.filter(row => String(row._id) === String(fixture.IDS.registered)) : body]));
      expect(thisSubmission['/api/submissions/assignment/:id'].length).toBe(1);
      expect(thisSubmission['/api/submissions/assignment/:id'][0].writingCorrections.length).toBeGreaterThan(0);
      expect(JSON.stringify(thisSubmission)).not.toContain(hidden.id);
    }
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
