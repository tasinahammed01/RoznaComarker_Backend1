const express = require('express');
const authController = require('../controllers/authController');
const {
  createAuthIpRateLimiter,
  createEmailRateLimiter
} = require('../middlewares/rateLimit.middleware');

const router = express.Router();

/**
 * @route   POST /api/auth/send-otp
 * @desc    Send OTP verification email
 * @access  Public
 */
const emailIpLimiter = (event, reason) => createAuthIpRateLimiter({
  windowMs: process.env.EMAIL_IP_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  limit: process.env.EMAIL_IP_RATE_LIMIT_MAX || 20,
  event,
  reason
});
const emailAddressLimiter = (event, reason) => createEmailRateLimiter({
  windowMs: process.env.EMAIL_ADDRESS_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000,
  limit: process.env.EMAIL_ADDRESS_RATE_LIMIT_MAX || 5,
  event,
  reason
});
const emailCooldownLimiter = (event, reason) => createEmailRateLimiter({
  windowMs: process.env.EMAIL_COOLDOWN_MS || 60 * 1000,
  limit: 1,
  event,
  reason
});
const emailDailyLimiter = (event, reason) => createEmailRateLimiter({
  windowMs: 24 * 60 * 60 * 1000,
  limit: process.env.EMAIL_DAILY_RATE_LIMIT_MAX || 20,
  event,
  reason
});

router.post('/send-otp',
  emailIpLimiter('OTP_SEND_RATE_LIMITED', 'otp_ip'),
  emailAddressLimiter('OTP_SEND_RATE_LIMITED', 'otp_email'),
  emailDailyLimiter('OTP_SEND_RATE_LIMITED', 'otp_daily'),
  emailCooldownLimiter('OTP_SEND_RATE_LIMITED', 'otp_cooldown'),
  authController.sendOTPValidation,
  authController.sendOTP);

/**
 * @route   POST /api/auth/verify-email
 * @desc    Send email verification link
 * @access  Public
 */
router.post('/verify-email',
  emailIpLimiter('EMAIL_VERIFICATION_RATE_LIMITED', 'verification_ip'),
  emailAddressLimiter('EMAIL_VERIFICATION_RATE_LIMITED', 'verification_email'),
  emailDailyLimiter('EMAIL_VERIFICATION_RATE_LIMITED', 'verification_daily'),
  emailCooldownLimiter('EMAIL_VERIFICATION_RATE_LIMITED', 'verification_cooldown'),
  authController.verifyEmailValidation,
  authController.verifyEmail);

/**
 * @route   POST /api/auth/reset-password
 * @desc    Send password reset link
 * @access  Public
 */
router.post('/reset-password',
  emailIpLimiter('PASSWORD_RESET_RATE_LIMITED', 'password_reset_ip'),
  emailAddressLimiter('PASSWORD_RESET_RATE_LIMITED', 'password_reset_email'),
  emailDailyLimiter('PASSWORD_RESET_RATE_LIMITED', 'password_reset_daily'),
  emailCooldownLimiter('PASSWORD_RESET_RATE_LIMITED', 'password_reset_cooldown'),
  authController.resetPasswordValidation,
  authController.resetPassword);

/**
 * @route   POST /api/auth/test-email
 * @desc    Test email functionality
 * @access  Public (Development only)
 */
if (process.env.NODE_ENV === 'development') {
  router.post('/test-email', authController.testEmailValidation, authController.testEmail);
}

module.exports = router;
