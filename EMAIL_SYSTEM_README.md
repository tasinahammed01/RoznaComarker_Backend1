# Authentication email

Firebase Authentication is authoritative for identity, passwords, email verification, reset action codes, and delivery of verification/password-reset messages.

The Angular client calls Firebase directly with trusted environment-derived continuation URLs:

- Verification: `FRONTEND_URL/verify-email`
- Password reset: `FRONTEND_URL/login`

Production uses `FRONTEND_URL=https://comarkers.roznahub.com`. Configure that domain in Firebase Authentication's Authorized domains list and configure the Firebase email templates in Firebase Console.

The deprecated backend paths `/api/auth/send-verification-email` and `/api/auth/request-password-reset` return `410 Gone`; they do not generate links or send mail.

The separate `src/services/email.service.js` Nodemailer wrapper remains only for class invitations. Its SMTP settings are unrelated to Firebase verification and password-reset delivery.
