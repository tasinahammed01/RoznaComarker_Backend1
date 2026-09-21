const express = require('express');
const request = require('supertest');
const accessLog = require('../src/middlewares/accessLog.middleware');
test('access logs omit SSE token, JWT and token-bearing Referer while preserving request URL', async () => {
  let log = '';
  const app = express(); app.use(accessLog({ stream: { write: value => { log += value; } } }));
  app.get('/api/notifications/stream', (req, res) => res.json({ token: req.query.sseToken }));
  const result = await request(app).get('/api/notifications/stream?sseToken=one-time-secret&token=long-lived-secret')
    .set('Authorization', 'Bearer jwt-secret').set('Referer', 'https://example.test/?sseToken=referer-secret');
  expect(result.body.token).toBe('one-time-secret');
  expect(log).toContain('/api/notifications/stream'); expect(log).not.toMatch(/secret|sseToken|Bearer/);
});
