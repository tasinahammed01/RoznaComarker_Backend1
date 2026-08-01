'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { execFileSync } = require('child_process');
const { vm: baseVm } = require('./generateProductionSubmissionFeedbackPdf');
const { generateSubmissionFeedbackPdf } = require('../src/modules/submissionFeedbackPdfGenerator');
const currentTemplate = require('../src/pdf/submissionFeedbackReportTemplate');
const browserManager = require('../src/services/pdfBrowserManager.service');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'output', 'pdf', 'compact-qualification');
const clone = (value) => JSON.parse(JSON.stringify(value));

function baselineRenderer() {
  const filename = path.join(ROOT, 'src', 'pdf', 'submissionFeedbackReportTemplate.js');
  const source = execFileSync('git', ['-c', `safe.directory=${ROOT.replace(/\\/gu, '/')}`,
    'show', 'HEAD:src/pdf/submissionFeedbackReportTemplate.js'], { cwd: ROOT, encoding: 'utf8' });
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(source, filename);
  return loaded.exports.renderSubmissionFeedbackReportHtml;
}

function renumber(vm) {
  let number = 0;
  for (const page of vm.submittedPages) {
    page.corrections = page.corrections.map((item) => ({ ...item, displayNumber: ++number,
      reportId: item.reportId || item.id || `qualification-${number}` }));
  }
  return vm;
}

function expandedCorrections(page, count, prefix) {
  const seeds = page.corrections.length ? page.corrections : baseVm.submittedPages[0].corrections;
  return Array.from({ length: count }, (_, index) => {
    const seed = clone(seeds[index % seeds.length]);
    return { ...seed, id: `${prefix}-${index + 1}`, reportId: `${prefix}-${index + 1}`,
      quotedText: `${seed.quotedText || 'Error'} ${index + 1}`,
      suggestedText: `${seed.suggestedText || 'Suggested correction'} ${index + 1}`,
      message: `${seed.message || 'Review this passage.'} Canonical row ${index + 1}.`,
      bboxList: (seed.bboxList || []).map((box, boxIndex) => ({ ...box,
        y: Math.min(94, Number(box.y || 5) + ((index + boxIndex) % 12) * 5.5) })) };
  });
}

function fixtures() {
  const one = clone(baseVm); one.submittedPages = [one.submittedPages[0]];
  one.submittedPages[0].corrections = one.submittedPages[0].corrections.slice(0, 3);

  const twoMany = clone(baseVm);
  twoMany.submittedPages[0].corrections = expandedCorrections(twoMany.submittedPages[0], 23, 'b-p1');
  twoMany.submittedPages[1].corrections = expandedCorrections(twoMany.submittedPages[1], 22, 'b-p2');

  const three = clone(baseVm); const third = clone(three.submittedPages[1]);
  third.fileId = 'file-3'; third.pageNumber = 1; third.displayPageNumber = 3;
  third.corrections = expandedCorrections(third, 6, 'c-p3');
  three.submittedPages[0].corrections = expandedCorrections(three.submittedPages[0], 5, 'c-p1');
  three.submittedPages[1].corrections = expandedCorrections(three.submittedPages[1], 5, 'c-p2');
  three.submittedPages.push(third); three.submission.uploadedPageCount = 3;

  const zero = clone(baseVm); zero.submittedPages = [zero.submittedPages[0]];
  zero.submittedPages[0].corrections = [];

  const long = clone(baseVm); long.submittedPages = [long.submittedPages[0]];
  long.submittedPages[0].transcript.highlightedSegments = [{ text: `${'A deliberately long transcript sentence for pagination verification. '.repeat(55)}`,
    correctionNumbers: [], symbols: [], color: '#39956b' }];
  long.submittedPages[0].corrections = expandedCorrections(long.submittedPages[0], 14, 'e-long')
    .map((item) => ({ ...item, suggestedText: `${item.suggestedText} ${'Clarify the intended relationship while preserving the original meaning. '.repeat(3)}`.slice(0, 300) }));

  return { A_one_image_few: renumber(one), B_two_images_45: renumber(twoMany),
    C_three_images: renumber(three), D_zero_corrections: renumber(zero), E_long_content: renumber(long) };
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const baseline = baselineRenderer();
  const results = [];
  for (const [name, vm] of Object.entries(fixtures())) {
    for (const [variant, renderer] of [['baseline', baseline], ['compact', currentTemplate.renderSubmissionFeedbackReportHtml]]) {
      const outputPath = path.join(OUT, `${name}-${variant}.pdf`);
      await generateSubmissionFeedbackPdf(vm, outputPath, { renderHtml: renderer,
        debugHtmlPath: path.join(OUT, `${name}-${variant}.html`) });
      results.push({ name, variant, outputPath, submittedPages: vm.submittedPages.length,
        corrections: vm.submittedPages.reduce((sum, page) => sum + page.corrections.length, 0) });
    }
  }
  console.log(JSON.stringify({ outputDirectory: OUT, results }, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(() => browserManager.closeBrowser());
