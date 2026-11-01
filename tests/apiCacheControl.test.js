process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
// API responses are user-specific: they must never be stored by a browser or a shared cache by default.
const request = require('supertest');
const app = require('../src/app');

test('an API response is private and not stored by default', async () => {
  const res = await request(app).get('/api/health');
  expect(res.status).toBe(200);
  expect(res.headers['cache-control']).toBe('private, no-store');
});

test('an API error response (unknown route, no auth) is not stored either', async () => {
  const res = await request(app).get('/api/submissions/does-not-exist');
  expect(res.headers['cache-control']).toBe('private, no-store');
});

test('non-API paths are not touched by the API default', async () => {
  const res = await request(app).get('/no-such-static-file.png');
  expect(res.headers['cache-control']).not.toBe('private, no-store');
});
