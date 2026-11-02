'use strict';
// Opt-in browser QA (RECOVERY_BROWSER_QA=1): the production Angular build opens the same realistic guest result (a) via the
// submission's own link and (b) via the recovery portal, for a marks-visible and a marks-hidden assignment. It compares API status
// codes, console errors and the rendered page text, and saves screenshots to output/recovery-portal-qa/.
const FRONT_PORT = 4392;
process.env.JWT_SECRET = 'recovery-browser-qa-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/recovery-browser-qa-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { pageImage } = require('./fixtures/imagePreflightPage');
const { seedRealisticGuestResult } = require('./helpers/realisticGuestResult');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const sendLink = require('../src/services/email.service').sendRecoveryPortalEmail;

jest.setTimeout(300000);
const EMAIL = 'qa-student@example.com';
const evidence = path.resolve(__dirname, '../../output/recovery-portal-qa');
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);

(process.env.RECOVERY_BROWSER_QA === '1' ? test : test.skip)('own link vs recovery portal: same calls, same console, same page', async () => {
  await connectInMemoryMongo(); await Submission.init(); await seedTestPlans();
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
  const report = {};
  try {
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'qa-teacher@example.com', role: 'teacher' });
    const cls = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'QA-BROWSER' });
    const make = (title, extra = {}) => Assignment.create({ title, class: cls._id, teacher: teacher._id, instructions: 'Describe your weekend.',
      qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, ...extra });
    const png = await pageImage();
    const cases = {
      visible: await seedRealisticGuestResult({ app, assignment: await make('Weekend essay (marks visible)'), teacher, email: EMAIL, png }),
      hidden: await seedRealisticGuestResult({ app, assignment: await make('Weekend essay (marks hidden)', { showMarksToStudent: false }), teacher, email: EMAIL, png }),
    };

    async function open(label, navigate) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1440, height: 1100 });
      const calls = [], consoleErrors = [];
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().replace(/[a-f\d]{24}/g, '<id>').replace(/:\d{4,5}/g, ':<port>')); });
      page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message}`));
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      page.on('response', res => {
        const url = new URL(res.url());
        if (url.pathname.startsWith('/api/') && res.request().method() !== 'OPTIONS')
          calls.push(`${res.request().method()} ${url.pathname.replace(/[a-f\d]{24}/g, ':id').replace(/\/media\/:id\/[^/]+$/, '/media/:id/:file')} ${res.status()}`);
      });
      let settled = 'ok';
      try {
        await navigate(page);
        await page.waitForSelector('app-my-submission-page', { timeout: 30000 });
      } catch (error) { settled = `not settled: ${error.name}`; }
      // What appears depends on the case (a marks-hidden result may show less); these waits only settle the page.
      await page.waitForFunction(() => document.querySelector('app-correction-overlay img')?.naturalWidth > 0, { timeout: 15000 }).catch(() => undefined);
      await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(t => t.value.includes('Teacher review complete.')), { timeout: 5000 }).catch(() => undefined);
      await page.waitForNetworkIdle({ idleTime: 1500, timeout: 15000 }).catch(() => { settled += ' (network kept polling)'; });
      const rendered = await page.evaluate(() => ({
        pageText: document.body.innerText.replace(/\s+/g, ' ').trim().slice(0, 600),
        text: document.querySelector('app-my-submission-page')?.innerText.replace(/\s+/g, ' ').trim() || '',
        teacherComment: [...document.querySelectorAll('textarea')].some(t => t.value.includes('Teacher review complete.')),
        imageLoaded: document.querySelector('app-correction-overlay img')?.naturalWidth > 0,
        url: location.pathname + location.hash,
      }));
      const screenshot = path.join(evidence, `${label}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });
      await context.close();
      return { calls: calls.filter(c => !c.includes('/api/recovery/')).sort(), recoveryCalls: calls.filter(c => c.includes('/api/recovery/')),
        consoleErrors: [...new Set(consoleErrors)].sort(), rendered, screenshot, settled };
    }

    for (const [name, seeded] of Object.entries(cases)) {
      const own = await open(`${name}-own-link`, page => page.goto(`http://localhost:${FRONT_PORT}${seeded.returnUrl.pathname}${seeded.returnUrl.hash}`, { waitUntil: 'networkidle0' }));
      const before = sendLink.mock.calls.length;
      // Each case asks for a fresh portal link: move the Date clock past the shared 2-minute email cool-down (timers stay real).
      const later = Date.now() + 3 * 60000;
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask', 'hrtime', 'performance'] });
      jest.setSystemTime(later);
      expect((await request(app).post('/api/recovery/request').send({ email: EMAIL })).status).toBe(202);
      for (let i = 0; i < 300 && sendLink.mock.calls.length === before; i++) await new Promise(r => setTimeout(r, 10));
      const link = new URL(sendLink.mock.calls.at(-1)[0].link);
      const title = (await Assignment.findById(seeded.submission.assignment)).title;
      const viaPortal = await open(`${name}-portal`, async page => {
        await page.goto(`http://localhost:${FRONT_PORT}${link.pathname}${link.hash}`, { waitUntil: 'networkidle0' });
        await page.waitForSelector('button.portal-item');
        await page.evaluate(t => [...document.querySelectorAll('button.portal-item')].find(b => b.textContent.includes(t)).click(), title);
      });
      report[name] = { own, viaPortal };
      expect(viaPortal.calls).toEqual(own.calls);
      expect(viaPortal.consoleErrors).toEqual(own.consoleErrors);
      expect(viaPortal.rendered.text).toBe(own.rendered.text);
      expect({ teacherComment: viaPortal.rendered.teacherComment, imageLoaded: viaPortal.rendered.imageLoaded })
        .toEqual({ teacherComment: own.rendered.teacherComment, imageLoaded: own.rendered.imageLoaded });
      if (name === 'visible') expect(own.rendered.teacherComment && own.rendered.imageLoaded).toBe(true);
      expect(viaPortal.rendered.url).not.toContain('#');
      // The rubric score is on the page only when the teacher shows marks; redaction must look the same on both paths.
      if (name === 'hidden') expect(own.rendered.text).not.toMatch(/\d+(\.\d+)? \/ 25/);
      else expect(own.rendered.text).toContain('20.0 / 25');
    }
    // PDF download: same result through both paths, and the portal read leaves the database untouched.
    process.env.ENABLE_TEST_PDF_HTTP = 'true';
    process.env.PDF_CHROME_NO_SANDBOX = 'true';
    process.env.PDF_FEEDBACK_CACHE_DIR = path.resolve(__dirname, '../../tmp/recovery-pdf-qa-cache');
    const seeded = cases.visible;
    const binary = req => req.buffer(true).parse((res, done) => { const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => done(null, Buffer.concat(chunks))); });
    const before = JSON.stringify(await Submission.findById(seeded.submission._id).lean());
    const ownPdf = await binary(request(app).get(`/api/guest/submissions/${seeded.submission._id}/pdf`).set('X-Guest-Token', seeded.guestToken));
    const exchange = await request(app).post('/api/recovery/exchange').send({ token: new URL(sendLink.mock.calls.at(-1)[0].link).hash.slice(1) });
    const portalPdf = await binary(request(app).get(`/api/guest/submissions/${seeded.submission._id}/pdf`).set('X-Recovery-Session', exchange.body.data.session));
    report.pdf = { own: { status: ownPdf.status, magic: ownPdf.body.subarray(0, 4).toString(), cache: ownPdf.headers['x-pdf-cache'] },
      portal: { status: portalPdf.status, magic: portalPdf.body.subarray(0, 4).toString(), cache: portalPdf.headers['x-pdf-cache'] },
      sameBytes: Buffer.compare(ownPdf.body, portalPdf.body) === 0 };
    expect(report.pdf.own).toMatchObject({ status: 200, magic: '%PDF' });
    expect(report.pdf.portal).toMatchObject({ status: 200, magic: '%PDF' });
    expect(JSON.stringify(await Submission.findById(seeded.submission._id).lean())).toBe(before);
    // The TTL indexes exist in this end-to-end database (created by the same migration production runs).
    const summary = await require('../scripts/migrateRecoveryPortalIndexes').ensureRecoveryPortalIndexes();
    report.ttlIndexes = Object.fromEntries(Object.entries(summary).map(([collection, list]) =>
      [collection, list.filter(i => i.expireAfterSeconds !== undefined).map(i => `${i.name}:${i.expireAfterSeconds}s`)]));
    expect(report.ttlIndexes).toEqual({ recoverytokens: ['recovery_token_purge_v1:0s'], recoverysessions: ['recovery_session_purge_v1:3600s'],
      recoveryemailwindows: ['recovery_email_window_purge_v1:0s'] });
  } finally {
    fs.writeFileSync(path.join(evidence, 'comparison.json'), JSON.stringify(report, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
