'use strict';
// Task 6A guard: students may only see corrections through src/services/studentCorrectionView.service.js. This static test fails when
// a file starts reading the raw correction list, its statistics or the teacher overlay without being reviewed and listed here, or when
// a student-facing handler stops going through the builder.
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(d => d.isDirectory() ? files(path.join(dir, d.name))
  : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
const rel = file => path.relative(SRC, file).split(path.sep).join('/');
const source = Object.fromEntries(files(SRC).map(f => [rel(f), fs.readFileSync(f, 'utf8')]));

// Every file allowed to touch the raw correction list or its persisted statistics, and why.
const RAW_READERS = {
  'models/Submission.js': 'schema',
  'models/SubmissionRevision.js': 'schema',
  'services/studentCorrectionView.service.js': 'THE builder',
  'services/teacherAnnotation.service.js': 'teacher-only overlay state',
  'controllers/teacherAnnotation.controller.js': 'teacher-only; optimistic-concurrency match on the stored list',
  'services/canonicalCorrectionsPipeline.service.js': 'writer (AI correction generation)',
  'services/submissionAnalysisLifecycle.service.js': 'writer',
  'services/semanticWritingCorrections.service.js': 'writer',
  'services/repeatedSourceConsistency.service.js': 'writer-side consistency check',
  'services/correctionQualityDiagnostics.service.js': 'server diagnostics (counts only, never a response)',
  'services/correctionCanonical.service.js': 'canonical library (pure functions over a given list)',
  'services/canonicalCorrectionRender.service.js': 'render library (given the visible list)',
  'services/canonicalEvaluation.service.js': 'scoring - decision 1: scores never change automatically',
  'services/staleAssignmentEvaluation.service.js': 'scoring readiness check',
  'services/writingAssessment.service.js': 'scoring',
  'services/canonicalResultState.service.js': 'reads the submission it is GIVEN; every student caller passes view.submission',
  'services/submissionCorrectionStatistics.service.js': 'counts the submission it is GIVEN (callers pass the projected submission)',
  'services/submissionRevision.service.js': 'draft snapshot writer (stores the raw list AND the overlay)',
  'services/submissionFeedbackPdfCache.service.js': 'cache identity only (includes the overlay), never output',
  'services/submissionFeedbackReport.service.js': 'PDF: builds from the view',
  'pdf/sample/submissionFeedbackReportViewModel.js': 'PDF view model of the projected submission',
  'services/draftComparison.service.js': 'compares projected submissions/revisions',
  'controllers/feedback.controller.js': 'feedback endpoint uses the view (plus the unreachable legacy block listed in the report)',
  'controllers/submission.controller.js': 'writers (upload/resubmit), student endpoints via the view, teacher retry (scoring)',
  'controllers/guestSubmission.controller.js': 'presentation picks statistics from view.submission',
  'utils/sourceFidelity.js': 'source-review eligibility',
  'app.js': 'route name only (writing-corrections legend)',
  'routes/writingCorrections.routes.js': 'route name only',
};
// Every file allowed to name the teacher overlay.
const OVERLAY_READERS = ['models/Submission.js', 'models/SubmissionRevision.js', 'services/studentCorrectionView.service.js',
  'services/teacherAnnotation.service.js', 'controllers/teacherAnnotation.controller.js', 'services/submissionRevision.service.js',
  'controllers/pdf.controller.js', 'services/submissionFeedbackPdfCache.service.js', 'services/submissionFeedbackReport.service.js',
  'routes/submission.routes.js' /* route wiring only */, 'services/draftComparison.service.js' /* selects the overlay it passes to the builder */,
  'services/scoreReview.service.js' /* teacher-only grade check; never reaches a student response */];
// Student-facing modules and the handlers in them that must go through the builder.
const MUST_USE_BUILDER = {
  'controllers/feedback.controller.js': ['getSubmissionFeedback', 'getFeedbackBySubmissionForStudent'],
  'controllers/submission.controller.js': ['getOcrCorrections', 'getMySubmissionByAssignmentId', 'getMySubmissions', 'getSubmissionsByAssignment'],
  'controllers/guestSubmission.controller.js': ['presentation', 'results'],
  'services/draftComparison.service.js': ['comparisonForSubmission', 'historiesForFilter'],
  'services/submissionFeedbackReport.service.js': ['buildPersistedSubmissionFeedbackReport'],
  'services/weeklyTeacherSummary.service.js': ['progressForWindow'],
};
const BUILDER_CALL = /loadStudentCorrectionViews?\(|buildStudentCorrectionView\(|studentSubmissions\(|visibleSubmissions\(/;

/** The text of one named function (declaration or `const name = endpoint(`), up to the next top-level definition. */
function body(text, name) {
  const start = text.search(new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(|const\\s+${name}\\s*=`));
  if (start < 0) return null;
  const rest = text.slice(start + 1);
  const next = rest.search(/\n(?:async\s+function|function|const\s+\w+\s*=\s*(?:endpoint|async))\b/);
  return text.slice(start, next < 0 ? undefined : start + 1 + next);
}

test('only reviewed files read the raw correction list or its statistics', () => {
  const readers = Object.keys(source).filter(f => /writingCorrections|correctionStatistics/.test(source[f]));
  expect(readers.filter(f => !RAW_READERS[f])).toEqual([]);
});

test('only reviewed files name the teacher overlay', () => {
  expect(Object.keys(source).filter(f => /teacherAnnotations/.test(source[f]) && !OVERLAY_READERS.includes(f))).toEqual([]);
});

test('every student-facing handler goes through the builder', () => {
  for (const [file, names] of Object.entries(MUST_USE_BUILDER)) for (const name of names) {
    const text = body(source[file], name);
    expect({ file, name, found: Boolean(text) }).toEqual({ file, name, found: true });
    expect({ file, name, usesBuilder: BUILDER_CALL.test(text) }).toEqual({ file, name, usesBuilder: true });
  }
});

test('the old per-surface filter is gone', () => {
  expect(Object.keys(source).filter(f => /\.effective\(/.test(source[f]))).toEqual([]);
});

test('practice and flashcards never read corrections', () => {
  const learning = Object.keys(source).filter(f => /adaptivePractice|flashcard/i.test(f));
  expect(learning.length).toBeGreaterThan(3);
  expect(learning.filter(f => /writingCorrections|areasForImprovement|teacherAnnotations/.test(source[f]))).toEqual([]);
});
