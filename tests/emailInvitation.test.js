'use strict';
jest.mock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: jest.fn(async options => ({ messageId: 'test-message', options })) })) }));
jest.mock('../src/utils/logger', () => ({ info: jest.fn(), error: jest.fn() }));
const nodemailer = require('nodemailer');
const { sendInvitationEmail } = require('../src/services/email.service');
beforeEach(() => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '465', SMTP_SECURE: 'true',
    SMTP_USER: 'resend', SMTP_PASS: 'synthetic-smtp-password', MAIL_FROM_EMAIL: 'sender@mail.example.com' });
});

test('escapes class content and preserves the canonical join link', async () => {
  const joinUrl = 'https://comarkers.roznahub.com/student/join-class?joinCode=A%26B';
  const response = await sendInvitationEmail({ to: 'student@example.com', className: '<Writing & Reading>',
    classCode: 'A&B', joinUrl, teacherName: 'Teacher' });
  expect(response.success).toBe(true);
  const options = nodemailer.createTransport.mock.results[0].value.sendMail.mock.calls[0][0];
  expect(options.to).toBe('student@example.com');
  expect(options.html).toContain('&lt;Writing &amp; Reading&gt;');
  expect(options.html).toContain('A&amp;B');
  expect(options.html).toContain('https://comarkers.roznahub.com/student/join-class?joinCode=A%26B');
  expect(options.html).not.toContain('<Writing & Reading>');
});
