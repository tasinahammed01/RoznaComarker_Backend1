'use strict';
// Copyscape Premium API (www.copyscape.com/api-guide.php, read 2026-11-27): one synchronous POST per check, o=csearch (the internet), f=json,
// c = full comparisons (the matched text of the top results), l = a hard spend limit in dollars, x=1 = free test mode. No match positions:
// the matched text is located on our text (locate.js). Price: 3 cents for the first 200 words, 1 cent per extra 100 words or part of 100.
// The key is sent only in the POST body; it is never logged or put in an error.
const { ProviderError } = require('../provider');
const { fetchCompat } = require('../../httpClient.service');

const ENDPOINT = 'https://www.copyscape.com/api/';
const name = 'copyscape';
const modeFor = () => 'sync';

const isConfigured = env => Boolean(String(env.COPYSCAPE_USERNAME || '').trim() && String(env.COPYSCAPE_API_KEY || '').trim());

function estimate(words) {
  const cents = 3 + Math.ceil(Math.max(0, words - 200) / 100);
  return { units: words, usd: cents / 100 };
}

const codeFor = message => {
  if (/credit|fund|balance/iu.test(message)) return 'insufficient_funds';
  if (/user|key|auth|login/iu.test(message)) return 'auth';
  return 'provider_error';
};
const count = value => Math.max(0, Math.round(Number(value) || 0));

async function submit({ text, words }, { env, settings, fetch = fetchCompat }) {
  const form = new URLSearchParams({ u: String(env.COPYSCAPE_USERNAME || '').trim(), k: String(env.COPYSCAPE_API_KEY || '').trim(), o: 'csearch',
    e: 'UTF-8', t: text, f: 'json', c: String(settings.fullComparisons), l: (estimate(words).usd + 0.02).toFixed(2) });
  if (String(env.COPYSCAPE_TEST_MODE || '').trim().toLowerCase() === 'true') form.set('x', '1');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), settings.providerTimeoutMs);
  let response;
  try {
    response = await fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form.toString(),
      signal: controller.signal });
  } catch (error) {
    // the request may have reached Copyscape and been charged
    throw new ProviderError(error?.name === 'AbortError' ? 'timeout' : 'network', { retryable: true, charged: true });
  } finally { clearTimeout(timer); }
  if (!response.ok) throw new ProviderError(`http_${response.status}`, { retryable: response.status >= 500 || response.status === 429 });
  let body;
  try { body = JSON.parse(await response.text()); } catch { throw new ProviderError('bad_response', { retryable: true, charged: true }); }
  if (body && typeof body.error === 'string') throw new ProviderError(codeFor(body.error));
  const results = Array.isArray(body?.result) ? body.result : [];
  return { state: 'completed', result: {
    units: count(body.querywords), costUsd: Number(body.cost) || 0, queryWords: count(body.querywords), resultCount: count(body.count ?? results.length),
    sources: results.map(r => {
      const compared = typeof r.textmatched === 'string';
      return { kind: 'web', title: r.title, url: r.url, viewUrl: r.viewurl, compared, matchedWords: count(compared ? r.wordsmatched : r.minwordsmatched),
        fragments: compared ? [r.textmatched] : null, passages: null };
    })
  } };
}

module.exports = { name, modeFor, isConfigured, estimate, submit, ENDPOINT };
