'use strict';
// Deterministic submissions for the annotation work (Task 6A): fixed ids and dates, a registered student and a guest, bound canonical
// corrections and a current, teacher-reviewed evaluation. Used by the golden (no-annotation) tests, the bug reproductions and the
// no-leak matrix. Synthetic text only.
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const id = hex => new mongoose.Types.ObjectId(hex.padStart(24, '0'));
const IDS = {
  teacher: id('a1'), otherTeacher: id('a2'), student: id('a3'), class: id('c1'), assignment: id('d1'),
  registered: id('e1'), guest: id('e2'), fileRegistered: id('f1'), fileGuest: id('f2'), feedbackRegistered: id('b1'), feedbackGuest: id('b2'),
};
const FIXED = new Date('2026-10-01T09:00:00.000Z');
// Errors: "goes" (AGR), "a apple" (ART), "dont" (SP), "goes" again later (AGR duplicate), "realy" (SP).
const WORDS = ['I', 'goes', 'to', 'the', 'park', 'every', 'day.', 'I', 'ate', 'a', 'apple', 'and', 'I', 'dont', 'like', 'it.',
  'She', 'goes', 'home', 'and', 'she', 'is', 'realy', 'tired.'];

async function writeImage(file) {
  const png = await require('sharp')({ create: { width: 1200, height: 900, channels: 3, background: { r: 252, g: 250, b: 245 } } }).png().toBuffer();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, png);
}

/** The words of one page with boxes in the display-image space (normalised 0..1, as stored by the OCR pipeline). */
function pageWords(fileId, words = WORDS) {
  return words.map((text, i) => {
    const line = Math.floor(i / 16), col = i % 16;
    return { id: `word_${fileId}_1_${i + 1}`, text, page: 1,
      bbox: { x0: 0.04 + col * 0.058, y0: 0.1 + line * 0.08, x1: 0.04 + col * 0.058 + 0.05, y1: 0.15 + line * 0.08 } };
  });
}

// [word index, symbol, category, suggestion, message] of the AI corrections on WORDS.
const AI_SPECS = [[1, 'AGR', 'GRAMMAR', 'go', 'Use "go" after "I".'], [9, 'ART', 'GRAMMAR', 'an', 'Use "an" before a vowel sound.'],
  [13, 'SP', 'MECHANICS', "don't", 'Missing apostrophe.'], [17, 'AGR', 'GRAMMAR', 'go', 'Check the verb.'], [22, 'SP', 'MECHANICS', 'really', 'Spelling.']];

/**
 * Writes OCR pages and bound AI corrections onto a submission document exactly as the pipeline persists them: canonical transcript,
 * deterministic correction ids (hash of the span), evidence binding. Used for the first OCR run and for simulated re-runs.
 */
async function applyOcrAndCorrections(doc, { fileId, words = WORDS, specs = AI_SPECS, assignment, teacher, ocrJobId }) {
  const pipeline = require('../../src/services/canonicalCorrectionsPipeline.service');
  const canonical = require('../../src/services/correctionCanonical.service');
  const evidence = require('../../src/services/correctionEvidenceIdentity.service');
  const versions = require('../../src/services/rubricLanguageScoring.service');
  const { buildCanonicalSubmissionTranscript, CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../../src/utils/ocrTranscriptNormalizer');
  const { resolveLegend } = require('../../src/services/correctionLegendResolver.service');
  const text = words.join(' ');
  doc.ocrJobId = ocrJobId;
  doc.ocrPages = [{ _id: id(doc.submissionMode === 'guest' ? '9b' : '9a'), fileId: String(fileId), fileOrder: 0, pageNumber: 1, pageIndex: 0, text, rawText: text, words: pageWords(fileId, words),
    coordinateSpace: 'display-image', width: 1200, height: 900, ocrImageWidth: 1200, ocrImageHeight: 900 }];
  const transcript = buildCanonicalSubmissionTranscript(doc);
  const sourceHash = pipeline.buildCorrectionSourceHash({ transcript: transcript.text, pages: transcript.pages, assignment,
    fileContentIdentity: doc.fileContentIdentity, legend: await resolveLegend() });
  const offset = word => { let start = 0; for (let i = 0; i < word; i++) start += words[i].length + 1; return start; };
  // A spec's word is one index or an inclusive [first, last] range of indexes.
  const raw = specs.map(([word, symbol, category, suggestedText, message]) => {
    const [first, last] = Array.isArray(word) ? word : [word, word];
    const start = offset(first), end = offset(last) + words[last].length;
    const wordIds = Array.from({ length: last - first + 1 }, (_, k) => `word_${fileId}_1_${first + k + 1}`);
    return { fileId: String(fileId), page: 1, startChar: start, endChar: end, quotedText: words.slice(first, last + 1).join(' '), suggestedText, message,
      category, symbol, wordIds, evidenceWordIds: [...wordIds] };
  });
  // Real canonical ids (deterministic hash of the span, as the AI pipeline assigns them).
  const legend = await resolveLegend();
  const corrections = raw.map(c => ({ ...c, id: `ai_${require('crypto').createHash('sha1').update([canonical.VERSION, 'AI', c.category, c.symbol, c.startChar, c.endChar, c.quotedText].join('|')).digest('hex').slice(0, 16)}`,
    source: 'AI', groupKey: c.category, symbolLabel: c.symbol, color: legend?.groups?.[0]?.color || '#c00' }));
  const count = cat => corrections.filter(c => c.category === cat).length;
  Object.assign(doc, { ocrStatus: 'completed', correctionStatus: 'completed', semanticStatus: 'completed', transcriptText: transcript.text,
    correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION,
    correctionGenerationConfig: { reviewIdentity: pipeline.buildCorrectionReviewIdentity({ assignment, policy: teacher.aiConfig }) },
    correctionVersion: canonical.VERSION, correctionSourceHash: sourceHash, writingCorrections: corrections,
    correctionStatistics: { grammar: count('GRAMMAR'), mechanics: count('MECHANICS'), content: 0, organization: 0, vocabulary: 0, total: corrections.length },
    evaluationStatus: 'completed', assessmentStatus: 'complete', assessmentCompletedAt: FIXED, evaluationVersion: versions.EVALUATION_VERSION });
  doc.writingCorrections = evidence.bindCorrections(doc.writingCorrections, transcript, doc);
  doc.correctionOcrJobId = doc.ocrJobId;
  doc.correctionOcrEvidenceHash = evidence.ocrEvidenceHash(transcript, doc);
  return sourceHash;
}

/**
 * Simulates a completed OCR re-run (and the AI correction regeneration that follows it): new words, new deterministic ids, new
 * evidence hash. The teacher overlay is left exactly as stored.
 */
async function rerunOcr({ submissionId, words, specs, ocrJobId = 'job-rerun' }) {
  const Submission = require('../../src/models/Submission');
  const Assignment = require('../../src/models/assignment.model');
  const User = require('../../src/models/user.model');
  const doc = await Submission.findById(submissionId);
  const assignment = await Assignment.findById(doc.assignment);
  const teacher = await User.findById(assignment.teacher);
  await applyOcrAndCorrections(doc, { fileId: doc.files[0], words, specs, assignment, teacher, ocrJobId });
  await doc.save();
  return doc;
}

/** Replaces the AI corrections only (an AI regenerate on unchanged OCR): same evidence, new ids for changed spans or symbols. */
async function regenerateCorrections({ submissionId, specs }) {
  const Submission = require('../../src/models/Submission');
  const doc = await Submission.findById(submissionId).lean();
  return rerunOcr({ submissionId, words: doc.ocrPages[0].words.map(w => w.text), specs, ocrJobId: doc.ocrJobId });
}

/** Builds and saves one submission with canonical corrections and a current evaluation. */
async function seedSubmission({ submissionId, fileId, feedbackId, mode, studentId, guestToken, uploadRoot, teacher, assignment }) {
  const Submission = require('../../src/models/Submission');
  const Feedback = require('../../src/models/SubmissionFeedback');
  const File = require('../../src/models/File');
  const evaluation = require('../../src/services/canonicalEvaluation.service');
  const versions = require('../../src/services/rubricLanguageScoring.service');
  const { evaluationPolicyHash } = require('../../src/services/teacherEvaluationPolicy.service');
  const access = require('../../src/services/guestAccess.service');

  const filename = `${fileId}.png`;
  await writeImage(path.join(uploadRoot, 'submissions', filename));
  await File.create({ _id: fileId, originalName: 'essay.png', filename, path: `${path.basename(uploadRoot)}/submissions/${filename}`,
    url: `/uploads/submissions/${filename}`, uploadedBy: mode === 'guest' ? teacher._id : studentId, role: mode === 'guest' ? 'teacher' : 'student',
    type: 'submissions', createdAt: FIXED });
  const doc = new Submission({ _id: submissionId, submissionMode: mode, ...(mode === 'guest' ? {} : { student: studentId }),
    assignment: assignment._id, class: assignment.class, qrToken: assignment.qrToken, files: [fileId], file: fileId,
    fileOrder: [{ fileId, order: 0 }], fileUrls: [`/uploads/submissions/${filename}`], fileUrl: `/uploads/submissions/${filename}`,
    fileContentIdentity: `fixture-${mode}`, submittedAt: FIXED, status: 'submitted', draftNumber: 1,
    ...(mode === 'guest' ? { guest: { displayName: 'Guest Student', normalizedEmail: 'guest.student@example.com', accessHash: access.hash(guestToken),
      expiresAt: new Date('2099-01-01T00:00:00.000Z') } } : {}) });
  const sourceHash = await applyOcrAndCorrections(doc, { fileId, assignment, teacher, ocrJobId: `job-${mode}` });
  await doc.save();
  const rubricHash = evaluation.hashRubric(assignment), policyHash = evaluationPolicyHash(teacher.aiConfig);
  // Structured feedback exactly as the canonical evaluation stores it: examples and scoring audit reference correction ids.
  const stored = doc.toObject();
  const categoryScores = { GRAMMAR: { score: 18, maxScore: 25, comment: 'Watch verb agreement.' }, MECHANICS: { score: 8, maxScore: 10, comment: 'Check spelling.' } };
  const detailedFeedback = { ...require('../../src/services/canonicalDetailedFeedback.service').buildDeterministicDetailedFeedback({
    corrections: stored.writingCorrections, statistics: stored.correctionStatistics, categoryScores, sourceHash, transcript: stored.transcriptText }),
  summary: 'Short paragraph.' };
  const scoringAudit = { version: 'fixture', categories: ['GRAMMAR', 'MECHANICS'].map(category => require('../../src/services/rubricLanguageScoring.service')
    .scoringAudit({ corrections: stored.writingCorrections, category, maxScore: categoryScores[category].maxScore, wordCount: WORDS.length })) };
  await Feedback.create({ _id: feedbackId, submissionMode: mode, submissionId, classId: assignment.class, ...(mode === 'guest' ? {} : { studentId }),
    teacherId: teacher._id, overallScore: 82, evaluationStatus: 'completed', evaluationSourceHash: sourceHash,
    assessmentVersion: versions.ASSESSMENT_VERSION, evaluationVersion: versions.EVALUATION_VERSION, overriddenByTeacher: true,
    detailedFeedbackSourceHash: sourceHash, evaluationRubricSourceHash: rubricHash, evaluationPolicyHash: policyHash,
    analysisInputHash: evaluation.analysisInputHash({ sourceHash, rubricHash, policyHash, contextHash: evaluation.hashBuiltInContext(assignment) }),
    rubricScores: { GRAMMAR: { score: 18, maxScore: 25, feedback: 'Watch verb agreement.' } },
    detailedFeedback, scoringAudit,
    teacherComments: 'Teacher review complete.', createdAt: FIXED, updatedAt: FIXED });
  return Submission.findById(submissionId);
}

/** Seeds the whole fixture. Returns ids, the guest token and the users. */
async function seedAnnotationFixture({ uploadRoot }) {
  const User = require('../../src/models/user.model');
  const Class = require('../../src/models/class.model');
  const Assignment = require('../../src/models/assignment.model');
  const [teacher, otherTeacher, student] = await User.create([
    { _id: IDS.teacher, firebaseUid: 'fixture-teacher', email: 'teacher@example.com', role: 'teacher', displayName: 'Teacher' },
    { _id: IDS.otherTeacher, firebaseUid: 'fixture-other', email: 'other@example.com', role: 'teacher', displayName: 'Other' },
    { _id: IDS.student, firebaseUid: 'fixture-student', email: 'student@example.com', role: 'student', displayName: 'Student' }]);
  await Class.create({ _id: IDS.class, name: 'Writing 7B', teacher: teacher._id, joinCode: 'FIXTURE-1' });
  await require('../../src/models/membership.model').create({ student: student._id, class: IDS.class, status: 'active' });
  const assignment = await Assignment.create({ _id: IDS.assignment, title: 'Weekend essay', class: IDS.class, teacher: teacher._id,
    instructions: 'Describe your weekend.', qrToken: 'fixture-qr', allowGuestSubmission: true });
  const guestToken = 'G'.repeat(43);
  const common = { uploadRoot, teacher, assignment };
  const registered = await seedSubmission({ ...common, submissionId: IDS.registered, fileId: IDS.fileRegistered, feedbackId: IDS.feedbackRegistered, mode: 'registered', studentId: student._id });
  const guest = await seedSubmission({ ...common, submissionId: IDS.guest, fileId: IDS.fileGuest, feedbackId: IDS.feedbackGuest, mode: 'guest', guestToken });
  return { IDS, teacher, otherTeacher, student, assignment, registered, guest, guestToken, WORDS };
}

/** Replaces values that change between runs (timestamps, timings) so outputs can be compared byte for byte. */
function normalizeVolatile(value) {
  if (typeof value === 'string') return value.replace(/https?:\/\/127\.0\.0\.1:\d+/g, '<host>');   // supertest's random port
  if (Array.isArray(value)) return value.map(normalizeVolatile);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, v]) => [key,
    /^(createdAt|updatedAt|generatedAt|timestamp|lastUsedAt|__v)$/.test(key) || /Ms$/.test(key) ? '<volatile>' : normalizeVolatile(v)]));
}

module.exports = { seedAnnotationFixture, normalizeVolatile, rerunOcr, regenerateCorrections, AI_SPECS, IDS, WORDS, FIXED };
