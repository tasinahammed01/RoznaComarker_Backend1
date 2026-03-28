const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

/**
 * @route   POST /api/auth/send-otp
 * @desc    Send OTP verification email
 * @access  Public
 */
router.post('/send-otp', authController.sendOTPValidation, authController.sendOTP);

/**
 * @route   POST /api/auth/verify-email
 * @desc    Send email verification link
 * @access  Public
 */
router.post('/verify-email', authController.verifyEmailValidation, authController.verifyEmail);

/**
 * @route   POST /api/auth/reset-password
 * @desc    Send password reset link
 * @access  Public
 */
router.post('/reset-password', authController.resetPasswordValidation, authController.resetPassword);

/**
 * @route   POST /api/auth/test-email
 * @desc    Test email functionality
 * @access  Public (Development only)
 */
router.post('/test-email', authController.testEmailValidation, authController.testEmail);

module.exports = router;
