'use strict';
// A local stand-in provider for tests and QA (SIMILARITY_PROVIDER=stub): no network, no cost. It reports one web source matching the
// essay's first 12 words. SIMILARITY_STUB_MODE=async makes it asynchronous: submitted first, completed by the next poll.
const name = 'stub';
const modeFor = env => (String(env.SIMILARITY_STUB_MODE || '').trim().toLowerCase() === 'async' ? 'async' : 'sync');
const isConfigured = () => true;
const estimate = words => ({ units: words, usd: 0 });

const resultFor = text => {
  const first = String(text || '').split(/\s+/u).filter(Boolean).slice(0, 12);
  return { units: 0, costUsd: 0, queryWords: 0, resultCount: first.length ? 1 : 0, foreignText: null,
    sources: first.length < 12 ? [] : [{ kind: 'web', title: 'Example source (stub)', url: 'https://example.test/stub-source', viewUrl: null, compared: true,
      matchedWords: 12, fragments: [first.join(' ')], passages: null }] };
};

async function submit({ text, scanId }, { env }) {
  if (modeFor(env) === 'async') return { state: 'submitted', externalRef: scanId, pending: { stage: 'stub', result: resultFor(text) } };
  return { state: 'completed', result: resultFor(text) };
}

async function poll(_ref, pending) {
  return pending?.result ? { state: 'completed', result: pending.result } : { state: 'failed', errorId: 'stub_lost', charged: false };
}

module.exports = { name, modeFor, isConfigured, estimate, submit, poll };
