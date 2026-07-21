'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('../tests/helpers/testServer');
const Assignment = require('../src/models/assignment.model');
const Submission = require('../src/models/Submission');
const SubmissionFeedback = require('../src/models/SubmissionFeedback');
const AdaptivePracticeSession = require('../src/models/AdaptivePracticeSession');
const service = require('../src/services/adaptivePractice.service');

async function main() {
  await connectInMemoryMongo();
  const studentId = new mongoose.Types.ObjectId();
  const teacherId = new mongoose.Types.ObjectId();
  const classId = new mongoose.Types.ObjectId();
  const page1 = 'Artificial intelligence supports learners with timely examples and personalized explanations. Students still need clear goals, accurate evidence, and feedback from their teachers.';
  const page2 = 'Responsible classroom use also requires privacy safeguards, careful review, and explanations of how automated suggestions should be evaluated before students accept them.';
  const transcript = `${page1}\n\n${page2}`;
  const assignment = await Assignment.create({ title: 'Responsible AI in education', instructions: 'Explain benefits and risks using clear evidence.', deadline: new Date(Date.now() + 86400000), class: classId, teacher: teacherId });
  const submission = await Submission.create({
    student: studentId, assignment: assignment._id, class: classId, status: 'submitted', submittedAt: new Date(),
    transcriptText: transcript, combinedOcrText: transcript,
    ocrPages: [{ fileId: new mongoose.Types.ObjectId(), pageNumber: 1, text: page1 }, { fileId: new mongoose.Types.ObjectId(), pageNumber: 1, text: page2 }]
  });
  await SubmissionFeedback.create({
    submissionId: submission._id, classId, studentId, teacherId, assessmentVersion: 'writing-rubric-100-v1',
    rubricScores: {
      CONTENT: { score: 10, maxScore: 20 }, ORGANIZATION: { score: 16, maxScore: 20 },
      VOCABULARY: { score: 16, maxScore: 20 }, GRAMMAR: { score: 21, maxScore: 25 }, MECHANICS: { score: 8, maxScore: 10 }
    },
    detailedFeedback: { strengths: ['Clear focus'], areasForImprovement: ['Add specific supporting evidence'], actionSteps: ['Develop one example'] }
  });
  const before = Date.now();
  const result = await service.generateSession(submission._id, studentId, { requestReceivedAt: new Date() });
  const stored = await AdaptivePracticeSession.findOne({ submissionId: submission._id }).lean();
  process.stdout.write(`${JSON.stringify({ state: result.state, wallClockMs: Date.now() - before, provider: stored?.generation?.provider, model: stored?.generation?.model, metrics: stored?.generation?.metrics }, null, 2)}\n`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(disconnectInMemoryMongo);
