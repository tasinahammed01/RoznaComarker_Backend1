'use strict';
// Opt-in browser state matrix (RECOVERY_BROWSER_QA=1, QA_PHASE=before|after): every submission state x every way a student reaches
// the result (original link, result-email link, recovery-resend link, portal), plus the email's token-less "recover" link and a tab
// reopened after the client-side token lifetime. Records screen, API statuses and console errors; screenshots per cell.
const FRONT_PORT = 4394;
process.env.JWT_SECRET = 'recovery-display-matrix-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = `http://localhost:${FRONT_PORT}`;
process.env.UPLOAD_BASE_PATH = 'uploads/recovery-display-matrix-' + process.pid;
// Harness: ~55 page loads from one IP would hit the global per-IP API limit (300 per 15 minutes).
process.env.BASELINE_RATE_LIMIT_MAX = '100000'; process.env.COARSE_IP_RATE_LIMIT_MAX = '100000';
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })),
  sendTeacherSubmissionEmail: jest.fn(async () => ({ success: true })), sendRecoveryPortalEmail: jest.fn(async () => ({ success: true })),
  sendGuestRecoveryEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/assessmentCreditRouter.service', () => ({ canRunAssessment: jest.fn(async () => ({ allowed: true })) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/middlewares/rateLimit.middleware', () => {
  const original = jest.requireActual('../src/middlewares/rateLimit.middleware');
  return { ...original, createSensitiveRateLimiter: options => original.createSensitiveRateLimiter({ ...options, limit: 100000 }),
    createEmailRateLimiter: options => original.createEmailRateLimiter({ ...options, limit: 100000 }) };
});
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
const access = require('../src/services/guestAccess.service');
const email = require('../src/services/email.service');

jest.setTimeout(900000);
const PHASE = process.env.QA_PHASE || 'run';
const evidence = path.resolve(__dirname, `../../output/recovery-display-qa/${PHASE}`);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const lastLink = () => {
  const calls = [...email.sendGuestSubmissionEmail.mock.calls, ...(email.sendGuestRecoveryEmail?.mock.calls || [])];
  const all = calls.map(([m]) => m.returnUrl || m.link).filter(Boolean);
  return all.at(-1);
};

(process.env.RECOVERY_BROWSER_QA === '1' ? test : test.skip)('state matrix: every state x every entry path', async () => {
  await connectInMemoryMongo(); await Submission.init(); await seedTestPlans();
  // Harness only: every cell needs its own link, so the per-address email limits are bypassed here (they are tested elsewhere).
  jest.spyOn(require('../src/services/recoveryEmailQuota.service'), 'claim').mockResolvedValue({ granted: true, reason: null, release: async () => {} });
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
  const cells = [];
  try {
    const teacher = await User.create({ firebaseUid: crypto.randomUUID(), email: 'matrix-teacher@example.com', role: 'teacher' });
    const cls = await Class.create({ name: 'Writing 7B', teacher: teacher._id, joinCode: 'MATRIX-A' });
    const closedClass = await Class.create({ name: 'Old class', teacher: teacher._id, joinCode: 'MATRIX-B' });
    const png = await pageImage();
    let n = 0;
    const assignmentFor = (title, extra = {}, classDoc = cls) => Assignment.create({ title, class: classDoc._id, teacher: teacher._id,
      instructions: 'Describe your weekend.', qrToken: `qr-${crypto.randomUUID()}`, allowGuestSubmission: true, ...extra });
    const plainSubmit = async (assignment, address) => {
      const res = await request(app).post(`/api/guest/assignments/${assignment.qrToken}/submit`).set('Idempotency-Key', crypto.randomUUID())
        .field('name', 'QA Student').field('email', address).attach('files', png, { filename: 'essay.png', contentType: 'image/png' });
      if (res.status !== 200) throw new Error('submit failed ' + res.status);
      const submission = await Submission.findOne({ assignment: assignment._id }).sort({ submittedAt: -1 });
      return { submission, returnUrl: new URL(res.body.data.returnUrl) };
    };

    // ---- States ----
    const states = [];
    async function state(name, build) { const address = `matrix${++n}@example.com`; states.push({ name, address, ...(await build(address)) }); }
    await state('processing', async a => { const x = await assignmentFor('Processing essay'); return { assignment: x, ...(await plainSubmit(x, a)) }; });
    await state('ocr-pending', async a => { const x = await assignmentFor('OCR pending essay'); const s = await plainSubmit(x, a);
      await Submission.updateOne({ _id: s.submission._id }, { $set: { ocrStatus: 'processing' } }); return { assignment: x, ...s }; });
    await state('ocr-failed', async a => { const x = await assignmentFor('OCR failed essay'); const s = await plainSubmit(x, a);
      await Submission.updateOne({ _id: s.submission._id }, { $set: { ocrStatus: 'failed', ocrErrorCode: 'OCR_PROVIDER_FAILED', assessmentStatus: 'failed' } }); return { assignment: x, ...s }; });
    await state('analysis-failed', async a => { const x = await assignmentFor('Analysis failed essay');
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png });
      await require('../src/models/SubmissionFeedback').deleteOne({ submissionId: s.submission._id });
      await Submission.updateOne({ _id: s.submission._id }, { $set: { correctionStatus: 'failed', semanticStatus: 'failed', evaluationStatus: 'failed', assessmentStatus: 'failed' } });
      return { assignment: x, ...s }; });
    await state('ai-marks-visible', async a => { const x = await assignmentFor('AI essay (marks visible)');
      return { assignment: x, ...(await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png, teacherReviewed: false })) }; });
    await state('ai-marks-hidden', async a => { const x = await assignmentFor('AI essay (marks hidden)', { showMarksToStudent: false });
      return { assignment: x, ...(await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png, teacherReviewed: false })) }; });
    await state('teacher-reviewed', async a => { const x = await assignmentFor('Reviewed essay');
      return { assignment: x, ...(await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png })) }; });
    await state('teacher-revoked', async a => { const x = await assignmentFor('Revoked essay');
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png }); return { assignment: x, ...s, after: async () =>
        Submission.updateOne({ _id: s.submission._id }, { $set: { 'guest.revokedAt': new Date() }, $unset: { 'guest.accessHash': 1, 'guest.recoveryAccess': 1 } }) }; });
    await state('no-ocr-data', async a => { const x = await assignmentFor('No OCR essay');
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png });
      await Submission.updateOne({ _id: s.submission._id }, { $set: { ocrPages: [] }, $unset: { transcriptText: 1, ocrText: 1, combinedOcrText: 1 } }); return { assignment: x, ...s }; });
    await state('two-attempts', async a => { const x = await assignmentFor('Two attempts essay');
      const older = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png, teacherComments: 'Review of the FIRST attempt.' });
      await Submission.updateOne({ _id: older.submission._id }, { $set: { submittedAt: new Date(Date.now() - 86400000) } });
      const newer = await plainSubmit(x, a);
      return { assignment: x, ...older, newerId: String(newer.submission._id), olderId: String(older.submission._id) }; });
    await state('assignment-closed', async a => { const x = await assignmentFor('Closed essay');
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png }); return { assignment: x, ...s, after: async () => Assignment.updateOne({ _id: x._id }, { $set: { isActive: false } }) }; });
    await state('class-inactive', async a => { const x = await assignmentFor('Inactive class essay', {}, closedClass);
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png }); return { assignment: x, ...s, after: async () => Class.updateOne({ _id: closedClass._id }, { $set: { isActive: false } }) }; });
    await state('link-expired', async a => { const x = await assignmentFor('Expired essay');
      const s = await seedRealisticGuestResult({ app, assignment: x, teacher, email: a, png }); return { assignment: x, ...s, after: async () =>
        Submission.updateOne({ _id: s.submission._id }, { $set: { 'guest.expiresAt': new Date(Date.now() - 1000) } }) }; });

    // ---- Entry links for each state (issued before the "after" change, as in real life) ----
    for (const s of states) {
      s.links = { original: s.returnUrl.href };
      const resultToken = crypto.randomBytes(32).toString('base64url');
      await Submission.updateOne({ _id: s.submission._id }, { $set: { 'guest.resultAccessHash': access.hash(resultToken), 'guest.resultExpiresAt': new Date(Date.now() + 30 * 86400000) } });
      s.links['result-email'] = access.returnUrl(s.submission._id, resultToken);
      const before = lastLink();
      const sent = await require('../src/services/guestRecovery.service').resendGuestLink({ emailNormalized: s.address,
        ...(s.name === 'two-attempts' ? { qrToken: s.assignment.qrToken } : { submissionId: String(s.submission._id) }) });
      s.links.resend = sent.sent && lastLink() !== before ? lastLink() : null;
      if (s.name === 'link-expired') {
        // An expired link: all links older than their lifetime. Expire the result and resend links too.
        await Submission.updateOne({ _id: s.submission._id }, { $set: { 'guest.resultExpiresAt': new Date(Date.now() - 1000), 'guest.recoveryAccess.$[].expiresAt': new Date(Date.now() - 1000) } });
      }
      const issued = await require('../src/services/recoveryPortal.service').issueLink(s.address);
      s.links.portal = issued.sent ? email.sendRecoveryPortalEmail.mock.calls.at(-1)[0].link : null;
      if (s.after) await s.after();
    }

    // ---- Browser ----
    async function visit(label, url, { portalTitle = null, beforeReload = null } = {}) {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      await page.setViewport({ width: 1280, height: 1000 });
      const calls = [], consoleErrors = [];
      page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text().replace(/[a-f\d]{24}/g, '<id>').slice(0, 140)); });
      page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message.slice(0, 140)));
      await page.setRequestInterception(true);
      page.on('request', req => {
        const target = new URL(req.url());
        if (target.pathname.startsWith('/api/')) return req.continue({ url: `http://127.0.0.1:${api.address().port}${target.pathname}${target.search}` });
        if (['127.0.0.1', 'localhost'].includes(target.hostname) || ['data:', 'blob:'].includes(target.protocol)) return req.continue();
        if (req.resourceType() === 'stylesheet') return req.respond({ status: 200, contentType: 'text/css', body: '' });
        return req.abort();
      });
      page.on('response', res => {
        const u = new URL(res.url());
        if (u.pathname.startsWith('/api/') && res.request().method() !== 'OPTIONS')
          calls.push(`${res.request().method()} ${u.pathname.replace(/[a-f\d]{24}/g, ':id').replace(/\/media\/:id\/[^/]+$/, '/media/:id/:f')} ${res.status()}`);
      });
      const settle = async () => { await page.waitForNetworkIdle({ idleTime: 1200, timeout: 20000 }).catch(() => undefined); await new Promise(r => setTimeout(r, 400)); };
      let openedId = null;
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await settle();
        if (portalTitle) {
          const clicked = await page.evaluate(t => { const b = [...document.querySelectorAll('button.portal-item')].find(x => x.textContent.includes(t)); if (b) { b.click(); return true; } return false; }, portalTitle);
          if (clicked) await settle();
        }
        if (beforeReload) { await beforeReload(page); await page.reload({ waitUntil: 'domcontentloaded' }); await settle(); }
        openedId = (page.url().match(/guest\/results\/([a-f\d]{24})/) || [])[1] || null;
      } catch (error) { consoleErrors.push('harness: ' + error.name); }
      const screen = await page.evaluate(() => {
        const result = document.querySelector('app-my-submission-page');
        const text = (result || document.querySelector('main') || document.body).innerText.replace(/\s+/g, ' ').trim();
        const headings = [...document.querySelectorAll('h1, h2')].map(h => h.innerText.trim()).filter(Boolean).slice(0, 4);
        return { view: result ? 'result' : document.querySelector('button.portal-item') ? 'portal-list' : document.querySelector('.notice-error') ? 'error' : document.querySelector('details.recovery, #portal-email') ? 'recovery' : 'other',
          headings, recoveryOpen: Boolean(document.querySelector('details.recovery')?.open), text: text.slice(0, 260),
          evaluationHeading: [...document.querySelectorAll('h2, h3, h4, strong')].map(x => x.innerText.trim()).find(t => /Evaluation/.test(t)) || null };
      });
      const shot = path.join(evidence, `${label}.png`);
      await page.screenshot({ path: shot, fullPage: false });
      await context.close();
      const cell = { cell: label, openedId, ...screen, api: calls, consoleErrors: [...new Set(consoleErrors)], screenshot: path.relative(path.resolve(__dirname, '../..'), shot) };
      cells.push(cell);
      return cell;
    }

    const origin = `http://localhost:${FRONT_PORT}`;
    for (const s of states) {
      for (const [entry, link] of Object.entries(s.links)) {
        if (!link) { cells.push({ cell: `${s.name}__${entry}`, view: 'no-link-issued' }); continue; }
        const u = new URL(link);
        const c = await visit(`${s.name}__${entry}`, `${origin}${u.pathname}${u.hash}`, entry === 'portal' ? { portalTitle: s.assignment.title } : {});
        if (s.name === 'two-attempts') c.attempt = c.openedId === s.newerId ? 'newer (no result yet)' : c.openedId === s.olderId ? 'older (reviewed)' : 'other';
      }
    }
    // Extra: the email's token-less "Recover Link", and a tab reopened after the client-side token lifetime.
    const reviewed = states.find(s => s.name === 'teacher-reviewed');
    await visit('extra__email-recover-link-no-token', `${origin}/guest/results/${reviewed.submission._id}`);
    const o = new URL(reviewed.links.original);
    await visit('extra__tab-reopened-after-1h', `${origin}${o.pathname}${o.hash}`, { beforeReload: page => page.evaluate(() => {
      for (const key of Object.keys(sessionStorage)) if (key.startsWith('comarker:guest-return:')) {
        const saved = JSON.parse(sessionStorage.getItem(key)); saved.until = Date.now() - 1000; sessionStorage.setItem(key, JSON.stringify(saved));
      }
    }) });
  } finally {
    fs.writeFileSync(path.join(evidence, 'matrix.json'), JSON.stringify(cells, null, 2));
    await browser.close(); api.close(); site.close(); await disconnectInMemoryMongo();
    fs.rmSync(uploadRoot, { recursive: true, force: true });
  }
});
