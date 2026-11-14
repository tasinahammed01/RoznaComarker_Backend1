'use strict';
// scripts/diagnoseEmail.js with SMTP and DNS mocked (nothing is sent, no network): it prints accepted/rejected, the SMTP code and
// enhanced status, messageId, timings, DNS facts and the recovery flag, and never the SMTP user, password or server text.
jest.mock('nodemailer', () => {
  const transport = { verify: jest.fn(async () => true), sendMail: jest.fn(), close: jest.fn() };
  return { createTransport: jest.fn(() => transport), transport };
});
const dns = require('dns').promises;
const nodemailer = require('nodemailer');

const SECRET_USER = 'smtp-user-secret@sender.example';
const SECRET_PASS = 'synthetic-smtp-password-value';
let output;
beforeEach(() => {
  Object.assign(process.env, { SMTP_HOST: 'smtp.hostinger.com', SMTP_PORT: '465', SMTP_SECURE: 'true', SMTP_USER: SECRET_USER, SMTP_PASS: SECRET_PASS,
    MAIL_FROM_EMAIL: SECRET_USER, MAIL_FROM_NAME: 'Rubrilo', ASSESSMENT_RECOVERY_ENABLED: 'false' });
  output = [];
  jest.spyOn(console, 'log').mockImplementation(line => output.push(String(line)));
  jest.spyOn(dns, 'resolveTxt').mockImplementation(async name => {
    if (name === 'sender.example') return [['v=spf1 include:_spf.mail.hostinger.com ~all']];
    if (name === '_dmarc.sender.example') return [['v=DMARC1; p=none']];
    if (name === 'hostingermail1._domainkey.sender.example') return [['v=DKIM1; k=rsa; p=MIIB']];
    throw Object.assign(new Error('nx'), { code: 'ENOTFOUND' });
  });
  jest.spyOn(dns, 'resolveMx').mockResolvedValue([{ priority: 5, exchange: 'mx1.hostinger.com' }]);
  jest.spyOn(dns, 'resolveCname').mockRejectedValue(Object.assign(new Error('nx'), { code: 'ENODATA' }));
  nodemailer.transport.sendMail.mockReset();
});
afterEach(() => jest.restoreAllMocks());
const run = async (...args) => { process.argv = ['node', 'diagnoseEmail.js', ...args]; await require('../scripts/diagnoseEmail').main(); return JSON.parse(output.join('\n')); };

test('accepted: prints the outcome, codes, messageId, timings, DNS and the recovery flag; no secrets or server text', async () => {
  nodemailer.transport.sendMail.mockResolvedValue({ accepted: ['me@mailbox.example'], rejected: [], response: '250 2.0.0 Ok: queued as SECRETTEXT', messageId: '<diag@sender.example>' });
  const report = await run('me@mailbox.example');
  expect(nodemailer.transport.sendMail).toHaveBeenCalledTimes(1);
  expect(report.send).toEqual(expect.objectContaining({ ok: true, recipientAccepted: true, acceptedCount: 1, rejectedCount: 0, smtpCode: 250,
    enhancedStatus: '2.0.0', messageId: '<diag@sender.example>' }));
  expect(report.send.sendMs).toEqual(expect.any(Number)); expect(report.connectAuthMs).toEqual(expect.any(Number));
  expect(report.dns).toEqual(expect.objectContaining({ senderDomain: 'sender.example', spfCount: 1, dmarc: ['v=DMARC1; p=none'], mx: ['5 mx1.hostinger.com'],
    dkimSelectorsFound: { hostingermail1: 'TXT present' } }));
  expect(report.assessmentRecoveryEnabled).toBe(false);
  expect(report.smtp).toEqual(expect.objectContaining({ host: 'smtp.hostinger.com', port: 465, secure: true }));
  const text = output.join('\n');
  for (const secret of [SECRET_PASS, SECRET_USER, 'SECRETTEXT']) expect(text).not.toContain(secret);
});

test('rejected recipient: ok false with the safe code and the SMTP code', async () => {
  nodemailer.transport.sendMail.mockResolvedValue({ accepted: [], rejected: ['me@mailbox.example'], response: '550 5.1.1 Mailbox unavailable' });
  const report = await run('me@mailbox.example');
  expect(report.send).toEqual(expect.objectContaining({ ok: false, code: 'PROVIDER_REJECTED', recipientAccepted: false, rejectedCount: 1, smtpCode: 550, enhancedStatus: '5.1.1' }));
  expect(output.join('\n')).not.toContain('Mailbox unavailable');
});

test('--dns-only sends nothing; a bad address prints usage only', async () => {
  const report = await run('me@mailbox.example', '--dns-only');
  expect(nodemailer.transport.sendMail).not.toHaveBeenCalled();
  expect(report.dns.spfCount).toBe(1);
  output = [];
  expect(await run('not-an-address')).toEqual(expect.objectContaining({ code: 'USAGE' }));
  expect(nodemailer.transport.sendMail).not.toHaveBeenCalled();
});
