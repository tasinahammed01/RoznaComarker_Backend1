'use strict';
// Content and Organization findings are real, counted findings. They never reach the rubric's input, so they cannot move a score, and no surface uses the old wording.
const { withoutLegacyWording, plainText } = require('../src/services/legacyFeedbackWording.service');
const detailed = require('../src/services/canonicalDetailedFeedback.service');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');

describe('old results', () => {
  const stored = { rubricScores: { ORGANIZATION: { score: 14, maxScore: 20, comment: 'Ideas jump. This is a holistic observation, not a counted correction.' },
    CONTENT: { comment: 'This category was assessed holistically from the submitted writing. No validated canonical content corrections were recorded.' } },
  detailedFeedback: { areasForImprovement: [{ title: 'Organization (holistic)', evidenceKind: 'holistic', explanation: 'Holistic rubric feedback; no counted local correction. Ideas jump.' }],
    actionSteps: [{ evidenceKind: 'holistic', reason: 'Grounded holistic rubric guidance, without a counted local correction.' }] } };
  test('read without the word, and without changing what is stored', () => {
    const before = JSON.stringify(stored), clean = withoutLegacyWording(stored);
    expect(JSON.stringify(stored)).toBe(before);
    const shown = { ...clean, detailedFeedback: { ...clean.detailedFeedback, areasForImprovement: clean.detailedFeedback.areasForImprovement.map(({ evidenceKind, ...a }) => a),
      actionSteps: clean.detailedFeedback.actionSteps.map(({ evidenceKind, ...a }) => a) } };
    expect(JSON.stringify(shown)).not.toMatch(/holistic/i);
    expect(clean.rubricScores.ORGANIZATION.comment).toBe('Ideas jump.');
    expect(clean.detailedFeedback.areasForImprovement[0].title).toBe('Organization');
    expect(clean.detailedFeedback.areasForImprovement[0].explanation).toBe('Ideas jump.');
  });
  test("the student's words, quotes and teacher text are never touched", () => {
    const value = { transcript: 'A holistic view.', writingCorrections: [{ quotedText: 'holistic', message: 'holistic' }], teacherComments: [{ comment: 'A holistic view.' }], quotedText: 'holistic' };
    expect(withoutLegacyWording(value)).toEqual(value);
  });
  test('dates, ids and missing values pass through', () => {
    const when = new Date(0);
    expect(withoutLegacyWording({ when, none: null, n: 3 })).toEqual({ when, none: null, n: 3 });
    expect(plainText('No such word.')).toBe('No such word.');
  });
  test('an old stored card still validates, and a new one has no such wording', () => {
    const transcript = 'Ideas jump here.', evidence = { evidenceId: 'doc:1', findingScope: 'holistic', evidenceType: 'transcript', correctionId: null, quotedText: 'Ideas jump', startChar: 0, endChar: 10, explanation: 'They jump.', suggestion: 'Link them.' };
    const categoryScores = { ORGANIZATION: { score: 14, maxScore: 20, improvementEvidence: [evidence] } };
    const statistics = { organization: 0 };
    const fresh = detailed.buildDeterministicDetailedFeedback({ corrections: [], statistics, categoryScores, sourceHash: 'h', transcript });
    const card = fresh.areasForImprovement.find(a => a.category === 'ORGANIZATION');
    expect(card.title).toBe('Organization');
    expect(card.explanation).not.toMatch(/holistic/i);
    expect(card.explanation).toContain('Ideas jump');
    const input = { corrections: [], statistics, categoryScores: { ...categoryScores }, sourceHash: 'h', transcript };
    expect(detailed.validateDetailedFeedback(fresh, input)).toBe(fresh);
    const old = { ...fresh, areasForImprovement: fresh.areasForImprovement.map(a => a.category === 'ORGANIZATION' ? { ...a, title: 'Organization (holistic)', explanation: 'Holistic rubric feedback; no counted local correction. ' + a.explanation } : a) };
    expect(detailed.validateDetailedFeedback(old, input)).toBe(old);
  });
});

describe('the rubric never sees Content or Organization findings', () => {
  const finding = (category, symbol) => ({ id: symbol, category, symbol, quotedText: 'text', startChar: 0, endChar: 4, message: 'm' });
  test('so adding them cannot change its input', async () => {
    jest.resetModules();
    const assess = jest.fn(async () => ({ categories: {}, customCriteria: [] }));
    jest.doMock('../src/services/semanticRubricAssessment.service', () => ({ ...jest.requireActual('../src/services/semanticRubricAssessment.service'), assess }));
    const evaluation = require('../src/services/canonicalEvaluation.service');
    expect(typeof evaluation.rubricInputCorrections).toBe('function');
    const input = [finding('GRAMMAR', 'AGR'), finding('CONTENT', 'DEV'), finding('ORGANIZATION', 'COH'), finding('MECHANICS', 'SP'), finding('VOCABULARY', 'WC')];
    expect(evaluation.rubricInputCorrections(input).map(c => c.symbol)).toEqual(['AGR', 'SP', 'WC']);
    jest.dontMock('../src/services/semanticRubricAssessment.service');
  });
});

describe('the PDF', () => {
  test('lists a real Content finding by its count', () => {
    const text = 'Dogs are good.';
    const html = renderSubmissionFeedbackReportHtml(buildSubmissionFeedbackReportViewModel({ generatedAt: 'x', identity: {}, legend: [], evaluation: {}, feedback: {},
      submission: { _id: 's', files: ['f'], canonicalText: text, correctionStatus: 'completed', correctionSourceHash: 'h',
        writingCorrections: [{ id: 'c', fileId: 'f', page: 1, category: 'CONTENT', symbol: 'DEV', quotedText: text, message: 'Add an example.', suggestedText: 'Give one reason.', startChar: 0, endChar: text.length, wordIds: [] }],
        transcriptPages: [{ fileId: 'f', pageNumber: 1, startChar: 0, endChar: text.length, text, imageWidth: 1000, imageHeight: 1000, words: [] }] } }));
    expect(html).toContain('<b>1</b><small>DEV 1</small><span>content</span>');
    expect(html).not.toMatch(/holistic/i);
  });
});
