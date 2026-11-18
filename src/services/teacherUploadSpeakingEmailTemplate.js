'use strict';
const { emailBrandHeaderHtml, emailPreheaderHtml } = require('./emailBrand.service');
const { escapeHtml } = require('./teacherUploadEmailTemplate');
// Stage 9: the email a student receives when the teacher uploaded a RECORDING for them, chose "Save and send" (or pressed Send), and marking
// is complete. The same layout, branding and safety as the essay email (teacherUploadEmailTemplate.js, unchanged): Rubrilo only, every value
// escaped in the HTML and kept on one line in the subject. Only the fields below are read: nothing from the recording (no transcript, audio,
// score or file name) can ever be inserted. Members only (they sign in); guest speaking results come with stage 10. Pure: no I/O.

const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const LEAD = 'Your teacher uploaded a recording for this assignment. It was marked like your own recording, and your feedback is ready.';
const ACCESS = 'Sign in to Rubrilo with this email address to see it.';

/**
 * @param {{ studentName: string, teacherName?: string, assignmentTitle: string, link: string }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildTeacherUploadSpeakingFeedbackEmail({ studentName, teacherName, assignmentTitle, link }) {
  const student = oneLine(studentName, 120) || 'there';
  const teacher = oneLine(teacherName, 120) || 'Your teacher';
  const assignment = oneLine(assignmentTitle, 200) || 'your assignment';
  const href = String(link || '');
  if (!/^https?:\/\//i.test(href)) throw Object.assign(new Error('Feedback link unavailable'), { code: 'TEMPLATE_FAILURE' });

  const subject = oneLine(`Your feedback is ready: ${assignment}`, 180);
  const text = ['Rubrilo', '', `Hi ${student},`, '', LEAD, `Assignment: ${assignment}`, ACCESS, '', href, '', `Sent by Rubrilo on behalf of ${teacher}.`].join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your feedback is ready</title><style>@media only screen and (max-width:480px){.email-outer{padding:12px 8px!important}.email-content{padding:24px 20px!important}.email-heading{font-size:28px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f2f6f8;color:#14264d;font-family:Arial,Helvetica,sans-serif;">
${emailPreheaderHtml('Your teacher uploaded a recording for you and your feedback is ready.')}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f6f8"><tr><td class="email-outer" align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:640px;background-color:#ffffff;border-radius:16px;border-top:5px solid #008081;">
<tr><td class="email-content" style="padding:32px;">
${emailBrandHeaderHtml()}
<h1 class="email-heading" style="margin:28px 0 14px;font-size:34px;line-height:41px;letter-spacing:-0.6px;color:#14264d;">Your feedback is ready</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:25px;color:#59657d;">Hi ${escapeHtml(student)},</p>
<p style="margin:0 0 22px;font-size:16px;line-height:25px;color:#59657d;">${escapeHtml(LEAD)} ${escapeHtml(ACCESS)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6f8" style="background-color:#f3f6f8;border-radius:12px;table-layout:fixed;"><tr><td style="padding:20px;">
<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#59657d;">Assignment</p>
<p style="margin:0;font-size:17px;line-height:25px;font-weight:bold;color:#14264d;overflow-wrap:anywhere;word-wrap:break-word;">${escapeHtml(assignment)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td align="center" bgcolor="#008081" style="background-color:#008081;border-radius:12px;mso-padding-alt:16px 20px;">
<a href="${escapeHtml(href)}" style="display:block;padding:16px 20px;color:#ffffff;font-size:17px;line-height:24px;font-weight:bold;text-decoration:none;border-radius:12px;">View my feedback <span aria-hidden="true">&nbsp; &#8594;</span></a>
</td></tr></table>
<p style="margin:14px 0 0;font-size:13px;line-height:20px;color:#59657d;overflow-wrap:anywhere;word-wrap:break-word;">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(href)}" style="color:#008081;">${escapeHtml(href)}</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #dce3eb;"><tr><td align="center" style="padding-top:18px;">
<p style="margin:0;font-size:12px;line-height:20px;color:#59657d;">Sent by Rubrilo on behalf of ${escapeHtml(teacher)}. Questions about your feedback? Ask your teacher.</p>
</td></tr></table>
</td></tr></table>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { buildTeacherUploadSpeakingFeedbackEmail, SPEAKING_EMAIL_LEAD: LEAD };
