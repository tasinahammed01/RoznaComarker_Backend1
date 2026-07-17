'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const request = require('supertest');
const express = require('express');
const connectDB = require('../src/config/db');
const adaptivePracticeRoutes = require('../src/routes/adaptivePractice.routes');
const { signJwt } = require('../src/utils/jwt');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Membership = require('../src/models/membership.model');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const AdaptivePracticeAttempt = require('../src/models/AdaptivePracticeAttempt');

const runMarker = `adaptive-phase3-${Date.now()}`;
const essay = 'Digital tools can support learning when they are used with a clear purpose. They give learners quick access to explanations and examples. This access is useful, but students still need to compare sources and explain their reasoning. Teachers can guide this process by choosing focused tasks. As a result, technology becomes a support for careful thinking rather than a replacement for it.';
const hash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const app = express();
app.use(express.json());
app.use('/api/adaptive-practice', adaptivePracticeRoutes);

async function main() {
  await connectDB();
  const teacher = await User.create({ firebaseUid: `${runMarker}-teacher`, email: `${runMarker}-teacher@example.invalid`, displayName: `${runMarker}-teacher`, role: 'teacher' });
  const student = await User.create({ firebaseUid: `${runMarker}-student`, email: `${runMarker}-student@example.invalid`, displayName: `${runMarker}-student`, role: 'student' });
  const classDoc = await Class.create({ name: runMarker, teacher: teacher._id, joinCode: `P3${Date.now().toString(36).slice(-8)}`.toUpperCase() });
  const membership = await Membership.create({ student: student._id, class: classDoc._id, status: 'active' });
  const assignment = await Assignment.create({ title: `${runMarker} synthetic writing`, instructions: 'Explain how digital tools can support careful learning.', deadline: new Date(Date.now() + 86400000), class: classDoc._id, teacher: teacher._id });
  const submission = await Submission.create({ student: student._id, assignment: assignment._id, class: classDoc._id, status: 'submitted', submittedAt: new Date(), transcriptText: essay, correctionStatistics: { content: 1, grammar: 2, organization: 1, vocabulary: 1, mechanics: 0, total: 5 } });
  const feedback = await SubmissionFeedback.create({ submissionId: submission._id, classId: classDoc._id, studentId: student._id, teacherId: teacher._id, overallScore: 68, assessmentVersion: 'synthetic-phase3-v1', rubricScores: { CONTENT: { score: 15, maxScore: 20 }, ORGANIZATION: { score: 11, maxScore: 20 }, VOCABULARY: { score: 12, maxScore: 20 }, GRAMMAR: { score: 19, maxScore: 25 }, MECHANICS: { score: 8, maxScore: 10 } }, correctionStatistics: { content: 1, grammar: 2, organization: 1, vocabulary: 1, mechanics: 0, total: 5 }, detailedFeedback: { strengths: ['Synthetic strength'], areasForImprovement: ['Synthetic flow'], actionSteps: ['Use transitions'] } });
  const gradingBefore = hash({ submission: await Submission.findById(submission._id).lean(), feedback: await SubmissionFeedback.findById(feedback._id).lean() });
  const token = signJwt(student);
  const auth = { Authorization: `Bearer ${token}` };

  let generated = await request(app).post(`/api/adaptive-practice/submissions/${submission._id}/generate`).set(auth).send({ retry: false });
  if (generated.status >= 400 || generated.body.data?.state === 'failed') generated = await request(app).post(`/api/adaptive-practice/submissions/${submission._id}/generate`).set(auth).send({ retry: true });
  if (generated.status !== 200 || generated.body.data?.state !== 'ready') throw new Error(`Generation failed safely: HTTP ${generated.status}, code ${generated.body.code || generated.body.data?.state}`);
  const session = generated.body.data.session;
  const activity = session.activities[0];
  const response1 = activity.skillId === 'VOCABULARY' ? 'Digital tools can facilitate learning by providing immediate access to relevant explanations and carefully selected examples.' : 'Digital tools provide quick access to explanations; however, learners must still compare sources and explain their reasoning.';
  const response2 = `${response1} Therefore, focused guidance helps students use technology as support for careful thinking.`;
  const first = await request(app).post(`/api/adaptive-practice/sessions/${session._id}/activities/${activity.activityId}/check`).set(auth).send({ response: response1 });
  if (first.status !== 200 || first.body.data?.state !== 'ready') throw new Error(`First check failed safely: HTTP ${first.status}, code ${first.body.code || first.body.data?.state}`);
  const identical = await request(app).post(`/api/adaptive-practice/sessions/${session._id}/activities/${activity.activityId}/check`).set(auth).send({ response: response1 });
  const changed = await request(app).post(`/api/adaptive-practice/sessions/${session._id}/activities/${activity.activityId}/check`).set(auth).send({ response: response2 });
  if (identical.status !== 200 || changed.status !== 200) throw new Error('Idempotency or changed-response check failed.');
  const restored = await request(app).get(`/api/adaptive-practice/submissions/${submission._id}`).set(auth);
  const attempts = await AdaptivePracticeAttempt.find({ sessionId: session._id }).sort({ attemptNumber: 1 }).lean();
  const gradingAfter = hash({ submission: await Submission.findById(submission._id).lean(), feedback: await SubmissionFeedback.findById(feedback._id).lean() });
  const counts = { sessions: await AdaptivePracticeSession.countDocuments({ submissionId: submission._id }), attempts: attempts.length };
  process.stdout.write(JSON.stringify({ runMarker, ids: { teacher: teacher._id, student: student._id, class: classDoc._id, membership: membership._id, assignment: assignment._id, submission: submission._id, feedback: feedback._id, session: session._id, attempts: attempts.map((item) => item._id) }, syntheticTranscript: { length: essay.length, sha256: crypto.createHash('sha256').update(essay).digest('hex') }, generation: { status: generated.status, provider: session.generation.provider, model: session.generation.model, targets: session.targetSkills, activityCount: session.activities.length }, firstCheck: { status: first.status, score: first.body.data.attempt.result.score, passed: first.body.data.attempt.result.passed }, identical: { status: identical.status, reused: identical.body.data.reused, sameAttempt: identical.body.data.attempt._id === first.body.data.attempt._id }, changed: { status: changed.status, attemptNumber: changed.body.data.attempt.attemptNumber, score: changed.body.data.attempt.result.score }, restoration: { status: restored.status, state: restored.body.data?.state, progress: restored.body.data?.progress }, counts, gradingUnchanged: gradingBefore === gradingAfter }, null, 2));
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }).finally(async () => mongoose.disconnect());
