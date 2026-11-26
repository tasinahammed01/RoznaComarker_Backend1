'use strict';
// Speaking Coach models and scripts/migrateSpeakingCoachIndexes.js (production connects with autoIndex off). Idempotent and additive.
// Also: the new purpose fields on AudioRecording and AudioUsageLedger are optional (existing documents, which have none, stay valid).
process.env.NODE_ENV = 'test';
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const SpeakingPracticeSession = require('../src/models/SpeakingPracticeSession');
const SpeakingPracticeAttempt = require('../src/models/SpeakingPracticeAttempt');
const AudioRecording = require('../src/models/AudioRecording');
const AudioUsageLedger = require('../src/models/AudioUsageLedger');
const { ensureSpeakingCoachIndexes, SPEAKING_COACH_INDEXES, main } = require('../scripts/migrateSpeakingCoachIndexes');

beforeAll(connectInMemoryMongo);
afterAll(disconnectInMemoryMongo);
beforeEach(clearDatabase);

const id = () => new mongoose.Types.ObjectId();
const SESSION_INDEXES = ['speaking_practice_session_student_v1', 'speaking_practice_session_guest_v1', 'speaking_practice_session_assignment_v1'];
const ATTEMPT_INDEXES = ['speaking_practice_attempt_number_v1', 'speaking_practice_attempt_request_v1', 'speaking_practice_attempt_queue_v1',
  'speaking_practice_attempt_recording_v1', 'speaking_practice_attempt_transcribing_v1'];

const task = (over = {}) => ({ taskId: 't1', order: 1, type: 'repeat_improve', criterionId: 'speaking-grammar', areaLabel: 'Grammar',
  prompt: 'Answer the task again and use the past tense carefully.', tip: 'Say each sentence slowly.', maxSeconds: 90, status: 'active',
  passRule: { rule: 'threshold', minimumPercent: 70 }, ...over });
const session = (over = {}) => ({ submissionId: id(), assignmentId: id(), studentId: id(), status: 'ready', settings: { passPercent: 70, attemptCap: 20 },
  sourceFingerprint: 'f'.repeat(64), sourceSnapshot: { criteria: [] }, tasks: [task()], currentTaskId: 't1', ...over });

test('the index names match the schemas exactly', () => {
  expect(SPEAKING_COACH_INDEXES).toEqual({ SpeakingPracticeSession: SESSION_INDEXES, SpeakingPracticeAttempt: ATTEMPT_INDEXES });
  expect(SpeakingPracticeSession.schema.indexes().map(([, o]) => o.name).sort()).toEqual([...SESSION_INDEXES].sort());
  expect(SpeakingPracticeAttempt.schema.indexes().map(([, o]) => o.name).sort()).toEqual([...ATTEMPT_INDEXES].sort());
});

test('creates every index, twice without error, and leaves other indexes alone', async () => {
  for (const model of [SpeakingPracticeSession, SpeakingPracticeAttempt]) { await model.collection.drop().catch(() => {}); await model.createCollection(); }
  await SpeakingPracticeSession.collection.createIndex({ createdAt: 1 }, { name: 'someone_elses_index' });
  const first = await ensureSpeakingCoachIndexes();
  expect(await ensureSpeakingCoachIndexes()).toEqual(first);
  const s = Object.fromEntries(first.SpeakingPracticeSession.map(index => [index.name, index]));
  expect(s.speaking_practice_session_student_v1).toEqual({ name: 'speaking_practice_session_student_v1', key: { submissionId: 1, studentId: 1, sourceFingerprint: 1 },
    unique: true, partialFilterExpression: { studentId: { $exists: true } } });
  expect(s.speaking_practice_session_guest_v1).toEqual({ name: 'speaking_practice_session_guest_v1', key: { submissionId: 1, guestSubmissionId: 1, sourceFingerprint: 1 },
    unique: true, partialFilterExpression: { guestSubmissionId: { $exists: true } } });
  expect(s.speaking_practice_session_assignment_v1).toEqual({ name: 'speaking_practice_session_assignment_v1', key: { assignmentId: 1, completedAt: 1 } });
  expect(s.someone_elses_index).toBeTruthy();
  const a = Object.fromEntries(first.SpeakingPracticeAttempt.map(index => [index.name, index]));
  expect(a.speaking_practice_attempt_number_v1).toEqual({ name: 'speaking_practice_attempt_number_v1', key: { sessionId: 1, attemptNumber: 1 }, unique: true });
  expect(a.speaking_practice_attempt_request_v1).toEqual({ name: 'speaking_practice_attempt_request_v1', key: { sessionId: 1, requestId: 1 }, unique: true });
  expect(a.speaking_practice_attempt_queue_v1).toEqual({ name: 'speaking_practice_attempt_queue_v1',
    key: { assessmentQueue: 1, assessmentNextAttemptAt: 1, assessmentLeaseUntil: 1 }, partialFilterExpression: { assessmentQueue: true } });
  expect(a.speaking_practice_attempt_recording_v1).toEqual({ name: 'speaking_practice_attempt_recording_v1', key: { recordingId: 1 } });
  expect(a.speaking_practice_attempt_transcribing_v1).toEqual({ name: 'speaking_practice_attempt_transcribing_v1', key: { status: 1, updatedAt: 1 },
    partialFilterExpression: { status: 'transcribing' } });
});

test('main refuses to run without MONGO_URI', async () => {
  const saved = process.env.MONGO_URI; delete process.env.MONGO_URI;
  try { await expect(main()).rejects.toThrow('MONGO_URI is required'); } finally { if (saved !== undefined) process.env.MONGO_URI = saved; }
});

describe('session documents', () => {
  beforeEach(() => SpeakingPracticeSession.createIndexes());

  test('a student session and a guest session are valid; a session with neither owner is not', async () => {
    await expect(SpeakingPracticeSession.create(session())).resolves.toBeTruthy();
    const guestId = id();
    await expect(SpeakingPracticeSession.create(session({ studentId: undefined, guestSubmissionId: guestId, submissionId: guestId }))).resolves.toBeTruthy();
    await expect(SpeakingPracticeSession.create(session({ studentId: undefined }))).rejects.toThrow(/studentId/);
  });

  test('one session per submission, owner and source', async () => {
    const first = session();
    await SpeakingPracticeSession.create(first);
    await expect(SpeakingPracticeSession.create({ ...first })).rejects.toMatchObject({ code: 11000 });
  });

  test('the settings snapshot cannot be changed once stored', async () => {
    const doc = await SpeakingPracticeSession.create(session());
    doc.settings.passPercent = 50; doc.settings.attemptCap = 99;
    await doc.save();
    const stored = await SpeakingPracticeSession.findById(doc._id).lean();
    expect(stored.settings).toEqual({ passPercent: 70, attemptCap: 20 });
  });

  test.each([['type', 'essay_rewrite'], ['status', 'done']])('a task with an unknown %s is refused', async (field, value) => {
    await expect(SpeakingPracticeSession.create(session({ tasks: [task({ [field]: value })] }))).rejects.toThrow(field);
  });

  test('one to three tasks', async () => {
    await expect(SpeakingPracticeSession.create(session({ tasks: [] }))).rejects.toThrow(/tasks/);
    await expect(SpeakingPracticeSession.create(session({ tasks: [1, 2, 3, 4].map(n => task({ taskId: `t${n}`, order: n }))}))).rejects.toThrow(/tasks/);
    await expect(SpeakingPracticeSession.create(session({ status: 'generating', tasks: [] }))).resolves.toBeTruthy();
  });
});

describe('attempt documents', () => {
  beforeEach(() => SpeakingPracticeAttempt.createIndexes());
  const attempt = (over = {}) => ({ sessionId: id(), submissionId: id(), studentId: id(), taskId: 't1', attemptNumber: 1, requestId: 'r'.repeat(20),
    status: 'transcribing', ...over });

  test('attempt numbers and request ids are unique per session', async () => {
    const a = attempt();
    await SpeakingPracticeAttempt.create(a);
    await expect(SpeakingPracticeAttempt.create({ ...a, requestId: 's'.repeat(20) })).rejects.toMatchObject({ code: 11000 });
    await expect(SpeakingPracticeAttempt.create({ ...a, attemptNumber: 2 })).rejects.toMatchObject({ code: 11000 });
  });

  test('the queue and lease fields are never serialised', async () => {
    const doc = await SpeakingPracticeAttempt.create(attempt({ assessmentQueue: true, assessmentLeaseUntil: new Date(), assessmentAttemptKey: 'k',
      assessing: { provider: 'synthetic-provider', model: 'synthetic-model' } }));
    const json = JSON.stringify(doc.toJSON());
    for (const key of ['assessmentQueue', 'assessmentLeaseUntil', 'assessmentAttemptKey', 'assessing']) expect(json).not.toContain(key);
  });
});

describe('purpose fields (additive)', () => {
  test('AudioRecording and AudioUsageLedger accept practice and stay valid without a purpose', () => {
    const base = { owner: id(), requestId: 'request-0000000001', audioFileId: id(), contentType: 'audio/webm', sizeBytes: 10 };
    expect(new AudioRecording(base).validateSync()).toBeUndefined();
    expect(new AudioRecording(base).purpose).toBeUndefined();
    expect(new AudioRecording({ ...base, purpose: 'practice', practiceAttemptId: id() }).validateSync()).toBeUndefined();
    expect(new AudioRecording({ ...base, purpose: 'other' }).validateSync()).toBeTruthy();
    const row = { key: 'k', recordingId: id(), uploader: id(), minutesChargedTo: id(), seconds: 5, dayKey: '2026-11-25', monthKey: '2026-11', state: 'reserved',
      reservedAt: new Date(), expiresAt: new Date() };
    expect(new AudioUsageLedger(row).validateSync()).toBeUndefined();
    expect(new AudioUsageLedger({ ...row, purpose: 'practice' }).validateSync()).toBeUndefined();
    expect(new AudioUsageLedger({ ...row, purpose: 'other' }).validateSync()).toBeTruthy();
  });
});
