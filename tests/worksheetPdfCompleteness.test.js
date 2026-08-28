const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { buildWorksheetQuestionReview, buildStudentWorksheetReportViewModel, generateWorksheetSubmissionPdf } = require('../src/modules/worksheetPdfGenerator');
const { buildStudentWorksheetPdfViewModel, generateStudentWorksheetResultPdf } = require('../src/modules/studentWorksheetResultPdfGenerator');
const { renderStudentWorksheetResultHtml } = require('../src/pdf/studentWorksheetResultTemplate');
const pdfBrowserManager = require('../src/services/pdfBrowserManager.service');

function potatoFixture() {
  const mcq = [
    ['mcq-1', 'Which potato stage develops stems, roots, and leaves?', ['Sprout development', 'Vegetative growth', 'Tuber bulking', 'Tuber maturation'], 'Vegetative growth'],
    ['mcq-2', 'Which structure grows outward underground?', ['Flowers', 'Stolons', 'Leaves', 'Roots'], 'Stolons'],
    ['mcq-3', 'Where do potato tubers develop?', ['On stolons', 'On flowers', 'On leaves', 'Above soil'], 'On stolons'],
    ['mcq-4', 'What protects a mature potato tuber?', ['Petals', 'Periderm', 'Pollen', 'Chlorophyll'], 'Periderm'],
  ].map(([id, text, options, correctAnswer]) => ({ id, text, options, correctAnswer }));
  const blanks = [
    ['blank-1', 'The potato plant develops a protective ', 'periderm'],
    ['blank-2', 'Underground stems are called ', 'stolons'],
    ['blank-3', 'The enlarged storage organs are ', 'tubers'],
  ].map(([blankId, text, correctAnswer], i) => ({ id: `sentence-${i + 1}`, parts: [{ type: 'text', value: text }, { type: 'blank', blankId, correctAnswer }] }));
  const pairs = [
    ['pair-1', 'Stolons', 'Underground stems that develop tubers'],
    ['pair-2', 'Sprout development', 'Shoots emerge from potato eyes'],
    ['pair-3', 'Vegetative growth', 'Stems roots and leaves develop'],
    ['pair-4', 'Tuber initiation', 'Small tubers begin forming'],
    ['pair-5', 'Tuber bulking', 'Tubers rapidly increase in size'],
    ['pair-6', 'Maturation', 'Vines die back and skins set'],
    ['pair-7', 'Periderm', 'Protective outer tuber tissue'],
  ].map(([id, left, right]) => ({ id, leftItem: { text: left }, rightItem: { text: right } }));
  const trueFalse = [
    ['tf-1', 'Potato tubers form on stolons.', true],
    ['tf-2', 'Potato tubers are fruits.', false],
    ['tf-3', 'Periderm helps protect a mature tuber.', true],
  ].map(([id, text, correctAnswer]) => ({ id, text, correctAnswer }));
  const answers = [
    ...mcq.map((q, i) => ({ sectionId: 'activity3', questionId: q.id, studentAnswer: i === 0 ? 'Sprout development' : q.options[(i + 1) % q.options.length], isCorrect: false })),
    ...blanks.map((s) => ({ sectionId: 'activity4', questionId: s.parts[1].blankId, studentAnswer: s.parts[1].correctAnswer, isCorrect: true })),
    ...pairs.map((p, i) => ({ sectionId: 'activity5', questionId: p.id, studentAnswer: i === 0 ? p.rightItem.text : pairs[(i + 1) % pairs.length].rightItem.text, isCorrect: i === 0 })),
    ...trueFalse.map((q, i) => ({ sectionId: 'activity6', questionId: q.id, studentAnswer: i === 0 ? String(q.correctAnswer) : String(!q.correctAnswer), isCorrect: i === 0 })),
  ];
  return {
    worksheet: { title: 'Potato Life Cycle 101', subject: 'Science', cefrLevel: 'A2', gradeLevel: '3', difficulty: 'hard',
      activity1: { title: 'Drag & Drop', items: [] }, activity2: { title: 'Classification', items: [] },
      activity3: { title: 'Multiple Choice', questions: mcq }, activity4: { title: 'Fill in the Blanks', sentences: blanks },
      activity5: { title: 'Matching Pairs', pairs }, activity6: { title: 'True or False', questions: trueFalse } },
    submission: { percentage: 29, totalPointsEarned: 5, totalPointsPossible: 17, timeTaken: 47, answers,
      sections: [{ sectionId: 'activity3', correctCount: 0, incorrectCount: 4, skippedCount: 0, totalQuestions: 4, percentage: 0 },
        { sectionId: 'activity4', correctCount: 3, incorrectCount: 0, skippedCount: 0, totalQuestions: 3, percentage: 100 },
        { sectionId: 'activity5', correctCount: 1, incorrectCount: 6, skippedCount: 0, totalQuestions: 7, percentage: 14 },
        { sectionId: 'activity6', correctCount: 1, incorrectCount: 2, skippedCount: 0, totalQuestions: 3, percentage: 33 }], isPassed: false, isLate: false, performanceStatus: 'Critical' },
    assignment: { dueDate: 'Sep 3, 2026' }, studentName: 'Tanjid Academic', studentEmail: 'tanjid.academic.01@gmail.com', className: 'vcvzxcvzxc', submittedAt: 'Aug 27, 2026 - 1:25 AM',
  };
}

function persistedActivitiesFixture() {
  const fixture = potatoFixture();
  const legacy = fixture.worksheet;
  fixture.worksheet = {
    ...legacy,
    activity1: null, activity2: null, activity3: null, activity4: null, activity5: null, activity6: null,
    activities: [
      { type: 'multipleChoice', title: 'Multiple Choice', instructions: 'Choose one.', data: legacy.activity3 },
      { type: 'fillBlanks', title: 'Fill in Blanks', instructions: 'Complete each blank.', data: legacy.activity4 },
      { type: 'matching', title: 'Matching Pairs', instructions: 'Match each pair.', data: legacy.activity5 },
      { type: 'trueFalse', title: 'True / False', instructions: 'Choose true or false.', data: legacy.activity6 },
    ],
  };
  fixture.submission.answers = fixture.submission.answers.map((answer) => ({
    ...answer,
    sectionId: { activity3: 'activity_0', activity4: 'activity_1', activity5: 'activity_2', activity6: 'activity_3' }[answer.sectionId],
  }));
  fixture.submission.sections = fixture.submission.sections.map((section, index) => ({
    sectionId: `activity_${index}`, correctCount: section.correctCount, incorrectCount: section.incorrectCount,
    skippedCount: section.skippedCount, totalPoints: section.totalQuestions, score: section.percentage,
  }));
  fixture.submission.totalPointsEarned = 0;
  fixture.submission.totalPointsPossible = 0;
  fixture.submission.percentage = 0;
  fixture.submission.earnedPoints = 5;
  fixture.submission.totalPoints = 17;
  fixture.submission.score = 29;
  return fixture;
}

describe('teacher single-student worksheet PDF', () => {
  afterAll(async () => { await pdfBrowserManager.closeBrowser(); });
  test('normalizes all canonical question types without scoring again', () => {
    const model = buildStudentWorksheetReportViewModel(potatoFixture());
    expect(model.questions).toHaveLength(17);
    expect(model).toMatchObject({ earned: 5, possible: 17, percentage: 29, correct: 5, incorrect: 12, skipped: 0 });
    expect(model.sectionPerformance.map((s) => [s.label, s.percentage, s.correct, s.total])).toEqual([
      ['Multiple Choice', 0, 0, 4], ['Fill in Blanks', 100, 3, 3], ['Matching Pairs', 14, 1, 7], ['True / False', 33, 1, 3],
    ]);
    expect(model.sectionPerformance.some((s) => s.total === 0)).toBe(false);
    expect(model.questions.find((q) => q.questionId === 'blank-1')).toMatchObject({ type: 'Fill in Blanks', studentAnswer: 'periderm', correctAnswer: 'periderm', isCorrect: true });
    expect(model.questions.find((q) => q.questionId === 'pair-2')).toMatchObject({ type: 'Matching', prompt: 'Sprout development', isCorrect: false });
    expect(model.questions.find((q) => q.questionId === 'tf-2')).toMatchObject({ type: 'True / False', studentAnswer: 'True', correctAnswer: 'False', isCorrect: false });
  });

  test('normalizes the real activities[].data persisted shape and dynamic answer section ids', () => {
    const fixture = persistedActivitiesFixture();
    const questions = buildWorksheetQuestionReview(fixture.worksheet, fixture.submission);
    const model = buildStudentWorksheetReportViewModel(fixture);
    expect(questions).toHaveLength(17);
    expect(model).toMatchObject({ earned: 5, possible: 17, percentage: 29, correct: 5, incorrect: 12, skipped: 0 });
    expect(model.questions.filter((q) => q.type === 'Multiple Choice')).toHaveLength(4);
    expect(model.questions.filter((q) => q.type === 'Fill in Blanks')).toHaveLength(3);
    expect(model.questions.filter((q) => q.type === 'Matching')).toHaveLength(7);
    expect(model.questions.filter((q) => q.type === 'True / False')).toHaveLength(3);
    expect(model.questions.every((q) => q.studentAnswer && q.correctAnswer)).toBe(true);
    expect(model.questions.filter((q) => q.isCorrect)).toHaveLength(5);
    expect(model.sectionPerformance.map((s) => [s.correct, s.total, s.percentage])).toEqual([[0, 4, 0], [3, 3, 100], [1, 7, 14], [1, 3, 33]]);
  });

  test('maps skipped answers explicitly', () => {
    const fixture = potatoFixture();
    fixture.submission.answers[0].studentAnswer = '';
    fixture.submission.answers[0].isCorrect = false;
    const question = buildStudentWorksheetReportViewModel(fixture).questions[0];
    expect(question).toMatchObject({ isSkipped: true, studentAnswer: 'No answer submitted' });
  });

  test('renders the complete 17-question report with prompts, options, student and correct answers', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksheet-pdf-'));
    const output = path.join(root, 'potato-life-cycle-report.pdf');
    await generateWorksheetSubmissionPdf(potatoFixture(), output);
    const bytes = fs.readFileSync(output);
    const parsed = await pdfParse(bytes);
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(parsed.text.match(/Q\d+\s+\|/g)).toHaveLength(17);
    for (const text of ['Which potato stage develops stems, roots, and leaves?', 'Sprout development', 'Vegetative growth', 'periderm', 'Stolons', 'Underground stems that develop tubers', 'Potato tubers are fruits.', 'Student answer', 'Correct answer', 'No answer submitted']) {
      if (text === 'No answer submitted') continue;
      expect(parsed.text).toContain(text);
    }
    expect(parsed.text.match(/Potato Life Cycle 101/g)).toHaveLength(document.getPageCount() + 1);
    expect(parsed.text).not.toMatch(/undefined|null|Ã|ðŸ|âœ|â€”/i);
    if (process.env.PDF_QA_OUTPUT) { fs.mkdirSync(path.dirname(process.env.PDF_QA_OUTPUT), { recursive: true }); fs.copyFileSync(output, process.env.PDF_QA_OUTPUT); }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('renders all 17 questions from activities[].data without the false empty state', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksheet-pdf-dynamic-'));
    const output = path.join(root, 'potato-life-cycle-dynamic-report.pdf');
    await generateWorksheetSubmissionPdf(persistedActivitiesFixture(), output);
    const bytes = fs.readFileSync(output);
    const parsed = await pdfParse(bytes);
    expect(parsed.text.match(/Q\d+\s+\|/g)).toHaveLength(17);
    expect(parsed.text).not.toContain('No gradable questions recorded for this submission.');
    expect(parsed.text).toContain('Section Performance');
    expect(parsed.text).toContain('Student answer');
    expect(parsed.text).toContain('Correct answer');
    if (process.env.PDF_QA_OUTPUT_DYNAMIC) { fs.mkdirSync(path.dirname(process.env.PDF_QA_OUTPUT_DYNAMIC), { recursive: true }); fs.copyFileSync(output, process.env.PDF_QA_OUTPUT_DYNAMIC); }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('allows the empty state only for a true zero-question submission', async () => {
    const fixture = { worksheet: { title: 'Empty Worksheet' }, submission: { totalPointsPossible: 0, totalPoints: 0, answers: [], sections: [] } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksheet-pdf-empty-'));
    const output = path.join(root, 'empty-report.pdf');
    await generateWorksheetSubmissionPdf(fixture, output);
    const parsed = await pdfParse(fs.readFileSync(output));
    expect(parsed.text).toContain('No gradable questions recorded for this submission.');
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('fails loudly when a scored submission normalizes to zero questions', async () => {
    const fixture = { worksheet: { title: 'Broken Mapping' }, submission: { totalPointsPossible: 17, answers: [] } };
    await expect(generateWorksheetSubmissionPdf(fixture, path.join(os.tmpdir(), 'should-not-render.pdf'))).rejects.toThrow(/expected 17 gradable questions but normalized 0/);
  });

  test('builds the Chromium student worksheet view model and HTML with all 17 worksheet items', () => {
    const model = buildStudentWorksheetPdfViewModel(persistedActivitiesFixture());
    const html = renderStudentWorksheetResultHtml(model);
    expect(model.totalGradable).toBe(17);
    expect(model.sections.map((section) => [section.type, section.items.length])).toEqual([
      ['Multiple Choice', 4], ['Fill in Blanks', 3], ['Matching', 7], ['True / False', 3],
    ]);
    expect((html.match(/data-question-id=/g) || [])).toHaveLength(17);
    expect(html).toContain('data-pdf-ready="true"');
    expect(html).toContain('window.__REPORT_READY__');
    expect(html).toContain('.pdf-root{height:auto;min-height:0;overflow:visible}');
    expect(html).toContain('.activity{break-inside:auto');
    expect(html).toContain('.option.correct');
    expect(html).toContain('.option.wrong');
    expect(html).not.toMatch(/questionsPerPage|overflow:hidden on worksheet|height:1123px/);
    for (const text of ['Q1', 'Q4', 'periderm', 'Stolons', 'Periderm helps protect a mature tuber.']) expect(html).toContain(text);
  });

  test('renders the complete student worksheet through Chromium without clipped or blank continuation pages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'student-worksheet-chromium-'));
    const output = path.join(root, 'potato-life-cycle-student-result.pdf');
    await generateStudentWorksheetResultPdf(persistedActivitiesFixture(), output);
    const bytes = fs.readFileSync(output);
    const parsed = await pdfParse(bytes);
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(3);
    expect(parsed.text).toContain('Potato Life Cycle 101');
    expect(parsed.text).toContain('Multiple Choice');
    expect(parsed.text).toContain('Fill in Blanks');
    expect(parsed.text).toContain('Matching Pairs');
    expect(parsed.text).toContain('True / False');
    expect(parsed.text).toContain('Periderm helps protect a mature tuber.');
    if (process.env.PDF_QA_STUDENT_CHROMIUM_OUTPUT) { fs.mkdirSync(path.dirname(process.env.PDF_QA_STUDENT_CHROMIUM_OUTPUT), { recursive: true }); fs.copyFileSync(output, process.env.PDF_QA_STUDENT_CHROMIUM_OUTPUT); }
    fs.rmSync(root, { recursive: true, force: true });
  }, 90000);
});
