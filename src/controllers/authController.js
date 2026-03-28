const { body, validationResult } = require('express-validator');
const emailService = require('../services/emailService');

class AuthController {
  async sendOTP(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      const otp = this.generateOTP();
      const result = await emailService.sendOTPEmail(email, otp);

      if (result.success) {
        res.status(200).json({
          success: true,
          message: 'OTP sent successfully',
          messageId: result.messageId,
          otp: otp // Remove this in production, only for testing
        });
      } else {
        res.status(500).json({
          success: false,
          message: 'Failed to send OTP',
          error: result.error
        });
      }
    } catch (error) {
      console.error('Error in sendOTP controller:', error.message);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  }

  async verifyEmail(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=${this.generateToken()}`;
      const result = await emailService.sendVerificationEmail(email, verificationLink);

      if (result.success) {
        res.status(200).json({
          success: true,
          message: 'Verification email sent successfully',
          messageId: result.messageId
        });
      } else {
        res.status(500).json({
          success: false,
          message: 'Failed to send verification email',
          error: result.error
        });
      }
    } catch (error) {
      console.error('Error in verifyEmail controller:', error.message);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  }

  async resetPassword(req, res) {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          message: 'Validation failed',
          errors: errors.array()
        });
      }

      const { email } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=${this.generateToken()}`;
      const result = await emailService.sendResetPasswordEmail(email, resetLink);

      if (result.success) {
        res.status(200).json({
          success: true,
          message: 'Password reset email sent successfully',
          messageId: result.messageId
        });
      } else {
        res.status(500).json({
          success: false,
          message: 'Failed to send password reset email',
          error: result.error
        });
      }
    } catch (error) {
      console.error('Error in resetPassword controller:', error.message);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  }

  async testEmail(req, res) {
    try {
      const { email, type } = req.body;

      if (!email) {
        return res.status(400).json({
          success: false,
          message: 'Email is required'
        });
      }

      let result;
      switch (type) {
        case 'otp':
          const otp = this.generateOTP();
          result = await emailService.sendOTPEmail(email, otp);
          break;
        case 'verification':
          const verificationLink = `${process.env.FRONTEND_URL}/verify-email?token=test-token`;
          result = await emailService.sendVerificationEmail(email, verificationLink);
          break;
        case 'reset':
          const resetLink = `${process.env.FRONTEND_URL}/reset-password?token=test-token`;
          result = await emailService.sendResetPasswordEmail(email, resetLink);
          break;
        default:
          const subject = 'Test Email from Rozna';
          const html = `
            <h2>Test Email</h2>
            <p>This is a test email from the Rozna application.</p>
            <p>Timestamp: ${new Date().toISOString()}</p>
          `;
          result = await emailService.sendEmail({ to: email, subject, html });
      }

      if (result.success) {
        res.status(200).json({
          success: true,
          message: 'Test email sent successfully',
          messageId: result.messageId,
          response: result.response
        });
      } else {
        res.status(500).json({
          success: false,
          message: 'Failed to send test email',
          error: result.error
        });
      }
    } catch (error) {
      console.error('Error in testEmail controller:', error.message);
      res.status(500).json({
        success: false,
        message: 'Internal server error',
        error: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
      });
    }
  }

  generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
  }

  generateToken() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  }
}

const sendOTPValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address')
];

const verifyEmailValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address')
];

const resetPasswordValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address')
];

const testEmailValidation = [
  body('email')
    .isEmail()
    .normalizeEmail()
    .withMessage('Please provide a valid email address'),
  body('type')
    .optional()
    .isIn(['otp', 'verification', 'reset'])
    .withMessage('Type must be one of: otp, verification, reset')
];

module.exports = new AuthController();
module.exports.sendOTPValidation = sendOTPValidation;
module.exports.verifyEmailValidation = verifyEmailValidation;
module.exports.resetPasswordValidation = resetPasswordValidation;
module.exports.testEmailValidation = testEmailValidation;
