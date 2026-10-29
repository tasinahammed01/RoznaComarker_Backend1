const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { emailReadiness, safeEmailFailure, smtpTransportOptions } = require('./emailReadiness.service');
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

// Presentation only: the CTA retains the caller's canonical capability URL.
function guestEmailHtml({ assignmentTitle, returnUrl, resultReady }) {
  const recovery = new URL(returnUrl);
  recovery.hash = '';
  const heading = resultReady ? 'Your Feedback Is Ready' : 'Assignment Submitted Successfully';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title><style>@media only screen and (max-width:480px){.email-outer{padding:12px 8px!important}.email-content{padding:24px 20px!important}.email-heading{font-size:28px!important;line-height:34px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f2f6f8;color:#14264d;font-family:Arial,Helvetica,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f2f6f8"><tr><td class="email-outer" align="center" style="padding:32px 16px;">
<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#ffffff" style="max-width:640px;background-color:#ffffff;border-radius:16px;border-top:5px solid #008081;">
<tr><td class="email-content" style="padding:32px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td width="46" height="46" align="center" bgcolor="#14264d" style="background-color:#14264d;color:#ffffff;border-radius:12px;font-size:21px;font-weight:bold;">RH</td>
<td style="padding-left:12px;"><strong style="font-size:24px;color:#14264d;">RoznaHub</strong><br><span style="font-size:14px;color:#59657d;">Co-Marker</span></td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr><td bgcolor="#fff7df" style="padding:10px 16px;background-color:#fff7df;border-radius:24px;color:#a96700;font-size:13px;font-weight:bold;">Guest Submission</td></tr></table>
<h1 class="email-heading" style="margin:20px 0 14px;font-size:34px;line-height:41px;letter-spacing:-0.6px;color:#14264d;">${heading}</h1>
<p style="margin:0 0 22px;font-size:16px;line-height:25px;color:#59657d;">${resultReady ? 'Your feedback is ready.' : 'Your work has been received and submitted successfully through RoznaHub Co-Marker.'} Use your private link below to view your feedback and results ${resultReady ? 'without logging in' : 'later'}.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#f3f6f8" style="background-color:#f3f6f8;border-radius:12px;table-layout:fixed;"><tr><td style="padding:20px;">
<p style="margin:0 0 6px;font-size:13px;line-height:20px;color:#59657d;">Assignment</p>
<p style="margin:0;font-size:17px;line-height:25px;font-weight:bold;color:#14264d;overflow-wrap:anywhere;word-wrap:break-word;">${escapeHtml(assignmentTitle)}</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;"><tr><td align="center" bgcolor="#008081" style="background-color:#008081;border-radius:12px;mso-padding-alt:16px 20px;">
<a href="${escapeHtml(returnUrl)}" style="display:block;padding:16px 20px;color:#ffffff;font-size:17px;line-height:24px;font-weight:bold;text-decoration:none;border-radius:12px;">Open My Return Link <span aria-hidden="true">&nbsp; &#8594;</span></a>
</td></tr></table>
<p style="margin:16px 0 20px;text-align:center;font-size:14px;line-height:22px;"><a href="${escapeHtml(recovery.href)}" style="color:#008081;font-weight:bold;text-decoration:underline;">Recover Link</a></p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#fff8e7" style="background-color:#fff8e7;border-radius:12px;"><tr><td style="padding:18px 20px;">
<strong style="color:#a96700;font-size:14px;line-height:22px;">Keep this link private.</strong>
<p style="margin:3px 0 0;color:#59657d;font-size:13px;line-height:21px;">Anyone with it can view your feedback. Do not share it. It expires; request a new link from the assignment page if needed.</p>
</td></tr></table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;border-top:1px solid #dce3eb;"><tr><td align="center" style="padding-top:18px;">
<p style="margin:0 0 8px;font-size:12px;line-height:20px;color:#59657d;">Need help? <a href="mailto:support@roznahub.com" style="color:#008081;font-weight:bold;text-decoration:none;">Contact support &#8594;</a></p>
<p style="margin:0;font-size:12px;line-height:20px;color:#59657d;">&copy; ${new Date().getFullYear()} RoznaHub. All rights reserved.</p>
</td></tr></table>
</td></tr></table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr></table></body></html>`;
}

// Create transporter using environment variables
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport(smtpTransportOptions());
  }
  return transporter;
}

async function sendInvitationEmail({ to, className, classCode, joinUrl, teacherName }) {
  try {
    const transporter = getTransporter();
    const safeName = escapeHtml(className);
    const safeCode = escapeHtml(classCode);
    const safeUrl = escapeHtml(joinUrl);
    
    const mailOptions = {
      from: `"${process.env.MAIL_FROM_NAME || 'CoMarker'}" <${process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: `You're invited to join ${String(className).replace(/[\r\n]/g, ' ')}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; text-align: center;">
            <h1 style="color: #2c3e50; margin-bottom: 20px;">🎓 Class Invitation</h1>
            <p style="font-size: 18px; color: #34495e; margin-bottom: 25px;">
              You've been invited to join <strong>${safeName}</strong>
            </p>
            
            <div style="background-color: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h3 style="color: #2c3e50; margin-bottom: 15px;">How to Join:</h3>
              
              <div style="text-align: left; margin-bottom: 20px;">
                <p style="margin-bottom: 10px;"><strong>Option 1: Use Class Code</strong></p>
                <ol style="color: #666; line-height: 1.6;">
                  <li>Go to your classroom dashboard</li>
                  <li>Click "Join Class" or "Add Class"</li>
                  <li>Enter this code: <span style="background-color: #e3f2fd; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 16px; font-weight: bold;">${safeCode}</span></li>
                </ol>
              </div>
              
              <div style="text-align: left;">
                <p style="margin-bottom: 10px;"><strong>Option 2: Direct Link</strong></p>
                <p style="margin-bottom: 15px;">Click the button below to join directly:</p>
                <a href="${safeUrl}"
                   style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; display: inline-block; font-weight: bold;">
                  Join Class Now
                </a>
              </div>
            </div>
            
            <div style="color: #6c757d; font-size: 14px; margin-top: 20px;">
              <p>This invitation will expire in 30 days.</p>
              <p>If you have trouble joining, contact your teacher.</p>
            </div>
          </div>
        </div>
      `,
    };

    const result = await transporter.sendMail(mailOptions);
    logger.info({ event: 'class_invitation_email_sent', provider: 'smtp' });
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    const code = safeEmailFailure(error);
    logger.error({ event: 'class_invitation_email_failed', code });
    return { success: false, error: code };
  }
}

// Test email configuration
async function testEmailConfig() {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    logger.info('Email service is ready');
    return { success: true };
  } catch (error) {
    const code = safeEmailFailure(error);
    logger.error({ event: 'email_configuration_failed', code });
    return { success: false, error: code };
  }
}

module.exports = {
  async sendTeacherSubmissionEmail({ to, assignmentTitle, studentName }) {
    try {
      const readiness = emailReadiness();
      if (!readiness.ready) return { success: false, code: readiness.code };
      const result = await getTransporter().sendMail({
        from: `"${process.env.MAIL_FROM_NAME || 'CoMarker'}" <${process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER}>`,
        to, subject: 'Co-Marker: assignment submitted',
        text: `${studentName} (Guest) submitted ${assignmentTitle}. Open the assignment submissions in Co-Marker to review it.`,
        html: `<p>${escapeHtml(studentName)} (Guest) submitted <strong>${escapeHtml(assignmentTitle)}</strong>.</p><p>Open the assignment submissions in Co-Marker to review it.</p>`
      });
      if (result?.rejected?.length && !result?.accepted?.length) return { success: false, code: 'PROVIDER_REJECTED' };
      return { success: true };
    } catch (error) {
      logger.warn({ event: 'teacher_submission_email_failed', code: safeEmailFailure(error) });
      return { success: false };
    }
  },
  async sendGuestSubmissionEmail({ to, assignmentTitle, returnUrl, resultReady = false }) {
    try {
      const readiness = emailReadiness();
      if (!readiness.ready) throw Object.assign(new Error('Email configuration unavailable'), { code: readiness.code });
      const status = resultReady ? 'feedback is ready' : 'submission was received';
      let message;
      try { message = {
        from: `"${process.env.MAIL_FROM_NAME || 'CoMarker'}" <${process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `Your Co-Marker ${resultReady ? 'feedback is ready' : 'assignment submission'}: ${String(assignmentTitle).replace(/[\r\n]/g, ' ').slice(0, 150)}`,
        text: `Rozna Co-Marker\n\nYour ${status} for ${assignmentTitle}.\nUse this private link to access your feedback without logging in:\n${returnUrl}\nKeep this link private. Do not share it. It expires; request a new link from the assignment page if needed.`,
        html: guestEmailHtml({ assignmentTitle, returnUrl, resultReady })
      }; } catch { throw Object.assign(new Error('Email template unavailable'), { code: 'TEMPLATE_FAILURE' }); }
      const result = await getTransporter().sendMail(message);
      if (result?.rejected?.length && !result?.accepted?.length) {
        throw Object.assign(new Error('Email rejected'), { code: 'PROVIDER_REJECTED' });
      }
      logger.info({ event: 'guest_confirmation_email_sent', provider: 'smtp' });
      return { success: true };
    } catch (error) {
      const code = safeEmailFailure(error);
      logger.warn({ event: 'guest_confirmation_email_failed', code });
      return { success: false, code };
    }
  },
  sendInvitationEmail,
  testEmailConfig,
  emailReadiness
};
