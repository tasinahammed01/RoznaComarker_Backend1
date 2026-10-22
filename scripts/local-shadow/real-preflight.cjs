'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root } = require('./config.cjs');
function credentials(source = require('dotenv').parse(fs.readFileSync(path.join(root, '.env')))) {
  const name = source.GOOGLE_CLOUD_KEY_FILE ? 'GOOGLE_CLOUD_KEY_FILE' : 'GOOGLE_APPLICATION_CREDENTIALS';
  const raw = String(source[name] || '').trim();
  if (!raw) throw Error('MISSING_GOOGLE_CLOUD_KEY_FILE_OR_GOOGLE_APPLICATION_CREDENTIALS');
  const clean = raw.replace(/^\.[\\/]/, '');
  const file = path.isAbsolute(clean) ? clean : path.resolve(root, clean.replace(/^backend[\\/]/i, ''));
  let account;
  try { account = JSON.parse(fs.readFileSync(file)); } catch { throw Error('MISSING_GOOGLE_SERVICE_ACCOUNT_FILE'); }
  if (account.type !== 'service_account' || !account.client_email || !account.private_key) throw Error('MISSING_GOOGLE_SERVICE_ACCOUNT_FIELDS');
  if (account.universe_domain && account.universe_domain !== 'googleapis.com') throw Error('GOOGLE_UNIVERSE_NOT_ALLOWED');
  if (account.token_uri && account.token_uri !== 'https://oauth2.googleapis.com/token') throw Error('GOOGLE_TOKEN_URI_NOT_ALLOWED');
  try { crypto.createPrivateKey(account.private_key); } catch { throw Error('INVALID_GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'); }
  if (!source.OPENROUTER_API_KEY?.trim()) throw Error('MISSING_OPENROUTER_API_KEY');
  // Return only supported credential fields. Never return the source environment or print this object.
  return { googleName: name, googlePath: file, openrouterKey: source.OPENROUTER_API_KEY.trim() };
}
const imagePath = path.resolve(root, '../staging-test-data/handwritten-page-01.jpg');
function image(file = imagePath) {
  if (path.resolve(file) !== imagePath || /golden|001-louise|[\\/]backend[\\/]uploads[\\/]/i.test(file)) throw Error('IMAGE_PATH_NOT_ALLOWED');
  const parent = path.dirname(file);
  if (fs.existsSync(parent) && (fs.lstatSync(parent).isSymbolicLink() || fs.realpathSync(parent) !== parent)) throw Error('IMAGE_PATH_REDIRECTED');
  if (!fs.existsSync(file)) return { present: false, missing: 'HANDWRITTEN_TEST_IMAGE_PATH' };
  const st = fs.lstatSync(file);
  if (!st.isFile() || st.isSymbolicLink() || fs.realpathSync(file) !== file || st.size === 0) throw Error('IMAGE_PATH_NOT_ALLOWED');
  const bytes = fs.readFileSync(file);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  const webp = bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw Error('IMAGE_TYPE_NOT_SUPPORTED');
  return { present: true, file, size: st.size, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}
module.exports = { credentials, image, imagePath };
