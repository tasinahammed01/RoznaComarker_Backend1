const {
  countSubmissionCorrections,
  buildSubmissionCorrectionStatistics
} = require('../src/services/submissionCorrectionStatistics.service');

function corrections(count, category, page) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${category}_${page}_${index}`,
    category,
    page,
    message: `${category} issue ${index}`
  }));
}

describe('submission correction statistics', () => {
  test('aggregates all pages into one cumulative result', async () => {
    const submission = {
      _id: 'submission-1',
      ocrPages: [
        { fileId: 'file-1', pageNumber: 1, corrections: [...corrections(10, 'CONTENT', 1), ...corrections(2, 'GRAMMAR', 1)] },
        { fileId: 'file-2', pageNumber: 1, corrections: [...corrections(5, 'CONTENT', 2), ...corrections(8, 'GRAMMAR', 2), ...corrections(3, 'MECHANICS', 2)] },
        { fileId: 'file-3', pageNumber: 1, corrections: [...corrections(1, 'CONTENT', 3), ...corrections(5, 'GRAMMAR', 3), ...corrections(1, 'MECHANICS', 3)] }
      ]
    };
    await expect(buildSubmissionCorrectionStatistics(submission)).resolves.toEqual({
      content: 16,
      grammar: 15,
      organization: 0,
      vocabulary: 0,
      mechanics: 4,
      total: 35
    });
  });

  test('deduplicates legacy/current copies and excludes invalid annotations', () => {
    const duplicate = { id: 'stable-1', category: 'GRAMMAR', page: 1, message: 'Issue' };
    const result = countSubmissionCorrections([
      duplicate,
      { ...duplicate },
      { correction: { category: '', comment: 'Teacher note' }, context: { pageNumber: 1 } },
      { id: 'deleted', category: 'CONTENT', deleted: true }
    ]);
    expect(result.statistics).toEqual({ content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0, total: 1 });
    expect(result.beforeDedupe).toBe(2);
    expect(result.afterDedupe).toBe(1);
  });

  test('scopes generated LanguageTool IDs by file/page', () => {
    const result = countSubmissionCorrections([
      { correction: { id: 'lt_1', groupKey: 'grammar' }, context: { fileId: 'a', pageNumber: 1 } },
      { correction: { id: 'lt_1', groupKey: 'grammar' }, context: { fileId: 'b', pageNumber: 1 } }
    ]);
    expect(result.statistics.grammar).toBe(2);
  });

  test('is role- and active-page-independent for the same submission', async () => {
    const submission = {
      _id: 'shared-submission',
      ocrPages: [
        { fileId: 'a', pageNumber: 1, corrections: corrections(2, 'CONTENT', 1) },
        { fileId: 'b', pageNumber: 1, corrections: corrections(3, 'GRAMMAR', 2) }
      ]
    };
    const studentStatistics = await buildSubmissionCorrectionStatistics(submission, { activeFileId: 'a', role: 'student' });
    const teacherStatistics = await buildSubmissionCorrectionStatistics(submission, { activeFileId: 'b', role: 'teacher' });
    expect(studentStatistics).toEqual(teacherStatistics);
    expect(studentStatistics.total).toBe(5);
  });
});
