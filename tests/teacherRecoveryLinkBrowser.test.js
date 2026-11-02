'use strict';
// Opt-in browser run (RECOVERY_BROWSER_QA=1): a signed-in teacher opens a guest submission, sends a recovery link (masked
// confirmation), the captured email link opens the student's result, and a second send inside the cool-down shows the countdown.
const FRONT_PORT = 4395;
process.env.JWT_SECRET = 'teacher-recovery-browser-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/teacher-recovery-browser-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })), sendTeacherRecoveryEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { pageImage } = require('./fixtures/imagePreflightPage');
const { seedRealisticGuestResult } = require('./helpers/realisticGuestResult');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const email = require('../src/services/email.service');

jest.setTimeout(300000);
const STUDENT = 'jane.student@example.com';
const evidence = path.resolve(__dirname, '../../output/teacher-recovery-qa');
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);

(process.env.RECOVERY_BROWSER_QA === '1' ? test : test.skip)('teacher sends a recovery link; it opens the student result; a second send shows the cool-down', async () => {
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
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'qa-teacher@example.com', role: 'teacher', displayName: 'QA Teacher' });
    const cls = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'TEACHER-QA' });
    const assignment = await Assignment.create({ title: 'Weekend essay', class: cls._id, teacher: teacher._id, instructions: 'Describe your weekend.',
      qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true });
    const seeded = await seedRealisticGuestResult({ app, assignment, teacher, email: STUDENT, png: await pageImage() });
    const jwt = signTestJwt({ id: teacher._id, role: 'teacher', firebaseUid: teacher.firebaseUid });

    async function newPage(withTeacherLogin) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1366, height: 1000 });
      if (withTeacherLogin) await page.evaluateOnNewDocument(token => { localStorage.setItem('backend_jwt', token); }, jwt);
      const responses = [];
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      page.on('response', res => { if (new URL(res.url()).pathname.includes('/guest-access/recovery-link') && res.request().method() !== 'OPTIONS')
        responses.push(`${res.request().method()} ${res.status()}`); });
      return { page, responses };
    }
    const actionText = page => page.$eval('app-guest-recovery-link-action', el => el.textContent.replace(/\s+/g, ' ').trim());

    // 1. The teacher opens the guest submission.
    const { page: teacherPage, responses } = await newPage(true);
    await teacherPage.goto(`http://localhost:${FRONT_PORT}/teacher/my-classes/detail/student-submissions/guest?classId=${cls._id}&assignmentId=${assignment._id}&submissionId=${seeded.submission._id}`,
      { waitUntil: 'domcontentloaded', timeout: 60000 });   // the teacher page keeps polling, so it never goes network-idle
    await teacherPage.waitForSelector('app-guest-recovery-link-action button[data-action=open]', { timeout: 60000 }).catch(async error => {
      await teacherPage.screenshot({ path: path.join(evidence, 'debug-teacher-page.png') });
      step('debug', { url: teacherPage.url().replace(/[a-fd]{24}/g, '<id>'), text: (await teacherPage.evaluate(() => document.body.innerText)).replace(/s+/g, ' ').slice(0, 400) });
      throw error;
    });
    await teacherPage.screenshot({ path: path.join(evidence, '1-teacher-submission.png') });
    step('teacher page', { action: await actionText(teacherPage) });

    // 2. Masked confirmation, then send.
    await teacherPage.click('app-guest-recovery-link-action button[data-action=open]');
    await teacherPage.waitForFunction(() => document.querySelector('app-guest-recovery-link-action')?.textContent.includes('Send a new access link to'));
    await teacherPage.screenshot({ path: path.join(evidence, '2-confirm-masked.png') });
    const confirmText = await actionText(teacherPage);
    step('confirmation', { text: confirmText });
    expect(confirmText).toContain('j***@example.com');
    expect(confirmText).not.toContain(STUDENT);
    await teacherPage.evaluate(() => [...document.querySelectorAll('app-guest-recovery-link-action button')].find(b => b.textContent.includes('Send link')).click());
    await teacherPage.waitForFunction(() => document.querySelector('app-guest-recovery-link-action')?.textContent.includes('Link sent to'));
    await teacherPage.screenshot({ path: path.join(evidence, '3-sent.png') });
    step('sent', { text: await actionText(teacherPage), emails: email.sendTeacherRecoveryEmail.mock.calls.length });
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(1);
    expect(email.sendTeacherRecoveryEmail.mock.calls[0][0].to).toBe(STUDENT);

    // 3. The captured link opens the student's result.
    const link = new URL(email.sendTeacherRecoveryEmail.mock.calls[0][0].link);
    const { page: studentPage } = await newPage(false);
    await studentPage.goto(`http://localhost:${FRONT_PORT}${link.pathname}${link.hash}`, { waitUntil: 'networkidle0' });
    const opened = await studentPage.waitForSelector('app-my-submission-page', { timeout: 30000 }).then(() => true, () => false);
    await studentPage.screenshot({ path: path.join(evidence, '4-student-result.png') });
    step('student opens link', { opened, submission: link.pathname.endsWith(String(seeded.submission._id)), tokenLeftInUrl: studentPage.url().includes('#') });
    expect(opened).toBe(true);
    expect(link.pathname).toBe(`/guest/results/${seeded.submission._id}`);

    // 4. A second send inside the cool-down shows the countdown.
    await teacherPage.click('app-guest-recovery-link-action button[data-action=open]');
    await teacherPage.waitForFunction(() => document.querySelector('app-guest-recovery-link-action')?.textContent.includes('Send a new access link to'));
    await teacherPage.evaluate(() => [...document.querySelectorAll('app-guest-recovery-link-action button')].find(b => b.textContent.includes('Send link')).click());
    await teacherPage.waitForFunction(() => /You can send again in \d:\d\d/.test(document.querySelector('app-guest-recovery-link-action')?.textContent || ''));
    await teacherPage.screenshot({ path: path.join(evidence, '5-cooldown.png') });
    const cooldownText = await actionText(teacherPage);
    step('second send', { text: cooldownText, emails: email.sendTeacherRecoveryEmail.mock.calls.length });
    expect(email.sendTeacherRecoveryEmail).toHaveBeenCalledTimes(1);
    report.recoveryLinkApi = responses;
    expect(responses).toEqual(['GET 200', 'POST 200', 'POST 429']);
  } finally {
    fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
