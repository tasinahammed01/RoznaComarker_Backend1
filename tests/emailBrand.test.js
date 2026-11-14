'use strict';
// The Rubrilo logo at the top of the HTML emails (teacher-upload feedback email and the guest submission/result email): a PNG over an
// absolute URL (EMAIL_LOGO_URL, else FRONTEND_URL): the supplied horizontal full-colour logo (icon + name in one image) at its own
// ratio, explicit size, alt "Rubrilo", display:block, no separate wordmark beside it, the old symbol and "R" badge gone, and the
// plain-text versions unchanged. SMTP is mocked.
jest.mock('nodemailer', () => {
  const transport = { sendMail: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const nodemailer = require('nodemailer');
const email = require('../src/services/email.service');
const { emailLogoUrl, emailBrandHeaderHtml } = require('../src/services/emailBrand.service');
const { buildTeacherUploadFeedbackEmail } = require('../src/services/teacherUploadEmailTemplate');
const transport = nodemailer.transport;

const link = 'https://school.example/guest/results/0123456789abcdef01234567#private-token-value';
const upload = { studentName: 'Sam Lee', teacherName: 'Ms Rahman', assignmentTitle: 'My Summer Holiday', link, expiresAt: new Date('2026-12-11T00:00:00Z') };
const IMG = '<img src="https://school.example/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png" width="156" height="50" alt="Rubrilo" style="display:block;width:156px;height:50px;border:0;outline:none;text-decoration:none;">';
const saved = {};

beforeEach(() => {
  for (const key of ['FRONTEND_URL', 'EMAIL_LOGO_URL', 'MAIL_FROM_EMAIL', 'MAIL_FROM_NAME', 'SMTP_PORT']) { saved[key] ??= process.env[key]; delete process.env[key]; }
  process.env.FRONTEND_URL = 'https://school.example';
  process.env.SMTP_USER = 'sender@example.com'; process.env.SMTP_PASS = 'test-only-password';
  jest.clearAllMocks(); transport.sendMail.mockReset(); transport.sendMail.mockResolvedValue({ accepted: ['a@example.com'], rejected: [] });
});
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe('logo URL', () => {
  test('built from FRONTEND_URL (trailing slash or a sub-path handled); EMAIL_LOGO_URL wins; nothing usable gives null', () => {
    expect(emailLogoUrl({ FRONTEND_URL: 'https://school.example' })).toBe('https://school.example/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png');
    expect(emailLogoUrl({ FRONTEND_URL: 'https://school.example/' })).toBe('https://school.example/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png');
    expect(emailLogoUrl({ FRONTEND_URL: 'https://school.example/app/' })).toBe('https://school.example/app/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png');
    expect(emailLogoUrl({ FRONTEND_URL: 'https://school.example', EMAIL_LOGO_URL: 'https://cdn.example/logo.png' })).toBe('https://cdn.example/logo.png');
    expect(emailLogoUrl({ FRONTEND_URL: 'https://school.example', EMAIL_LOGO_URL: 'not a url' })).toBe('https://school.example/logo_and_icon/logo/rubrilo-logo-horizontal-fullcolor@512w.png');
    expect(emailLogoUrl({})).toBeNull();
    expect(emailLogoUrl({ FRONTEND_URL: 'javascript:alert(1)' })).toBeNull();
  });

  test('without any usable URL the row shows the wordmark alone (no broken image)', () => {
    const html = emailBrandHeaderHtml({});
    expect(html).not.toContain('<img');
    expect(html).toContain('<strong style="font-size:24px;color:#14264d;">Rubrilo</strong>');
  });

  test('a hostile override is escaped in the attribute', () => {
    expect(emailBrandHeaderHtml({ EMAIL_LOGO_URL: 'https://cdn.example/a.png?x="><script>' })).not.toContain('"><script>');
  });
});

describe.each([
  ['teacher-upload feedback email', async () => { const { html, text } = buildTeacherUploadFeedbackEmail(upload); return { html, text }; }],
  ['guest submission email', async () => {
    await email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'Essay', returnUrl: link, resultReady: true });
    const message = transport.sendMail.mock.calls[0][0]; return { html: message.html, text: message.text };
  }]
])('%s', (_name, build) => {
  test('shows the horizontal logo PNG (icon + name in one image; absolute URL, 156x50 = the 512x164 ratio, alt "Rubrilo", display:block) with no separate wordmark; the old symbol and "R" badge are gone', async () => {
    const { html } = await build();
    expect(html).toContain(IMG);
    expect(Math.abs(156 / 50 - 512 / 164)).toBeLessThan(0.01);
    expect(html).not.toContain('<strong style="font-size:24px;color:#14264d;">Rubrilo</strong>');
    expect(html).not.toContain('rubrilo-symbol');
    expect(html).not.toContain('font-size:21px;font-weight:bold;">R</td>');
    expect(html).not.toMatch(/<svg|data:image/);
  });
  test('the plain-text version has no image or logo URL', async () => {
    const { text } = await build();
    if (text !== undefined) { expect(text).not.toMatch(/\.png|logo_and_icon/); expect(text.split('\n')[0]).toBe('Rubrilo'); }
  });
});

test('the teacher-upload plain text is exactly as before', () => {
  expect(buildTeacherUploadFeedbackEmail(upload).text).toBe([
    'Rubrilo', '', 'Hi Sam Lee,', '', 'Ms Rahman uploaded your handwritten work for "My Summer Holiday" and your feedback is ready.',
    'This private link opens your feedback without an account until 11 December 2026.', '', link, '',
    'Keep this link private: anyone with it can see your feedback. If it stops working, ask your teacher to send it again.', '',
    'Sent by Rubrilo on behalf of Ms Rahman.'].join('\n'));
});

test('the sender display name defaults to "Rubrilo" (MAIL_FROM_NAME sets it)', async () => {
  await email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...upload });
  expect(transport.sendMail.mock.calls[0][0].from).toBe('"Rubrilo" <sender@example.com>');
  process.env.MAIL_FROM_NAME = 'Rubrilo Feedback';
  transport.sendMail.mockClear();
  await email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...upload });
  expect(transport.sendMail.mock.calls[0][0].from).toBe('"Rubrilo Feedback" <sender@example.com>');
});

// Every HTML email the backend sends: the shared logo header and a preheader hidden in the message body. Plain text is unchanged
// (byte-for-byte against the base commit in the Problem 2 proof); here: no preheader or logo URL leaks into it.
describe('every backend email: shared logo and hidden preheader', () => {
  const sent = async run => { transport.sendMail.mockReset(); transport.sendMail.mockImplementation(async o => ({ accepted: String(o.to).split(',').map(a => a.trim()), rejected: [] }));
    await run(); return transport.sendMail.mock.calls[0][0]; };
  const EMAILS = [
    ['guest receipt', () => sent(() => email.sendGuestSubmissionEmail({ to: 'a@example.com', assignmentTitle: 'Essay', returnUrl: link, resultReady: false }))],
    ['guest feedback ready', () => sent(() => email.sendGuestSubmissionEmail({ to: 'a@example.com', assignmentTitle: 'Essay', returnUrl: link, resultReady: true }))],
    ['recovery portal link', () => sent(() => email.sendRecoveryPortalEmail({ to: 'a@example.com', link: 'https://school.example/recover/portal#t', expiresInHours: 24 }))],
    ['single-submission access link', () => sent(() => email.sendGuestRecoveryEmail({ to: 'a@example.com', link, expiresInDays: 30 }))],
    ['teacher-sent access link', () => sent(() => email.sendTeacherRecoveryEmail({ to: 'a@example.com', link, expiresInDays: 30 }))],
    ['class invitation', () => sent(() => email.sendInvitationEmail({ to: 'a@example.com', className: 'Writing 7B', classCode: 'ABC123', joinUrl: 'https://school.example/join/ABC123' }))],
    ['teacher notice of a guest submission', () => sent(() => email.sendTeacherSubmissionEmail({ to: 'a@example.com', assignmentTitle: 'Essay', studentName: 'Sam' }))],
    ['teacher-upload feedback', async () => ({ ...buildTeacherUploadFeedbackEmail(upload), from: null })],
  ];
  test.each(EMAILS)('%s: the logo image, never the text-only "Rubrilo" line', async (_name, build) => {
    const { html } = await build();
    expect(html).toContain(IMG);
    expect(html).not.toContain('font-size:18px;font-weight:bold;">Rubrilo</p>');
  });
  test.each(EMAILS)('%s: a preheader hidden in every client, first in the body, escaped, not in the plain text', async (_name, build) => {
    const { html, text } = await build();
    const pre = /<div style="(display:none;[^"]*mso-hide:all[^"]*)">([^<]*)<\/div>/.exec(html);
    expect(pre).not.toBeNull();
    for (const rule of ['display:none', 'max-height:0', 'max-width:0', 'overflow:hidden', 'opacity:0', 'mso-hide:all']) expect(pre[1]).toContain(rule);
    expect(html.indexOf(pre[0])).toBeLessThan(html.indexOf(IMG));
    expect(pre[2]).not.toMatch(/[<>]/);
    if (text !== undefined) { expect(text).not.toContain('&#847;'); expect(text).not.toMatch(/\.png|logo_and_icon/); }
  });
  test('the preheader escapes what it is given', () => {
    const { emailPreheaderHtml } = require('../src/services/emailBrand.service');
    expect(emailPreheaderHtml('<script>"x"</script>')).toContain('&lt;script&gt;&quot;x&quot;&lt;/script&gt;');
    expect(emailPreheaderHtml('')).toBe('');
  });
  test('the sender name defaults to "Rubrilo" (MAIL_FROM_NAME overrides it); no code path names the old brand', async () => {
    for (const [, build] of EMAILS.slice(0, 7)) expect((await build()).from).toBe('"Rubrilo" <sender@example.com>');
    process.env.MAIL_FROM_NAME = 'Custom Name';
    expect((await EMAILS[2][1]()).from).toBe('"Custom Name" <sender@example.com>');
    const fs = require('fs'), path = require('path');
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : /\.c?js$/.test(e.name) ? [path.join(dir, e.name)] : []);
    const offenders = walk(path.join(__dirname, '../src')).filter(file => /Rozna[\s-]+Co-?Marker/i.test(fs.readFileSync(file, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
