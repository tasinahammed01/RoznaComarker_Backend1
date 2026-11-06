'use strict';
// /api/health: the public answer is the status only. The runtime contract (prompt and model versions, contract hash, deployment revision) comes
// only with X-Deploy-Token equal to HEALTH_DETAIL_TOKEN. Unset or too short: never.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'health-detail-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const request = require('supertest');
const app = require('../src/app');
const { MIN_TOKEN_LENGTH } = require('../src/routes/health.routes');
const { verifyRuntime, requestHealth } = require('../scripts/verify-runtime-contract');
const { runtimeContractFingerprint } = require('../src/services/runtimeContractFingerprint.service');

const TOKEN = 'a'.repeat(8) + 'b'.repeat(24);   // 32 characters
const saved = process.env.HEALTH_DETAIL_TOKEN;
const health = (headers = {}) => request(app).get('/api/health').set(headers);
afterEach(() => { if (saved === undefined) delete process.env.HEALTH_DETAIL_TOKEN; else process.env.HEALTH_DETAIL_TOKEN = saved; });

describe('public answer', () => {
  beforeEach(() => { process.env.HEALTH_DETAIL_TOKEN = TOKEN; });
  test('is the status only: nothing about prompts, models, hashes, environment or time', async () => {
    const res = await health();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'OK' });
    for (const word of ['runtime', 'contract', 'prompt', 'model', 'environment', 'timestamp', 'applicationVersion']) expect(JSON.stringify(res.body)).not.toContain(word);
  });
  test('a wrong token is the same public answer, not an error', async () => {
    const res = await health({ 'X-Deploy-Token': TOKEN.slice(0, -1) + 'x' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, status: 'OK' });
  });
  test('a token of another length, empty, or the right token with extra characters', async () => {
    for (const value of ['', ' ', 'short', TOKEN + 'x', TOKEN.toUpperCase()]) expect((await health({ 'X-Deploy-Token': value })).body).toEqual({ success: true, status: 'OK' });
  });
  test('the token in the query string or a cookie does nothing', async () => {
    expect((await request(app).get(`/api/health?token=${TOKEN}&x-deploy-token=${TOKEN}`).set('Cookie', `x-deploy-token=${TOKEN}`)).body).toEqual({ success: true, status: 'OK' });
  });
  test('the other headers a monitor or load balancer sends make no difference', async () => {
    const res = await health({ 'User-Agent': 'UptimeRobot/2.0', Accept: 'text/plain' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('OK');
  });
});

describe('with the right token', () => {
  beforeEach(() => { process.env.HEALTH_DETAIL_TOKEN = TOKEN; });
  test('the runtime contract is returned, as before', async () => {
    const res = await health({ 'X-Deploy-Token': TOKEN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ success: true, status: 'OK', environment: 'test', timestamp: expect.any(String) }));
    // What the service itself computes: the test does not pin a contract version that the next change moves.
    expect(res.body.runtime).toEqual(JSON.parse(JSON.stringify(runtimeContractFingerprint())));
    expect(res.body.runtime).toMatchObject({ applicationVersion: expect.any(String), contractHash: expect.stringMatching(/^[a-f0-9]{16}$/), contracts: expect.any(Object) });
  });
  test('the token is not echoed back, in the body or the headers', async () => {
    const res = await health({ 'X-Deploy-Token': TOKEN });
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.headers)).not.toContain(TOKEN);
  });
});

describe('no usable token on the server: never', () => {
  test.each([['unset', undefined], ['empty', ''], ['too short', 'x'.repeat(MIN_TOKEN_LENGTH - 1)]])('%s', async (_name, value) => {
    if (value === undefined) delete process.env.HEALTH_DETAIL_TOKEN; else process.env.HEALTH_DETAIL_TOKEN = value;
    // The header a caller would send, including an empty one and the very value the server holds.
    for (const sent of [value ?? '', 'undefined', 'null', '', 'x'.repeat(MIN_TOKEN_LENGTH - 1)]) {
      const res = await health({ 'X-Deploy-Token': sent });
      expect({ sent, body: res.body }).toEqual({ sent, body: { success: true, status: 'OK' } });
    }
  });
  test('a token of exactly the minimum length works', async () => {
    process.env.HEALTH_DETAIL_TOKEN = 'k'.repeat(MIN_TOKEN_LENGTH);
    expect((await health({ 'X-Deploy-Token': 'k'.repeat(MIN_TOKEN_LENGTH) })).body.runtime).toBeDefined();
  });
});

describe('the deploy check', () => {
  test('sends the header from the same env var and verifies against a real backend answer', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN;
    const sent = [];
    const fetchImpl = async (url, options) => {
      sent.push(options.headers);
      const res = await health(options.headers['x-deploy-token'] ? { 'X-Deploy-Token': options.headers['x-deploy-token'] } : {});
      return { ok: res.status === 200, status: res.status, json: async () => res.body };
    };
    const env = { NODE_ENV: 'test', HEALTH_DETAIL_TOKEN: TOKEN };
    expect(await verifyRuntime({ env, fetchImpl })).toMatchObject({ ok: true, code: 'MATCH' });
    expect(sent[0]['x-deploy-token']).toBe(TOKEN);
  });
  test('without the token: a clear failure naming the variable, not a mismatch', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN;
    const fetchImpl = async () => { const res = await health(); return { ok: true, status: 200, json: async () => res.body }; };
    const result = await verifyRuntime({ env: { NODE_ENV: 'test' }, fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'HEALTH_DETAIL_TOKEN_MISSING' });
    expect(result.message).toContain('HEALTH_DETAIL_TOKEN');
  });
  test('with a token the backend does not accept: says so, and does not print either token', async () => {
    process.env.HEALTH_DETAIL_TOKEN = TOKEN;
    const fetchImpl = async (_url, options) => { const res = await health({ 'X-Deploy-Token': options.headers['x-deploy-token'] }); return { ok: true, status: 200, json: async () => res.body }; };
    const result = await verifyRuntime({ env: { NODE_ENV: 'test', HEALTH_DETAIL_TOKEN: 'w'.repeat(32) }, fetchImpl });
    expect(result).toMatchObject({ ok: false, code: 'MALFORMED_HEALTH_RESPONSE' });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain('w'.repeat(32));
  });
  test('requestHealth sends no header when there is no token', async () => {
    let headers;
    await requestHealth('http://x', { fetchImpl: async (_url, options) => { headers = options.headers; return { ok: true, json: async () => ({}) }; } });
    expect(headers).toEqual({ accept: 'application/json' });
  });
  test('the fingerprint the check compares against is unchanged', () => {
    expect(runtimeContractFingerprint({ NODE_ENV: 'test' }).contractHash).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('consumers that must not break', () => {
  test('verify-production-security reads success and status from the public answer', async () => {
    delete process.env.HEALTH_DETAIL_TOKEN;
    const res = await health();
    expect(res.body.success === true && res.body.status === 'OK').toBe(true);
    expect(/(mongodb(?:\+srv)?:\/\/|sk_(?:test|live)_|whsec_|private[_-]?key|authorization)/iu.test(JSON.stringify(res.body))).toBe(false);
  });
  test('the answer stays private and unstored, and is not limited by the global limiter', async () => {
    expect((await health()).headers['cache-control']).toBe('private, no-store');
    for (let i = 0; i < 30; i += 1) expect((await health()).status).toBe(200);
  });
});
