'use strict';
// A realistic, completed guest result for portal QA: a real guest upload (stored image on disk), OCR words with boxes, canonical
// corrections bound to those words, a current evaluation with rubric scores, detailed feedback and a teacher comment.
// Same recipe as tests/identicalReupload.release.test.js, through the guest upload endpoint. Synthetic content only.
const crypto = require('crypto');
const request = require('supertest');
const Submission = require('../../src/models/Submission');
const Feedback = require('../../src/models/SubmissionFeedback');

async function seedRealisticGuestResult({ app, assignment, teacher, email, name = 'QA Student', png, overallScore = 82, teacherComments = 'Teacher review complete.' }) {
  const pipeline = require('../../src/services/canonicalCorrectionsPipeline.service');
  const evaluation = require('../../src/services/canonicalEvaluation.service');
  const canonical = require('../../src/services/correctionCanonical.service');
  const evidence = require('../../src/services/correctionEvidenceIdentity.service');
  const { buildCanonicalSubmissionTranscript } = require('../../src/utils/ocrTranscriptNormalizer');
  const { resolveLegend } = require('../../src/services/correctionLegendResolver.service');
  const { evaluationPolicyHash } = require('../../src/services/teacherEvaluationPolicy.service');
  const versions = require('../../src/services/rubricLanguageScoring.service');

  const accepted = await request(app).post(`/api/guest/assignments/${assignment.qrToken}/submit`).set('Idempotency-Key', crypto.randomUUID())
    .field('name', name).field('email', email).attach('files', png, { filename: 'essay.png', contentType: 'image/png' });
  if (accepted.status !== 200) throw new Error(`guest upload failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
  const returnUrl = new URL(accepted.body.data.returnUrl);
  const submission = await Submission.findOne({ assignment: assignment._id, submissionMode: 'guest' }).sort({ submittedAt: -1 });
  const fileId = String(submission.files[0]);
  const texts = ['I', 'goes', 'to', 'the', 'park', 'every', 'day.'];
  submission.ocrPages = [{ fileId, fileOrder: 0, pageNumber: 1, pageIndex: 0, text: texts.join(' '), rawText: texts.join(' '),
    words: texts.map((text, i) => ({ id: `word_${fileId}_1_${i + 1}`, text, page: 1, bbox: { x0: 60 + i * 90, y0: 120, x1: 130 + i * 90, y1: 160 } })) }];
  const transcript = buildCanonicalSubmissionTranscript(submission);
  const sourceHash = pipeline.buildCorrectionSourceHash({ transcript: transcript.text, pages: transcript.pages,
    assignment, fileContentIdentity: submission.fileContentIdentity, legend: await resolveLegend() });
  const wordId = `word_${fileId}_1_2`;
  Object.assign(submission, { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed',
    transcriptText: transcript.text,
    correctionTranscriptLayoutVersion: require('../../src/utils/ocrTranscriptNormalizer').CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionGenerationConfig: { reviewIdentity: pipeline.buildCorrectionReviewIdentity({ assignment, policy: teacher.aiConfig }) },
    correctionVersion: canonical.VERSION, correctionSourceHash: sourceHash,
    writingCorrections: [{ id: 'qa-correction', fileId, wordIds: [wordId], evidenceWordIds: [wordId], page: 1,
      startChar: 2, endChar: 6, quotedText: 'goes', suggestedText: 'go', category: 'GRAMMAR', symbol: 'AGR' }],
    correctionStatistics: { grammar: 1, total: 1 }, evaluationStatus: 'completed', evaluationVersion: versions.EVALUATION_VERSION, assessmentStatus: 'complete', assessmentCompletedAt: new Date() });
  submission.writingCorrections = evidence.bindCorrections(submission.writingCorrections, transcript, submission);
  submission.correctionOcrJobId = submission.ocrJobId;
  submission.correctionOcrEvidenceHash = evidence.ocrEvidenceHash(transcript, submission);
  await submission.save();
  const rubricHash = evaluation.hashRubric(assignment), policyHash = evaluationPolicyHash(teacher.aiConfig);
  await Feedback.create({ submissionMode: 'guest', submissionId: submission._id, classId: submission.class, teacherId: teacher._id,
    overallScore, evaluationStatus: 'completed', evaluationSourceHash: sourceHash,
    assessmentVersion: versions.ASSESSMENT_VERSION, evaluationVersion: versions.EVALUATION_VERSION,
    // The teacher reviewed the AI result (the common released state); the detailed feedback belongs to this exact source.
    overriddenByTeacher: true, detailedFeedbackSourceHash: sourceHash, evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
    analysisInputHash: evaluation.analysisInputHash({ sourceHash, rubricHash, policyHash, contextHash: evaluation.hashBuiltInContext(assignment) }),
    rubricScores: { GRAMMAR: { score: 20, maxScore: 25, feedback: 'Watch subject-verb agreement.' } },
    detailedFeedback: { status: 'completed', sourceHash, version: 'canonical-detailed-feedback-1', summary: 'A clear short paragraph.',
      strengths: ['Clear ideas.'], areasForImprovement: ['Subject-verb agreement.'], actionSteps: ['Check verbs after "I".'] },
    teacherComments });
  return { submission: await Submission.findById(submission._id), guestToken: returnUrl.hash.slice(1), returnUrl };
}

module.exports = { seedRealisticGuestResult };
