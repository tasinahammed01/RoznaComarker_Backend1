jest.mock('../src/services/visionOcr.service', () => ({ detectOrientationAnnotation: jest.fn(async () => require('./fixtures/orientationAnnotation').annotation()) }));
'use strict';
jest.setTimeout(30000);
process.env.UPLOAD_BASE_PATH = 'uploads/image-preflight-test-' + process.pid;
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
const { pageImage } = require('./fixtures/imagePreflightPage');
const mockSubmit = jest.fn((_req, res) => res.json({ success: true }));
jest.mock('../src/controllers/submission.controller', () => new Proxy({}, {
  get: (_target, name) => name === 'enforceResubmissionPermission' ? (_req, _res, next) => next()
    : (...args) => mockSubmit(...args)
}));
jest.mock('../src/middlewares/jwtAuth.middleware', () => ({ verifyJwtToken: (req, res, next) => {
  if (!req.headers.authorization) return res.status(401).json({ success: false });
  req.user = { _id: '507f1f77bcf86cd799439011', role: req.headers['x-test-role'] || 'student' }; next();
} }));
jest.mock('../src/middlewares/usage.middleware', () => ({
  enforceStorageLimitFromUploadedFiles: () => (_req, _res, next) => next(),
}));
jest.mock('../src/middlewares/rateLimit.middleware', () => ({
  createUserRateLimiter: () => (_req, _res, next) => next(),
  createSensitiveRateLimiter: () => (_req, _res, next) => next(),
}));
const app = express();
app.use('/api/submissions', require('../src/routes/submission.routes'));
const root = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');
let before;
let testUser = 0;
beforeEach(() => { testUser++; mockSubmit.mockClear();
  require('../src/services/visionOcr.service').detectOrientationAnnotation.mockReset().mockResolvedValue(require('./fixtures/orientationAnnotation').annotation());
  before = new Set(fs.existsSync(root) ? fs.readdirSync(root) : []); });
afterEach(() => {
  // These test-owned Multer files are the only ones removed here.
  for (const name of fs.existsSync(root) ? fs.readdirSync(root) : []) {
    if (!before.has(name)) fs.unlinkSync(path.join(root, name));
  }
});
const send = (route, image) => request(app).post('/api/submissions/' + route)
  .set('Authorization', 'Bearer test').attach('file', image, { filename: 'page.png', contentType: 'image/png' });

test.each(['507f1f77bcf86cd799439012', 'qr/test-token'])('rotated direct API blocks controller even with fabricated pass: %s', async route => {
  require('../src/services/visionOcr.service').detectOrientationAnnotation.mockResolvedValue(require('./fixtures/orientationAnnotation').annotation(Array(6).fill(180)));
  const response = await request(app).post('/api/submissions/'+route).set('Authorization','Bearer test')
    .field('orientationPassed','true').field('preflightToken','fabricated')
    .attach('file',await pageImage({gain:0.81 + testUser/1000}),{filename:'rotated.png',contentType:'image/png'});
  expect(response.status).toBe(422);
  expect(response.body.data.images[0].checks[0].status).toBe('fail');
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('preview then exact final bytes reuses trusted result', async () => {
  const bytes = await pageImage({gain:0.86});
  expect((await send('image-preflight', bytes)).body.data.ready).toBe(true);
  expect((await send('507f1f77bcf86cd799439012',bytes)).status).toBe(200);
  expect(require('../src/services/visionOcr.service').detectOrientationAnnotation).toHaveBeenCalledTimes(1);
});
test('undetermined direct upload blocks with retry', async () => {
  require('../src/services/visionOcr.service').detectOrientationAnnotation.mockResolvedValue(null);
  expect((await send('qr/test-token',await pageImage({gain:0.83}))).status).toBe(503);
  expect(mockSubmit).not.toHaveBeenCalled();
});

test('analysis-only endpoint returns checks and cleans the temporary upload', async () => {
  const response = await send('image-preflight', await pageImage());
  expect(response.status).toBe(200);
  expect(response.body.data.ready).toBe(true);
  expect(mockSubmit).not.toHaveBeenCalled();
  // Middleware cleanup is awaited after response; allow the filesystem promise to settle.
  await new Promise(setImmediate);
  expect(fs.readdirSync(root).filter(name => !before.has(name))).toEqual([]);
});
test.each(['507f1f77bcf86cd799439012', 'qr/test-token'])('blocks rejected images before the submission/assessment controller: %s', async route => {
  const response = await send(route, await pageImage({ width: 200, height: 250 }));
  expect(response.status).toBe(422);
  expect(response.body.code).toBe('IMAGE_PREFLIGHT_FAILED');
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(fs.readdirSync(root).filter(name => !before.has(name))).toEqual([]);
});
test('one failing page blocks the whole batch and removes all temporary files', async () => {
  const response = await request(app).post('/api/submissions/507f1f77bcf86cd799439012').set('Authorization', 'Bearer test')
    .attach('files', await pageImage(), { filename: 'good.png', contentType: 'image/png' })
    .attach('files', await pageImage({ gain: 0.03 }), { filename: 'dark.png', contentType: 'image/png' });
  expect(response.status).toBe(422);
  expect(response.body.data.images.map(image => image.ready)).toEqual([true, false]);
  expect(mockSubmit).not.toHaveBeenCalled();
  expect(fs.readdirSync(root).filter(name => !before.has(name))).toEqual([]);
});
test('valid images continue to the unchanged submission controller', async () => {
  expect((await send('507f1f77bcf86cd799439012', await pageImage())).status).toBe(200);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});
test('technical decode errors block with a retry state', async () => {
  const corrupt = Buffer.from([137,80,78,71,13,10,26,10,0,0,0]);
  const response = await send('507f1f77bcf86cd799439012', corrupt);
  expect(response.status).toBe(503);
  expect(response.body.code).toBe('IMAGE_PREFLIGHT_UNAVAILABLE');
  expect(mockSubmit).not.toHaveBeenCalled();
});
test('requires authentication and the student role for preflight', async () => {
  expect((await request(app).post('/api/submissions/image-preflight')).status).toBe(401);
  expect((await request(app).post('/api/submissions/image-preflight').set('Authorization', 'Bearer test')
    .set('x-test-role', 'teacher')).status).toBe(403);
});
test('keeps file signature security and PDF submission behavior', async () => {
  expect((await send('image-preflight', Buffer.from('not an image'))).status).toBe(400);
  const response = await request(app).post('/api/submissions/507f1f77bcf86cd799439012').set('Authorization', 'Bearer test')
    .attach('file', Buffer.from('%PDF-1.4\n'), { filename: 'page.pdf', contentType: 'application/pdf' });
  expect(response.status).toBe(200);
  expect(mockSubmit).toHaveBeenCalledTimes(1);
});
