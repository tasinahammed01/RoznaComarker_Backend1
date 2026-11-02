'use strict';
// Opt-in browser run (RECOVERY_BROWSER_QA=1) of the reported bug: a student who lost the link asks for it on the result page, opens
// the emailed link, asks AGAIN after the cool-down, gets a second email, and every link works. Production Angular build in Chromium.
const FRONT_PORT = 4393;
process.env.JWT_SECRET = 'recovery-resend-browser-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/recovery-resend-browser-' + process.pid;
process.env.RECOVERY_EMAIL_COOLDOWN_SECONDS = '30';   // the minimum, so the run waits in real time
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { pageImage } = require('./fixtures/imagePreflightPage');
const { seedRealisticGuestResult } = require('./helpers/realisticGuestResult');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const email = require('../src/services/email.service');

jest.setTimeout(300000);
const EMAIL = 'resend-browser@example.com';
const evidence = path.resolve(__dirname, '../../output/recovery-resend-qa');
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);

(process.env.RECOVERY_BROWSER_QA === '1' ? test : test.skip)('lost link -> recover -> link works -> recover again after cool-down -> second link works, old links too', async () => {
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
  const report = { steps: [] };
  const step = (name, data = {}) => report.steps.push({ name, ...data });
  try {
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'resend-teacher@example.com', role: 'teacher' });
    const cls = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'RESEND-QA' });
    const assignment = await Assignment.create({ title: 'Weekend essay', class: cls._id, teacher: teacher._id, instructions: 'Describe your weekend.',
      qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true });
    const seeded = await seedRealisticGuestResult({ app, assignment, teacher, email: EMAIL, png: await pageImage() });
    email.sendGuestSubmissionEmail.mockClear();

    async function newPage() {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      const consoleErrors = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160)); });
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      return { page, context, consoleErrors };
    }
    const resultLoads = async link => {
      const { page, context } = await newPage();
      await page.goto(`http://localhost:${FRONT_PORT}${new URL(link).pathname}${new URL(link).hash}`, { waitUntil: 'networkidle0' });
      const ok = await page.waitForSelector('app-my-submission-page', { timeout: 30000 }).then(() => true, () => false);
      return { ok, page, context };
    };
    const emails = () => email.sendGuestRecoveryEmail.mock.calls.map(([m]) => m.link);
    const waitForEmails = async n => { for (let i = 0; i < 600 && emails().length < n; i++) await new Promise(r => setTimeout(r, 50)); };

    // 1. The student lost the link: the result page without a token offers recovery.
    const { page: lost, consoleErrors } = await newPage();
    await lost.goto(`http://localhost:${FRONT_PORT}/guest/results/${seeded.submission._id}`, { waitUntil: 'networkidle0' });
    await lost.waitForSelector('details.recovery summary');
    // Task 4: the form is already open on a page without its link; open it only if it is not.
    if (!(await lost.$eval('details.recovery', d => d.open))) await lost.click('details.recovery summary');
    await lost.type('#recovery-email', EMAIL);
    await lost.click('details.recovery button[type=submit]');
    await lost.waitForFunction(() => /You can ask again in \d:\d\d/.test(document.querySelector('details.recovery button[type=submit]')?.textContent || ''));
    const first = await lost.evaluate(() => ({ button: document.querySelector('details.recovery button[type=submit]').textContent.trim(),
      disabled: document.querySelector('details.recovery button[type=submit]').disabled, status: document.querySelector('details.recovery p[role=status]').textContent.trim() }));
    await lost.screenshot({ path: path.join(evidence, '1-first-request-cooldown.png'), fullPage: true });
    await waitForEmails(1);
    step('first request', { ...first, emailsSent: emails().length });
    expect(first.disabled).toBe(true);
    expect(emails()).toHaveLength(1);

    // 2. The emailed link works.
    const one = await resultLoads(emails()[0]);
    await one.page.screenshot({ path: path.join(evidence, '2-first-link-opens.png'), fullPage: true });
    step('first link opens', { ok: one.ok });
    expect(one.ok).toBe(true);

    // 3. Ask again after the cool-down (real time): the button comes back and a second email is sent.
    await lost.waitForFunction(() => !document.querySelector('details.recovery button[type=submit]').disabled, { timeout: 60000 });
    await lost.click('details.recovery button[type=submit]');
    await waitForEmails(2);
    await lost.screenshot({ path: path.join(evidence, '3-second-request.png'), fullPage: true });
    step('second request after cool-down', { emailsSent: emails().length, distinctLinks: new Set(emails()).size });
    expect(emails()).toHaveLength(2);
    expect(new Set(emails()).size).toBe(2);

    // 4. Both emailed links, and the original link, work.
    const two = await resultLoads(emails()[1]);
    await two.page.screenshot({ path: path.join(evidence, '4-second-link-opens.png'), fullPage: true });
    const oneAgain = await resultLoads(emails()[0]);
    const original = await resultLoads(seeded.returnUrl.href);
    step('all links after resend', { second: two.ok, firstAgain: oneAgain.ok, original: original.ok });
    expect([two.ok, oneAgain.ok, original.ok]).toEqual([true, true, true]);
    report.consoleErrors = consoleErrors;
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
