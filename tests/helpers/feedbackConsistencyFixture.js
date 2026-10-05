const { buildCanonicalSubmissionTranscript } = require('../../src/utils/ocrTranscriptNormalizer');
const { normalizeCorrection } = require('../../src/services/correctionCanonical.service');
const { defaultLegend } = require('../../src/services/writingCorrections.service');
const { ASSESSMENT_VERSION, EVALUATION_VERSION } = require('../../src/services/rubricLanguageScoring.service');

function feedbackConsistencyFixture(fileId = 'new-file') {
  const text = 'Students was ready\nThey read teh book';
  const words = ['Students', 'was', 'ready', 'They', 'read', 'teh', 'book'].map((word, i) => ({
    id: `w${i}`, text: word, paragraphIndex: i < 3 ? 0 : 1,
    bbox: { x: 10 + (i < 3 ? i : i - 3) * 16, y: i < 3 ? 25 : 45, w: 12, h: 3 }, confidence: 0.98
  }));
  const submission = { _id: 'new-consistency-submission', files: [fileId],
    ocrPages: [{ fileId, pageNumber: 1, words, rawText: text }], ocrStatus: 'completed',
    correctionStatus: 'completed', correctionSourceHash: 'new-consistency-hash', writingCorrections: [] };
  const canonical = buildCanonicalSubmissionTranscript(submission);
  const raw = [
    { symbol: 'AGR', quotedText: 'Students was ready', suggestedText: 'Students were ready', message: 'Match the plural subject.' },
    { symbol: 'WC', quotedText: 'Students was ready', suggestedText: 'Students seemed ready', message: 'Choose the intended verb.' },
    { symbol: 'P', quotedText: 'Students was ready', suggestedText: 'Students was ready.', message: 'End the sentence.' },
    { symbol: 'SP', quotedText: 'teh', suggestedText: 'the', message: 'Check this spelling.' }
  ];
  submission.writingCorrections = raw.map((c) => normalizeCorrection(c, canonical.text, canonical.wordSpans, defaultLegend(), 'AI'));
  if (submission.writingCorrections.some((c) => !c || !c.visualTarget)) throw Error('Current pipeline did not derive all fixture targets');
  const evaluation = { status: 'completed', evaluationSourceHash: submission.correctionSourceHash,
    assessmentVersion: ASSESSMENT_VERSION, evaluationVersion: EVALUATION_VERSION,
    overallScore: 83.7, grade: 'B', rubricScores: {
      GRAMMAR: { score: 21.7, maxScore: 25, comment: 'Review sentence agreement.' },
      VOCABULARY: { score: 17, maxScore: 20, comment: 'Choose precise words.' },
      ORGANIZATION: { score: 16, maxScore: 20, comment: 'Connect your ideas.' },
      CONTENT: { score: 17, maxScore: 20, comment: 'Develop your examples.' },
      MECHANICS: { score: 8, maxScore: 10, comment: 'Check punctuation and spelling.' },
      PRESENTATION: { score: 4, maxScore: 5, comment: 'Keep the writing legible.' }
    } };
  const feedback = { detailedFeedbackSourceHash: submission.correctionSourceHash, teacherComments: 'Keep developing your ideas.',
    detailedFeedback: { areasForImprovement: [{ id: 'agreement', category: 'GRAMMAR', title: 'Agreement', issueCount: 1,
      explanation: 'Check subject and verb agreement.', score: 21.7, maxScore: 25, dominantSymbols: ['AGR'],
      examples: [{ correctionId: submission.writingCorrections[0].id, symbol: 'AGR', quotedText: 'Students was ready',
        suggestedText: 'Students were ready', message: 'Match the plural subject.' }] }],
      strengths: [{ id: 'ideas', category: 'CONTENT', title: 'Ideas', explanation: 'Your ideas are clear.', score: 17, maxScore: 20, evidence: ['Students were ready.'] }],
      actionSteps: [{ id: 'revise', priority: 1, category: 'GRAMMAR', action: 'Revise the opening sentence.',
        reason: 'Match the plural subject.', relatedSymbols: ['AGR'], relatedCorrectionIds: [submission.writingCorrections[0].id] }] } };
  return { submission: { ...submission, canonicalText: canonical.text, transcriptPages: canonical.pages },
    canonicalTranscript: canonical, evaluation, feedback, legend: defaultLegend() };
}
module.exports = { feedbackConsistencyFixture };
