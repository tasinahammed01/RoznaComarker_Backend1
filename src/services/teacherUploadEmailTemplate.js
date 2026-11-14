'use strict';
const { emailBrandHeaderHtml, emailPreheaderHtml } = require('./emailBrand.service');
// The email a student receives when the teacher uploaded their handwritten work and chose "Save and send" (or pressed Send):
// Rubrilo branding, the teacher's name, the assignment and a private link to the finished feedback. Every inserted value is
// escaped in the HTML and stripped of line breaks in the subject (no header injection). Pure: no I/O.

const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const oneLine = (value, max) => String(value == null ? '' : value).replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function formatDate(date) {
  try { return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(date); }
  catch { return ''; }
}

/**
 * @param {{ studentName: string, teacherName?: string, assignmentTitle: string, link: string, expiresAt?: Date|null, needsLogin?: boolean }} input
 * @returns {{ subject: string, text: string, html: string }}
 */
function buildTeacherUploadFeedbackEmail({ studentName, teacherName, assignmentTitle, link, expiresAt = null, needsLogin = false }) {
  const student = oneLine(studentName, 120) || 'there';
  const teacher = oneLine(teacherName, 120) || 'Your teacher';
  const assignment = oneLine(assignmentTitle, 200) || 'your assignment';
  const href = String(link || '');
  if (!/^https?:\/\//i.test(href)) throw Object.assign(new Error('Feedback link unavailable'), { code: 'TEMPLATE_FAILURE' });
  const until = expiresAt instanceof Date && !Number.isNaN(expiresAt.getTime()) ? formatDate(expiresAt) : '';
  const access = needsLogin
    ? 'Sign in to Rubrilo with this email address to see it.'
    : `This private link opens your feedback without an account${until ? ` until ${until}` : ''}.`;

  const subject = oneLine(`Your feedback is ready: ${assignment}`, 180);
  const text = [
    'Rubrilo',
    '',
    `Hi ${student},`,
    '',
    `${teacher} uploaded your handwritten work for "${assignment}" and your feedback is ready.`,
    access,
    '',
    href,
    '',
    needsLogin ? '' : 'Keep this link private: anyone with it can see your feedback. If it stops working, ask your teacher to send it again.',
    '',
    `Sent by Rubrilo on behalf of ${teacher}.`
  ].filter((line, i, all) => !(line === '' && all[i - 1] === '')).join('\n');

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Your feedback is ready</title><style>@media only screen and (max-width:480px){.email-outer{padding:12px 8px!important}.email-content{padding:24px 20px!important}.email-heading{font-size:28px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f2f6f8;color:#14264d;font-family:Arial,Helvetica,sans-serif;">
${emailPreheaderHtml(`${teacher} uploaded your work and your feedback is ready.`)}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f6f8"><tr><td class="email-outer" align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:640px;background-color:#ffffff;border-radius:16px;border-top:5px solid #008081;">
<tr><td class="email-content" style="padding:32px;">
${emailBrandHeaderHtml()}
<h1 class="email-heading" style="margin:28px 0 14px;font-size:34px;line-height:41px;letter-spacing:-0.6px;color:#14264d;">Your feedback is ready</h1>
<p style="margin:0 0 14px;font-size:16px;line-height:25px;color:#59657d;">Hi ${escapeHtml(student)},</p>
<p style="margin:0 0 22px;font-size:16px;line-height:25px;color:#59657d;"><strong style="color:#14264d;">${escapeHtml(teacher)}</strong> uploaded your handwritten work and your feedback is ready. ${escapeHtml(access)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6f8" style="background-color:#f3f6f8;border-radius:12px;table-layout:fixed;"><tr><td style="padding:20px;">
<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#59657d;">Assignment</p>
<p style="margin:0;font-size:17px;line-height:25px;font-weight:bold;color:#14264d;overflow-wrap:anywhere;word-wrap:break-word;">${escapeHtml(assignment)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td align="center" bgcolor="#008081" style="background-color:#008081;border-radius:12px;mso-padding-alt:16px 20px;">
<a href="${escapeHtml(href)}" style="display:block;padding:16px 20px;color:#ffffff;font-size:17px;line-height:24px;font-weight:bold;text-decoration:none;border-radius:12px;">View my feedback <span aria-hidden="true">&nbsp; &#8594;</span></a>
</td></tr></table>
<p style="margin:14px 0 0;font-size:13px;line-height:20px;color:#59657d;overflow-wrap:anywhere;word-wrap:break-word;">If the button does not work, copy this link into your browser:<br><a href="${escapeHtml(href)}" style="color:#008081;">${escapeHtml(href)}</a></p>
${needsLogin ? '' : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff8e7" style="margin-top:20px;background-color:#fff8e7;border-radius:12px;"><tr><td style="padding:18px 20px;">
<strong style="color:#a96700;font-size:14px;line-height:22px;">Keep this link private.</strong>
<p style="margin:3px 0 0;color:#59657d;font-size:13px;line-height:21px;">Anyone with it can see your feedback. If it stops working, ask your teacher to send it again.</p>
</td></tr></table>`}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #dce3eb;"><tr><td align="center" style="padding-top:18px;">
<p style="margin:0;font-size:12px;line-height:20px;color:#59657d;">Sent by Rubrilo on behalf of ${escapeHtml(teacher)}. Questions about your feedback? Ask your teacher.</p>
</td></tr></table>
</td></tr></table>
</td></tr></table></body></html>`;
  return { subject, text, html };
}

module.exports = { buildTeacherUploadFeedbackEmail, escapeHtml };
