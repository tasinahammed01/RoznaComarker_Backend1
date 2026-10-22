'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const { Ledger } = require('../scripts/local-shadow/ledger.cjs');
const preflight = require('../scripts/local-shadow/real-preflight.cjs');
const real = require('../scripts/local-shadow/real-one.cjs');
const { root } = require('../scripts/local-shadow/config.cjs');
const hash = 'a'.repeat(64);
const dirs = [];
function directory() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rozna-local-one-')); dirs.push(d); return d; }
afterAll(() => { for (const d of dirs) { for (const name of fs.readdirSync(d)) fs.unlinkSync(path.join(d, name)); fs.rmdirSync(d); } });
test('credential import projects only existing supported fields, ignoring production resources', () => {
  const dir = directory(), file = path.join(dir, 'account.json');
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  fs.writeFileSync(file, JSON.stringify({ type: 'service_account', client_email: 'test@example.invalid', private_key: key }));
  const value = preflight.credentials({ GOOGLE_CLOUD_KEY_FILE: file, OPENROUTER_API_KEY: 'test-secret', MONGO_URI: 'remote', SMTP_PASS: 'remote', FIREBASE_PRIVATE_KEY: 'remote', PAYPAL_LIVE_CLIENT_SECRET: 'remote', FRONTEND_URL: 'remote', UPLOAD_BASE_PATH: 'remote', GEMINI_API_KEY: 'remote' });
  expect(Object.keys(value).sort()).toEqual(['googleName', 'googlePath', 'openrouterKey']);
  expect(value.googleName).toBe('GOOGLE_CLOUD_KEY_FILE');
  expect(preflight.credentials({ GOOGLE_APPLICATION_CREDENTIALS: file, OPENROUTER_API_KEY: 'test' }).googleName).toBe('GOOGLE_APPLICATION_CREDENTIALS');
  expect(() => preflight.credentials({})).toThrow('MISSING_GOOGLE');
  expect(() => preflight.credentials({ GOOGLE_CLOUD_KEY_FILE: file })).toThrow('MISSING_OPENROUTER_API_KEY');
});
test('single generation reservation survives new instances and child process restart', () => {
  const dir = directory(); new Ledger(dir).reserve('shadow', hash);
  expect(() => new Ledger(dir).reserve('shadow', hash)).toThrow('ONE_SHOT_BUDGET_CONSUMED');
  const result = cp.spawnSync(process.execPath, ['-e', `const {Ledger}=require('./scripts/local-shadow/ledger.cjs');try{new Ledger(process.argv[1]).reserve('shadow','a'.repeat(64));process.exit(2)}catch(e){console.log(e.message)}`, dir], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stdout).toContain('ONE_SHOT_BUDGET_CONSUMED');
});
test.each(['upload', 'orientation', 'document', 'shadow-http', 'google-orientation-http', 'google-document-http'])('budget %s cannot be consumed twice', kind => {
  const ledger = new Ledger(directory()); ledger.reserve(kind, hash); expect(() => ledger.reserve(kind, hash)).toThrow('BUDGET_CONSUMED');
});
test('ledger projects safe fields instead of secret-bearing arbitrary metadata', () => {
  const dir = directory(), ledger = new Ledger(dir);
  ledger.event('TEST', { httpStatus: 200, Authorization: 'must-not-store', key: 'must-not-store', base64: 'must-not-store', error: 'must-not-store' });
  expect(fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8')).not.toContain('must-not-store');
});
test('image preflight rejects Golden001, production upload and redirected input paths', () => {
  for (const p of ['tests/fixtures/hybrid-source/private/001-louise-mallard/image.jpg', 'uploads/source.jpg', '../staging-test-data/elsewhere.jpg']) {
    expect(() => preflight.image(path.resolve(root, p))).toThrow('IMAGE_PATH_NOT_ALLOWED');
  }
  expect(preflight.image().present).toBe(fs.existsSync(preflight.imagePath));
});
test('Vision SDK remains real, uses supported REST transport, no retries, and preserves callbacks', () => {
  class SDK { constructor(opts) { this.opts = opts; } batchAnnotateImages(req, opts, cb) { cb(null, { response: true }); return { req, opts }; } }
  const Client = real.visionClass({ ImageAnnotatorClient: SDK }); const client = new Client({ keyFilename: 'local-file' });
  const callback = jest.fn(); const result = client.batchAnnotateImages({ requests: [{ features: [{ type: 'DOCUMENT_TEXT_DETECTION' }] }] }, { retry: 'bad' }, callback);
  expect(client.opts).toEqual({ keyFilename: 'local-file', fallback: true }); expect(result.opts.retry).toBeNull(); expect(callback).toHaveBeenCalled();
  expect(() => client.batchAnnotateImages({ requests: [{ features: [{ type: 'FACE_DETECTION' }] }] }, {}, callback)).toThrow('OPERATION_NOT_ALLOWED');
});
test('scoped network policy requires explicit real-one and denies unrelated hosts and raw sockets', () => {
  const dir = directory();
  const script = `const {Ledger}=require('./scripts/local-shadow/ledger.cjs');const n=require('./scripts/local-shadow/network.cjs');n.install({realOne:process.argv[2]==='yes',ledger:new Ledger(process.argv[1]),imageHash:'a'.repeat(64)});const result=n.scope('google','orientation',()=>[n.allowed('vision.googleapis.com'),n.allowed('oauth2.googleapis.com'),n.allowed('openrouter.ai'),n.allowed('smtp.gmail.com'),n.allowed('mongodb.example.com')]);result.push(n.scope('shadow','generation',()=>n.allowed('openrouter.ai')));result.push(n.allowed('vision.googleapis.com'));try{n.scope('google','orientation',()=>require('net').connect({host:'vision.googleapis.com',port:443}));result.push('unsafe')}catch{result.push('raw-denied')}console.log(JSON.stringify(result))`;
  for (const active of ['yes', 'no']) {
    const value = cp.spawnSync(process.execPath, ['-e', script, dir, active], { cwd: root, encoding: 'utf8' });
    expect(value.status).toBe(0); expect(JSON.parse(value.stdout)).toEqual([active === 'yes', active === 'yes', false, false, false, active === 'yes', false, 'raw-denied']);
  }
});
test('actual transport entry is single-use; redirects and unrelated fetches are blocked without network', () => {
  const dir = directory();
  const script = `const {Ledger}=require('./scripts/local-shadow/ledger.cjs');global.fetch=async()=>({status:200});const n=require('./scripts/local-shadow/network.cjs');n.install({realOne:true,ledger:new Ledger(process.argv[1]),imageHash:'a'.repeat(64)});(async()=>{await n.scope('shadow','generation',()=>fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST'}));try{await n.scope('shadow','generation',()=>fetch('https://openrouter.ai/api/v1/chat/completions',{method:'POST'}));process.exit(2)}catch(e){if(e.message!=='ONE_SHOT_BUDGET_CONSUMED')throw e}try{await n.scope('shadow','generation',()=>fetch('https://api.openai.com/v1/chat/completions',{method:'POST'}));process.exit(3)}catch(e){if(e.code!=='LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED')throw e}console.log('safe')})()`;
  const result = cp.spawnSync(process.execPath, ['-e', script, dir], { cwd: root, encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('safe');
});
test('Google annotation and auth HTTP requests are counted separately and retries cannot spend more', () => {
  const dir = directory();
  const script = `const {Ledger}=require('./scripts/local-shadow/ledger.cjs');global.fetch=async()=>({status:200});const n=require('./scripts/local-shadow/network.cjs');const ledger=new Ledger(process.argv[1]);n.install({realOne:true,ledger,imageHash:'a'.repeat(64)});(async()=>{for(const phase of ['orientation','document'])await n.scope('google',phase,()=>fetch('https://vision.googleapis.com/v1/images:annotate',{method:'POST'}));await n.scope('google','document',()=>fetch('https://oauth2.googleapis.com/token',{method:'POST'}));try{await n.scope('google','document',()=>fetch('https://vision.googleapis.com/v1/images:annotate',{method:'POST'}));process.exit(2)}catch(e){if(e.message!=='ONE_SHOT_BUDGET_CONSUMED')throw e}console.log(n.counts.providerRequests)})()`;
  const result = cp.spawnSync(process.execPath, ['-e', script, dir], { cwd: root, encoding: 'utf8' });
  expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('3');
  for (const kind of ['google-orientation-http','google-document-http','google-auth-1']) expect(new Ledger(dir).spent(kind)).toBe(true);
});
test('TLS hostname substitution and insecure certificate settings fail closed without transport', () => {
  const dir = directory();
  const script = `const n=require('./scripts/local-shadow/network.cjs');const {Ledger}=require('./scripts/local-shadow/ledger.cjs');n.install({realOne:true,ledger:new Ledger(process.argv[1]),imageHash:'a'.repeat(64)});for(const opts of [{host:'evil.invalid',servername:'vision.googleapis.com',port:443},{host:'vision.googleapis.com',port:443,rejectUnauthorized:false}])try{n.scope('google','orientation',()=>require('tls').connect(opts));process.exit(2)}catch(e){if(e.code!=='LOCAL_SHADOW_EXTERNAL_NETWORK_DENIED')throw e}console.log('safe')`;
  const result = cp.spawnSync(process.execPath, ['-e', script, dir], { cwd: root, encoding: 'utf8' }); expect(result.status).toBe(0); expect(result.stdout.trim()).toBe('safe');
});
test('generator requires HTTP finish, performs one frozen v15 attempt with private credentials and no retry', async () => {
  const ledger = new Ledger(directory()); ledger.reserve('upload', hash);
  const input = { identity: { sourceSha256: hash }, transcript: 'hello world', transcriptHash: crypto.createHash('sha256').update('hello world').digest('hex'), assignment: {} };
  const attempt = jest.fn(async options => { expect(options.entry.model).toBe('openai/gpt-4.1-mini'); expect(options.schemaName).toBe('semantic_corrections_v15'); expect(options.env.OPENROUTER_API_KEY).toBe('test-private-key'); return { content: '{}', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0.01 }, finishReason: 'stop' }; });
  const generate = real.createGenerator({ ledger, image: { sha256: hash }, key: 'test-private-key', attempt, fetchImpl: jest.fn() });
  const args = { signal: new AbortController().signal };
  await expect(generate(input, args)).rejects.toThrow('RESPONSE_FINISH_REQUIRED'); expect(attempt).not.toHaveBeenCalled();
  ledger.event('HTTP_RESPONSE_FINISHED', { httpStatus: 200 });
  await expect(generate(input, args)).resolves.toBe('{}');
  await expect(generate(input, args)).rejects.toThrow('BUDGET_CONSUMED'); expect(attempt).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(ledger.directory, 'events.jsonl'), 'utf8')).not.toContain('test-private-key');
});
test('failed experimental generation remains consumed and cannot fallback or retry', async () => {
  const ledger = new Ledger(directory()); ledger.reserve('upload', hash); ledger.event('HTTP_RESPONSE_FINISHED', { httpStatus: 200 });
  const attempt = jest.fn(async () => { throw Error('provider-secret'); });
  const input = { identity: { sourceSha256: hash }, transcript: 'hello', transcriptHash: crypto.createHash('sha256').update('hello').digest('hex'), assignment: {} };
  const generate = real.createGenerator({ ledger, image: { sha256: hash }, key: 'key', attempt, fetchImpl: jest.fn() });
  await expect(generate(input, { signal: new AbortController().signal })).rejects.toThrow('LOCAL_SHADOW_GENERATION_FAILED');
  await expect(generate(input, { signal: new AbortController().signal })).rejects.toThrow('BUDGET_CONSUMED'); expect(attempt).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(path.join(ledger.directory, 'events.jsonl'), 'utf8')).not.toContain('provider-secret');
});
test('local bootstrap suppresses production writers only inside its process', () => {
  const c = require('../src/services/canonicalCorrectionsPipeline.service'); const e = require('../src/services/canonicalEvaluation.service'); const a = require('../src/services/autoRubricDesigner.service');
  const old = [c.generateAndPersist, e.generate, a.autoGenerateRubricDesignerForSubmission];
  try { real.suppressProductionAI(new Ledger(directory())); expect(c.generateAndPersist).not.toBe(old[0]); expect(e.generate).not.toBe(old[1]); expect(a.autoGenerateRubricDesignerForSubmission).not.toBe(old[2]); }
  finally { [c.generateAndPersist, e.generate, a.autoGenerateRubricDesignerForSubmission] = old; }
});
