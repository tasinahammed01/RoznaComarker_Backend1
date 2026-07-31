'use strict';

const fs = require('fs');
const path = require('path');

const read = (relative) => fs.readFileSync(path.resolve(__dirname, relative), 'utf8');

describe('cross-device canonical result contracts', () => {
  test('one student and assignment identify exactly one canonical submission', () => {
    const model = read('../src/models/Submission.js');
    const controller = read('../src/controllers/submission.controller.js');
    expect(model).toMatch(/index\(\{ student: 1, assignment: 1 \}, \{ unique: true \}\)/);
    expect(controller).toMatch(/Submission\.findOne\(\{[\s\S]*student: studentId,[\s\S]*assignment: assignmentId/);
  });

  test('authenticated dynamic result routes apply no-store without changing static caching', () => {
    const submissionRoutes = read('../src/routes/submission.routes.js');
    const feedbackRoutes = read('../src/routes/feedback.routes.js');
    expect(submissionRoutes).toMatch(/'\/assignment\/:assignmentId\/my',[\s\S]*noStore/);
    expect(submissionRoutes).toMatch(/router\.get\('\/my', noStore/);
    expect(submissionRoutes).toMatch(/getOcrCorrectionsMiddleware = \[[\s\S]*noStore/);
    expect(feedbackRoutes).toMatch(/router\.get\([\s\S]*'\/:submissionId',[\s\S]*noStore/);
    expect(submissionRoutes).toContain("res.set('Cache-Control', 'no-store')");
  });

  test('Angular service worker is disabled and cannot stale-cache authenticated API responses', () => {
    const angular = JSON.parse(read('../../RoznaComarker/angular.json'));
    const build = angular.projects['rozna-comarker-fe'].architect.build.options;
    expect(build.serviceWorker).not.toBe(true);
    expect(fs.existsSync(path.resolve(__dirname, '../../RoznaComarker/ngsw-config.json'))).toBe(false);
  });

  test('responsive device service is not used to select submission endpoints', () => {
    const api = read('../../RoznaComarker/src/app/api/submission-api.service.ts');
    expect(api).not.toMatch(/DeviceService|userAgent|matchMedia|innerWidth/);
    expect(api).not.toContain("params.set('_cb'");
  });
});
