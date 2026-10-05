const { feedbackConsistencyFixture } = require('./helpers/feedbackConsistencyFixture');
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { createSubmittedImageLayout } = require('../src/pdf/submittedImageAnnotationLayout');

describe('canonical website and static report feedback', () => {
  test('newly generated current-pipeline corrections resolve identically with narrow words and punctuation anchors', () => {
    const input = feedbackConsistencyFixture(), original = JSON.stringify(input);
    const website = buildCanonicalCorrectionRenderModels(input.submission.writingCorrections, input.canonicalTranscript, input.submission.ocrPages);
    const vm = buildSubmissionFeedbackReportViewModel(input), pdf = vm.submittedPages.flatMap((p) => p.corrections);
    expect(pdf).toHaveLength(website.length);
    for (const c of website) {
      const rendered = pdf.find((p) => p.id === c.id);
      expect(rendered.renderTarget).toEqual(c.renderTarget);
      expect(rendered).toMatchObject({ symbol: c.symbol, category: c.category, quotedText: c.quotedText,
        message: c.message, suggestedText: c.suggestedText, fileId: c.fileId, page: c.page });
      expect(c.renderTarget.source).toBe('visualTarget');
    }
    expect(website.find((c) => c.symbol === 'AGR').renderTarget.wordIds).toHaveLength(1);
    expect(website.find((c) => c.symbol === 'AGR').wordIds).toHaveLength(3);
    expect(website.find((c) => c.symbol === 'P').renderTarget.anchors).toHaveLength(1);
    expect(JSON.stringify(input)).toBe(original);
  });
  test('one line for an identical target, all types and notes retained, with a separate insertion anchor', () => {
    const vm = buildSubmissionFeedbackReportViewModel(feedbackConsistencyFixture()), page = vm.submittedPages[0];
    const layout = createSubmittedImageLayout(page);
    expect(layout.underlines).toHaveLength(3);
    expect(layout.underlines.filter((l) => l.box.boundary)).toHaveLength(1);
    const shared = layout.underlines.find((l) => l.corrections.length === 2);
    expect(shared.corrections.map((c) => c.symbol).sort()).toEqual(['AGR', 'WC']);
    expect(layout.groupedMarkers).toHaveLength(1);
    const html = renderSubmissionFeedbackReportHtml(vm);
    for (const c of page.corrections) expect(html).toContain(`<tr data-correction-id="${c.id}">`);
    expect(html).toContain('AGR/WC');
    expect(html).toMatch(/<sup>P #\d+<\/sup>/);
    expect(html).toContain('Students was ready');
    const marked = page.transcript.highlightedSegments.filter((s) => s.correctionNumbers.length && !s.anchor);
    expect(marked.map((s) => s.text)).toEqual(['was', 'teh']);
  });
  test('redacted PDF preserves qualitative feedback without numeric grading or charts', () => {
    const input = feedbackConsistencyFixture();
    const teacher = buildSubmissionFeedbackReportViewModel(input);
    const student = buildSubmissionFeedbackReportViewModel({ ...input, marksVisible: false });
    const html = renderSubmissionFeedbackReportHtml(student);
    expect(teacher.result.overallScore).toBe(83.7);
    expect(student.result.overallScore).toBeUndefined();
    expect(student.result.grade).toBeUndefined();
    expect(student.result.maximumScore).toBeUndefined();
    expect(student.categoryScores).toEqual([]);
    expect(html).not.toContain('83.7'); expect(html).not.toContain('21.7');
    expect(html).not.toContain('class="score-card"'); expect(html).not.toContain('class="bar"');
    for (const text of ['Marks hidden by teacher', 'Review sentence agreement.', 'Keep developing your ideas.',
      'Check subject and verb agreement.', 'Your ideas are clear.', 'Revise the opening sentence.', 'Students was ready']) expect(html).toContain(text);
    expect(student.statistics.total).toBe(teacher.statistics.total);
  });
  test('legacy word IDs and bbox fallback remain scoped without mutating historical data', () => {
    const input = feedbackConsistencyFixture(), first = input.submission.writingCorrections[0];
    const legacy = { ...first }; delete legacy.visualTarget;
    const bbox = { ...legacy, id: 'bbox', wordIds: [], quotedText: '', startChar: undefined, endChar: undefined };
    const [words, boxes] = buildCanonicalCorrectionRenderModels([legacy, bbox], input.canonicalTranscript, input.submission.ocrPages);
    expect(words.renderTarget.source).toBe('wordIds'); expect(words.renderTarget.wordIds).toHaveLength(3);
    expect(boxes.renderTarget.source).toBe('bboxList'); expect(boxes.renderTarget.boxes).toEqual(first.bboxList);
    const [invalid] = buildCanonicalCorrectionRenderModels([{ ...first, visualTarget: { version: 1, wordIds: ['foreign'], anchors: [] } }], input.canonicalTranscript);
    expect(invalid.renderTarget.source).toBe('wordIds');
  });
});
