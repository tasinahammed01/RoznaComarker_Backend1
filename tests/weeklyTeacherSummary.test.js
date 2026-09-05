'use strict';
process.env.NODE_ENV = 'test'; process.env.JWT_SECRET = 'weekly-summary-test';
const User = require('../src/models/user.model'); const Class = require('../src/models/class.model');
const Assignment = require('../src/models/assignment.model'); const Membership = require('../src/models/membership.model');
const Submission = require('../src/models/Submission'); const SubmissionRevision = require('../src/models/SubmissionRevision');
const SubmissionFeedback = require('../src/models/SubmissionFeedback'); const AssessmentRun = require('../src/models/AssessmentRun');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession'); const Notification = require('../src/models/notification.model');
const weekly = require('../src/services/weeklyTeacherSummary.service');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');

const rubric = (content, grammar) => ({ CONTENT: { score: content, maxScore: 20 }, GRAMMAR: { score: grammar, maxScore: 20 } });
const feedback = (score, scores) => ({ overallScore: score, evaluationStatus: 'completed', rubricScores: scores,
  evaluationRubricSourceHash: 'same-rubric' });

describe('weekly teacher summary', () => {
  let teacher; let student; let classDoc; let assignment; let submission; let now;
  beforeAll(async () => { await connectInMemoryMongo(); await Notification.init(); }); afterAll(disconnectInMemoryMongo);
  beforeEach(async () => {
    await clearDatabase(); delete process.env.WEEKLY_SUMMARY_ENABLED; delete process.env.WEEKLY_SUMMARY_DAY;
    delete process.env.WEEKLY_SUMMARY_HOUR; delete process.env.WEEKLY_SUMMARY_TIMEZONE; require('../src/services/retentionSettings.service').invalidate();
    now = new Date('2026-08-20T12:00:00.000Z');
    teacher = await User.create({ firebaseUid: 'weekly-teacher', email: 'weekly@example.test', role: 'teacher' });
    student = await User.create({ firebaseUid: 'weekly-student', email: 'weekly-student@example.test', role: 'student' });
    classDoc = await Class.create({ name: 'English 8A', teacher: teacher._id, joinCode: 'WEEKLY8A' });
    assignment = await Assignment.create({ title: 'Essay', deadline: new Date('2026-09-01'), class: classDoc._id, teacher: teacher._id });
    await Membership.create({ class: classDoc._id, student: student._id, status: 'active' });
    submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id,
      status: 'submitted', submittedAt: new Date('2026-08-19T10:00:00Z'), createdAt: new Date('2026-08-14T10:00:00Z'),
      isLate: false, draftNumber: 2, evaluationStatus: 'completed', assessmentStatus: 'complete',
      assessmentCompletedAt: new Date('2026-08-19T11:00:00Z'), writingCorrections: [], evaluationRubricSourceHash: 'same-rubric' });
    await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id,
      teacherId: teacher._id, ...feedback(82, rubric(17, 16)) });
    await SubmissionRevision.create({ sourceSubmissionId: submission._id, student: student._id, assignment: assignment._id,
      class: classDoc._id, draftNumber: 1, submittedAt: new Date('2026-08-14T10:00:00Z'), evaluationStatus: 'completed',
      assessmentStatus: 'complete', assessmentCompletedAt: new Date('2026-08-14T11:00:00Z'),
      writingCorrections: [{ category: 'GRAMMAR', symbol: 'G', quotedText: 'bad' }], evaluationRubricSourceHash: 'same-rubric',
      feedbackSnapshot: feedback(72, rubric(14, 14)) });
    await AssessmentRun.create({ runId: 'complete-run', submissionId: submission._id, assignmentId: assignment._id,
      teacherId: teacher._id, sourceHash: 'source', status: 'complete', completedAt: new Date('2026-08-19T11:00:00Z') });
    await AssessmentRun.create({ runId: 'failed-run', submissionId: submission._id, assignmentId: assignment._id,
      teacherId: teacher._id, sourceHash: 'source-2', status: 'failed', failedAt: new Date('2026-08-19T11:00:00Z') });
    await AdaptivePracticeSession.collection.insertOne({ submissionId: submission._id, studentId: student._id,
      assignmentId: assignment._id, status: 'ready', sourceFingerprint: 'one', completedAt: new Date('2026-08-19T12:00:00Z') });
  });

  test('uses an exact rolling seven-day UTC window', () => {
    const window = weekly.resolveWindow(now); expect(window.end.toISOString()).toBe(now.toISOString());
    expect(window.end.getTime() - window.start.getTime()).toBe(weekly.WINDOW_MS);
  });

  test('separates activity, counts authoritative completion once, and derives legitimate revision progress', async () => {
    const result = await weekly.getWeeklySummary(teacher, now);
    expect(result.activity).toEqual({ newSubmissions: 1, revisedDrafts: 1, adaptiveCompletions: 1, successfulAssessments: 1 });
    expect(result.progress).toMatchObject({ studentsImproved: 1, improvedRevisions: 1,
      averageRevisionScoreDelta: 10, issuesCorrected: 1, strongestImprovedCategory: null });
    expect(result.current).toEqual({ waitingForReview: 1, classesWithPendingReview: 1 });
    expect(result.classes[0]).toMatchObject({ name: 'English 8A', newSubmissions: 1, revisedDrafts: 1,
      studentsImproved: 1, waitingForReview: 1 });
  });

  test('foreign teacher data is excluded and no persisted accounting state is changed', async () => {
    const foreign = await User.create({ firebaseUid: 'foreign-weekly', email: 'foreign-weekly@example.test', role: 'teacher' });
    const result = await weekly.getWeeklySummary(foreign, now);
    expect(result.activity).toEqual({ newSubmissions: 0, revisedDrafts: 0, adaptiveCompletions: 0, successfulAssessments: 0 });
    expect(result.headline).toContain('Quiet week');
  });

  test('digest is disabled by default and concurrent delivery is idempotent when enabled', async () => {
    expect(await weekly.deliverWeeklyDigest(teacher, now)).toEqual({ status: 'disabled' });
    process.env.WEEKLY_SUMMARY_ENABLED = 'true';
    await Promise.all([weekly.deliverWeeklyDigest(teacher, now), weekly.deliverWeeklyDigest(teacher, now)]);
    expect(await Notification.countDocuments({ type: 'weekly_summary', recipient: teacher._id })).toBe(1);
  });

  test('runner minutes and seconds in one configured hour share one canonical digest identity', async () => {
    process.env.WEEKLY_SUMMARY_ENABLED = 'true'; process.env.WEEKLY_SUMMARY_DAY = 'Monday';
    process.env.WEEKLY_SUMMARY_HOUR = '9'; process.env.WEEKLY_SUMMARY_TIMEZONE = 'Asia/Dhaka';
    require('../src/services/retentionSettings.service').invalidate();
    await weekly.runWeeklyDigest(new Date('2026-08-17T03:01:10.000Z'));
    await weekly.runWeeklyDigest(new Date('2026-08-17T03:20:45.000Z'));
    await weekly.runWeeklyDigest(new Date('2026-08-17T03:59:59.000Z'));
    const notifications = await Notification.find({ type: 'weekly_summary', recipient: teacher._id }).lean();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].data.windowEnd).toBe('2026-08-17T03:00:00.000Z');
  });

  test('next scheduled week has a new identity and timezone boundaries remain local', async () => {
    process.env.WEEKLY_SUMMARY_ENABLED = 'true'; process.env.WEEKLY_SUMMARY_DAY = 'Monday';
    process.env.WEEKLY_SUMMARY_HOUR = '0'; process.env.WEEKLY_SUMMARY_TIMEZONE = 'Asia/Dhaka';
    require('../src/services/retentionSettings.service').invalidate();
    expect((await weekly.runWeeklyDigest(new Date('2026-08-16T18:15:00.000Z'))).status).toBe('complete');
    expect((await weekly.runWeeklyDigest(new Date('2026-08-23T18:45:00.000Z'))).status).toBe('complete');
    expect(await Notification.countDocuments({ type: 'weekly_summary', recipient: teacher._id })).toBe(2);
    expect((await weekly.runWeeklyDigest(new Date('2026-08-23T19:00:00.000Z'))).status).toBe('not_due');
    expect((await weekly.runWeeklyDigest(new Date('2026-08-24T18:00:00.000Z'))).status).toBe('not_due');
  });
});
