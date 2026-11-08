'use strict';

const cheerio = require('cheerio');
const { vm: fixture } = require('../scripts/generateProductionSubmissionFeedbackPdf');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');

function report(source) {
  const vm = JSON.parse(JSON.stringify(fixture));
  const text = 'I writed\nthis essay.\n\nAn intentional paragraph stays.';
  vm.submittedPages = [{ ...vm.submittedPages[0], transcriptSource: source, transcript: { text, highlightedSegments: [
    { text: 'I ', correctionNumbers: [], symbols: [] },
    { text: 'writed\nthis', correctionNumbers: [1, 2], symbols: ['VF', 'SP'], color: '#39956b' },
    { text: ' essay.\n', correctionNumbers: [], symbols: [] },
    { text: '\nAn intentional paragraph stays.', correctionNumbers: [], symbols: [] }
  ] } }];
  return vm;
}

describe('PDF transcript presentation', () => {
  test('reflows display lines while preserving paragraphs, markers and canonical text', () => {
    const vm = report('handwritingGeometry'), before = JSON.stringify(vm);
    const $ = cheerio.load(renderSubmissionFeedbackReportHtml(vm));
    expect($('.transcript-soft-break').length).toBe(1);
    expect($('.transcript-soft-break').text()).toBe('\n');
    expect($('.transcription mark').attr('data-correction-numbers')).toBe('1,2');
    expect($('.transcription sup').text()).toBe('VF/SP #01,#02');
    $('.transcription sup').remove();
    expect($('.transcription').text()).toBe(vm.submittedPages[0].transcript.text);
    expect($('.transcription mark').text()).toBe('writed\nthis');
    expect(JSON.stringify(vm)).toBe(before);
  });

  test.each(['sourceTextExact', 'visionFullText', undefined])('flows %s lines without changing source text or paragraph boundaries', source => {
    const vm = report(source), $ = cheerio.load(renderSubmissionFeedbackReportHtml(vm));
    expect($('.transcript-soft-break').length).toBe(1);
    expect($('.transcript-soft-break').text()).toBe('\n');
    $('.transcription sup').remove();
    expect($('.transcription').text()).toBe(vm.submittedPages[0].transcript.text);
  });

  test('preserves whitespace-only blank lines, CRLF and paragraph breaks across correction segments', () => {
    const vm = report('sourceTextExact'), text = 'First\r\nline.\r\n \t\r\nNext\n\nLast.';
    vm.submittedPages[0].transcript = { text, highlightedSegments: [
      { text: 'First\r', correctionNumbers: [], symbols: [] },
      { text: '\nline.\r\n \t', correctionNumbers: [1], symbols: ['SP'], color: '#39956b' },
      { text: '\r\nNext\n', correctionNumbers: [], symbols: [] },
      { text: '\nLast.', correctionNumbers: [], symbols: [] }
    ] };
    const $ = cheerio.load(renderSubmissionFeedbackReportHtml(vm));
    expect($('.transcript-soft-break').text()).toBe('\r\n');
    $('.transcription sup').remove();
    expect($('.transcription').text()).toBe(text);
    expect($('.transcription mark').text()).toBe('\nline.\r\n \t');
  });

  test('passes canonical source provenance to the report without changing text, offsets or words', () => {
    const text = 'Keep\nspeling.\n\nNext paragraph.';
    const page = { fileId: 'f1', pageNumber: 1, source: 'handwritingGeometry', text, startChar: 42, endChar: 42 + text.length, words: [] };
    const input = { submission: { files: ['f1'], transcriptPages: [page], canonicalText: text, writingCorrections: [] } };
    const before = JSON.stringify(input), vm = buildSubmissionFeedbackReportViewModel(input);
    expect(vm.submittedPages[0].transcriptSource).toBe('handwritingGeometry');
    expect(vm.submittedPages[0].transcript).toMatchObject({ text, startChar: 42, endChar: 42 + text.length });
    expect(JSON.stringify(input)).toBe(before);
  });

  test('Chromium flows exact-source lines across the available width without clipping', async () => {
    const browser = await require('puppeteer').launch({ headless: true, args: ['--no-sandbox'] });
    try {
      const page = await browser.newPage();
      await page.setViewport({ width: 703, height: 1000 });
      await page.setRequestInterception(true);
      page.on('request', request => request.url().startsWith('data:') ? request.continue() : request.abort());
      const measure = async (source, hardBreaks = false) => {
        const vm = report(source);
        await page.setContent(renderSubmissionFeedbackReportHtml(vm));
        if (hardBreaks) await page.addStyleTag({ content: '.transcript-soft-break { white-space: pre-wrap !important; }' });
        return page.evaluate(() => {
          const box = document.querySelector('.transcription'), rect = box.getBoundingClientRect();
          return { width: rect.width, height: rect.height, scrollWidth: box.scrollWidth,
            container: box.parentElement.getBoundingClientRect().width };
        });
      };
      const exact = await measure('sourceTextExact', true), reflow = await measure('sourceTextExact');
      expect(reflow.width).toBeGreaterThan(690);
      expect(reflow.width).toBeCloseTo(reflow.container, 0);
      expect(reflow.height).toBeLessThan(exact.height);
      const vm = report('handwritingGeometry'), text = 'Longword'.repeat(100);
      vm.submittedPages[0].transcript = { text, highlightedSegments: [{ text, correctionNumbers: [], symbols: [] }] };
      await page.setContent(renderSubmissionFeedbackReportHtml(vm));
      const overflow = await page.$eval('.transcription', box => box.scrollWidth - box.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    } finally { await browser.close(); }
  }, 30000);
});
