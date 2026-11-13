'use strict';
// The feedback PDF lists the categories in the one canonical order (src/constants/assessmentCategories.js), the same as the AI-assisted
// Evaluation and Edit scores on screen. Fails if the PDF uses another order. Synthetic sample data only; no browser.
const { ASSESSMENT_CATEGORY_ORDER, ASSESSMENT_CATEGORY_LABELS } = require('../src/constants/assessmentCategories');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { vm: sample } = require('../scripts/generateProductionSubmissionFeedbackPdf');

const ORDER = ['GRAMMAR', 'VOCABULARY', 'ORGANIZATION', 'CONTENT', 'MECHANICS', 'PRESENTATION'];
const positions = (html, needles) => needles.map(needle => html.indexOf(needle));
const ascending = list => list.every((value, index) => value >= 0 && (index === 0 || value > list[index - 1]));

test('the canonical order and labels', () => {
  expect([...ASSESSMENT_CATEGORY_ORDER]).toEqual(ORDER);
  expect(ORDER.map(key => ASSESSMENT_CATEGORY_LABELS[key])).toEqual(['Grammar', 'Vocabulary', 'Organization & Structure', 'Content & Task Achievement',
    'Spelling & Punctuation', 'Presentation & Handwriting']);
});

test('PDF score rows follow it even when the scores are stored in another order', () => {
  const stored = ['CONTENT', 'ORGANIZATION', 'GRAMMAR', 'VOCABULARY', 'MECHANICS', 'PRESENTATION'];
  const rubricScores = Object.fromEntries(stored.map(key => [key, { score: 1, maxScore: 5, comment: `${key} comment` }]));
  const vm = buildSubmissionFeedbackReportViewModel({ submission: { _id: 's1', writingCorrections: [], correctionSourceHash: 'h1' },
    evaluation: { status: 'completed', evaluationSourceHash: 'h1', overallScore: 50, grade: 'F', rubricScores }, feedback: { overriddenByTeacher: true } });
  expect(vm.categoryScores.map(row => String(row.category).toUpperCase())).toEqual(ORDER);
});

test('PDF correction statistics and AI feedback follow it', () => {
  const html = renderSubmissionFeedbackReportHtml(sample);
  const stats = html.slice(html.indexOf('class="stats"'));
  expect(ascending(positions(stats, ['grammar</span>', 'vocabulary</span>', 'organization</span>', 'content</span>', 'mechanics</span>']))).toBe(true);
});
