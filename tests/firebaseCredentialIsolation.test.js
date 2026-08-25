const fs = require('fs');
const path = require('path');

describe('Firebase Admin and Vision credential isolation', () => {
  test('Firebase Admin uses only explicit FIREBASE_* service-account values', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/config/firebase.js'), 'utf8');
    expect(source).toMatch(/process\.env\.FIREBASE_PROJECT_ID/);
    expect(source).toMatch(/process\.env\.FIREBASE_CLIENT_EMAIL/);
    expect(source).toMatch(/process\.env\.FIREBASE_PRIVATE_KEY/);
    expect(source).toMatch(/admin\.credential\.cert/);
    expect(source).not.toMatch(/GOOGLE_APPLICATION_CREDENTIALS|GOOGLE_CLOUD_KEY_FILE|applicationDefault/);
  });

  test('Vision prefers its dedicated key variable and has no silent credential fallback', () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/services/visionOcr.service.js'), 'utf8');
    expect(source).toMatch(/GOOGLE_CLOUD_KEY_FILE \|\| process\.env\.GOOGLE_APPLICATION_CREDENTIALS/);
    expect(source).not.toContain('using fallback backend/key/vision_key.json');
    expect(source).not.toMatch(/process\.env\.GOOGLE_APPLICATION_CREDENTIALS\s*=/);
  });
});
