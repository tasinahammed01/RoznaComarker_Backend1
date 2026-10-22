'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { root, home, localDirectory } = require('./config.cjs');
const network = require('./network.cjs');
const preflight = require('./real-preflight.cjs');
const { Ledger } = require('./ledger.cjs');
function inspect() {
  const secret = preflight.credentials();
  const image = preflight.image();
  localDirectory(path.join(home, 'private', 'real-one'));
  const ledger = new Ledger(path.join(home, 'private', 'real-one'));
  const missing = [];
  if (!image.present) missing.push('HANDWRITTEN_TEST_IMAGE_PATH');
  if (ledger.spent('upload') || ledger.spent('shadow') || ledger.spent('shadow-http')) missing.push('UNUSED_REAL_ONE_LEDGER');
  const sessionPath = path.join(home, 'private', 'session.json');
  if (!fs.existsSync(sessionPath)) missing.push('LOCAL_GUEST_ASSIGNMENT_SESSION');
  return { secret, image, ledger, missing };
}
function summary(result) {
  return { ready: result.missing.length === 0, missing: result.missing, googleCredentialVariable: result.secret.googleName,
    googleCredentialFieldsPresent: true, openrouterCredentialField: 'OPENROUTER_API_KEY', openrouterCredentialPresent: true,
    externalHosts: network.HOSTS, imagePresent: result.image.present, ledgerUnused: !result.ledger.spent('upload') && !result.ledger.spent('shadow'),
    verifierConfigured: false, providerCallsDuringPreflight: 0 };
}
function visionClass(sdk) {
  return class LocalVisionClient extends sdk.ImageAnnotatorClient {
    constructor(options) { super({ ...options, fallback: true }); }
    batchAnnotateImages(request, options = {}, callback) {
      if (request?.requests?.length !== 1 || request.requests[0].features?.some(f => !['DOCUMENT_TEXT_DETECTION', 11].includes(f.type))) throw Error('LOCAL_VISION_OPERATION_NOT_ALLOWED');
      return super.batchAnnotateImages(request, { ...options, retry: null }, callback);
    }
  };
}
function install(result, dependencies = {}) {
  if (result.missing.length) throw Error('REAL_ONE_PREFLIGHT_INCOMPLETE');
  const { secret, image, ledger } = result;
  process.env[secret.googleName] = secret.googlePath;
  const sdkPath = require.resolve('@google-cloud/vision');
  const sdk = require(sdkPath);
  // Local process only: the application's existing Vision helper gets the same SDK, REST transport, no retries.
  require.cache[sdkPath].exports = { ...sdk, ImageAnnotatorClient: visionClass(sdk) };
  const vision = require('../../src/services/visionOcr.service');
  const orient = vision.detectOrientationAnnotation;
  const document = vision.extractOcrFromImageFile;
  vision.detectOrientationAnnotation = async (...args) => {
    ledger.reserve('orientation', image.sha256);
    const start = Date.now();
    try { const value = await network.scope('google', 'orientation', () => orient(...args)); ledger.event('GOOGLE_OPERATION_COMPLETED', { kind: 'orientation', latencyMs: Date.now() - start }); return value; }
    catch { ledger.event('GOOGLE_OPERATION_FAILED', { kind: 'orientation', latencyMs: Date.now() - start }); throw Error('LOCAL_ORIENTATION_FAILED'); }
  };
  vision.extractOcrFromImageFile = async (file, ...args) => {
    const bytes = fs.readFileSync(file);
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw Error('LOCAL_OCR_IMAGE_MISMATCH');
    ledger.reserve('document', image.sha256);
    const start = Date.now();
    try { const value = await network.scope('google', 'document', () => document(file, ...args)); ledger.event('GOOGLE_OPERATION_COMPLETED', { kind: 'document', latencyMs: Date.now() - start }); return value; }
    catch { ledger.event('GOOGLE_OPERATION_FAILED', { kind: 'document', latencyMs: Date.now() - start }); throw Error('LOCAL_DOCUMENT_OCR_FAILED'); }
  };
  const preflightMiddleware = require('../../src/middlewares/imagePreflight.middleware');
  const enforce = preflightMiddleware.enforceImagePreflight;
  preflightMiddleware.enforceImagePreflight = (req, res, next) => {
    try {
      const files = Array.isArray(req.files) ? req.files : [];
      if (files.length !== 1 || !files[0].detectedMime?.startsWith('image/')) throw Error('ONE_IMAGE_REQUIRED');
      const bytes = files[0].buffer || fs.readFileSync(files[0].path);
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw Error('AUTHORIZED_IMAGE_REQUIRED');
      ledger.reserve('upload', image.sha256);
      return enforce(req, res, next);
    } catch {
      for (const file of req.files || []) {
        const absolute = path.resolve(file.path || '');
        if (absolute.startsWith(path.join(home, 'uploads') + path.sep)) { try { fs.unlinkSync(absolute); } catch {} }
      }
      return res.status(409).json({ success: false, message: 'Local one-image budget or image identity check blocked this request.' });
    }
  };
  suppressProductionAI(ledger);
  const hook = require('../../src/services/correctionShadow/stagingHook');
  const snapshot = hook.snapshotCompleted;
  hook.snapshotCompleted = (...args) => { const pages = snapshot(...args); ledger.event('OCR_COMPLETED'); return pages; };
  const observe = hook.observeCompleted;
  hook.observeCompleted = (...args) => { ledger.event('SHADOW_SCHEDULED'); return observe(...args); };
  const Review = require('../../src/models/CorrectionShadowReview');
  const update = Review.updateOne;
  Review.updateOne = async function (...args) {
    const value = await update.apply(this, args); ledger.event('PRIVATE_ARTIFACT_COMPLETED'); return value;
  };
  const gateway = require('../../src/services/aiGateway.service');
  const shutdown = new AbortController();
  const generate = createGenerator({ ledger, image, key: secret.openrouterKey,
    attempt: dependencies.attempt || gateway.providerAttempt, fetchImpl: dependencies.fetchImpl || global.fetch, shutdownSignal: shutdown.signal });
  hook.configureStagingAdapters({ generator: { id: 'local-real-one-v15', model: 'openai/gpt-4.1-mini' }, generate, reviewers: [], timeoutMs: 45000 });
  return { ledger, image, stop: () => { process.env.CORRECTION_PIPELINE_MODE = 'legacy'; shutdown.abort(); network.disable(); ledger.event('MODE_DISABLED'); } };
}
function suppressProductionAI(ledger) {
  // Only this standalone local bootstrap mutates loaded exports. Production files/defaults remain untouched.
  const skip = async () => { ledger.event('PRODUCTION_AI_SUPPRESSED'); return { status: 'LOCAL_ONLY_SUPPRESSED' }; };
  require('../../src/services/canonicalCorrectionsPipeline.service').generateAndPersist = skip;
  require('../../src/services/canonicalEvaluation.service').generate = skip;
  require('../../src/services/autoRubricDesigner.service').autoGenerateRubricDesignerForSubmission = skip;
}
function createGenerator({ ledger, image, key, attempt, fetchImpl, shutdownSignal }) {
  return async (input, { signal }) => {
    if (input.identity.sourceSha256 !== image.sha256 || !ledger.spent('upload')) throw Error('SHADOW_IMAGE_IDENTITY_REQUIRED');
    const events = fs.readFileSync(path.join(ledger.directory, 'events.jsonl'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
    if (!events.some(e => e.event === 'HTTP_RESPONSE_FINISHED' && e.httpStatus === 200)) throw Error('RESPONSE_FINISH_REQUIRED');
    ledger.reserve('shadow', image.sha256);
    const unique = require('../../src/services/correctionUniqueSource.service');
    const request = unique.buildRequest(input);
    const start = Date.now(); ledger.event('OPENROUTER_REQUEST_STARTED', { provider: 'openrouter', model: 'openai/gpt-4.1-mini' });
    let httpStatus;
    try {
      const result = await network.scope('shadow', 'generation', () => attempt({
        entry: { provider: 'openrouter', model: 'openai/gpt-4.1-mini', fallbackIndex: 0 },
        messages: request.messages, responseSchema: request.responseSchema, schemaName: request.schemaName,
        maxOutputTokens: 8000, temperature: 0, responseFormat: 'json', attemptTimeoutMs: 45000,
        now: Date.now, env: { OPENROUTER_API_KEY: key, FRONTEND_URL: 'http://localhost:4200' },
        fetchImpl: async (url, options) => {
          if (url !== 'https://openrouter.ai/api/v1/chat/completions') throw Error('SHADOW_ENDPOINT_NOT_ALLOWED');
          const response = await fetchImpl(url, { ...options, signal: AbortSignal.any([options.signal, signal, shutdownSignal].filter(Boolean)), redirect: 'error' });
          httpStatus = response.status; return response;
        }
      }));
      const usage = result.usage || {};
      ledger.event('OPENROUTER_REQUEST_COMPLETED', { httpStatus, latencyMs: Date.now() - start,
        promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
        providerCost: usage.cost, finishReason: result.finishReason, provider: 'openrouter', model: 'openai/gpt-4.1-mini' });
      return result.content;
    } catch { ledger.event('OPENROUTER_REQUEST_FAILED', { httpStatus, latencyMs: Date.now() - start }); throw Error('LOCAL_SHADOW_GENERATION_FAILED'); }
  };
}
module.exports = { inspect, summary, install, createGenerator, suppressProductionAI, visionClass };
