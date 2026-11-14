'use strict';
// Stage 4: the feedback email for work a teacher uploaded. Rubrilo branding (never the old brand), teacher, assignment, link,
// plain-text version, escaping, no header injection; SMTP is mocked.
jest.mock('nodemailer', () => {
  const transport = { sendMail: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});
jest.mock('../src/utils/logger', () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn() }));
const nodemailer = require('nodemailer');
const logger = require('../src/utils/logger');
const email = require('../src/services/email.service');
const { buildTeacherUploadFeedbackEmail } = require('../src/services/teacherUploadEmailTemplate');
const transport = nodemailer.transport;

const link = 'https://school.example/guest/results/0123456789abcdef01234567#private-token-value';
const base = { studentName: 'Sam Lee', teacherName: 'Ms Rahman', assignmentTitle: 'My Summer Holiday', link, expiresAt: new Date('2026-12-11T00:00:00Z') };

beforeEach(() => {
  jest.clearAllMocks(); transport.sendMail.mockReset(); transport.sendMail.mockResolvedValue({ accepted: ['sam@example.com'], rejected: [] });
  process.env.SMTP_USER = 'sender@example.com'; process.env.SMTP_PASS = 'test-only-password';
  delete process.env.MAIL_FROM_EMAIL; delete process.env.MAIL_FROM_NAME; delete process.env.SMTP_PORT;
});

describe('template', () => {
  test('is a branded Rubrilo email with the teacher, assignment, link and expiry, in HTML and plain text', () => {
    const { subject, text, html } = buildTeacherUploadFeedbackEmail(base);
    expect(subject).toBe('Your feedback is ready: My Summer Holiday');
    for (const part of [text, html]) {
      expect(part).toContain('Rubrilo'); expect(part).toContain('Ms Rahman'); expect(part).toContain('My Summer Holiday');
      expect(part).toContain(link); expect(part).toContain('11 December 2026');
      expect(part).not.toMatch(/rozna/i); expect(part).not.toMatch(/\bRH\b/);
    }
    expect(text).toContain('Hi Sam Lee,');
    expect(text).toContain('Keep this link private');
    expect(html).toContain('View my feedback');
    expect(html).not.toMatch(/support@/i);
  });

  test('escapes every inserted value and keeps the subject on one line', () => {
    const hostile = { ...base, studentName: '<img src=x onerror=alert(1)>', teacherName: 'Ms "R" <b>Rahman</b>',
      assignmentTitle: 'Essay\r\nBcc: victim@example.com <script>alert(1)</script>' };
    const { subject, html } = buildTeacherUploadFeedbackEmail(hostile);
    expect(subject).not.toMatch(/[\r\n]/);
    expect(html).not.toMatch(/<script>|<img src=x|<b>Rahman/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Ms &quot;R&quot; &lt;b&gt;Rahman&lt;/b&gt;');
    const quoted = buildTeacherUploadFeedbackEmail({ ...base, link: 'https://school.example/x?a="><script>' }).html;
    expect(quoted).not.toContain('"><script>');
  });

  test('a class member is told to sign in instead of receiving a private link note', () => {
    const { text, html } = buildTeacherUploadFeedbackEmail({ ...base, link: 'https://school.example/student/my-classes', needsLogin: true, expiresAt: null });
    expect(text).toContain('Sign in to Rubrilo');
    expect(text).not.toContain('Keep this link private'); expect(html).not.toContain('Keep this link private');
  });

  test('falls back politely without a teacher name and refuses a non-web link', () => {
    expect(buildTeacherUploadFeedbackEmail({ ...base, teacherName: '' }).text).toContain('Your teacher uploaded');
    expect(() => buildTeacherUploadFeedbackEmail({ ...base, link: 'javascript:alert(1)' })).toThrow();
  });
});

describe('delivery (SMTP mocked)', () => {
  test('sends the HTML and the plain-text version from Rubrilo', async () => {
    await expect(email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...base })).resolves.toEqual({ success: true,
      delivery: { acceptedCount: 1, rejectedCount: 0, responseCode: null, enhancedStatus: null, messageId: null } });
    const message = transport.sendMail.mock.calls[0][0];
    expect(message).toEqual(expect.objectContaining({ to: 'sam@example.com', subject: 'Your feedback is ready: My Summer Holiday' }));
    expect(message.from).toBe('"Rubrilo" <sender@example.com>');
    expect(message.text).toContain(link); expect(message.html).toContain('View my feedback');
  });

  test('a provider failure returns a safe code and never logs the recipient or the link', async () => {
    transport.sendMail.mockRejectedValueOnce(Object.assign(new Error(`sam@example.com ${link}`), { code: 'ECONNREFUSED' }));
    await expect(email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...base })).resolves.toEqual({ success: false, code: 'SMTP_CONNECTION_FAILED' });
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/sam@example.com|private-token/);
  });

  test('a rejected recipient, a broken template and missing configuration are failures with safe codes', async () => {
    transport.sendMail.mockResolvedValueOnce({ accepted: [], rejected: ['sam@example.com'] });
    expect((await email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...base })).code).toBe('PROVIDER_REJECTED');
    expect((await email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...base, link: 'not-a-link' })).code).toBe('TEMPLATE_FAILURE');
    delete process.env.SMTP_USER; delete process.env.SMTP_PASS;
    const unconfigured = await email.sendTeacherUploadFeedbackEmail({ to: 'sam@example.com', ...base });
    expect(unconfigured.success).toBe(false); expect(transport.sendMail).toHaveBeenCalledTimes(1);
  });
});
