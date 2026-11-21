'use strict';
const { emailBrandHeaderHtml, emailPreheaderHtml } = require('./emailBrand.service');
const { escapeHtml } = require('./teacherUploadEmailTemplate');
// Stage 10: the two emails a GUEST receives for a speaking assignment, with the same layout as the essay guest email (email.service.js
// guestEmailHtml, unchanged): the receipt right after the upload, and "your feedback is ready" once marking is complete. Rubrilo only. Every
// value is escaped in the HTML and kept on one line in the subject. Only the fields below are read: nothing from the recording (no transcript,
// audio, score or file name) can ever be inserted. Pure: no I/O.

const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const RECEIPT_LEAD = 'Your recording was received. It will be turned into text and marked, and your teacher can see it. Use your private link below to see your feedback when it is ready.';
const READY_LEAD = 'Your recording was marked and your feedback is ready. Use your private link below to see it without signing in.';
const PRIVATE = 'Anyone with this link can see your feedback, so do not share it. It expires; you can ask for a new link on the assignment page.';

/**
 * @param {{ assignmentTitle: string, returnUrl: string, resultReady?: boolean }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildGuestSpeakingEmail({ assignmentTitle, returnUrl, resultReady = false }) {
  const assignment = oneLine(assignmentTitle, 200) || 'your assignment';
  const href = String(returnUrl || '');
  if (!/^https?:\/\//i.test(href)) throw Object.assign(new Error('Return link unavailable'), { code: 'TEMPLATE_FAILURE' });
  const recovery = new URL('/recover', href).href;
  const heading = resultReady ? 'Your feedback is ready' : 'Recording received';
  const lead = resultReady ? READY_LEAD : RECEIPT_LEAD;
  const subject = oneLine(`${resultReady ? 'Your Rubrilo feedback is ready' : 'Your Rubrilo recording was received'}: ${assignment}`, 180);
  const text = ['Rubrilo', '', heading, '', lead, `Assignment: ${assignment}`, '', href, '', `Keep this link private. ${PRIVATE}`,
    `Lost this email later? Get a new link: ${recovery}`, '', 'Sent by Rubrilo.'].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title><style>@media only screen and (max-width:480px){.email-outer{padding:12px 8px!important}.email-content{padding:24px 20px!important}.email-heading{font-size:28px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f2f6f8;color:#14264d;font-family:Arial,Helvetica,sans-serif;">
${emailPreheaderHtml(resultReady ? 'Your feedback is ready. Open it with your private link.' : 'Your recording was received. Keep this email: it has your private link.')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f6f8"><tr><td class="email-outer" align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:640px;background-color:#ffffff;border-radius:16px;border-top:5px solid #008081;">
<tr><td class="email-content" style="padding:32px;">
${emailBrandHeaderHtml()}
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr><td bgcolor="#fff7df" style="padding:10px 16px;background-color:#fff7df;border-radius:24px;color:#a96700;font-size:13px;font-weight:bold;">Guest Submission</td></tr></table>
<h1 class="email-heading" style="margin:20px 0 14px;font-size:34px;line-height:41px;letter-spacing:-0.6px;color:#14264d;">${heading}</h1>
<p style="margin:0 0 22px;font-size:16px;line-height:25px;color:#59657d;">${escapeHtml(lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6f8" style="background-color:#f3f6f8;border-radius:12px;table-layout:fixed;"><tr><td style="padding:20px;">
<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#59657d;">Assignment</p>
<p style="margin:0;font-size:17px;line-height:25px;font-weight:bold;color:#14264d;overflow-wrap:anywhere;word-wrap:break-word;">${escapeHtml(assignment)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td align="center" bgcolor="#008081" style="background-color:#008081;border-radius:12px;mso-padding-alt:16px 20px;">
<a href="${escapeHtml(href)}" style="display:block;padding:16px 20px;color:#ffffff;font-size:17px;line-height:24px;font-weight:bold;text-decoration:none;border-radius:12px;">${resultReady ? 'View my feedback' : 'Open my private link'} <span aria-hidden="true">&nbsp; &#8594;</span></a>
</td></tr></table>
<p style="margin:16px 0 20px;text-align:center;font-size:14px;line-height:22px;color:#59657d;">Lost this email later? <a href="${escapeHtml(recovery)}" style="color:#008081;font-weight:bold;text-decoration:underline;">Get a new link</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff8e7" style="background-color:#fff8e7;border-radius:12px;"><tr><td style="padding:18px 20px;">
<strong style="color:#a96700;font-size:14px;line-height:22px;">Keep this link private.</strong>
<p style="margin:3px 0 0;color:#59657d;font-size:13px;line-height:21px;">${escapeHtml(PRIVATE)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #dce3eb;"><tr><td align="center" style="padding-top:18px;">
<p style="margin:0;font-size:12px;line-height:20px;color:#59657d;">Sent by Rubrilo. Questions about your feedback? Ask your teacher.</p>
</td></tr></table>
</td></tr></table>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { buildGuestSpeakingEmail, RECEIPT_LEAD, READY_LEAD };
