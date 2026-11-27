'use strict';
// Similarity providers behind one interface: Copyscape (synchronous, built in full), Copyleaks (asynchronous: submit, then webhooks; built
// against the documented contract with hand-written fixtures, NOT verified against the live service) and the stub. Every request goes to a
// fake fetch: no network. The normalised result and its mapping onto the canonical text (provider.js) are tested here too.
const crypto = require('crypto');
const { getProvider, resolveSources, ProviderError, SOURCE_LABELS } = require('../src/services/similarity/provider');
const copyscape = require('../src/services/similarity/providers/copyscape');
const copyleaks = require('../src/services/similarity/providers/copyleaks');
const stub = require('../src/services/similarity/providers/stub');
const { readSettings } = require('../src/services/similarity/policy');
const { tokenize } = require('../src/services/similarity/normalize');
const F = require('./helpers/similarityProviderFixtures');

const words = (seed, n) => Array.from({ length: n }, (_, i) => `q${seed}${i}`).join(' ');
const settings = (env = {}) => readSettings(env).settings;
const KEY = 'csk-0123456789abcdef';
const CS_ENV = Object.freeze({ COPYSCAPE_USERNAME: 'tester', COPYSCAPE_API_KEY: KEY });
const SECRET = 'w'.repeat(40);
const CL_ENV = Object.freeze({ COPYLEAKS_EMAIL: 'api@example.test', COPYLEAKS_API_KEY: '00000000-0000-0000-0000-000000000000',
  SIMILARITY_WEBHOOK_BASE_URL: 'https://api.example.test', SIMILARITY_WEBHOOK_SECRET: SECRET, SIMILARITY_COPYLEAKS_USD_PER_CREDIT: '0.05' });

describe('getProvider', () => {
  test('by SIMILARITY_PROVIDER; none (the default) or an unknown name: no external provider', () => {
    expect(getProvider({})).toBeNull();
    expect(getProvider({ SIMILARITY_PROVIDER: 'none' })).toBeNull();
    expect(getProvider({ SIMILARITY_PROVIDER: 'turnitin' })).toBeNull();
    expect(getProvider({ SIMILARITY_PROVIDER: 'copyscape' })).toBe(copyscape);
    expect(getProvider({ SIMILARITY_PROVIDER: 'copyleaks' })).toBe(copyleaks);
    expect(getProvider({ SIMILARITY_PROVIDER: 'stub' })).toBe(stub);
  });
  test('every adapter has the same interface; Copyscape is synchronous, Copyleaks asynchronous', () => {
    for (const p of [copyscape, copyleaks, stub]) {
      expect(typeof p.name).toBe('string');
      expect(['sync', 'async']).toContain(p.modeFor({}));
      for (const fn of ['isConfigured', 'estimate', 'submit']) expect(typeof p[fn]).toBe('function');
    }
    expect(copyscape.modeFor({})).toBe('sync');
    expect(copyleaks.modeFor({})).toBe('async');
    expect(stub.modeFor({})).toBe('sync');
    expect(stub.modeFor({ SIMILARITY_STUB_MODE: 'async' })).toBe('async');
  });
});

describe('Copyscape adapter', () => {
  test('configured only with a username and a key', () => {
    expect(copyscape.isConfigured({}, settings())).toBe(false);
    expect(copyscape.isConfigured({ COPYSCAPE_USERNAME: 'u' }, settings())).toBe(false);
    expect(copyscape.isConfigured(CS_ENV, settings())).toBe(true);
  });
  test('estimate: 3 cents for the first 200 words, 1 cent per extra 100 words or part of 100', () => {
    const usd = n => copyscape.estimate(n, settings()).usd;
    expect(usd(1)).toBe(0.03);
    expect(usd(200)).toBe(0.03);
    expect(usd(201)).toBe(0.04);
    expect(usd(300)).toBe(0.04);
    expect(usd(301)).toBe(0.05);
    expect(usd(1000)).toBe(0.11);
  });
  test('one POST with the documented fields, a spend limit, JSON format and full comparisons; test mode only when asked', async () => {
    const text = words('a', 240);
    const fetch = F.fakeFetch([{ match: url => url === 'https://www.copyscape.com/api/', reply: { body: F.copyscapeSearch(words('a', 14)) } }]);
    await copyscape.submit({ text, words: 240 }, { env: CS_ENV, settings: settings(), fetch });
    expect(fetch.calls).toHaveLength(1);
    const call = fetch.calls[0];
    expect(call.method).toBe('POST');
    expect(call.headers['Content-Type']).toBe('application/x-www-form-urlencoded');
    const form = Object.fromEntries(new URLSearchParams(call.body));
    expect(form).toEqual({ u: 'tester', k: KEY, o: 'csearch', e: 'UTF-8', t: text, f: 'json', c: '10', l: '0.06' });
    const testMode = F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch('') } }]);
    await copyscape.submit({ text, words: 240 }, { env: { ...CS_ENV, COPYSCAPE_TEST_MODE: 'true' }, settings: settings(), fetch: testMode });
    expect(new URLSearchParams(testMode.calls[0].body).get('x')).toBe('1');
  });
  test('the result: compared results carry their matched text; the others are found but not compared', async () => {
    const fetch = F.fakeFetch([{ match: () => true, reply: { body: F.copyscapeSearch('matched words here') } }]);
    const out = await copyscape.submit({ text: words('a', 240), words: 240 }, { env: CS_ENV, settings: settings(), fetch });
    expect(out.state).toBe('completed');
    expect(out.result).toEqual({ units: 240, costUsd: 0.04, queryWords: 240, resultCount: 2, sources: [
      { kind: 'web', title: 'Example page one', url: 'https://example.test/page-one', viewUrl: 'https://view.example.test/c/abc',
        compared: true, matchedWords: 14, fragments: ['matched words here'], passages: null },
      { kind: 'web', title: 'Example page two', url: 'https://example.test/page-two', viewUrl: 'https://view.example.test/c/def',
        compared: false, matchedWords: 9, fragments: null, passages: null }] });
  });
  test('an error answer becomes a coded ProviderError; the key and the text never appear in it', async () => {
    const text = words('secretessay', 30);
    for (const [message, code, charged] of [['No credits remaining', 'insufficient_funds', false], ['Username or API key not valid', 'auth', false],
      ['Something else', 'provider_error', false]]) {
      const fetch = F.fakeFetch([{ match: () => true, reply: { body: { error: message } } }]);
      const error = await copyscape.submit({ text, words: 30 }, { env: CS_ENV, settings: settings(), fetch }).catch(e => e);
      expect(error).toBeInstanceOf(ProviderError);
      expect(error).toMatchObject({ code, charged });
      expect(`${error.message} ${JSON.stringify(error)}`).not.toMatch(new RegExp(`${KEY}|qsecretessay|tester`));
    }
  });
  test('a timeout may have been charged; a bad answer and an HTTP error are coded', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const timeout = await copyscape.submit({ text: 'x', words: 1 }, { env: CS_ENV, settings: settings(), fetch: F.fakeFetch([{ match: () => true, reply: abort }]) }).catch(e => e);
    expect(timeout).toMatchObject({ code: 'timeout', charged: true, retryable: true });
    const bad = await copyscape.submit({ text: 'x', words: 1 }, { env: CS_ENV, settings: settings(), fetch: F.fakeFetch([{ match: () => true, reply: { body: 'not json' } }]) }).catch(e => e);
    expect(bad).toMatchObject({ code: 'bad_response' });
    const http = await copyscape.submit({ text: 'x', words: 1 }, { env: CS_ENV, settings: settings(), fetch: F.fakeFetch([{ match: () => true, reply: { status: 503, body: {} } }]) }).catch(e => e);
    expect(http).toMatchObject({ code: 'http_503', retryable: true, charged: false });
  });
});

describe('Copyleaks adapter (documented contract; not verified against the live service)', () => {
  beforeEach(() => copyleaks._resetTokenCache());
  const SCAN = 'rb0123456789abcdef01234567';
  const login = { match: url => url === 'https://id.copyleaks.com/v3/account/login/api',
    reply: { body: { access_token: 'tok-1', '.issued': new Date().toISOString(), '.expires': new Date(Date.now() + 48 * 3600e3).toISOString() } } };
  const submitRoute = { match: url => url.startsWith('https://api.copyleaks.com/v3/scans/submit/file/'), reply: { status: 201, body: '' } };

  test('configured only with an email, a key, a public webhook (https + secret) and a price per credit', () => {
    expect(copyleaks.isConfigured(CL_ENV, settings(CL_ENV))).toBe(true);
    for (const missing of ['COPYLEAKS_EMAIL', 'COPYLEAKS_API_KEY', 'SIMILARITY_WEBHOOK_BASE_URL', 'SIMILARITY_WEBHOOK_SECRET', 'SIMILARITY_COPYLEAKS_USD_PER_CREDIT']) {
      const env = { ...CL_ENV, [missing]: '' };
      expect(copyleaks.isConfigured(env, settings(env))).toBe(false);
    }
  });
  test('estimate: 1 credit per 250 words or part, times the configured price', () => {
    const s = settings(CL_ENV);
    expect(copyleaks.estimate(1, s)).toEqual({ units: 1, usd: 0.05 });
    expect(copyleaks.estimate(250, s)).toEqual({ units: 1, usd: 0.05 });
    expect(copyleaks.estimate(251, s)).toEqual({ units: 2, usd: 0.1 });
  });
  test('submit: logs in once (token cached), PUTs the text as base64 with webhooks, secret header, signed payload, short retention, no hub indexing', async () => {
    const fetch = F.fakeFetch([login, submitRoute]);
    const text = words('b', 60);
    const out = await copyleaks.submit({ text, words: 60, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    expect(out).toEqual({ state: 'submitted', externalRef: SCAN, pending: { stage: 'scanning' } });
    await copyleaks.submit({ text, words: 60, scanId: `${SCAN.slice(0, -1)}9` }, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    expect(fetch.calls.filter(c => c.url.includes('/login/')).length).toBe(1);
    const put = fetch.calls[1];
    expect(put.method).toBe('PUT');
    expect(put.url).toBe(`https://api.copyleaks.com/v3/scans/submit/file/${SCAN}`);
    expect(put.headers.Authorization).toBe('Bearer tok-1');
    const body = JSON.parse(put.body);
    expect(Buffer.from(body.base64, 'base64').toString('utf8')).toBe(text);
    expect(body.filename).toBe('essay.txt');
    expect(body.properties).toEqual({ action: 0, sandbox: false, expiration: 24, scanMethodAlgorithm: 0,
      developerPayload: crypto.createHmac('sha256', SECRET).update(`copyleaks:${SCAN}`).digest('hex'),
      webhooks: { status: `https://api.example.test/api/similarity/webhooks/copyleaks/{STATUS}/${SCAN}`,
        statusHeaders: [['X-Similarity-Webhook-Secret', SECRET]] },
      scanning: { internet: true }, exclude: { quotes: true }, filters: { minCopiedWords: 8 } });
    expect(body.properties.indexing).toBeUndefined();
    expect(body.properties.scanning.copyleaksDb).toBeUndefined();
  });
  test('sandbox when COPYLEAKS_SANDBOX=true; a token close to expiry is renewed', async () => {
    const expiring = { ...login, reply: { body: { access_token: 'tok-old', '.expires': new Date(Date.now() + 60e3).toISOString() } } };
    const fetch = F.fakeFetch([expiring, submitRoute]);
    await copyleaks.submit({ text: words('b', 20), words: 20, scanId: SCAN }, { env: { ...CL_ENV, COPYLEAKS_SANDBOX: 'true' }, settings: settings(CL_ENV), fetch });
    await copyleaks.submit({ text: words('b', 20), words: 20, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    expect(fetch.calls.filter(c => c.url.includes('/login/')).length).toBe(2);
    expect(JSON.parse(fetch.calls[1].body).properties.sandbox).toBe(true);
  });
  test('a text under 6 words is not sent; login and submit errors are coded and never carry the key', async () => {
    await expect(copyleaks.submit({ text: 'too short', words: 2, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch: F.fakeFetch([]) }))
      .rejects.toMatchObject({ code: 'too_short', charged: false, retryable: false });
    const badLogin = F.fakeFetch([{ ...login, reply: { status: 401, body: { error: { id: 'invalid_credentials', code: 2 } } } }]);
    const e1 = await copyleaks.submit({ text: words('b', 20), words: 20, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch: badLogin }).catch(e => e);
    expect(e1).toMatchObject({ code: 'auth', charged: false, retryable: false });
    const limited = F.fakeFetch([{ ...login, reply: { status: 429, body: {} } }]);
    const e2 = await copyleaks.submit({ text: words('b', 20), words: 20, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch: limited }).catch(e => e);
    expect(e2).toMatchObject({ code: 'rate_limited', retryable: true });
    const noCredits = F.fakeFetch([login, { ...submitRoute, reply: { status: 400, body: { error: { id: 'insufficient_credits', code: 13 } } } }]);
    const e3 = await copyleaks.submit({ text: words('b', 20), words: 20, scanId: SCAN }, { env: CL_ENV, settings: settings(CL_ENV), fetch: noCredits }).catch(e => e);
    expect(e3).toMatchObject({ code: 'insufficient_credits', charged: false });
    expect(JSON.stringify([e1, e2, e3]) + e1.message + e3.message).not.toMatch(/00000000-0000|api@example/);
  });
  test('webhook verification: the secret header (constant time) and the signed payload for status events', () => {
    const payload = copyleaks.payloadFor(SCAN, CL_ENV);
    expect(copyleaks.verifyWebhook({ 'x-similarity-webhook-secret': SECRET }, { developerPayload: payload }, SCAN, CL_ENV, { status: true })).toBe(true);
    expect(copyleaks.verifyWebhook({ 'x-similarity-webhook-secret': SECRET }, { developerPayload: payload }, 'other-scan', CL_ENV, { status: true })).toBe(false);
    expect(copyleaks.verifyWebhook({ 'x-similarity-webhook-secret': 'x'.repeat(40) }, { developerPayload: payload }, SCAN, CL_ENV, { status: true })).toBe(false);
    expect(copyleaks.verifyWebhook({}, { developerPayload: payload }, SCAN, CL_ENV, { status: true })).toBe(false);
    expect(copyleaks.verifyWebhook({ 'x-similarity-webhook-secret': SECRET }, {}, SCAN, CL_ENV, { status: false })).toBe(true);
    expect(copyleaks.verifyWebhook({ 'x-similarity-webhook-secret': SECRET }, {}, SCAN, {}, { status: false })).toBe(false);
  });
  test('completed: asks for one export of the results (most matched first) and the crawled version, every upload carrying the secret', async () => {
    const fetch = F.fakeFetch([login, { match: url => url.includes('/v3/downloads/'), reply: { status: 202, body: {} } }]);
    const next = await copyleaks.onStatus('completed', F.copyleaksCompleted(SCAN), { stage: 'scanning' }, SCAN, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    expect(next.state).toBe('waiting');
    expect(next.pending.stage).toBe('exporting');
    expect(next.pending.summary).toEqual({ totalWords: 60, credits: 1, results: [
      { id: 'r-web-1', kind: 'web', title: 'Example web page', url: 'https://example.test/web-1', matchedWords: 12 },
      { id: 'r-repo-1', kind: 'repository', title: 'Journal article', url: null, matchedWords: 10 },
      { id: 'r-db-1', kind: 'repository', title: 'Shared hub document', url: null, matchedWords: 8 }] });
    const exportCall = fetch.calls.find(c => c.url.includes('/v3/downloads/'));
    expect(exportCall.method).toBe('POST');
    expect(exportCall.url).toBe(`https://api.copyleaks.com/v3/downloads/${SCAN}/export/${next.pending.exportId}`);
    expect(next.pending.exportId).toMatch(/^[a-z0-9]{3,36}$/);
    const body = JSON.parse(exportCall.body);
    const base = `https://api.example.test/api/similarity/webhooks/copyleaks/export/${SCAN}`;
    const header = [['X-Similarity-Webhook-Secret', SECRET]];
    expect(body).toEqual({ completionWebhook: `${base}/completed`, completionWebhookHeaders: header, maxRetries: 3,
      crawledVersion: { endpoint: `${base}/crawled`, verb: 'POST', headers: header },
      results: ['r-web-1', 'r-repo-1', 'r-db-1'].map(id => ({ id, endpoint: `${base}/results/${id}`, verb: 'POST', headers: header })) });
  });
  test('a duplicate completed event (delivery is at least once) is ignored once the export was asked for', async () => {
    const fetch = F.fakeFetch([login, { match: url => url.includes('/v3/downloads/'), reply: { status: 202, body: {} } }]);
    const ctx = { env: CL_ENV, settings: settings(CL_ENV), fetch };
    const first = await copyleaks.onStatus('completed', F.copyleaksCompleted(SCAN), { stage: 'scanning' }, SCAN, ctx);
    expect(await copyleaks.onStatus('completed', F.copyleaksCompleted(SCAN), first.pending, SCAN, ctx)).toEqual({ state: 'ignored' });
    expect(fetch.calls.filter(c => c.url.includes('/v3/downloads/'))).toHaveLength(1);
  });
  test('completed with no results: done at once, no export', async () => {
    const empty = F.copyleaksCompleted(SCAN);
    empty.results.internet = []; empty.results.database = []; empty.results.repositories = [];
    const fetch = F.fakeFetch([login]);
    const next = await copyleaks.onStatus('completed', empty, { stage: 'scanning' }, SCAN, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    expect(next).toEqual({ state: 'completed', result: { units: 1, costUsd: 0.05, queryWords: 60, resultCount: 0, sources: [], foreignText: null } });
    expect(fetch.calls.filter(c => c.url.includes('/downloads/'))).toEqual([]);
  });
  test('an error event fails the job without a charge; other events are ignored', async () => {
    const ctx = { env: CL_ENV, settings: settings(CL_ENV), fetch: F.fakeFetch([]) };
    expect(await copyleaks.onStatus('error', F.copyleaksError(), { stage: 'scanning' }, SCAN, ctx)).toEqual({ state: 'failed', errorId: 'insufficient_credits', charged: false });
    expect(await copyleaks.onStatus('creditschecked', {}, { stage: 'scanning' }, SCAN, ctx)).toEqual({ state: 'ignored' });
    expect(await copyleaks.onStatus('indexed', {}, { stage: 'scanning' }, SCAN, ctx)).toEqual({ state: 'ignored' });
  });
  test('the uploads keep only match positions (never the matched page text); export completed builds the normalised result and deletes the scan', async () => {
    const fetch = F.fakeFetch([login, { match: url => url.includes('/v3/downloads/'), reply: { status: 202, body: {} } },
      { match: url => url === 'https://api.copyleaks.com/v3.1/scans/delete', reply: { status: 202, body: {} } }]);
    const ctx = { env: CL_ENV, settings: settings(CL_ENV), fetch };
    let pending = (await copyleaks.onStatus('completed', F.copyleaksCompleted(SCAN), { stage: 'scanning' }, SCAN, ctx)).pending;
    pending = copyleaks.onExportUpload('results', 'r-web-1', F.copyleaksResult({ starts: [0, 40], lengths: [20, 15] }), pending);
    pending = copyleaks.onExportUpload('results', 'r-unknown', F.copyleaksResult({ starts: [0], lengths: [5] }), pending);
    pending = copyleaks.onExportUpload('crawled', null, F.copyleaksCrawled('the crawled text'), pending);
    expect(JSON.stringify(pending)).not.toMatch(/never store/);
    expect(pending.results).toEqual({ 'r-web-1': [{ start: 0, length: 20 }, { start: 40, length: 15 }] });
    const done = await copyleaks.onExportCompleted(F.copyleaksExportCompleted(true), pending, SCAN, ctx);
    expect(done).toEqual({ state: 'completed', result: { units: 1, costUsd: 0.05, queryWords: 60, resultCount: 3, foreignText: 'the crawled text', sources: [
      { kind: 'web', title: 'Example web page', url: 'https://example.test/web-1', viewUrl: null, compared: true, matchedWords: 12, fragments: null,
        passages: [{ start: 0, length: 20 }, { start: 40, length: 15 }] },
      { kind: 'repository', title: 'Journal article', url: null, viewUrl: null, compared: false, matchedWords: 10, fragments: null, passages: null },
      { kind: 'repository', title: 'Shared hub document', url: null, viewUrl: null, compared: false, matchedWords: 8, fragments: null, passages: null }] } });
    const del = fetch.calls.find(c => c.url.endsWith('/v3.1/scans/delete'));
    expect(del.method).toBe('PATCH');
    expect(JSON.parse(del.body)).toEqual({ scans: [{ id: SCAN }], purge: true });
  });
  test('an export with a failed upload, or without the crawled text, fails (the scan may have been charged)', async () => {
    const ctx = { env: CL_ENV, settings: settings(CL_ENV), fetch: F.fakeFetch([login, { match: () => true, reply: { status: 202, body: {} } }]) };
    const pending = { stage: 'exporting', exportId: 'x1', summary: { totalWords: 60, credits: 1, results: [] }, results: {}, crawledText: 'text' };
    expect(await copyleaks.onExportCompleted(F.copyleaksExportCompleted(false), pending, SCAN, ctx)).toEqual({ state: 'failed', errorId: 'export_failed', charged: true });
    expect(await copyleaks.onExportCompleted(F.copyleaksExportCompleted(true), { ...pending, crawledText: undefined }, SCAN, ctx))
      .toEqual({ state: 'failed', errorId: 'export_incomplete', charged: true });
  });
  test('resend asks Copyleaks to send the status webhook again', async () => {
    const fetch = F.fakeFetch([login, { match: url => url.endsWith('/webhooks/resend'), reply: { status: 202, body: {} } }]);
    await copyleaks.resend(SCAN, { env: CL_ENV, settings: settings(CL_ENV), fetch });
    const call = fetch.calls.find(c => c.url.endsWith('/webhooks/resend'));
    expect(call).toMatchObject({ method: 'POST', url: `https://api.copyleaks.com/v3/scans/${SCAN}/webhooks/resend` });
  });
});

describe('stub provider (tests and local QA)', () => {
  test('synchronous by default: one web source matching the essay\'s first 12 words, no cost', async () => {
    const text = words('c', 40);
    const out = await stub.submit({ text, words: 40, scanId: 'x' }, { env: {}, settings: settings() });
    expect(out.state).toBe('completed');
    expect(out.result.sources).toEqual([{ kind: 'web', title: 'Example source (stub)', url: 'https://example.test/stub-source', viewUrl: null,
      compared: true, matchedWords: 12, fragments: [text.split(' ').slice(0, 12).join(' ')], passages: null }]);
    expect(out.result.costUsd).toBe(0);
  });
  test('asynchronous on request: submitted, then completed by polling', async () => {
    const env = { SIMILARITY_STUB_MODE: 'async' };
    const out = await stub.submit({ text: words('c', 40), words: 40, scanId: 'stub-1' }, { env, settings: settings() });
    expect(out).toMatchObject({ state: 'submitted', externalRef: 'stub-1' });
    const polled = await stub.poll('stub-1', out.pending, { env, settings: settings() });
    expect(polled.state).toBe('completed');
    expect(polled.result.sources).toHaveLength(1);
  });
});

describe('resolveSources: the normalised result onto the canonical text', () => {
  const text = `${words('d', 10)} ${words('m', 20)} ${words('e', 10)}`;
  const tokens = tokenize(text);
  const blocked = new Array(tokens.length).fill(false);
  const s = settings();
  test('positions on the same text are used; matched text is located; not compared stays without spans; labels are generic', () => {
    const start = tokens[10].start;
    const out = resolveSources({ foreignText: text, sources: [
      { kind: 'web', title: 'P', url: 'https://example.test/p', viewUrl: null, compared: true, matchedWords: 20, fragments: null,
        passages: [{ start, length: tokens[29].end - start }] },
      { kind: 'repository', title: 'J', url: null, viewUrl: null, compared: true, matchedWords: 12, fragments: [words('m', 12)], passages: null },
      { kind: 'web', title: 'N', url: 'https://example.test/n', viewUrl: 'https://view.example.test/n', compared: false, matchedWords: 9, fragments: null, passages: null }] },
    { text, tokens, blocked, settings: s });
    expect(out.map(x => [x.kind, x.label, x.compared, x.spans.map(sp => [sp.wordStart, sp.wordEnd])])).toEqual([
      ['web', SOURCE_LABELS.web, true, [[10, 30]]], ['repository', SOURCE_LABELS.repository, true, [[10, 22]]], ['web', SOURCE_LABELS.web, false, []]]);
    expect(out[2]).toMatchObject({ approxWords: 9, viewUrl: 'https://view.example.test/n', url: 'https://example.test/n', title: 'N' });
    expect(SOURCE_LABELS).toEqual({ web: 'Internet source', repository: 'Published or institutional source', internal: 'Another submission in Rubrilo' });
  });
  test('a compared source whose text cannot be found in the essay is kept as not compared', () => {
    const out = resolveSources({ foreignText: null, sources: [{ kind: 'web', title: 'P', url: 'https://example.test/p', viewUrl: null, compared: true,
      matchedWords: 9, fragments: ['nothing like the essay at all here today'], passages: null }] }, { text, tokens, blocked, settings: s });
    expect(out[0]).toMatchObject({ compared: false, approxWords: 9, spans: [] });
  });
  test('a url that is not http(s) is dropped', () => {
    const out = resolveSources({ sources: [{ kind: 'web', title: 'P', url: 'javascript:alert(1)', viewUrl: 'ftp://x', compared: false, matchedWords: 1 }] },
      { text, tokens, blocked, settings: s });
    expect(out[0].url).toBeUndefined();
    expect(out[0].viewUrl).toBeUndefined();
  });
});
