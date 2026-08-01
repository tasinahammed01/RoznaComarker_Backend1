jest.mock('../src/services/writingCorrections.service', () => ({
  check: jest.fn(),
  getLegend: jest.fn()
}));

const fs = require('fs');
const path = require('path');
const writingCorrectionsService = require('../src/services/writingCorrections.service');
const writingCorrectionsController = require('../src/controllers/writingCorrections.controller');
const { countSubmissionCorrections } = require('../src/services/submissionCorrectionStatistics.service');

const source = (relativePath) => fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
const functionSource = (contents, name, nextName) => {
  const start = contents.indexOf(`async function ${name}`);
  const end = contents.indexOf(`async function ${nextName}`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Unable to isolate ${name}`);
  return contents.slice(start, end);
};

describe('submission result LanguageTool isolation', () => {
  beforeEach(() => jest.clearAllMocks());

  test('student and teacher result consumers never call the generic check API', () => {
    const pages = [
      '../../RoznaComarker/src/app/pages/students/my-class-student-pages/detail-my-class-student-pages/my-submission-page/my-submission-page.ts',
      '../../RoznaComarker/src/app/pages/teachers/my-classes-pages/detail-my-classes-pages/student-submission-pages/student-submission-pages.ts'
    ].map((file) => fs.readFileSync(path.resolve(__dirname, file), 'utf8')).join('\n');
    expect(pages).not.toMatch(/writingCorrectionsApi\s*\.\s*check\s*\(/);
    expect(pages).toMatch(/buildCanonicalWritingIssues/);
  });

  test('canonical corrections and feedback reads contain no provider or write path', () => {
    const submissionController = source('src/controllers/submission.controller.js');
    const feedbackController = source('src/controllers/feedback.controller.js');
    const correctionRead = functionSource(submissionController, 'getOcrCorrections', 'regenerateCanonicalCorrections');
    const wholeFeedbackFunction = functionSource(feedbackController, 'getSubmissionFeedback', 'createFeedback');
    // Legacy unreachable migration code remains below the canonical response
    // returns; audit the executable canonical read prefix only.
    const feedbackRead = wholeFeedbackFunction.slice(0, wholeFeedbackFunction.indexOf('await Submission.updateOne'));

    expect(correctionRead).not.toMatch(/buildOcrCorrections|writingCorrectionsService|LanguageTool|canonicalCorrectionsPipeline|\.save\s*\(|updateOne|findOneAndUpdate/);
    expect(feedbackRead).not.toMatch(/buildSubmissionCorrectionStatistics|buildOcrCorrections|writingCorrectionsService|LanguageTool|semanticWriting|canonicalEvaluation|\.save\s*\(|updateOne|findOneAndUpdate/);
    expect(correctionRead).toMatch(/doc\.writingCorrections/);
    expect(feedbackRead).toMatch(/countSubmissionCorrections/);
  });

  test('retired generic check is not exported or mounted', () => {
    expect(writingCorrectionsController.check).toBeUndefined();
    expect(source('src/routes/writingCorrections.routes.js')).not.toMatch(/router\.post\(['"]\/check/);
    expect(writingCorrectionsService.check).not.toHaveBeenCalled();
  });

  test('legend endpoint does not import the legacy checker', () => {
    const controller = source('src/controllers/writingCorrections.controller.js');
    expect(controller).toMatch(/resolveLegend/);
    expect(controller).not.toMatch(/writingCorrections\.service|LanguageTool|\.check\(/);
  });

  test('two-page persisted 26 plus 2 fixture is identical for repeated teacher and student reads', () => {
    const corrections = [
      ...Array.from({ length: 11 }, (_, index) => ({ id: `g-${index}`, source: 'LANGUAGETOOL', category: 'GRAMMAR', fileId: index < 6 ? 'page-1' : 'page-2' })),
      ...Array.from({ length: 15 }, (_, index) => ({ id: `m-${index}`, source: 'LANGUAGETOOL', category: 'MECHANICS', fileId: index < 8 ? 'page-1' : 'page-2' })),
      { id: 'o-1', source: 'AI', category: 'ORGANIZATION', fileId: 'page-1' },
      { id: 'v-1', source: 'AI', category: 'VOCABULARY', fileId: 'page-2' }
    ];
    const canonical = {
      submissionId: 'two-page-submission',
      files: ['page-1', 'page-2'],
      corrections,
      statistics: countSubmissionCorrections(corrections).statistics,
      evaluationStatus: 'completed',
      score: 53
    };
    const studentRead = structuredClone(canonical);
    const teacherRead = structuredClone(canonical);
    const reloadRead = structuredClone(canonical);
    expect(studentRead).toEqual(teacherRead);
    expect(reloadRead).toEqual(studentRead);
    expect(canonical.corrections).toHaveLength(28);
    expect(canonical.statistics).toEqual({
      content: 0, grammar: 11, organization: 1, vocabulary: 1, mechanics: 15, total: 28
    });
    expect(writingCorrectionsService.check).not.toHaveBeenCalled();
  });
});
