'use strict';
// Task 6A regression guard: for submissions WITHOUT teacher annotations, every student-facing surface must return exactly what it
// returned before the annotation refactor. The fixture file was produced from the pre-refactor code with UPDATE_GOLDEN=1.
process.env.JWT_SECRET = 'annotation-golden-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-golden';   // fixed: paths are part of the compared output
const fs = require('fs');
const path = require('path');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, normalizeVolatile } = require('./helpers/annotationFixture');
const { surfaces, capture } = require('./helpers/studentSurfaces');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
// Not *.json: the repository's .gitignore excludes every .json file outside package files.
const GOLDEN = path.join(__dirname, 'fixtures', 'annotationGolden.golden');
let fixture;

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

test('every student-facing surface is byte-identical for submissions without teacher annotations', async () => {
  const studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
  const actual = normalizeVolatile(await capture(surfaces({ app, ids: fixture.IDS, studentJwt, guestToken: fixture.guestToken })));
  for (const [name, value] of Object.entries(actual)) expect({ name, status: value.status }).toEqual({ name, status: 200 });
  if (process.env.UPDATE_GOLDEN === '1') {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, JSON.stringify(actual, null, 1) + '\n');
  }
  const expected = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
  for (const name of Object.keys(expected)) expect({ name, value: actual[name] }).toEqual({ name, value: expected[name] });
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
});
