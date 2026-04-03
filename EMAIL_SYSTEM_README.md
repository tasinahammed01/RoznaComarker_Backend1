# Production-Ready Email System with Nodemailer & SendGrid

## Overview
This implementation provides a complete, production-ready email system using Nodemailer with SendGrid SMTP. It follows clean architecture principles with proper error handling, validation, and security.

## Folder Structure
```
backend/
├── src/
│   ├── services/
│   │   └── emailService.js          # Main email service with Nodemailer configuration
│   ├── controllers/
│   │   └── authController.js        # Email endpoints with validation
│   ├── routes/
│   │   └── authRoutes.js            # Express routes for email functionality
│   └── app.js                       # Updated with email routes
├── .env.example                     # Updated with SendGrid configuration
└── package.json                     # Nodemailer already included
```

## Setup Instructions

### 1. Environment Configuration
Add these to your `.env` file:
```bash
# SendGrid SMTP Configuration (Required)
SENDGRID_API_KEY=your_sendgrid_api_key_here
EMAIL_FROM=noreply@rozna.com

# Frontend URL for verification/reset links
FRONTEND_URL=http://82.112.234.151:4200
```

### 2. SendGrid Setup
1. Create a SendGrid account: https://sendgrid.com/
2. Generate an API key in your SendGrid dashboard
3. Add the API key to your `.env` file
4. Verify your sender identity in SendGrid settings

## Available Endpoints

### Send OTP Email
```http
POST /api/email-auth/send-otp
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Send Email Verification
```http
POST /api/email-auth/verify-email
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Send Password Reset
```http
POST /api/email-auth/reset-password
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Test Email (Development)
```http
POST /api/email-auth/test-email
Content-Type: application/json

{
  "email": "test@example.com",
  "type": "otp" // or "verification", "reset"
}
```

## Usage Examples

### Basic Email Sending
```javascript
import emailService from './services/emailService.js';

// Send custom email
const result = await emailService.sendEmail({
  to: 'user@example.com',
  subject: 'Welcome to Rozna',
  html: '<h1>Welcome!</h1><p>Thanks for joining us.</p>'
});

if (result.success) {
  console.log('Email sent:', result.messageId);
} else {
  console.error('Failed to send:', result.error);
}
```

### Send OTP
```javascript
import emailService from './services/emailService.js';

const result = await emailService.sendOTPEmail('user@example.com', '123456');
```

### Send Verification Email
```javascript
import emailService from './services/emailService.js';

const verificationLink = 'https://yourapp.com/verify?token=abc123';
const result = await emailService.sendVerificationEmail('user@example.com', verificationLink);
```

## Features

### ✅ Production Ready
- Clean architecture with separation of concerns
- Comprehensive error handling and logging
- Input validation using express-validator
- Environment-based configuration
- No hardcoded credentials

### ✅ Security
- Input sanitization and validation
- Environment variables for sensitive data
- TLS configuration for SMTP
- Rate limiting ready (can be added)

### ✅ Email Templates
- Modern, responsive HTML templates
- Professional design with gradients
- Mobile-friendly layouts
- Security notices and warnings
- Alternative text links for accessibility

### ✅ Reusable Functions
- `sendEmail()` - Generic email sending
- `sendOTPEmail()` - OTP verification emails
- `sendVerificationEmail()` - Email verification
- `sendResetPasswordEmail()` - Password reset

## Response Format

### Success Response
```json
{
  "success": true,
  "message": "OTP sent successfully",
  "messageId": "abc123@smtp.sendgrid.net"
}
```

### Error Response
```json
{
  "success": false,
  "message": "Validation failed",
  "errors": [
    {
      "msg": "Please provide a valid email address",
      "param": "email",
      "location": "body"
    }
  ]
}
```

## Testing

### Using curl
```bash
# Test OTP endpoint
curl -X POST http://82.112.234.151:5000/api/email-auth/send-otp \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Test verification endpoint
curl -X POST http://82.112.234.151:5000/api/email-auth/verify-email \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'
```

### Using Postman
Import the collection or create requests with:
- Method: POST
- Headers: Content-Type: application/json
- Body: JSON with email field

## Production Considerations

### 1. Rate Limiting
Add rate limiting to prevent abuse:
```javascript
import { createSensitiveRateLimiter } from './middlewares/rateLimit.middleware';

router.post('/send-otp', createSensitiveRateLimiter(), sendOTPValidation, authController.sendOTP);
```

### 2. Monitoring
- Monitor email delivery rates
- Set up SendGrid event webhooks
- Log failed deliveries for analysis

### 3. Security
- Remove OTP from response in production
- Add CSRF protection
- Implement proper authentication for sensitive endpoints

### 4. Scalability
- Consider using a queue system for high volume
- Implement retry logic for failed emails
- Add circuit breaker pattern

## Dependencies
- `nodemailer` - Email sending library (already installed)
- `express-validator` - Input validation (already installed)
- `dotenv` - Environment variables (already installed)

## Troubleshooting

### Common Issues
1. **API Key Error**: Verify SendGrid API key is correct
2. **Authentication Failed**: Ensure sender identity is verified in SendGrid
3. **Connection Refused**: Check network connectivity and firewall settings
4. **Template Issues**: Verify HTML template syntax

### Debug Mode
Enable debug logging:
```bash
NODE_ENV=development npm run dev
```

This implementation provides a solid foundation for email functionality in your Rozna application with all the production-ready features you requested.
