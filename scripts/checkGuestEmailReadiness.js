'use strict';
// Read configuration without starting the application, connecting to MongoDB or sending mail.
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { emailReadiness, safeEmailFailure, smtpTransportOptions } = require('../src/services/emailReadiness.service');
async function checkEmailReadiness({ env, verify = false, createTransport = require('nodemailer').createTransport, timeoutMs = 15000 }) {
  const result = { ...emailReadiness(env),
    configured: Object.fromEntries(['SMTP_HOST', 'SMTP_PORT', 'SMTP_SECURE', 'SMTP_USER', 'SMTP_PASS', 'MAIL_FROM_EMAIL']
      .map(key => [key, Boolean(String(env[key] || '').trim())])), verifyRequested: verify, transportVerified: false };
  if (verify && result.ready) {
    let transport; let timer;
    try {
      transport = createTransport(smtpTransportOptions(env));
      // Bound the whole operation too, including DNS and providers that stall between stages.
      await Promise.race([transport.verify(), new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('SMTP verification timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
      })]);
      result.transportVerified = true;
    }
    catch (error) { result.code = safeEmailFailure(error); result.ready = false; }
    finally { clearTimeout(timer); try { transport?.close(); } catch { /* No provider data in output. */ } }
  }
  return result;
}
async function main() {
  const file = path.resolve(__dirname, '..', '.env');
  const local = fs.existsSync(file) ? dotenv.parse(fs.readFileSync(file)) : {};
  // Match dotenv's default: inherited process variables take precedence over the file.
  const result = { envFilePresent: fs.existsSync(file), ...await checkEmailReadiness({
    env: { ...local, ...process.env }, verify: process.argv.includes('--verify') }) };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ready) process.exitCode = 1;
}
if (require.main === module) main().catch(() => {
  console.log(JSON.stringify({ ready: false, code: 'OTHER_SAFE_PROVIDER_FAILURE' })); process.exitCode = 1;
});
module.exports = { checkEmailReadiness };
