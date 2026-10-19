const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const { emailReadiness, safeEmailFailure, smtpTransportOptions } = require('./emailReadiness.service');
const escapeHtml = value => String(value == null ? '' : value).replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

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
  async sendGuestSubmissionEmail({ to, assignmentTitle, returnUrl }) {
    try {
      const readiness = emailReadiness();
      if (!readiness.ready) throw Object.assign(new Error('Email configuration unavailable'), { code: readiness.code });
      let message;
      try { message = {
        from: `"${process.env.MAIL_FROM_NAME || 'CoMarker'}" <${process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER}>`,
        to,
        subject: `Your Co-Marker assignment submission: ${String(assignmentTitle).replace(/[\r\n]/g, ' ').slice(0, 150)}`,
        text: `Rozna Co-Marker\n\nYour submission for ${assignmentTitle} was received.\nUse this private link to access your feedback without logging in:\n${returnUrl}\nKeep this link private. Do not share it. It expires; request a new link from the assignment page if needed.`,
        html: `<h2>Rozna Co-Marker</h2><p>Your submission for <strong>${escapeHtml(assignmentTitle)}</strong> was received.</p><p>Use this private link to access your feedback without logging in:</p><p><a href="${escapeHtml(returnUrl)}">Return to your results</a></p><p>Keep this link private. Do not share it. It expires; request a new link from the assignment page if needed.</p>`
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
