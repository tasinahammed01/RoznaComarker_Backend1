'use strict';
// Synthetic Submission Feedback Report view models for page-layout tests (two submitted pages). No real student data: the base is
// the synthetic production-template fixture, the text is generated filler, and marker tokens (QSTART/QEND, RSTART/REND) let a test
// find where each card or revision guidance item starts and ends in the rendered PDF.
const { vm: base } = require('../../scripts/generateProductionSubmissionFeedbackPdf');

const FILLER = ['lorem', 'ipsum', 'dolor', 'sit', 'amet', 'tempor', 'magna', 'aliqua'];
const words = (n, seed = 0) => Array.from({ length: n }, (_, i) => FILLER[(i + seed) % FILLER.length]).join(' ');

/**
 * options: brief (characters, or { lines, perLine } for a brief of many short lines), notes ([page1, page2] correction notes),
 * cards (areas for improvement), cardWords, actions (revision guidance items), actionWords, worstCover (all score rows, grade,
 * teacher-adjusted, long identity values that wrap), teacherWords (length of the teacher's overall comment).
 */
function layoutViewModel({ brief = 0, notes = [5, 5], cards = 2, cardWords = 40, actions = 0, actionWords = 10, worstCover = false,
  teacherWords = 60 } = {}) {
  const vm = JSON.parse(JSON.stringify(base));
  // The brief starts with BSTART and ends with BEND (within the 6000-character limit), so a test can find both ends.
  vm.submission.assignmentInstructions = typeof brief === 'object'
    ? ['BSTART', ...Array.from({ length: brief.lines }, (_, i) => words(brief.perLine || 2, i)), 'BEND'].join('\n')
    : brief ? `BSTART ${words(Math.ceil(brief / 5), 1).slice(0, brief - 'BSTART  BEND'.length)} BEND` : '';
  if (worstCover) {
    Object.assign(vm.submission, { title: `Synthetic assignment ${words(80, 2)}`, className: `Synthetic class ${words(30, 3)}`,
      studentName: `Synthetic Student ${words(5, 4)}`, teacherName: `Synthetic Teacher ${words(5, 5)}`, studentEmail: 'synthetic.student.with.a.long.address@example.invalid' });
    vm.categoryScores = ['Grammar', 'Vocabulary', 'Organization', 'Content', 'Mechanics', 'Presentation']
      .map((category, i) => ({ category, score: 10 + i, maxScore: 20, percentage: 50 + i * 5, issueCount: i + 1 }));
    Object.assign(vm.result, { overallScore: 75, maximumScore: 120, grade: 'B', teacherAdjusted: true });
    vm.marksVisible = true;
  }
  vm.submittedPages = vm.submittedPages.map((page, i) => ({ ...page, corrections: Array.from({ length: notes[i] ?? 5 }, (_, n) => ({
    ...page.corrections[n % page.corrections.length], id: `p${i}c${n}`, reportId: `p${i}c${n}`, displayNumber: n + 1,
    message: words(18, n), suggestedText: words(4, n) })) }));
  const card = (k, type) => ({ title: `Card ${type}${k}`, category: 'GRAMMAR', score: 18, maxScore: 25, issueCount: 3, examples: [],
    explanation: `QSTART${type}${k} ${words(Array.isArray(cardWords) ? cardWords[k % cardWords.length] : cardWords, k)} QEND${type}${k}` });
  vm.detailedFeedback = { areasForImprovement: Array.from({ length: cards }, (_, k) => card(k, 'A')), strengths: [card(0, 'S')],
    actionSteps: Array.from({ length: actions }, (_, k) => ({ action: `RSTART${k} Revise the highlighted passages ${words(actionWords, k)}`,
      reason: `${k + 3} canonical grammar issues currently affect this category. REND${k}` })) };
  vm.teacherComments = `TSTART ${words(teacherWords, 3)} TEND`;
  vm.aiEvaluationFeedback = [];
  return vm;
}

module.exports = { layoutViewModel };
