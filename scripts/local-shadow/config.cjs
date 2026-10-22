'use strict';
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const root = path.resolve(__dirname, '../..');
const home = path.join(root, '.local-shadow');
function configuration() {
  return {
    NODE_ENV: 'staging', HOST: '127.0.0.1', PORT: '5001',
    CORRECTION_PIPELINE_MODE: 'shadow_v15', OCR_SOURCE_MODE: 'legacy',
    ASSESSMENT_RECOVERY_ENABLED: 'false', UPLOAD_BASE_PATH: '.local-shadow/uploads',
    MONGO_URI: 'mongodb://127.0.0.1:27028/rozna_shadow_local?replicaSet=localShadow',
    FRONTEND_URL: 'http://localhost:4200', PUBLIC_API_URL: 'http://127.0.0.1:5001',
    BASE_URL: 'http://127.0.0.1:5001', CORS_ALLOWED_ORIGINS: 'http://localhost:4200',
    CORS_ORIGINS: 'http://localhost:4200', JWT_SECRET: crypto.randomBytes(48).toString('hex'),
    FIREBASE_PROJECT_ID: 'local-shadow-offline',
    FIREBASE_CLIENT_EMAIL: 'offline@local-shadow-offline.iam.gserviceaccount.com',
    FIREBASE_PRIVATE_KEY: crypto.generateKeyPairSync('rsa', { modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey,
    GOOGLE_APPLICATION_CREDENTIALS: path.join(home, 'NO_PROVIDER_CREDENTIALS'),
    PAYMENT_PROVIDER: 'paypal', PAYPAL_ENV: 'sandbox', PAYPAL_LIVE_ENABLED: 'false',
    PAYPAL_SANDBOX_CLIENT_ID: 'offline-not-a-credential', PAYPAL_SANDBOX_CLIENT_SECRET: 'offline-not-a-credential',
    PAYPAL_SANDBOX_WEBHOOK_ID: 'offline-webhook', PAYPAL_SANDBOX_PRODUCT_ID: 'offline-product',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_MONTHLY: 'offline-essential-monthly',
    PAYPAL_SANDBOX_PLAN_ESSENTIAL_ANNUAL: 'offline-essential-annual',
    PAYPAL_SANDBOX_PLAN_PRO_MONTHLY: 'offline-pro-monthly', PAYPAL_SANDBOX_PLAN_PRO_ANNUAL: 'offline-pro-annual',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false', MAIL_FROM_EMAIL: 'offline@example.invalid',
    MONGOMS_RUNTIME_DOWNLOAD: 'false', NG_CLI_ANALYTICS: 'false'
  };
}
function assertIsolation(env) {
  if (env.MONGO_URI !== configurationUri || env.HOST !== '127.0.0.1' || env.PORT !== '5001' ||
      env.UPLOAD_BASE_PATH !== '.local-shadow/uploads' || env.NODE_ENV !== 'staging' ||
      env.CORRECTION_PIPELINE_MODE !== 'shadow_v15' || !['legacy','astra_verified'].includes(env.OCR_SOURCE_MODE) ||
      (env.OCR_SOURCE_MODE==='astra_verified'&&env.LOCAL_ASTRA_VERIFIED_OPT_IN!=='true') ||
      env.ASSESSMENT_RECOVERY_ENABLED !== 'false') throw Error('LOCAL_SHADOW_ISOLATION_REJECTED');
}
const configurationUri = 'mongodb://127.0.0.1:27028/rozna_shadow_local?replicaSet=localShadow';
function applyEnvironment(sourceOptions) {
  // Preserve operating-system/runtime discovery only. Never inherit app/provider credentials.
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS)$/i;
  for (const key of Object.keys(process.env)) if (!allowed.test(key)) delete process.env[key];
  const env = configuration();
  if(sourceOptions){
    for(const key of ['OCR_ASTRA_MODEL','OCR_FABLE_MODEL','OPENROUTER_API_KEY','GOOGLE_CLOUD_KEY_FILE','GOOGLE_APPLICATION_CREDENTIALS'])
      if(sourceOptions[key])env[key]=sourceOptions[key];
    Object.assign(env,{OCR_SOURCE_MODE:'astra_verified',LOCAL_ASTRA_VERIFIED_OPT_IN:'true'});
  }
  assertIsolation(env); Object.assign(process.env, env);
  // Existing modules load backend/.env. Suppress dotenv file loading only in this dedicated process.
  require('dotenv').config = () => ({ parsed: {} });
  return env;
}
function localDirectory(directory) {
  const relative = path.relative(home, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('LOCAL_DIRECTORY_OUTSIDE_SANDBOX');
  fs.mkdirSync(directory, { recursive: true });
  for (const candidate of [home, directory]) {
    if (fs.lstatSync(candidate).isSymbolicLink() || path.relative(root, fs.realpathSync(candidate)).startsWith('..')) {
      throw Error('LOCAL_DIRECTORY_REDIRECTED');
    }
  }
}
module.exports = { root, home, configuration, assertIsolation, applyEnvironment, localDirectory };
