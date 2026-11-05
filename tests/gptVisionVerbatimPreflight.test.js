'use strict';
// Gemini verbatim reader through the real upload preflight, submission claim and OCR worker (in-memory Mongo, mocked provider).
jest.setTimeout(90000);
process.env.GUEST_SUBMISSION_ENABLED = 'true'; process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'verbatim-offline'; process.env.UPLOAD_USER_RATE_LIMIT_MAX = '500';
process.env.AUTH_WRITE_RATE_LIMIT_MAX = '1000';
process.env.UPLOAD_BASE_PATH = 'uploads/gpt-verbatim-test-' + process.pid;
jest.mock('../src/services/assessmentRecovery.service', () => ({ scheduleSubmissionAnalysis: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn(async () => {}) }));
jest.mock('../src/services/imagePreflight.service', () => ({ evaluateImage: jest.fn(async () => ({ ready: true, checks: [] })) }));
jest.mock('../src/services/aiGateway.service', () => ({ providerAttempt: jest.fn() }));
jest.mock('../src/services/email.service', () => ({ sendGuestSubmissionEmail: jest.fn(async () => ({ success: true })) }));
jest.mock('../src/services/notification.service', () => ({ createNotification: jest.fn(async () => null) }));
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: jest.fn(async () => [{ fullTextAnnotation: { pages: [] } }]) })) }));
const sharp = require('sharp'), request = require('supertest'), fs = require('fs'), path = require('path');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer'), { seedTestPlans } = require('./helpers/seedTestPlans'), { signTestJwt } = require('./helpers/auth');
const User = require('../src/models/user.model'), Class = require('../src/models/class.model'), Assignment = require('../src/models/assignment.model'), Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission'), File = require('../src/models/File'), Evidence = require('../src/models/SourceFidelityEvidence');
const gateway = require('../src/services/aiGateway.service'), scheduled = require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const c = require('../src/services/gptVisionExact/contract');
const GEMINI = c.GEMINI_MODEL, QWEN = c.QWEN_MODEL;
const VERBATIM = 'gpt_vision_exact_verbatim_v1', PLAIN = 'gpt_vision_exact_plain_v1';
const QUESTION = 'Describe your favourite place and explain why you like it.';
const ANSWER = ['My favourite place is the park.', 'I play footbal there with my frends.', 'This artical show that parks matter.'];
let token, student, teacher, cls, a, bytes, serial = 0, verbatimReply, secondReply;
const reply = (over = {}) => JSON.stringify({ version: 'verbatim-page-v2', name_present: true, question_lines: [QUESTION], struck_through: [{ text: 'For example,', after_word: '' }], answer_lines: ANSWER,
  uncertain: [{ line: 1, word: 'frends' }], ...over });
const jsonWire = { version: c.QWEN_WIRE_VERSION, physicalLines: [{ segments: [{ classification: 'PROMPT_OR_INSTRUCTION', text: QUESTION, confidence: 1 }] },
  ...ANSWER.map(text => ({ segments: [{ classification: 'STUDENT_ACTIVE_TEXT', text, confidence: 1 }] }))], uncertainties: [] };
const profiles = () => gateway.providerAttempt.mock.calls.map(([o]) => o.requestProfile);
const check = () => request(app).post('/api/submissions/image-preflight').set('Authorization', 'Bearer ' + token).field('assignmentId', String(a._id)).field('phase', 'source').attach('file', bytes, { filename: 'page.png', contentType: 'image/png' });
const submit = () => request(app).post('/api/submissions/' + a._id).set('Authorization', 'Bearer ' + token).field('canSubmit', 'true').attach('files', bytes, { filename: 'page.png', contentType: 'image/png' });
async function runWorker() {
  const doc = await Submission.findOne({ assignment: a._id });
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({ fileIds: doc.files, targetDoc: doc, jobId: doc.ocrJobId });
  return Submission.findById(doc._id);
}
const useGemini = (extra = {}) => Object.assign(process.env, { OCR_GPT_VISION_MODEL: GEMINI, OCR_GPT_VISION_READER: 'verbatim_json', ...extra });
const useQwen = (reader = 'json_contract') => { Object.assign(process.env, { OCR_GPT_VISION_MODEL: QWEN, OCR_GPT_VISION_READER: reader }); delete process.env.OCR_GPT_VISION_SECOND_READER; };
beforeAll(async () => {
  await connectInMemoryMongo(); await seedTestPlans();
  [student, teacher] = await User.create(['student', 'teacher'].map(role => ({ role, firebaseUid: 'gpt-verb-' + role, email: role + '@gpt-verb.invalid' })));
  token = signTestJwt({ id: student._id, role: 'student', firebaseUid: student.firebaseUid });
  cls = await Class.create({ name: 'Verbatim', teacher: teacher._id, joinCode: 'VRB', qrCodeUrl: 'data:,' }); await Membership.create({ student: student._id, class: cls._id });
});
beforeEach(async () => {
  await require('../src/models/SourceVerificationCircuit').deleteMany({});
  process.env.OCR_SOURCE_MODE = 'gpt_vision_exact'; process.env.OPENROUTER_API_KEY = 'mock-only'; delete process.env.OCR_GPT_VISION_SECOND_READER;
  delete process.env.OCR_GPT_VISION_TEMPERATURE; delete process.env.OCR_GPT_VISION_REASONING; useGemini();
  a = await Assignment.create({ title: 'Favourite place ' + (++serial), instructions: QUESTION, class: cls._id, teacher: teacher._id, qrToken: 'verb-' + serial });
  bytes = await sharp({ create: { width: 800, height: 1000, channels: 3, background: { r: 200, g: 40 + serial, b: 90 } } }).png().toBuffer();
  verbatimReply = reply(); secondReply = `${QUESTION}\n${ANSWER.join('\n').replace('frends', 'friends')}`;
  gateway.providerAttempt.mockReset().mockImplementation(async o => ({ returnedModel: o.entry.model,
    content: o.requestProfile === VERBATIM ? verbatimReply : o.requestProfile === PLAIN ? secondReply : JSON.stringify(jsonWire) }));
  scheduled.mockClear();
});
afterAll(async () => {
  delete process.env.OCR_SOURCE_MODE; delete process.env.OCR_GPT_VISION_READER; delete process.env.OCR_GPT_VISION_MODEL;
  const dir = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH, 'submissions');
  if (fs.existsSync(dir)) for (const name of fs.readdirSync(dir)) if (/^[a-f\d-]+\.png$/i.test(name)) fs.unlinkSync(path.join(dir, name));
  await disconnectInMemoryMongo();
});

test('upload makes one paid Gemini read; the worker reuses it; grading text is the answer only; review flags are on the page record', async () => {
  expect((await check()).body.data).toMatchObject({ canSubmit: true, sourceReadStatus: 'PASSED' });
  expect(profiles()).toEqual([VERBATIM]);
  expect(gateway.providerAttempt.mock.calls[0][0]).toMatchObject({ temperature: 0, responseFormat: 'json' });
  expect((await submit()).status).toBe(200);
  const doc = await runWorker();
  expect(doc.sourceTranscriptExact).toBe(ANSWER.join('\n'));
  for (const hidden of [QUESTION, 'For example']) expect(doc.sourceTranscriptExact).not.toContain(hidden);
  // the text that grading receives (the canonical transcript built from the stored pages) is the same answer-only text
  const graded = require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript(doc);
  expect(graded.text).toBe(ANSWER.join('\n'));
  expect(graded.isComplete).toBe(true);
  for (const hidden of [QUESTION, 'For example']) expect(graded.text).not.toContain(hidden);
  expect(profiles()).toEqual([VERBATIM]);
  const summary = doc.ocrPages[0].sourceVerificationSummary;
  expect(summary.review).toMatchObject({ readerMode: 'verbatim_json', struckCount: 1, questionLineCount: 1, uncertainCount: 1, uncertain: [{ line: 1, word: 'frends' }] });
  expect(JSON.stringify(doc.ocrPages)).not.toContain('For example');
  const saved = await Evidence.findOne({ 'identity.assignmentId': String(a._id) }).select('+payload').lean();
  expect(saved.identity).toMatchObject({ model: GEMINI, readerMode: 'verbatim_json' });
  expect(saved.payload.review.struck).toEqual([{ text: 'For example,', after_word: '' }]);
});

test('uncertain words never block the upload or the submission', async () => {
  verbatimReply = reply({ uncertain: ANSWER.map((l, i) => ({ line: i, word: l.split(' ')[0] })) });
  expect((await check()).body.data).toMatchObject({ canSubmit: true, sourceReadStatus: 'PASSED' });
  expect((await submit()).status).toBe(200);
  expect((await runWorker()).ocrPages[0].sourceVerificationSummary.review.uncertainCount).toBe(3);
});

test.each([['not JSON', '{'], ['a name field', reply({ name: 'A Student' })]])('%s blocks the upload with one call and creates nothing', async (_n, bad) => {
  verbatimReply = bad;
  const files = await File.countDocuments();
  expect((await check()).body.data).toMatchObject({ canSubmit: false });
  expect((await submit()).status).not.toBe(200);
  expect(await Submission.countDocuments({ assignment: a._id })).toBe(0); expect(await File.countDocuments()).toBe(files);
  expect(scheduled).not.toHaveBeenCalled(); expect(profiles()).toEqual([VERBATIM]);
});

test('switch-over: a page checked under Qwen can be submitted after switching to Gemini, with no re-read', async () => {
  useQwen();
  expect((await check()).body.data.canSubmit).toBe(true);
  expect(profiles()).toEqual(['gpt_vision_exact_v1']);
  useGemini();
  expect((await submit()).status).toBe(200);
  const doc = await runWorker();
  expect(doc.sourceTranscriptExact).toBe(ANSWER.join('\n'));
  expect(profiles()).toEqual(['gpt_vision_exact_v1']);
  expect(doc.ocrPages[0].sourcePrimaryModel).toBe(QWEN);   // reported as the model that really read it
});

test('rollback: a page checked under Gemini can be submitted after setting .env back to Qwen, with no re-read', async () => {
  expect((await check()).body.data.canSubmit).toBe(true);
  useQwen();
  expect((await submit()).status).toBe(200);
  expect((await runWorker()).sourceTranscriptExact).toBe(ANSWER.join('\n'));
  expect(profiles()).toEqual([VERBATIM]);
});

test('switch-over never accepts a changed assignment text, or evidence from a model that was not approved for the pair', async () => {
  expect((await check()).body.data.canSubmit).toBe(true);
  useQwen();
  await Assignment.updateOne({ _id: a._id }, { $set: { instructions: 'A completely different task.' } });
  expect((await submit()).status).not.toBe(200);
  expect(await Submission.countDocuments({ assignment: a._id })).toBe(0);
});

test('submit-time carry-over proves the stored assignment text itself: evidence whose assignment hash does not match is refused', async () => {
  expect((await check()).body.data.canSubmit).toBe(true);
  // The key is intact, but the stored evidence claims a different assignment text: only the explicit hash comparison can notice.
  await Evidence.updateOne({ 'identity.assignmentId': String(a._id) }, { $set: { 'identity.legacyPromptSha256': c.sha('some other assignment text') } });
  useQwen();
  expect((await submit()).status).not.toBe(200);
  expect(await Submission.countDocuments({ assignment: a._id })).toBe(0);
  expect(profiles()).toEqual([VERBATIM]);
});

test('worker-time claim re-proves the assignment text: an assignment edited after submission is not claimed from the other model\'s evidence', async () => {
  expect((await check()).body.data.canSubmit).toBe(true);
  useQwen();
  expect((await submit()).status).toBe(200);               // carried over at submit time
  await Assignment.updateOne({ _id: a._id }, { $set: { instructions: 'The teacher changed the task after submission.' } });
  const doc = await Submission.findOne({ assignment: a._id });
  const outcome = await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({ fileIds: doc.files, targetDoc: doc, jobId: doc.ocrJobId });
  expect(outcome.ocrStatus).toBe('failed');
  expect(profiles()).toEqual([VERBATIM]);                  // refused, and nothing was re-read or paid for
});

test('with the plain reader as the second reader: two calls at upload, differences stored for review, one transcript for grading', async () => {
  useGemini({ OCR_GPT_VISION_SECOND_READER: QWEN });
  expect((await check()).body.data.canSubmit).toBe(true);
  expect(profiles()).toEqual([VERBATIM, PLAIN]);
  expect((await submit()).status).toBe(200);
  const doc = await runWorker();
  expect(doc.sourceTranscriptExact).toBe(ANSWER.join('\n'));
  expect(profiles()).toEqual([VERBATIM, PLAIN]);   // the worker reads nothing
  const saved = await Evidence.findOne({ 'identity.assignmentId': String(a._id) }).select('+payload').lean();
  // words are reported as written, with their punctuation
  expect(saved.payload.review.secondReader).toMatchObject({ model: QWEN, status: 'compared', differingWords: 1, differences: [{ line: 1, word: 'frends.', other: 'friends.' }] });
  expect(doc.ocrPages[0].sourceVerificationSummary.review.secondReader).toMatchObject({ status: 'compared', differingWords: 1 });
});

test('a second reader that fails cannot block the page', async () => {
  useGemini({ OCR_GPT_VISION_SECOND_READER: QWEN });
  gateway.providerAttempt.mockImplementation(async o => {
    if (o.requestProfile === PLAIN) throw Object.assign(new Error('private'), { code: 'AI_ATTEMPT_TIMEOUT' });
    return { returnedModel: o.entry.model, content: verbatimReply };
  });
  expect((await check()).body.data).toMatchObject({ canSubmit: true, sourceReadStatus: 'PASSED' });
  const saved = await Evidence.findOne({ 'identity.assignmentId': String(a._id) }).select('+payload').lean();
  expect(saved.payload.review.secondReader).toMatchObject({ model: QWEN, status: 'unavailable' });
  expect((await submit()).status).toBe(200);
});
