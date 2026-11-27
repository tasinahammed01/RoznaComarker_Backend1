'use strict';
// Copyleaks plagiarism API, built against the documentation on docs.copyleaks.com (read 2026-11-27). NOT VERIFIED AGAINST THE LIVE SERVICE:
// the tests use hand-written payloads of the documented shapes. Run a sandbox scan (COPYLEAKS_SANDBOX=true) before any real use.
//
// Flow (asynchronous, webhooks only: Copyleaks has no polling endpoint for results):
//   1. login   POST https://id.copyleaks.com/v3/account/login/api { email, key } -> access_token (valid 48 h; login is limited to 12 per 15 min,
//              so the token is cached and renewed when under an hour is left)
//   2. submit  PUT  https://api.copyleaks.com/v3/scans/submit/file/{scanId} { base64, filename, properties } -> 201
//   3. status webhook  POST {base}/api/similarity/webhooks/copyleaks/{completed|error|...}/{scanId}, with our secret header and the signed
//              developerPayload. completed: the sources found (no positions) -> step 4. error: the job fails (nothing charged).
//   4. export  POST https://api.copyleaks.com/v3/downloads/{scanId}/export/{exportId}: Copyleaks uploads each result (match positions on its
//              crawled copy of our text) and the crawled version to our endpoints, then calls the export-completed webhook.
//   5. delete  PATCH https://api.copyleaks.com/v3.1/scans/delete { scans: [{ id }], purge: true } once the export is in.
// A missed webhook can be sent again: POST https://api.copyleaks.com/v3/scans/{scanId}/webhooks/resend.
// Never indexes into the Shared Data Hub: scanning.copyleaksDb and indexing are left out. Retention: SIMILARITY_COPYLEAKS_RETENTION_HOURS.
// Billing: 1 credit = 250 words or part of 250; the dollar price is the account's (SIMILARITY_COPYLEAKS_USD_PER_CREDIT).
const crypto = require('crypto');
const { ProviderError } = require('../provider');
const { webhookConfig } = require('../policy');
const { fetchCompat } = require('../../httpClient.service');

const name = 'copyleaks';
const ID_URL = 'https://id.copyleaks.com';
const API_URL = 'https://api.copyleaks.com';
const SECRET_HEADER = 'X-Similarity-Webhook-Secret';
const MAX_EXPORT_RESULTS = 50;
const TOKEN_MARGIN_MS = 60 * 60 * 1000;

const modeFor = () => 'async';
const credentials = env => ({ email: String(env.COPYLEAKS_EMAIL || '').trim(), key: String(env.COPYLEAKS_API_KEY || '').trim() });
const isConfigured = (env, settings) => Boolean(credentials(env).email && credentials(env).key && webhookConfig(env) && settings.copyleaksUsdPerCredit);

function estimate(words, settings) {
  const units = Math.max(1, Math.ceil(words / 250));
  return { units, usd: Math.round(units * (settings.copyleaksUsdPerCredit || 0) * 10000) / 10000 };
}

/** The signed developerPayload for one scan: HMAC-SHA256 of the scan id with the webhook secret. */
const payloadFor = (scanId, env) => crypto.createHmac('sha256', webhookConfig(env)?.secret || '').update(`copyleaks:${scanId}`).digest('hex');
const sameText = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
};
/** Our secret header (constant time) and, for status events, the signed payload for this scan id. */
function verifyWebhook(headers, body, scanId, env, { status }) {
  const config = webhookConfig(env);
  if (!config) return false;
  if (!sameText(headers?.[SECRET_HEADER.toLowerCase()], config.secret)) return false;
  return !status || sameText(body?.developerPayload, payloadFor(scanId, env));
}

let tokenCache = null;
const _resetTokenCache = () => { tokenCache = null; };

async function call(fetch, url, options, settings) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.providerTimeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); } catch (error) {
    throw new ProviderError(error?.name === 'AbortError' ? 'timeout' : 'network', { retryable: true, charged: options.method === 'PUT' });
  } finally { clearTimeout(timer); }
}
async function errorIdOf(response) {
  try { const body = JSON.parse(await response.text()); return typeof body?.error?.id === 'string' ? body.error.id.slice(0, 64) : null; } catch { return null; }
}

async function token({ env, settings, fetch }) {
  if (tokenCache && tokenCache.expiresAt - Date.now() > TOKEN_MARGIN_MS) return tokenCache.value;
  const response = await call(fetch, `${ID_URL}/v3/account/login/api`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(credentials(env)) }, settings);
  if (response.status === 429) throw new ProviderError('rate_limited', { retryable: true });
  if (response.status === 400 || response.status === 401) throw new ProviderError('auth');
  if (!response.ok) throw new ProviderError(`http_${response.status}`, { retryable: response.status >= 500 });
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw new ProviderError('bad_response', { retryable: true }); }
  if (typeof body?.access_token !== 'string') throw new ProviderError('bad_response', { retryable: true });
  tokenCache = { value: body.access_token, expiresAt: Date.parse(body['.expires']) || Date.now() + 47 * 3600e3 };
  return tokenCache.value;
}

async function api(ctx, method, path, body) {
  const bearer = await token(ctx);
  const response = await call(ctx.fetch, `${API_URL}${path}`, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, ctx.settings);
  if (response.status === 401) { _resetTokenCache(); throw new ProviderError('auth', { retryable: true }); }
  if (response.status === 429) throw new ProviderError('rate_limited', { retryable: true });
  if (!response.ok) {
    const id = await errorIdOf(response);
    throw new ProviderError(id || `http_${response.status}`, { retryable: response.status >= 500 });
  }
  return response;
}

const withCtx = ctx => ({ ...ctx, fetch: ctx.fetch || fetchCompat });

async function submit({ text, words, scanId }, rawCtx) {
  const ctx = withCtx(rawCtx);
  if (words < 6 || String(text).trim().length < 30) throw new ProviderError('too_short');
  const config = webhookConfig(ctx.env);
  if (!config) throw new ProviderError('not_configured');
  await api(ctx, 'PUT', `/v3/scans/submit/file/${scanId}`, {
    base64: Buffer.from(text, 'utf8').toString('base64'),
    filename: 'essay.txt',
    properties: {
      action: 0,
      sandbox: String(ctx.env.COPYLEAKS_SANDBOX || '').trim().toLowerCase() === 'true',
      expiration: ctx.settings.copyleaksRetentionHours,
      scanMethodAlgorithm: 0,
      developerPayload: payloadFor(scanId, ctx.env),
      webhooks: { status: `${config.baseUrl}/api/similarity/webhooks/copyleaks/{STATUS}/${scanId}`, statusHeaders: [[SECRET_HEADER, config.secret]] },
      scanning: { internet: true },
      exclude: { quotes: Boolean(ctx.settings.excludeQuotes) },
      filters: { minCopiedWords: ctx.settings.minMatchWords }
    }
  });
  return { state: 'submitted', externalRef: scanId, pending: { stage: 'scanning' } };
}

const GROUPS = Object.freeze([['internet', 'web'], ['database', 'repository'], ['batch', 'repository'], ['repositories', 'repository']]);
function summaryOf(body) {
  const results = [];
  for (const [group, kind] of GROUPS) {
    for (const r of Array.isArray(body?.results?.[group]) ? body.results[group] : []) {
      if (typeof r?.id !== 'string' || !r.id) continue;
      results.push({ id: r.id.slice(0, 64), kind, title: String(r.title || '').slice(0, 300), url: kind === 'web' && typeof r.url === 'string' ? r.url : null,
        matchedWords: Math.max(0, Math.round(Number(r.matchedWords) || 0)) });
    }
  }
  results.sort((a, b) => b.matchedWords - a.matchedWords);
  return { totalWords: Math.max(0, Math.round(Number(body?.scannedDocument?.totalWords) || 0)),
    credits: Math.max(0, Math.round(Number(body?.scannedDocument?.credits) || 0)), results: results.slice(0, MAX_EXPORT_RESULTS) };
}

const resultOf = (summary, results, foreignText, settings) => ({
  units: summary.credits, costUsd: Math.round(summary.credits * (settings.copyleaksUsdPerCredit || 0) * 10000) / 10000, queryWords: summary.totalWords,
  resultCount: summary.results.length, foreignText,
  sources: summary.results.map(r => {
    const passages = results?.[r.id]?.length ? results[r.id] : null;
    return { kind: r.kind, title: r.title, url: r.url, viewUrl: null, compared: Boolean(passages), matchedWords: r.matchedWords, fragments: null, passages };
  })
});

/** A status event. completed -> asks for the export (or completes when nothing matched); error -> failed, nothing charged. */
async function onStatus(status, body, pending, scanId, rawCtx) {
  const ctx = withCtx(rawCtx);
  if (status === 'error') return { state: 'failed', errorId: typeof body?.error?.id === 'string' ? body.error.id.slice(0, 64) : 'provider_error', charged: false };
  if (status !== 'completed' || pending?.stage !== 'scanning') return { state: 'ignored' };
  const summary = summaryOf(body);
  if (!summary.results.length) return { state: 'completed', result: resultOf(summary, {}, null, ctx.settings) };
  const config = webhookConfig(ctx.env);
  const exportId = `x${crypto.randomBytes(12).toString('hex')}`;
  const base = `${config.baseUrl}/api/similarity/webhooks/copyleaks/export/${scanId}`;
  const headers = [[SECRET_HEADER, config.secret]];
  await api(ctx, 'POST', `/v3/downloads/${scanId}/export/${exportId}`, {
    completionWebhook: `${base}/completed`, completionWebhookHeaders: headers, maxRetries: 3,
    crawledVersion: { endpoint: `${base}/crawled`, verb: 'POST', headers },
    results: summary.results.map(r => ({ id: r.id, endpoint: `${base}/results/${r.id}`, verb: 'POST', headers }))
  });
  return { state: 'waiting', pending: { stage: 'exporting', exportId, summary, results: {} } };
}

const MATCH_TYPES = Object.freeze(['identical', 'minorChanges', 'relatedMeaning']);
/** One exported file. A result keeps only its positions on the crawled text (never the matched page's text); the crawled text is kept. */
function onExportUpload(kind, resultId, body, pending) {
  if (pending?.stage !== 'exporting') return pending;
  if (kind === 'crawled') return { ...pending, crawledText: typeof body?.text?.value === 'string' ? body.text.value : '' };
  if (kind !== 'results' || !pending.summary.results.some(r => r.id === resultId)) return pending;
  const spans = [];
  for (const type of MATCH_TYPES) {
    const chars = body?.text?.comparison?.[type]?.source?.chars;
    const starts = Array.isArray(chars?.starts) ? chars.starts : [];
    const lengths = Array.isArray(chars?.lengths) ? chars.lengths : [];
    starts.forEach((start, i) => { if (Number.isInteger(start) && Number.isInteger(lengths[i])) spans.push({ start, length: lengths[i] }); });
  }
  return { ...pending, results: { ...pending.results, [resultId]: spans } };
}

/** The export-completed event: every upload healthy and the crawled text present -> the normalised result; then the scan is deleted. */
async function onExportCompleted(body, pending, scanId, rawCtx) {
  const ctx = withCtx(rawCtx);
  if (pending?.stage !== 'exporting') return { state: 'ignored' };
  const healthy = body?.completed === true && (Array.isArray(body.tasks) ? body.tasks : []).every(t => t?.isHealthy === true);
  if (!healthy) return { state: 'failed', errorId: 'export_failed', charged: true };
  if (typeof pending.crawledText !== 'string') return { state: 'failed', errorId: 'export_incomplete', charged: true };
  const result = resultOf(pending.summary, pending.results, pending.crawledText, ctx.settings);
  await api(ctx, 'PATCH', '/v3.1/scans/delete', { scans: [{ id: scanId }], purge: true }).catch(() => {});
  return { state: 'completed', result };
}

async function resend(scanId, rawCtx) {
  await api(withCtx(rawCtx), 'POST', `/v3/scans/${scanId}/webhooks/resend`);
}

module.exports = { name, modeFor, isConfigured, estimate, submit, onStatus, onExportUpload, onExportCompleted, resend, verifyWebhook, payloadFor,
  SECRET_HEADER, _resetTokenCache };
