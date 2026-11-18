'use strict';
// Stage 10: the guest emails for a speaking assignment (receipt and "feedback is ready") have their own wording and template
// (guestSpeakingEmailTemplate.js); the essay guest email is byte-for-byte what it was (pinned below, computed on the code before stage 10).
// Rubrilo only; nothing from the recording; every value escaped. nodemailer is mocked: nothing is sent.
jest.mock('nodemailer', () => {
  const transport = { sendMail: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), metric: jest.fn() }));
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const email = require('../src/services/email.service');
const { buildGuestSpeakingEmail } = require('../src/services/guestSpeakingEmailTemplate');
const transport = nodemailer.transport;
const LINK = 'https://school.example/guest/speaking/6a0000000000000000000001#private-token-value';

beforeEach(() => {
  jest.clearAllMocks(); transport.sendMail.mockReset();
  transport.sendMail.mockImplementation(async options => ({ accepted: String(options.to).split(',').map(a => a.trim()), rejected: [] }));
  process.env.SMTP_USER = 'sender@example.com'; process.env.SMTP_PASS = 'test-only-password';
  delete process.env.MAIL_FROM_EMAIL; delete process.env.MAIL_FROM_NAME; delete process.env.SMTP_PORT;
});

// sha256 of [from, to, subject, text, html] of the essay guest email (receipt, then result), with the footer year normalised.
const ESSAY_PINNED = ['c640f597b6eae5dad5a07d59e227a02c3438b04a217bec4d1da37679406df220', 'b7b1fec384d56d03dd1fb23fcc8a71ec8128204cc1aa0032de0e037ad3fddc24'];
async function essayHashes() {
  const out = [];
  for (const resultReady of [false, true]) {
    await email.sendGuestSubmissionEmail({ to: 'guest@example.com', assignmentTitle: 'River essay', returnUrl: 'https://school.example/guest/results/abc#tok', resultReady });
    const m = transport.sendMail.mock.calls.at(-1)[0];
    const normalised = JSON.stringify([m.from, m.to, m.subject, m.text, m.html]).replace(/\d{4} RoznaHub/g, 'YEAR RoznaHub');
    out.push(crypto.createHash('sha256').update(normalised).digest('hex'));
  }
  return out;
}

test('the essay guest email is unchanged, byte for byte (receipt and result)', async () => {
  expect(await essayHashes()).toEqual(ESSAY_PINNED);
});

test('speaking receipt: its own wording, the private link, the recovery link; Rubrilo only', async () => {
  const res = await email.sendGuestSubmissionEmail({ to: 'dee@example.com', assignmentTitle: 'Describe your town', returnUrl: LINK, kind: 'speaking' });
  expect(res).toEqual({ success: true });
  const m = transport.sendMail.mock.calls[0][0];
  expect(m.to).toBe('dee@example.com');
  expect(m.from).toContain('"Rubrilo"');
  expect(m.subject).toBe('Your Rubrilo recording was received: Describe your town');
  expect(m.text).toContain('Your recording was received. It will be turned into text and marked, and your teacher can see it.');
  expect(m.text).toContain(LINK);
  expect(m.text).toContain('https://school.example/recover');
  expect(m.html).toContain('Recording received');
  expect(`${m.subject}${m.text}${m.html}`).not.toMatch(/RoznaHub|roznahub|Comarker|handwrit|essay/i);
});

test('speaking result: "Your feedback is ready" wording and the same private link', async () => {
  await email.sendGuestSubmissionEmail({ to: 'dee@example.com', assignmentTitle: 'Describe your town', returnUrl: LINK, resultReady: true, kind: 'speaking' });
  const m = transport.sendMail.mock.calls[0][0];
  expect(m.subject).toBe('Your Rubrilo feedback is ready: Describe your town');
  expect(m.text).toContain('Your recording was marked and your feedback is ready. Use your private link below to see it without signing in.');
  expect(m.html).toContain('View my feedback');
  expect(m.text).toContain(LINK);
});

test('the template: escaped values, a one-line subject, no injection; a non-web link is refused; only the given fields are used', () => {
  const { subject, html, text } = buildGuestSpeakingEmail({ assignmentTitle: '<script>x</script>\r\nBcc: a@example.com', returnUrl: LINK });
  expect(subject).not.toMatch(/[\r\n]/);
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
  expect(text).not.toContain('\r');
  expect(() => buildGuestSpeakingEmail({ assignmentTitle: 'A', returnUrl: 'javascript:alert(1)' })).toThrow(expect.objectContaining({ code: 'TEMPLATE_FAILURE' }));
  const extra = buildGuestSpeakingEmail({ assignmentTitle: 'A', returnUrl: LINK, transcript: 'SECRET TRANSCRIPT', overallScore: 87, fileName: 'answer.wav' });
  expect(`${extra.text}${extra.html}`).not.toMatch(/SECRET TRANSCRIPT|87|answer\.wav/);
});

test('a template failure is a safe failure code, never a throw', async () => {
  const res = await email.sendGuestSubmissionEmail({ to: 'dee@example.com', assignmentTitle: 'A', returnUrl: 'not-a-link', kind: 'speaking' });
  expect(res).toEqual({ success: false, code: 'TEMPLATE_FAILURE' });
  expect(transport.sendMail).not.toHaveBeenCalled();
});
