'use strict';
// Handwriting spacing and capitals check (L2), production stage. Default OFF (HANDWRITING_MECHANICS_CHECK_ENABLED=true turns it on).
// Runs only for exact-source essays, beside the correction call, and NEVER delays or fails marking: every problem skips the page,
// line or group and is logged as counts; the caller bounds the wait. Never logs student text. Never rewrites the transcript.
const crypto = require('crypto');
const path = require('path');
const engine = require('./engine');
const profile = require('./profile');

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const FEATURE = 'handwriting_mechanics_check';
const SETTLE_GRACE_MS = 1000;

/** Same rule as ocrPipeline's toAbsoluteStoredPath: a stored path must resolve inside the backend folder. */
function storedPath(value) {
  if (!value || typeof value !== 'string') return null;
  const resolved = path.resolve(BACKEND_ROOT, value);
  return resolved !== BACKEND_ROOT && resolved.startsWith(`${BACKEND_ROOT}${path.sep}`) ? resolved : null;
}

/** Configuration, read from the environment each time. An invalid value falls back to its default and is reported, never thrown. */
function settings(env = process.env) {
  const invalid = [];
  const number = (name, fallback, min, max, integer = true) => {
    const raw = env?.[name];
    if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) { invalid.push(name); return fallback; }
    return value;
  };
  return { enabled: String(env?.HANDWRITING_MECHANICS_CHECK_ENABLED ?? '').trim().toLowerCase() === 'true',
    concurrency: number('HANDWRITING_MECHANICS_CONCURRENCY', 4, 1, 16),
    callTimeoutMs: number('HANDWRITING_MECHANICS_CALL_TIMEOUT_MS', 20000, 1, 120000),
    stageBudgetMs: number('HANDWRITING_MECHANICS_STAGE_BUDGET_MS', 30000, 1, 600000),
    waitAfterCorrectionMs: number('HANDWRITING_MECHANICS_WAIT_AFTER_CORRECTION_MS', 8000, 0, 120000),
    maxLines: number('HANDWRITING_MECHANICS_MAX_LINES', 150, 1, 2000),
    linesPerCrop: number('HANDWRITING_MECHANICS_LINES_PER_CROP', 1, 1, 6),
    minConfidence: number('HANDWRITING_MECHANICS_MIN_CONFIDENCE', 0.8, 0.5, 1, false),
    invalid };
}

const isExact = doc => require('../../utils/sourceFidelity').isExact(doc);
const applies = (doc, env = process.env) => settings(env).enabled && isExact(doc);

/** What goes into correctionSourceHash: null (nothing added, hash unchanged) unless the check applies to this essay. */
function hashIdentity(doc, env = process.env) {
  if (!applies(doc, env)) return null;
  const s = settings(env);
  return { version: engine.VERSION, prompt: engine.PROMPT_VERSION, schema: engine.SCHEMA_VERSION, model: profile.MODEL,
    minConfidence: s.minConfidence, linesPerCrop: s.linesPerCrop };
}

// One limiter for the whole process, so several essays at once cannot flood the provider.
const limiter = { active: 0, waiting: [] };
function acquire(max, signal) {
  const release = () => { limiter.active -= 1; const next = limiter.waiting.shift(); if (next) next(); };
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { code: 'ABORTED' }));
  if (limiter.active < max) { limiter.active += 1; return Promise.resolve(release); }
  return new Promise((resolve, reject) => {
    const grant = () => { signal.removeEventListener('abort', cancel); limiter.active += 1; resolve(release); };
    const cancel = () => { const at = limiter.waiting.indexOf(grant); if (at >= 0) limiter.waiting.splice(at, 1);
      reject(Object.assign(new Error('aborted'), { code: 'ABORTED' })); };
    limiter.waiting.push(grant);
    signal.addEventListener('abort', cancel, { once: true });
  });
}

const safeCode = error => (typeof error?.code === 'string' && /^[A-Z0-9_]{1,64}$/u.test(error.code) ? error.code : 'UNEXPECTED_ERROR');
const bump = (counts, key) => { counts[key] = (counts[key] || 0) + 1; };
const pageReason = (code, message) => Object.assign(new Error(message), { pageReason: code });

/** Exactly the pixels the reader and the geometry used, or a skip reason. */
async function pageImage(stored, deps) {
  if (stored.coordinateSpace && stored.coordinateSpace !== 'display-image') throw pageReason('COORDINATE_SPACE', 'geometry space');
  const pdfRaster = Boolean(stored.derivedImageFileId);
  let file, bytes;
  try {
    file = await deps.loadFile(String(pdfRaster ? stored.derivedImageFileId : stored.fileId));
    const absolute = storedPath(file?.path);
    if (!absolute) throw pageReason('FILE_UNAVAILABLE', 'path');
    bytes = await deps.readFile(absolute);
  } catch (error) { throw error.pageReason ? error : pageReason('FILE_UNAVAILABLE', 'read'); }
  let data, width, height;
  try {
    if (pdfRaster) {
      if (!file.rasterHash || sha(bytes) !== file.rasterHash) throw pageReason('PAGE_IMAGE_MISMATCH', 'raster hash');
      ({ width, height } = await require('sharp')(bytes, { failOn: 'error' }).metadata()); data = bytes;
    } else {
      const oriented = await require('../gptVisionExact/imageInput').orientImage(bytes);
      if (!stored.ocrInputSha256 || sha(oriented.data) !== stored.ocrInputSha256) throw pageReason('PAGE_IMAGE_MISMATCH', 'image hash');
      ({ width, height } = oriented.info); data = oriented.data;
    }
  } catch (error) { throw error.pageReason ? error : pageReason('PAGE_IMAGE_INVALID', 'decode'); }
  if (width !== Number(stored.width) || height !== Number(stored.height)) throw pageReason('PAGE_IMAGE_MISMATCH', 'size');
  return { data, width, height };
}

const inactive = status => ({ done: Promise.resolve(), stop() {}, settle: async () => ({ status, findings: [], summary: null }) });

/**
 * Starts the check and returns { done, stop(reason), settle({ correctionSucceeded, waitMs }) }. settle never throws and resolves
 * within waitMs plus a short grace: { status, findings, summary }. findings are raw correction candidates for validateCorrections.
 */
function start({ doc, transcript, pages, transcriptComplete, env = process.env, deps: injected = {} } = {}) {
  const s = settings(env);
  if (!s.enabled || !isExact(doc)) return inactive('disabled');
  const deps = { loadFile: id => require('../../models/File').findById(id).select('path rasterHash width height').lean(),
    readFile: file => require('fs/promises').readFile(file), logger: require('../../utils/logger'), now: Date.now, ...injected };
  if (!deps.providerAttempt) deps.providerAttempt = options => require('../aiGateway.service').providerAttempt(options);
  const startedAt = deps.now(), controller = new AbortController(), text = typeof transcript === 'string' ? transcript : '';
  const summary = { version: engine.VERSION, promptVersion: engine.PROMPT_VERSION, schemaVersion: engine.SCHEMA_VERSION, status: null, reason: null,
    pages: 0, pagesSkipped: {}, lines: 0, linesChecked: 0, linesSkipped: {}, groups: 0, calls: 0, callsFailed: {}, groupsDiscarded: {},
    promptTokens: 0, completionTokens: 0, costUsd: 0, candidates: { SPC: 0, CAP: 0 }, findings: 0, findingsDropped: {},
    durationMs: 0, aborted: null, settingsInvalid: s.invalid };
  const completed = [];
  let fatal = null, finished = null;
  const stop = reason => { if (!controller.signal.aborted) { summary.aborted = reason; controller.abort(reason); } };
  const budget = setTimeout(() => stop('stage_budget'), s.stageBudgetMs);

  async function runGroup(group, image) {
    let release;
    try { release = await acquire(s.concurrency, controller.signal); } catch { bump(summary.groupsDiscarded, 'NOT_STARTED'); return; }
    try {
      const items = engine.groupItems(group);
      const crop = await require('sharp')(image.data).extract(engine.cropBox(group, image.width, image.height))
        .jpeg({ quality: 92, chromaSubsampling: '4:4:4' }).toBuffer();
      if (controller.signal.aborted) { bump(summary.groupsDiscarded, 'NOT_STARTED'); return; }
      summary.calls += 1;
      let result;
      try {
        result = await deps.providerAttempt({ entry: { provider: 'openrouter', model: profile.MODEL }, feature: FEATURE,
          requestProfile: profile.REQUEST_PROFILE, messages: [{ role: 'system', content: engine.PROMPT }, { role: 'user', content: [
            { type: 'text', text: engine.userMessage(group, items) },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${crop.toString('base64')}` } }] }],
          maxOutputTokens: profile.MAX_OUTPUT_TOKENS, temperature: 0, responseFormat: 'json', responseSchema: engine.responseSchema(items),
          schemaName: 'handwriting_mechanics', attemptTimeoutMs: s.callTimeoutMs, env, now: Date.now, signal: controller.signal,
          ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      } catch (error) { bump(summary.callsFailed, safeCode(error)); return; }
      summary.promptTokens += Number(result?.usage?.prompt_tokens) || 0;
      summary.completionTokens += Number(result?.usage?.completion_tokens) || 0;
      summary.costUsd += Number(result?.usage?.cost) || 0;
      const reply = engine.parseReply(result?.content, items);
      if (!reply.ok) { bump(summary.groupsDiscarded, reply.reason); return; }
      completed.push({ items, reply });
    } catch (error) { bump(summary.groupsDiscarded, safeCode(error)); }
    finally { release(); }
  }

  async function run() {
    if (transcriptComplete !== true || !text) { summary.reason = 'TRANSCRIPT_INCOMPLETE'; return; }
    const storedPages = Array.isArray(doc.ocrPages) ? doc.ocrPages : [];
    const work = [];
    let linesLeft = s.maxLines;
    for (const page of Array.isArray(pages) ? pages : []) {
      if (controller.signal.aborted) return;
      summary.pages += 1;
      const stored = storedPages.find(p => String(p?.fileId) === String(page?.fileId) && Number(p?.pageNumber || 1) === Number(page?.pageNumber || 1));
      if (!stored) { bump(summary.pagesSkipped, 'PAGE_NOT_FOUND'); continue; }
      let image;
      try { image = await pageImage(stored, deps); } catch (error) { bump(summary.pagesSkipped, error.pageReason || 'PAGE_PREPARE_FAILED'); continue; }
      const lines = engine.pageLines({ text: page.text, startChar: page.startChar, words: stored.words, width: image.width, height: image.height });
      summary.lines += lines.length;
      const usable = [];
      for (const line of lines) {
        if (!line.box) bump(summary.linesSkipped, line.reason || 'NO_GEOMETRY');
        else if (linesLeft <= 0) bump(summary.linesSkipped, 'MAX_LINES');
        else { usable.push(line); linesLeft -= 1; }
      }
      summary.linesChecked += usable.length;
      for (const group of engine.groupLines(usable, s.linesPerCrop).groups) work.push([group, image]);
    }
    summary.groups = work.length;
    await Promise.all(work.map(([group, image]) => runGroup(group, image)));
  }

  const done = run().catch(error => { fatal = safeCode(error); }).finally(() => clearTimeout(budget));
  const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(resolve, Math.max(0, ms)))]);

  function finish(discarded) {
    if (finished) return finished;
    clearTimeout(budget);
    const findings = [];
    if (!discarded && !fatal) {
      const context = engine.textContext(text);
      for (const { items, reply } of completed) {
        for (const candidate of engine.candidates(items, reply, { ...context, minConfidence: s.minConfidence })) {
          summary.candidates[candidate.symbol] += 1;
          const finding = engine.buildFinding(candidate, text);
          if (finding.dropped) bump(summary.findingsDropped, finding.dropped); else findings.push(finding);
        }
      }
    }
    const allLinesChecked = !Object.keys(summary.pagesSkipped).length && !Object.keys(summary.linesSkipped).length;
    summary.status = discarded ? 'discarded' : fatal ? 'failed' : summary.groups === 0 ? 'skipped'
      : completed.length === summary.groups && allLinesChecked ? 'completed' : completed.length ? 'partial' : 'failed';
    if (fatal) summary.reason = fatal;
    summary.findings = findings.length;
    summary.costUsd = Math.round(summary.costUsd * 1e6) / 1e6;
    summary.durationMs = deps.now() - startedAt;
    try {
      if (s.invalid.length) deps.logger.warn({ event: 'handwriting_mechanics_settings_invalid', names: s.invalid });
      deps.logger.info({ event: 'handwriting_mechanics_check', submissionId: String(doc?._id || ''), ...summary });
    } catch { /* Logging never fails marking. */ }
    finished = { status: summary.status, findings: discarded ? [] : findings, summary: { ...summary } };
    return finished;
  }

  async function settle({ correctionSucceeded, waitMs = s.waitAfterCorrectionMs } = {}) {
    try {
      if (correctionSucceeded !== true) { stop('correction_failed'); await within(done, SETTLE_GRACE_MS); return finish(true); }
      await within(done, Math.min(Number(waitMs) || 0, s.waitAfterCorrectionMs));
      stop('wait_limit');
      await within(done, SETTLE_GRACE_MS);
      return finish(false);
    } catch {
      return { status: 'failed', findings: [], summary: { ...summary, status: 'failed', reason: 'SETTLE_FAILED' } };
    }
  }
  return { done, stop, settle };
}

module.exports = { FEATURE, settings, applies, hashIdentity, start, storedPath };
