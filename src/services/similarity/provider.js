'use strict';
// The external similarity provider behind one interface, chosen by SIMILARITY_PROVIDER (copyscape | copyleaks | stub; none = internal only).
//
//   name                       'copyscape' | 'copyleaks' | 'stub' (stored only in the teacher-only audit)
//   modeFor(env)               'sync' (submit returns the result) | 'async' (submit returns submitted; webhooks or poll complete it)
//   isConfigured(env, settings) every credential and setting it needs is present
//   estimate(words, settings)  { units, usd }: the provider's billing units and the estimated dollars (for the daily spend stop)
//   submit(input, ctx)         input { text, words, scanId }; ctx { env, settings, fetch }
//                              -> { state: 'completed', result } | { state: 'submitted', externalRef, pending }
//   poll?(ref, pending, ctx)   async without webhooks: { state: 'waiting' | 'completed' | 'failed', ... }
//   resend?(ref, ctx)          async with webhooks: ask the provider to send the status event again
//
// A normalised result (the only thing above the adapter): { units, costUsd, queryWords, resultCount, foreignText, sources: [{ kind: web |
// repository, title, url, viewUrl, compared, matchedWords, passages: [{ start, length }] on foreignText | null, fragments: [matched text] | null }] }.
// Provider percentages are never used: the report computes its own (overall.js). Errors are ProviderError { code, retryable, charged }.
const { providerName } = require('./policy');
const { locateFragments, mapForeignSpans } = require('./locate');

class ProviderError extends Error {
  constructor(code, { retryable = false, charged = false } = {}) {
    super(`similarity provider error: ${code}`);
    this.name = 'ProviderError';
    this.code = code;
    this.retryable = retryable;
    this.charged = charged;
  }
  toJSON() { return { code: this.code, retryable: this.retryable, charged: this.charged }; }
}

const ADAPTERS = {
  copyscape: () => require('./providers/copyscape'),
  copyleaks: () => require('./providers/copyleaks'),
  stub: () => require('./providers/stub')
};

/** The adapter for SIMILARITY_PROVIDER, or null (none). */
function getProvider(env = process.env) {
  const name = providerName(env);
  return ADAPTERS[name] ? ADAPTERS[name]() : null;
}

/** Generic labels shown to the teacher (provider names never appear). */
const SOURCE_LABELS = Object.freeze({ web: 'Internet source', repository: 'Published or institutional source', internal: 'Another submission in Rubrilo' });

const safeUrl = value => {
  try { const url = new URL(String(value)); return ['http:', 'https:'].includes(url.protocol) ? url.toString().slice(0, 2048) : undefined; } catch { return undefined; }
};

/**
 * The normalised result's sources as report sources (no sourceId yet): spans on the canonical text from the provider's positions or by
 * locating its matched text. A compared source that cannot be placed on the essay is kept as "not compared" (no highlight, no percentage).
 */
function resolveSources(result, { text, tokens, blocked, settings }) {
  const opts = { minWords: settings.minMatchWords, blocked };
  return (Array.isArray(result?.sources) ? result.sources : []).map(source => {
    let spans = [];
    if (source.compared && Array.isArray(source.passages)) spans = mapForeignSpans(result.foreignText, source.passages, text, tokens, opts);
    else if (source.compared && Array.isArray(source.fragments)) spans = locateFragments(source.fragments, text, tokens, opts);
    const kind = source.kind === 'repository' ? 'repository' : 'web';
    const out = { kind, label: SOURCE_LABELS[kind], title: String(source.title || '').slice(0, 300) || undefined, url: safeUrl(source.url),
      viewUrl: source.viewUrl ? safeUrl(source.viewUrl) : undefined, compared: spans.length > 0, spans };
    if (!out.compared) out.approxWords = Math.max(0, Math.round(Number(source.matchedWords) || 0));
    return out;
  });
}

module.exports = { getProvider, resolveSources, ProviderError, SOURCE_LABELS };
