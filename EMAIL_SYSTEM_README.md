# Transactional authentication email

Firebase remains authoritative for identity, email verification, passwords, and action codes. The backend uses Firebase Admin to generate verification and password-reset links; Resend only delivers those links.

## Configuration

```env
APP_FRONTEND_URL=http://localhost:4200
RESEND_API_KEY=
RESEND_FROM_EMAIL=no-reply@roznahub.com
RESEND_FROM_NAME=CoMarker
```

Production uses `APP_FRONTEND_URL=https://comarkers.roznahub.com`. Never commit a real API key. Verify `roznahub.com` in Resend and publish the DNS records Resend provides before production delivery.

The central service is `src/services/emailService.js`. Auth controllers must not call the Resend SDK directly and must never log Firebase links, action codes, email bodies, Firebase ID tokens, authorization headers, or provider credentials.

The separate `src/services/email.service.js` SMTP implementation is retained only for class invitations. The unused legacy `/api/email-auth/*` custom-token routes were removed; authentication email uses only the Firebase-first `/api/auth/*` flow.
