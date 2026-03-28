const nodemailer = require('nodemailer');

// Create transporter using environment variables
let transporter = null;

function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransporter({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

async function sendInvitationEmail({ to, className, classCode, joinUrl, teacherName }) {
  try {
    const transporter = getTransporter();
    
    const mailOptions = {
      from: `"${teacherName || 'Classroom'}" <${process.env.SMTP_USER}>`,
      to: Array.isArray(to) ? to.join(', ') : to,
      subject: `You're invited to join ${className}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background-color: #f8f9fa; padding: 30px; border-radius: 10px; text-align: center;">
            <h1 style="color: #2c3e50; margin-bottom: 20px;">🎓 Class Invitation</h1>
            <p style="font-size: 18px; color: #34495e; margin-bottom: 25px;">
              You've been invited to join <strong>${className}</strong>
            </p>
            
            <div style="background-color: white; padding: 25px; border-radius: 8px; margin-bottom: 25px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h3 style="color: #2c3e50; margin-bottom: 15px;">How to Join:</h3>
              
              <div style="text-align: left; margin-bottom: 20px;">
                <p style="margin-bottom: 10px;"><strong>Option 1: Use Class Code</strong></p>
                <ol style="color: #666; line-height: 1.6;">
                  <li>Go to your classroom dashboard</li>
                  <li>Click "Join Class" or "Add Class"</li>
                  <li>Enter this code: <span style="background-color: #e3f2fd; padding: 8px 12px; border-radius: 4px; font-family: monospace; font-size: 16px; font-weight: bold;">${classCode}</span></li>
                </ol>
              </div>
              
              <div style="text-align: left;">
                <p style="margin-bottom: 10px;"><strong>Option 2: Direct Link</strong></p>
                <p style="margin-bottom: 15px;">Click the button below to join directly:</p>
                <a href="${joinUrl}" 
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
    console.log('Email sent successfully:', result.messageId);
    return { success: true, messageId: result.messageId };
    
  } catch (error) {
    console.error('Failed to send email:', error);
    return { success: false, error: error.message };
  }
}

// Test email configuration
async function testEmailConfig() {
  try {
    const transporter = getTransporter();
    await transporter.verify();
    console.log('Email service is ready');
    return { success: true };
  } catch (error) {
    console.error('Email service configuration error:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  sendInvitationEmail,
  testEmailConfig
};
