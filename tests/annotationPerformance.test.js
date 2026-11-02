'use strict';
// Task 6A performance: hundreds of corrections and teacher entries. Prints timings; the bounds are generous regression guards.
// PERF_BASELINE_ONLY=1 measures only the unannotated endpoint (used to time the pre-6A code with the same fixture).
process.env.JWT_SECRET = 'annotation-perf-secret';
process.env.NODE_ENV = 'test';
process.env.GUEST_SUBMISSION_ENABLED = 'true';
process.env.UPLOAD_BASE_PATH = 'uploads/annotation-perf';
process.env.AUTH_READ_RATE_LIMIT_MAX = '100000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const app = require('../src/app');
const Submission = require('../src/models/Submission');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { signTestJwt } = require('./helpers/auth');
const { seedAnnotationFixture, rerunOcr } = require('./helpers/annotationFixture');

jest.setTimeout(600000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
// 480 distinct-ish words (a real essay does not repeat 100-character passages), 300 corrections.
const WORDS = Array.from({ length: 480 }, (_, i) => i % 4 === 0 ? `goes${i}` : `word${i}`);
const SPECS = Array.from({ length: 300 }, (_, k) => { const i = Math.floor(k * 1.6);
  return [i, k % 2 ? 'SP' : 'AGR', k % 2 ? 'MECHANICS' : 'GRAMMAR', 'fix', `Message ${k}.`]; });
let fixture, studentJwt;
const median = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
async function time(fn, runs = 5) { const out = []; for (let i = 0; i < runs; i++) { const t = process.hrtime.bigint(); await fn(); out.push(Number(process.hrtime.bigint() - t) / 1e6); } return median(out); }
const endpoint = () => request(app).get(`/api/submissions/${fixture.IDS.registered}/ocr-corrections`).set('Authorization', `Bearer ${studentJwt}`)
  .then(res => { if (res.status !== 200) throw new Error(String(res.status)); return res; });

beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  fixture = await seedAnnotationFixture({ uploadRoot });
  await rerunOcr({ submissionId: fixture.IDS.registered, words: WORDS, specs: SPECS, ocrJobId: 'job-perf' });
  studentJwt = signTestJwt({ id: fixture.student._id, role: 'student', firebaseUid: fixture.student.firebaseUid });
});
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });

test('timings with 300 corrections', async () => {
  const baseline = await time(endpoint);
  console.log(`[annotation perf] ocr-corrections, 300 corrections, no annotations: ${baseline.toFixed(1)} ms (median of 5)`);
  if (process.env.PERF_BASELINE_ONLY === '1') return;
  const policy = require('../src/services/teacherAnnotation.service');
  const view = require('../src/services/studentCorrectionView.service');
  const load = () => Submission.findById(fixture.IDS.registered).select('+teacherAnnotations').lean();
  // 200 teacher entries through the real write path (resolution + prepare per write): 100 hides, 100 edits.
  let doc = await load();
  const writeTimes = [];
  for (let k = 0; k < 200; k++) {
    const target = doc.writingCorrections[k];
    const started = process.hrtime.bigint();
    const resolution = view.resolveOverlay(doc, doc.teacherAnnotations ?? null);
    const { sourceHash } = policy.source(doc);
    const body = k % 2 ? { action: 'hide', id: target.id } : { action: 'edit', id: target.id, value: { fileId: target.fileId, page: 1, startChar: target.startChar,
      endChar: target.endChar, quotedText: target.quotedText, symbol: target.symbol, category: target.category, message: `Teacher ${k}.`, suggestedText: 'fix' } };
    const result = policy.prepare(doc, fixture.teacher._id, { ...body, revision: policy.normalizeState(doc.teacherAnnotations).revision, sourceHash, requestId: crypto.randomUUID() }, { resolution });
    writeTimes.push(Number(process.hrtime.bigint() - started) / 1e6);
    await Submission.updateOne({ _id: doc._id }, { $set: { teacherAnnotations: result.state } });
    doc = await load();
  }
  const builder = await time(async () => view.buildStudentCorrectionView(doc));
  const annotated = await time(endpoint);
  const visible = view.buildStudentCorrectionView(doc);
  expect(visible.corrections).toHaveLength(200);
  expect(visible.corrections.filter(c => c.teacherEdited)).toHaveLength(100);
  // OCR re-run that moves every offset: every entry is relocated by text.
  await rerunOcr({ submissionId: doc._id, words: ['Intro', ...WORDS], specs: SPECS.map(([w, ...r]) => [w + 1, ...r]), ocrJobId: 'job-perf-2' });
  doc = await load();
  const relocated = await time(async () => view.buildStudentCorrectionView(doc));
  const afterRerun = view.buildStudentCorrectionView(doc, { audience: 'teacher' });
  expect(afterRerun.corrections).toHaveLength(200);
  expect(afterRerun.orphans).toEqual([]);
  const rerunEndpoint = await time(endpoint);
  console.log(`[annotation perf] write path (resolve + prepare), 300 corrections: first ${writeTimes[0].toFixed(1)} ms, 200th ${writeTimes[199].toFixed(1)} ms`);
  console.log(`[annotation perf] builder, 300 corrections + 200 entries: ${builder.toFixed(1)} ms; after OCR re-run (relocation): ${relocated.toFixed(1)} ms`);
  console.log(`[annotation perf] ocr-corrections: no annotations ${baseline.toFixed(1)} ms; 200 entries ${annotated.toFixed(1)} ms; after re-run ${rerunEndpoint.toFixed(1)} ms`);
  expect(builder).toBeLessThan(1000);
  expect(relocated).toBeLessThan(2000);
  expect(writeTimes[199]).toBeLessThan(2000);
});
