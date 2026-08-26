const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

describe('Firebase-managed authentication email architecture', () => {
  test('backend auth source has no transactional provider dependency', () => {
    const route = fs.readFileSync(path.join(__dirname, '../src/routes/auth.routes.js'), 'utf8');
    expect(route).not.toMatch(/emailService|nodemailer|resend|generateEmailVerificationLink|generatePasswordResetLink/i);
    expect(fs.existsSync(path.join(__dirname, '../src/controllers/transactionalAuthEmail.controller.js'))).toBe(false);
    expect(fs.existsSync(path.join(__dirname, '../src/services/emailService.js'))).toBe(false);
  });

  test.each(['/send-verification-email', '/request-password-reset'])(
    'deprecated endpoint %s returns a controlled 410 response', async (endpoint) => {
      const router = require('../src/routes/auth.routes');
      const app = express();
      app.use(express.json());
      app.use('/api/auth', router);
      const response = await request(app).post(`/api/auth${endpoint}`).send({ email: 'person@example.test' });
      expect(response.status).toBe(410);
      expect(response.body.code).toBe('ENDPOINT_DEPRECATED');
    }
  );
});
