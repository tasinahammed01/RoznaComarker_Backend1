const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '..', '..', '.env') });

function isPlaceholder(value) {
  return /replace|change[_-]?me|your[_-]|example|placeholder/iu.test(String(value || ''));
}

function assertHttpsUrl(name, value, expectedHost) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(`${name} must be a valid HTTPS URL`); }
  if (url.protocol !== 'https:' || url.username || url.password || (expectedHost && url.hostname !== expectedHost)) {
    throw new Error(`${name} must be a trusted HTTPS URL`);
  }
  return url;
}

function validateProductionSecurity(environment = process.env) {
  if (environment.NODE_ENV !== 'production') return;
  const host = String(environment.HOST || '127.0.0.1').trim();
  if (host !== '127.0.0.1') {
    throw new Error('HOST must be 127.0.0.1 in production so the API is reachable only through Nginx');
  }
  const secret = String(environment.JWT_SECRET || '');
  if (secret.length < 32 || isPlaceholder(secret)) {
    throw new Error('JWT_SECRET must be a non-placeholder secret of at least 32 characters in production');
  }
  if (/localhost|127\.0\.0\.1/iu.test(String(environment.MONGO_URI || ''))) {
    throw new Error('MONGO_URI must not use localhost in production');
  }
  assertHttpsUrl('FRONTEND_URL', environment.FRONTEND_URL, 'comarkers.roznahub.com');
  assertHttpsUrl('PUBLIC_API_URL', environment.PUBLIC_API_URL, 'comarkerback.roznahub.com');

  const allowedOrigins = String(environment.CORS_ALLOWED_ORIGINS || environment.CORS_ORIGINS || '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  if (allowedOrigins.length !== 1 || allowedOrigins[0] !== 'https://comarkers.roznahub.com') {
    throw new Error('Production CORS must allow exactly https://comarkers.roznahub.com');
  }

  const stripeSecret = String(environment.STRIPE_SECRET_KEY || '');
  const webhookSecret = String(environment.STRIPE_WEBHOOK_SECRET || '');
  if (!/^sk_(test|live)_/u.test(stripeSecret) || !/^whsec_/u.test(webhookSecret)) {
    throw new Error('Stripe production configuration is missing or malformed');
  }
  const publishable = String(environment.STRIPE_PUBLISHABLE_KEY || '');
  if (publishable) {
    const secretMode = stripeSecret.startsWith('sk_live_') ? 'live' : 'test';
    if (!publishable.startsWith(`pk_${secretMode}_`)) {
      throw new Error('Stripe publishable and secret key modes do not match');
    }
  }
}

const required = [
  'PORT',
  'MONGO_URI',
  'NODE_ENV',
  'JWT_SECRET',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS'
];

if (process.env.NODE_ENV === 'production') {
  required.push('FRONTEND_URL', 'PUBLIC_API_URL', 'BASE_URL');
  required.push('STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET');
  if (!String(process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS || '').trim()) {
    throw new Error('Missing required env var: CORS_ALLOWED_ORIGINS');
  }
}

validateProductionSecurity(process.env);

// Validate each required variable with a clear, individual error message
// so misconfiguration is surfaced precisely at startup (not silently at runtime).
for (const key of required) {
  if (!process.env[key] || String(process.env[key]).trim() === '') {
    throw new Error(`Missing required env var: ${key}`);
  }
}

const env = {
  HOST: process.env.HOST || (process.env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0'),
  PORT: Number(process.env.PORT),
  MONGO_URI: process.env.MONGO_URI,
  NODE_ENV: process.env.NODE_ENV,
  JWT_SECRET: process.env.JWT_SECRET,
  FRONTEND_URL: process.env.FRONTEND_URL,
  CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || process.env.CORS_ORIGINS,
  CORS_ORIGINS: process.env.CORS_ORIGINS,
  PUBLIC_API_URL: process.env.PUBLIC_API_URL,
  BASE_URL: process.env.BASE_URL,
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY,
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  RESEND_FROM_NAME: process.env.RESEND_FROM_NAME,
  UNSPLASH_ACCESS_KEY: process.env.UNSPLASH_ACCESS_KEY,
  UNSPLASH_SECRET_KEY: process.env.UNSPLASH_SECRET_KEY
};

module.exports = env;
module.exports.validateProductionSecurity = validateProductionSecurity;
