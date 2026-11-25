'use strict';
// Speaking Coach isolation: practice never reaches graded data or the teacher's reports.
// - Static: only the coach itself, the audio worker (its practice branch), the minutes (practice caps) and submission removal may require the
//   practice models or services. Reports, PDFs, dashboards, summaries and the graded result never do.
// - Dynamic: the assignment report, the graded speaking result (student and teacher), student and class progress and the weekly summary read
//   the same before and after a practice session with attempts exists.
// - Removal: deleting a speaking submission deletes its practice sessions, attempts, practice recordings and any practice audio still on disk.
// In-memory MongoDB; the REAL gateway against a fake OpenRouter; an injected speech-to-text fake; no network; synthetic texts only.
process.env.JWT_SECRET = 'speaking-coach-isolation-secret';
process.env.NODE_ENV = 'test';
process.env.UPLOAD_BASE_PATH = `uploads/speaking-coach-isolation-${process.pid}`;
for (const name of ['AUTH_READ_RATE_LIMIT_MAX', 'AUTH_WRITE_RATE_LIMIT_MAX', 'BASELINE_RATE_LIMIT_MAX', 'COARSE_IP_RATE_LIMIT_MAX', 'SENSITIVE_RATE_LIMIT_MAX']) process.env[name] = '1000000';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const realNetwork = jest.fn(() => { throw new Error('REAL_NETWORK_CALL_BLOCKED'); });
const originalFetch = globalThis.fetch;
beforeAll(() => { globalThis.fetch = jest.fn(async () => realNetwork()); });
afterAll(() => { globalThis.fetch = originalFetch; });
afterEach(() => expect(realNetwork).not.toHaveBeenCalled());

const request = require('supertest');
const app = require('../src/app');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const { seedTestPlans } = require('./helpers/seedTestPlans');
const { seedSpeaking, makeAudioSubmission } = require('./helpers/speakingFixtures');
const h = require('./helpers/speakingAssessmentFixtures');
const samples = require('./helpers/audioSamples');
const { TEXTS } = require('./fixtures/audio/speakingBenchmark.cjs');
const FIXTURE = require('./fixtures/audio/deepgram-nova3-response.cjs');
const File = require('../src/models/File');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const storage = require('../src/services/audio/storage');
const processing = require('../src/services/audio/processing');
const assessment = require('../src/services/audio/speakingAssessment.service');
const deepgram = require('../src/services/audio/stt/deepgram');
const draftComparison = require('../src/services/draftComparison.service');
const weekly = require('../src/services/weeklyTeacherSummary.service');
const removal = require('../src/services/submissionRemoval.service');
const coach = require('../src/services/speakingCoach/generation.service');
const attempts = require('../src/services/speakingCoach/attempt.service');
const check = require('../src/services/speakingCoach/assessment.service');

jest.setTimeout(120000);
const uploadRoot = path.resolve(__dirname, '..', process.env.UPLOAD_BASE_PATH);
const auth = token => ({ Authorization: `Bearer ${token}` });
const ENV = { ...h.TEST_ENV, AUDIO_STT_ENABLED: 'true', SPEAKING_COACH_ENABLED: 'true' };
const GOOD = Object.fromEntries(h.DEFAULT_IDS.map(id => [id, 'Good']));
const ATTEMPT_TEXT = 'My town is small and peaceful. It has one school and one shop. I go to school on foot every morning with my friend. '
  + 'There is a river near the park and people are friendly. I like my town because it is calm and green.';
let f;

beforeAll(connectInMemoryMongo);
afterAll(async () => { await disconnectInMemoryMongo(); fs.rmSync(uploadRoot, { recursive: true, force: true }); });
beforeEach(async () => {
  await clearDatabase(); await seedTestPlans();
  for (const model of [AudioRecording, AudioUsageLedger, SpeakingPracticeSession, SpeakingPracticeAttempt]) await model.createIndexes();
  process.env.AUDIO_STT_ENABLED = 'true';
  f = await seedSpeaking();
  await h.personalCredits(f.teacher.user, 5);
});
afterEach(() => { delete process.env.AUDIO_STT_ENABLED; });

async function assessed() {
  const made = await makeAudioSubmission(f, { status: 'ready', seconds: 60 });
  await AudioRecording.collection.updateOne({ _id: made.recording._id }, { $set: { derived: { derivedTextVersion: 'audio-derived-text-v1',
    displayText: { text: TEXTS.WEAK, fillers: [] }, assessorText: TEXTS.WEAK, fluency: h.fluencyFor(TEXTS.WEAK) }, transcriptSchemaVersion: 'audio-transcript-v1',
    wordTimingsAvailable: true } });
  await assessment.enqueueAssessment(made.recording._id);
  await assessment.runSpeakingAssessment(made.recording._id, { env: h.TEST_ENV,
    fetchImpl: h.fakeOpenRouter(h.output({ levels: { ...GOOD, 'speaking-grammar': 'Developing' } })) });
  return made;
}

function upload() {
  fs.mkdirSync(storage.audioRoot(), { recursive: true });
  const filename = `${crypto.randomUUID()}.wav`;
  const bytes = samples.wav(20);
  fs.writeFileSync(path.join(storage.audioRoot(), filename), bytes);
  return { filename, storedPath: storage.storedPathFor(filename), extension: '.wav', contentType: 'audio/wav', sizeBytes: bytes.length, durationSeconds: 20,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'), commit() { this.committed = true; } };
}

/** A practice session with one checked attempt (its audio deleted) and one attempt still waiting for its transcription (its audio on disk). */
async function practised(made) {
  const actor = f.student.user._id;
  const { session } = await coach.startSession(made.submission._id, actor, { env: ENV, fetchImpl: h.fakeOpenRouter({ status: 500 }) });
  const send = async () => attempts.commitAttempt({ context: await attempts.prepareAttempt({ sessionId: session._id, taskId: 't1', actor,
    requestId: `req-${crypto.randomUUID()}`, env: ENV }), upload: upload(), actor });
  const first = await send();
  await processing.processAudioRecording(first.recordingId, { transcribe: async () => ({ transcript: deepgram.normalize(FIXTURE), attempts: [], fallbackUsed: false }),
    env: ENV });
  await AudioRecording.collection.updateOne({ _id: first.recordingId }, { $set: { 'derived.assessorText': ATTEMPT_TEXT } });
  await check.runPracticeCheck(first._id, { env: ENV, fetchImpl: h.fakeOpenRouter({ assessable: true, notAssessableReason: 'none', onTask: true,
    level: 'Developing', improved: [], stillWeak: ['Check each verb as you say it.'], nextTip: 'Speak a little more slowly.' }) });
  const second = await send();
  return { session, first, second };
}

describe('static: who may use practice data', () => {
  test('only the coach, the audio worker branch, the practice minutes and submission removal require the practice models or services', () => {
    const src = path.join(__dirname, '..', 'src');
    const files = [];
    const walk = dir => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full); else if (entry.name.endsWith('.js')) files.push(full);
    } };
    walk(src);
    // A require of a practice model or a coach module, or the model definitions (not the unrelated recording field speakingCoachDataAvailable).
    const USES = /require\(['"][^'"]*(?:SpeakingPractice(?:Session|Attempt)|\/speakingCoach\/[^'"]*|speakingCoach\.(?:controller|routes))['"]\)|model\(['"]SpeakingPractice/;
    const users = files.filter(file => USES.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(src, file).split(path.sep).join('/')).sort();
    const allowed = users.filter(file => file.startsWith('services/speakingCoach/') || /^models\/SpeakingPractice(Session|Attempt)\.js$/.test(file));
    expect(users.filter(file => !allowed.includes(file))).toEqual(['app.js', 'controllers/speakingCoach.controller.js', 'routes/speakingCoach.routes.js',
      'routes/speakingGuest.routes.js', 'services/audio/processing.js', 'services/audio/usage.js', 'services/submissionRemoval.service.js'].sort());
  });
});

describe('dynamic: reports and dashboards read the same with practice data', () => {
  test('assignment report, graded result, student and class progress, weekly summary', async () => {
    const made = await assessed();
    const read = async () => ({
      report: await request(app).get(`/api/assignments/${f.assignment._id}/report`).set(auth(f.teacher.token)).then(res => ({ status: res.status, body: res.body })),
      studentResult: (await request(app).get(`/api/speaking/submissions/${made.submission._id}/result`).set(auth(f.student.token))).body,
      teacherResult: (await request(app).get(`/api/speaking/submissions/${made.submission._id}/result`).set(auth(f.teacher.token))).body,
      studentProgress: await draftComparison.studentProgress(f.klass._id, f.student.user._id, f.teacher.user),
      classProgress: await draftComparison.classProgressSummaries(f.klass._id),
      weekly: await weekly.progressForWindow({ teacherId: f.teacher.user._id, classIds: [f.klass._id], assignmentIds: [f.assignment._id],
        start: new Date(Date.now() - 86400000), end: new Date(Date.now() + 3600000) })
    });
    const before = await read();
    // The assignment report is essay-only (409 for a speaking assignment, before and after): practice cannot appear there.
    expect(before.report).toMatchObject({ status: 409, body: { code: 'ASSIGNMENT_REPORT_UNSUPPORTED' } });
    expect(before.studentResult.data.state).toBe('ready');
    await practised(made);
    expect(await SpeakingPracticeAttempt.countDocuments()).toBe(2);
    const after = await read();
    const stable = value => JSON.parse(JSON.stringify(value).replace(/"generatedAt":"[^"]*"/g, '"generatedAt":"-"'));
    expect(stable(after)).toEqual(stable(before));
  });
});

describe('removal', () => {
  test('removing the submission removes its practice: sessions, attempts, practice recordings and practice audio still on disk', async () => {
    const made = await assessed();
    const { second } = await practised(made);
    const waiting = await AudioRecording.findById(second.recordingId).lean();
    const file = await File.findById(waiting.audioFileId).lean();
    const absolute = storage.resolveStoredAudioPath(file.path);
    expect(fs.existsSync(absolute)).toBe(true);
    const other = await makeAudioSubmission(f, { status: 'ready', seconds: 8, mode: 'guest' });   // another submission and its practice stay
    await SpeakingPracticeSession.create({ submissionId: other.submission._id, assignmentId: f.assignment._id, guestSubmissionId: other.submission._id,
      status: 'ready', settings: { passPercent: 70, attemptCap: 20 }, sourceFingerprint: 'e'.repeat(64), tasks: [{ taskId: 't1', order: 1, type: 'follow_up',
        criterionId: 'speaking-task', areaLabel: 'Task', prompt: 'Say one more reason.', tip: 'Take your time.', maxSeconds: 90, status: 'active',
        passRule: { rule: 'threshold', minimumPercent: 70 } }], currentTaskId: 't1' });

    await removal.removeSubmissionForTeacher(made.submission._id, f.teacher.user._id);
    expect(await SpeakingPracticeSession.countDocuments({ submissionId: made.submission._id })).toBe(0);
    expect(await SpeakingPracticeAttempt.countDocuments({ submissionId: made.submission._id })).toBe(0);
    expect(await AudioRecording.countDocuments({ purpose: 'practice' })).toBe(0);
    expect(await File.findById(file._id)).toBeNull();
    expect(fs.existsSync(absolute)).toBe(false);
    expect(await SpeakingPracticeSession.countDocuments({ submissionId: other.submission._id })).toBe(1);
  });
});
