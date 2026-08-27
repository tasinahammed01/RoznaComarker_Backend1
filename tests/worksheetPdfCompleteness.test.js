const fs = require('fs');
const os = require('os');
const path = require('path');
const pdfParse = require('pdf-parse');
const { PDFDocument } = require('pdf-lib');
const { generateWorksheetSubmissionPdf } = require('../src/modules/worksheetPdfGenerator');

describe('worksheet PDF completeness and pagination', () => {
  test('renders every question and answer in the representative 17-question submission', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worksheet-pdf-'));
    const output = path.join(root, 'seventeen-questions.pdf');
    const mcq = Array.from({ length: 4 }, (_, i) => ({ id: `mcq-${i + 1}`, text: `MCQ question ${i + 1}`, options: ['Alpha', 'Beta', 'Gamma', 'Delta'], correctAnswer: 'Alpha' }));
    const blanks = Array.from({ length: 3 }, (_, i) => ({ id: `blank-sentence-${i + 1}`, parts: [{ type: 'text', value: `Blank question ${i + 1}: ` }, { type: 'blank', blankId: `blank-${i + 1}`, correctAnswer: `answer-${i + 1}` }] }));
    const pairs = Array.from({ length: 7 }, (_, i) => ({ id: `pair-${i + 1}`, leftItem: { text: `Left item ${i + 1}` }, rightItem: { text: `Right item ${i + 1}` } }));
    const trueFalse = Array.from({ length: 3 }, (_, i) => ({ id: `tf-${i + 1}`, text: `True false question ${i + 1}`, correctAnswer: i % 2 === 0 }));
    const answers = [
      ...mcq.map((q) => ({ sectionId: 'activity3', questionId: q.id, studentAnswer: 'Alpha', isCorrect: true })),
      ...blanks.map((_, i) => ({ sectionId: 'activity4', questionId: `blank-${i + 1}`, studentAnswer: `answer-${i + 1}`, isCorrect: true })),
      ...pairs.map((p) => ({ sectionId: 'activity5', questionId: p.id, studentAnswer: p.rightItem.text, isCorrect: true })),
      ...trueFalse.map((q) => ({ sectionId: 'activity6', questionId: q.id, studentAnswer: String(q.correctAnswer), isCorrect: true }))
    ];
    await generateWorksheetSubmissionPdf({
      worksheet: { title: 'Seventeen Question Worksheet', subject: 'Science', cefrLevel: 'A2', gradeLevel: '3', difficulty: 'hard',
        activity3: { title: 'Multiple Choice', questions: mcq }, activity4: { title: 'Fill in the Blanks', wordBank: blanks.map((_, i) => `answer-${i + 1}`), sentences: blanks },
        activity5: { title: 'Matching Pairs', pairs }, activity6: { title: 'True or False', questions: trueFalse } },
      submission: { percentage: 100, totalPointsEarned: 17, totalPointsPossible: 17, answers, sections: [], isPassed: true, isLate: false },
      studentName: 'PDF QA Student', studentEmail: 'qa@example.test', submittedAt: '2026-08-27'
    }, output);
    const bytes = fs.readFileSync(output); const parsed = await pdfParse(bytes); const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThan(1);
    expect(parsed.text).toContain('MCQ question 4');
    expect(parsed.text).toContain('Blank question 3');
    expect(parsed.text).toContain('Left item 7');
    expect(parsed.text).toContain('True false question 3');
    expect(parsed.text).toContain('Right item 7');
    expect(parsed.text).not.toMatch(/Ã|ðŸ|âœ|â€”/);
    if (process.env.PDF_QA_OUTPUT) {
      fs.mkdirSync(path.dirname(process.env.PDF_QA_OUTPUT), { recursive: true });
      fs.copyFileSync(output, process.env.PDF_QA_OUTPUT);
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
});
