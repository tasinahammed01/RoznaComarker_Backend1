'use strict';
// Email delivery diagnostic. Sends ONE test email through the application's real SMTP settings (the same transport options as
// src/services/email.service.js) to the address you pass, and checks the sender domain's public DNS. Run it on the server, from
// the backend folder, against your OWN mailbox:
//
//   node scripts/diagnoseEmail.js you@your-mailbox.example
//   node scripts/diagnoseEmail.js you@your-mailbox.example --dns-only     (DNS checks only, no email sent)
//
// It prints ONLY: configuration readiness (codes and field names), the SMTP host/port/TLS mode, timings, whether the server accepted
// the recipient, the SMTP reply code and enhanced status, the messageId, public DNS facts for the sender domain, and whether the
// background marking recovery is enabled. It never prints the SMTP user or password, the server's reply text or any other secret.
// Configuration is read like the application reads it: process environment first, then backend/.env.
const fs = require('fs');
const path = require('path');
const dns = require('dns').promises;
const dotenv = require('dotenv');
const { emailReadiness, safeEmailFailure, smtpTransportOptions } = require('../src/services/emailReadiness.service');

// Selectors used by common providers (Hostinger, Resend, Google, Microsoft, generic). A miss here does not prove DKIM is absent:
// the provider may use another selector name (find it in a received message's DKIM-Signature header, "s=").
const DKIM_SELECTORS = ['default', 'mail', 'dkim', 'hostingermail1', 'hostingermail2', 'hostingermail3', 'resend', 's1', 's2', 'selector1', 'selector2', 'google', 'k1', 'smtp'];
const ADDRESS = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

function loadEnv() {
  const file = path.resolve(__dirname, '..', '.env');
  const local = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
  return { ...local, ...process.env };
}
const ms = start => Number(process.hrtime.bigint() - start) / 1e6;
const txt = async name => { try { return (await dns.resolveTxt(name)).map(parts => parts.join('')); } catch (error) { return { error: error.code || 'DNS_ERROR' }; } };

/** Public DNS facts for the sender domain: SPF, DMARC, MX and which guessed DKIM selectors exist. Read-only. */
async function dnsReport(domain) {
  const root = await txt(domain);
  const spf = Array.isArray(root) ? root.filter(r => /^v=spf1\b/i.test(r)) : root;
  const dmarcRecords = await txt(`_dmarc.${domain}`);
  const dmarc = Array.isArray(dmarcRecords) ? dmarcRecords.filter(r => /^v=DMARC1\b/i.test(r)) : dmarcRecords;
  let mx;
  try { mx = (await dns.resolveMx(domain)).sort((a, b) => a.priority - b.priority).map(r => `${r.priority} ${r.exchange}`); } catch (error) { mx = { error: error.code || 'DNS_ERROR' }; }
  const dkim = {};
  for (const selector of DKIM_SELECTORS) {
    const records = await txt(`${selector}._domainkey.${domain}`);
    let cname = null;
    try { cname = (await dns.resolveCname(`${selector}._domainkey.${domain}`))[0] || null; } catch { /* no CNAME */ }
    const found = Array.isArray(records) && records.some(r => /v=DKIM1|k=rsa|p=/i.test(r));
    if (found || cname) dkim[selector] = cname ? `CNAME -> ${cname}` : 'TXT present';
  }
  return { senderDomain: domain, spf, spfCount: Array.isArray(spf) ? spf.length : 0, dmarc, mx, dkimSelectorsFound: dkim,
    dkimNote: Object.keys(dkim).length ? undefined : 'No guessed selector found; check the s= value of a received message\'s DKIM-Signature header.' };
}

async function main() {
  const args = process.argv.slice(2);
  const to = String(args.find(a => !a.startsWith('--')) || '').trim();
  const dnsOnly = args.includes('--dns-only');
  if (!ADDRESS.test(to)) { console.log(JSON.stringify({ ok: false, code: 'USAGE', usage: 'node scripts/diagnoseEmail.js you@your-mailbox.example [--dns-only]' })); process.exitCode = 2; return; }
  const env = loadEnv();
  const readiness = emailReadiness(env);
  const fromEmail = String(env.MAIL_FROM_EMAIL || env.SMTP_USER || '');
  const report = {
    readiness: { ready: readiness.ready, code: readiness.code, missing: readiness.missing },
    senderName: String(env.MAIL_FROM_NAME || 'Rubrilo'),           // the display name recipients see (MAIL_FROM_NAME; unset = "Rubrilo")
    // Background marking recovery (env ASSESSMENT_RECOVERY_ENABLED; unset = enabled). The running server logs the same value at start:
    // look for {"event":"background_workers","assessmentRecoveryEnabled":...} in the PM2 log.
    assessmentRecoveryEnabled: String(env.ASSESSMENT_RECOVERY_ENABLED || 'true').toLowerCase() !== 'false',
  };
  const domain = fromEmail.includes('@') ? fromEmail.split('@').pop().toLowerCase() : null;
  report.dns = domain ? await dnsReport(domain) : { error: 'NO_SENDER_DOMAIN' };
  if (dnsOnly || !readiness.ready) { console.log(JSON.stringify(report, null, 2)); if (!readiness.ready) process.exitCode = 1; return; }

  const options = smtpTransportOptions(env);
  report.smtp = { host: options.host, port: options.port, secure: options.secure, requireTLS: Boolean(options.requireTLS), pooled: false,
    timeoutsMs: { connection: options.connectionTimeout, greeting: options.greetingTimeout, socket: options.socketTimeout } };
  const transport = require('nodemailer').createTransport(options);
  try {
    let start = process.hrtime.bigint();
    try { await transport.verify(); report.connectAuthMs = Math.round(ms(start)); }
    catch (error) { report.connectAuthMs = Math.round(ms(start)); report.verify = { ok: false, code: safeEmailFailure(error), smtpCode: Number(error?.responseCode) || null }; }
    start = process.hrtime.bigint();
    const sentAt = new Date();
    let info;
    try {
      info = await transport.sendMail({ from: `"${report.senderName}" <${fromEmail}>`, to,
        subject: 'Rubrilo email diagnostic', text: `This is a one-off diagnostic email from Rubrilo, sent at ${sentAt.toISOString()}. You can delete it.` });
    } catch (error) {
      report.send = { ok: false, code: safeEmailFailure(error), smtpCode: Number(error?.responseCode) || null, command: error?.command || null, sendMs: Math.round(ms(start)) };
      console.log(JSON.stringify(report, null, 2)); process.exitCode = 1; return;
    }
    const outcome = require('../src/services/email.service').deliveryOutcome(info, to);
    report.send = { ok: outcome.delivered, code: outcome.code, recipientAccepted: outcome.delivered || (outcome.details.acceptedCount > 0 && outcome.code !== 'PROVIDER_REJECTED'),
      acceptedCount: outcome.details.acceptedCount, rejectedCount: outcome.details.rejectedCount, smtpCode: outcome.details.responseCode,
      enhancedStatus: outcome.details.enhancedStatus, messageId: outcome.details.messageId, sentAt: sentAt.toISOString(), sendMs: Math.round(ms(start)) };
    console.log(JSON.stringify(report, null, 2));
    if (!outcome.delivered) process.exitCode = 1;
  } finally { try { transport.close(); } catch { /* nothing to report */ } }
}

if (require.main === module) main().catch(error => { console.log(JSON.stringify({ ok: false, code: safeEmailFailure(error) })); process.exitCode = 1; });
module.exports = { main, dnsReport, DKIM_SELECTORS };
