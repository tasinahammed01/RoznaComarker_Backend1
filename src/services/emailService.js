const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
require('dotenv').config();

class EmailService {
  constructor() {
    this.transporter = null;
    this.initializeTransporter();
  }

  initializeTransporter() {
    try {
      if (!process.env.SENDGRID_API_KEY) {
        logger.warn('SendGrid API key not found in environment variables');
        return;
      }

      this.transporter = nodemailer.createTransport({
        host: 'smtp.sendgrid.net',
        port: 587,
        secure: false,
        auth: {
          user: 'apikey',
          pass: process.env.SENDGRID_API_KEY
        },
        tls: {
          rejectUnauthorized: false
        }
      });

      this.transporter.verify((error, success) => {
        if (error) {
          logger.error(`Email transporter verification failed: ${error.message}`);
        } else {
          logger.info('Email transporter is ready to send messages');
        }
      });
    } catch (error) {
      logger.error(`Failed to initialize email transporter: ${error.message}`);
    }
  }

  async sendEmail({ to, subject, html, from = null }) {
    try {
      if (!this.transporter) {
        throw new Error('Email transporter not initialized');
      }

      if (!to || !subject || !html) {
        throw new Error('Missing required parameters: to, subject, html');
      }

      const mailOptions = {
        from: from || process.env.EMAIL_FROM || 'noreply@rozna.com',
        to,
        subject,
        html
      };

      const info = await this.transporter.sendMail(mailOptions);
      
      return {
        success: true,
        messageId: info.messageId,
        response: info.response
      };
    } catch (error) {
      logger.error(`Failed to send email: ${error.message}`);
      return {
        success: false,
        error: error.message,
        details: error
      };
    }
  }

  async sendOTPEmail(to, otp) {
    try {
      if (!to || !otp) {
        throw new Error('Email and OTP are required');
      }

      const subject = 'Your OTP Verification Code';
      const html = this.getOTPTemplate(otp);

      return await this.sendEmail({ to, subject, html });
    } catch (error) {
      logger.error(`Failed to send OTP email: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendVerificationEmail(to, verificationLink) {
    try {
      if (!to || !verificationLink) {
        throw new Error('Email and verification link are required');
      }

      const subject = 'Verify Your Email Address';
      const html = this.getVerificationTemplate(verificationLink);

      return await this.sendEmail({ to, subject, html });
    } catch (error) {
      logger.error(`Failed to send verification email: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async sendResetPasswordEmail(to, resetLink) {
    try {
      if (!to || !resetLink) {
        throw new Error('Email and reset link are required');
      }

      const subject = 'Reset Your Password';
      const html = this.getResetPasswordTemplate(resetLink);

      return await this.sendEmail({ to, subject, html });
    } catch (error) {
      logger.error(`Failed to send reset password email: ${error.message}`);
      return {
        success: false,
        error: error.message
      };
    }
  }

  getOTPTemplate(otp) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>OTP Verification</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #f4f7fa;
            margin: 0;
            padding: 20px;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
          }
          .header {
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: 600;
          }
          .content {
            padding: 40px 30px;
            text-align: center;
          }
          .otp-container {
            background-color: #f8f9ff;
            border: 2px dashed #667eea;
            border-radius: 8px;
            padding: 20px;
            margin: 30px 0;
            display: inline-block;
          }
          .otp-code {
            font-size: 36px;
            font-weight: bold;
            color: #667eea;
            letter-spacing: 8px;
            margin: 0;
            text-decoration: none;
          }
          .footer {
            background-color: #f8f9fa;
            padding: 20px 30px;
            text-align: center;
            color: #6c757d;
            font-size: 14px;
          }
          .warning {
            color: #dc3545;
            font-size: 14px;
            margin-top: 20px;
            padding: 15px;
            background-color: #fff5f5;
            border-radius: 6px;
            border-left: 4px solid #dc3545;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>OTP Verification</h1>
          </div>
          <div class="content">
            <h2>Your Verification Code</h2>
            <p>Use the following One-Time Password to verify your identity:</p>
            
            <div class="otp-container">
              <p class="otp-code">${otp}</p>
            </div>
            
            <p>This code will expire in <strong>10 minutes</strong>.</p>
            
            <div class="warning">
              <strong>Security Notice:</strong> Never share this code with anyone. Our team will never ask for your OTP.
            </div>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Rozna. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getVerificationTemplate(verificationLink) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Email Verification</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #f4f7fa;
            margin: 0;
            padding: 20px;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
          }
          .header {
            background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
            color: white;
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: 600;
          }
          .content {
            padding: 40px 30px;
            text-align: center;
          }
          .btn {
            display: inline-block;
            padding: 15px 40px;
            background: linear-gradient(135deg, #28a745 0%, #20c997 100%);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 16px;
            margin: 20px 0;
            transition: transform 0.2s;
          }
          .btn:hover {
            transform: translateY(-2px);
          }
          .footer {
            background-color: #f8f9fa;
            padding: 20px 30px;
            text-align: center;
            color: #6c757d;
            font-size: 14px;
          }
          .alternative {
            margin-top: 30px;
            padding: 20px;
            background-color: #f8f9ff;
            border-radius: 6px;
            border-left: 4px solid #28a745;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Verify Your Email</h1>
          </div>
          <div class="content">
            <h2>Welcome to Rozna!</h2>
            <p>Thank you for signing up. Please click the button below to verify your email address:</p>
            
            <a href="${verificationLink}" class="btn">Verify Email Address</a>
            
            <div class="alternative">
              <p><strong>Can't click the button?</strong></p>
              <p>Copy and paste this link into your browser:</p>
              <p style="word-break: break-all; color: #28a745; font-family: monospace;">${verificationLink}</p>
            </div>
            
            <p>This link will expire in <strong>24 hours</strong>.</p>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Rozna. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }

  getResetPasswordTemplate(resetLink) {
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Reset Password</title>
        <style>
          body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background-color: #f4f7fa;
            margin: 0;
            padding: 20px;
            color: #333;
          }
          .container {
            max-width: 600px;
            margin: 0 auto;
            background-color: #ffffff;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
            overflow: hidden;
          }
          .header {
            background: linear-gradient(135deg, #dc3545 0%, #fd7e14 100%);
            color: white;
            padding: 40px 30px;
            text-align: center;
          }
          .header h1 {
            margin: 0;
            font-size: 32px;
            font-weight: 600;
          }
          .content {
            padding: 40px 30px;
            text-align: center;
          }
          .btn {
            display: inline-block;
            padding: 15px 40px;
            background: linear-gradient(135deg, #dc3545 0%, #fd7e14 100%);
            color: white;
            text-decoration: none;
            border-radius: 6px;
            font-weight: 600;
            font-size: 16px;
            margin: 20px 0;
            transition: transform 0.2s;
          }
          .btn:hover {
            transform: translateY(-2px);
          }
          .footer {
            background-color: #f8f9fa;
            padding: 20px 30px;
            text-align: center;
            color: #6c757d;
            font-size: 14px;
          }
          .alternative {
            margin-top: 30px;
            padding: 20px;
            background-color: #fff5f5;
            border-radius: 6px;
            border-left: 4px solid #dc3545;
          }
          .warning {
            color: #dc3545;
            font-size: 14px;
            margin-top: 20px;
            padding: 15px;
            background-color: #fff5f5;
            border-radius: 6px;
            border-left: 4px solid #dc3545;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>Reset Your Password</h1>
          </div>
          <div class="content">
            <h2>Password Reset Request</h2>
            <p>We received a request to reset your password. Click the button below to proceed:</p>
            
            <a href="${resetLink}" class="btn">Reset Password</a>
            
            <div class="alternative">
              <p><strong>Can't click the button?</strong></p>
              <p>Copy and paste this link into your browser:</p>
              <p style="word-break: break-all; color: #dc3545; font-family: monospace;">${resetLink}</p>
            </div>
            
            <p>This link will expire in <strong>1 hour</strong>.</p>
            
            <div class="warning">
              <strong>Security Notice:</strong> If you didn't request this password reset, please ignore this email. Your password will remain unchanged.
            </div>
          </div>
          <div class="footer">
            <p>&copy; ${new Date().getFullYear()} Rozna. All rights reserved.</p>
            <p>This is an automated message, please do not reply to this email.</p>
          </div>
        </div>
      </body>
      </html>
    `;
  }
}

module.exports = new EmailService();
