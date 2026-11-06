'use strict';
// Draft comparison v2: two drafts that are different texts (cheap local word-set similarity below UNRELATED_SIMILARITY) get a limited
// comparison that claims nothing. Flag off: v1 payload. Synthetic data only.
process.env.JWT_SECRET = 'draft-unrelated-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.FRONTEND_URL = 'https://school.example';
process.env.UPLOAD_BASE_PATH = 'uploads/draft-unrelated';
process.env.SENSITIVE_RATE_LIMIT_MAX = '1000';
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const SubmissionRevision = require('../src/models/SubmissionRevision');
const { captureCurrentRevision } = require('../src/services/submissionRevision.service');
const { textSimilarity, UNRELATED_SIMILARITY } = require('../src/services/draftComparison.service');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture } = require('./helpers/annotationFixture');

jest.setTimeout(300000);
const ESSAY = 'Last weekend my family visited the old harbour town. We walked along the stone pier, watched fishing boats unload their catch and ate fresh bread from a small bakery near the church. In the afternoon it rained, so we stayed in a cosy cafe and played cards until the sun returned over the grey water.';
const EDITED = 'Last weekend my family visited the old harbour town by the sea. We walked slowly along the stone pier, watched the fishing boats unload their catch and ate warm bread from a tiny bakery near the church. In the afternoon it rained heavily, so we stayed in a cosy cafe and played cards until the sun came back over the grey water.';
const REWRITTEN = 'My family spent last weekend in an old harbour town. On the stone pier we watched boats bring in fish, and later we bought bread at a bakery beside the church. When rain came in the afternoon we hid in a cafe, played cards and waited for the sun over the water.';
const UNRELATED = 'Photosynthesis allows green plants to convert sunlight into chemical energy. Chlorophyll inside chloroplasts captures light, while roots absorb minerals through tiny hairs. Scientists measure oxygen release to study how temperature, carbon dioxide levels and leaf structure change growth rates across different seasons and climates.';

describe('text similarity (pure)', () => {
  test('identical and lightly edited drafts are related; a rewritten version of the same essay stays related; a different text is not', () => {
    expect(textSimilarity(ESSAY, ESSAY)).toBe(1);
    expect(textSimilarity(ESSAY, EDITED)).toBeGreaterThan(0.6);
    expect(textSimilarity(ESSAY, REWRITTEN)).toBeGreaterThanOrEqual(UNRELATED_SIMILARITY);
    expect(textSimilarity(ESSAY, UNRELATED)).toBeLessThan(UNRELATED_SIMILARITY);
  });
  test('empty or very short text: no judgement (null)', () => {
    expect(textSimilarity('', ESSAY)).toBeNull();
    expect(textSimilarity('Too short to judge.', ESSAY)).toBeNull();
    expect(textSimilarity(ESSAY, '   ')).toBeNull();
  });
});

describe('API', () => {
  const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
  let fixture;
  const jwt = user => signTestJwt({ id: user._id, role: user.role, firebaseUid: user.firebaseUid });
  const asStudent = () => request(app).get(`/api/submissions/${fixture.IDS.registered}/draft-comparison`).set('Authorization', `Bearer ${jwt(fixture.student)}`);
  const asGuest = () => request(app).get(`/api/guest/submissions/${fixture.IDS.guest}/drafts`).set('X-Guest-Token', fixture.guestToken);
  /** Two assessed drafts with the given transcripts (the fixture's assessment is kept for both). */
  async function drafts(id, previousText, currentText) {
    await captureCurrentRevision(await Submission.findById(id));
    await SubmissionRevision.updateOne({ sourceSubmissionId: id, draftNumber: 1 }, { $set: { transcriptText: previousText } });
    await Submission.updateOne({ _id: id }, { $set: { draftNumber: 2, transcriptText: currentText, fileContentIdentity: `unrelated-2-${id}` } });
  }
  beforeAll(connectInMemoryMongo);
  beforeEach(async () => {
    process.env.DRAFT_COMPARISON_V2_ENABLED = 'true';
    await mongoose.connection.dropDatabase(); await seedTestPlans();
    fixture = await seedAnnotationFixture({ uploadRoot });
  });
  afterAll(async () => { delete process.env.DRAFT_COMPARISON_V2_ENABLED; await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

  test('different texts: textsUnrelated, scores kept, no change, no claim, no issue counts or lists', async () => {
    await drafts(fixture.IDS.registered, ESSAY, UNRELATED);
    const data = (await asStudent()).body.data;
    expect(data.textsUnrelated).toBe(true);
    expect(data.overall).toEqual(expect.objectContaining({ previousScore: 82, currentScore: 82, delta: null, status: 'TEXTS_UNRELATED' }));
    expect(data.summary).toEqual({ improved: false, unchanged: false, declined: false, limited: true });
    expect(data.rubricCategories.every(c => c.delta === null && c.available === false)).toBe(true);
    expect({ available: data.issuesAvailable, issues: data.issues, message: data.issuesMessage })
      .toEqual({ available: false, issues: null, message: 'These drafts look like different texts, so the comparison is limited.' });
    expect(data).not.toHaveProperty('issueDetails');
  });
  test('a lightly edited draft is not flagged and keeps the v2 lists', async () => {
    await drafts(fixture.IDS.registered, ESSAY, EDITED);
    const data = (await asStudent()).body.data;
    expect(data).not.toHaveProperty('textsUnrelated');
    expect(data.comparisonVersion).toBe(2);
    expect(data.issueDetails).toBeDefined();
  });
  test('flag off: the v1 payload, even for different texts', async () => {
    await drafts(fixture.IDS.registered, ESSAY, UNRELATED);
    process.env.DRAFT_COMPARISON_V2_ENABLED = 'false';
    const data = (await asStudent()).body.data;
    expect(data).not.toHaveProperty('textsUnrelated');
    expect(data).not.toHaveProperty('comparisonVersion');
    expect(data.overall.status).not.toBe('TEXTS_UNRELATED');
  });
  test('guest link: the same limited payload, nothing internal', async () => {
    await drafts(fixture.IDS.guest, ESSAY, UNRELATED);
    const res = await asGuest();
    expect(res.status).toBe(200);
    expect(res.body.data.textsUnrelated).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/previousSubmissionId|matchStrategy|teacher@example\.com|evaluationProvider|analysisInputHash|similarity/);
  });
});
