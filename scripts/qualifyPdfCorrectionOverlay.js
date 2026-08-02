'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { buildSubmissionFeedbackReportViewModel } = require('../src/pdf/sample/submissionFeedbackReportViewModel');
const { generateSubmissionFeedbackPdf } = require('../src/modules/submissionFeedbackPdfGenerator');
const browserManager = require('../src/services/pdfBrowserManager.service');

const outputDir = path.resolve(__dirname, '..', '..', 'output', 'pdf');
const colors = { CONTENT: '#b9474d', GRAMMAR: '#287a55', ORGANIZATION: '#2f6f9f', VOCABULARY: '#7445a2', MECHANICS: '#946b00' };
const symbols = { CONTENT: 'DEV', GRAMMAR: 'AGR', ORGANIZATION: 'COH', VOCABULARY: 'WC', MECHANICS: 'SP' };

function submittedImage(label, targets) {
  const width = 900; const height = 1180; const canvas = createCanvas(width, height); const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fffdf8'; ctx.fillRect(0, 0, width, height); ctx.strokeStyle = '#d9e7ee'; ctx.lineWidth = 2;
  for (let y = 95; y < height - 50; y += 62) { ctx.beginPath(); ctx.moveTo(55, y); ctx.lineTo(width - 55, y); ctx.stroke(); }
  ctx.fillStyle = '#152d47'; ctx.font = 'bold 28px Arial'; ctx.fillText(label, 55, 48);
  ctx.font = '26px Arial'; ctx.fillStyle = '#273849';
  targets.forEach((target, index) => {
    const x = target.box.x0 / 100 * width; const y = target.box.y0 / 100 * height;
    ctx.fillText(target.word, x, y + 29); ctx.fillStyle = '#718096';
    ctx.fillText(`context line ${index + 1} continues across the submitted page`, 70, Math.min(height - 30, y + 67));
    ctx.fillStyle = '#273849';
  });
  return { dataUrl: canvas.toDataURL('image/png'), width, height };
}

function makeViewModel(name, pageCounts, options = {}) {
  const reportName = options.reportName || name;
  const files = pageCounts.map((_, index) => `file-${index + 1}`); const transcriptPages = []; const corrections = [];
  const imageDataByPageKey = {}; let offset = 0; let correctionNumber = 0;
  pageCounts.forEach((count, pageIndex) => {
    const fileId = files[pageIndex]; const targets = Array.from({ length: count }, (_, index) => {
      const category = Object.keys(colors)[(correctionNumber + index) % 5]; const row = Math.floor(index / 4); const column = index % 4;
      return { category, word: `error${correctionNumber + index + 1}`, box: { x0: 9 + column * 21, y0: 12 + row * 13, x1: 20 + column * 21, y1: 15 + row * 13 } };
    });
    const image = submittedImage(`${reportName} - submitted image ${pageIndex + 1}`, targets);
    const text = targets.length ? targets.map((target) => target.word).join(' ') : 'This page has no canonical corrections.';
    transcriptPages.push({ fileId, pageNumber: 1, startChar: offset, endChar: offset + text.length, text,
      imageWidth: image.width, imageHeight: image.height, words: targets.map((target, index) => ({ id: `${fileId}-w${index}`, bbox: target.box })) });
    imageDataByPageKey[`${fileId}:1`] = image.dataUrl;
    targets.forEach((target, index) => {
      const startChar = offset + text.indexOf(target.word); correctionNumber += 1;
      corrections.push({ id: `c${correctionNumber}`, fileId, page: 1, category: target.category,
        symbol: symbols[target.category], color: colors[target.category], quotedText: target.word,
        suggestedText: `fixed${correctionNumber}`, message: `${target.category} fixture correction`,
        startChar, endChar: startChar + target.word.length, wordIds: [`${fileId}-w${index}`], bboxList: [target.box] });
    });
    offset += text.length + 2;
  });
  const canonicalText = transcriptPages.map((page) => page.text).join('\n\n');
  const vm = buildSubmissionFeedbackReportViewModel({ generatedAt: '2026-08-02T00:00:00.000Z', identity: {
    title: `PDF overlay qualification ${reportName}`, className: 'Deterministic QA', studentName: 'Fixture Student', teacherName: 'Fixture Teacher'
  }, legend: Object.keys(colors).map((category) => ({ category, symbol: symbols[category], label: `${category} fixture`, color: colors[category] })),
  submission: { _id: name, files, canonicalText, correctionStatus: 'completed', correctionSourceHash: 'fixture-source',
    transcriptPages, writingCorrections: corrections, imageDataByPageKey }, evaluation: {}, feedback: {} });
  if (options.before) vm.submittedPages.forEach((page) => page.corrections.forEach((correction) => { correction.bboxList = []; }));
  return vm;
}

async function main() {
  await fs.promises.mkdir(outputDir, { recursive: true });
  const fixtures = [
    ['overlay-before-missing-markers', [6], { before: true, reportName: 'overlay-a-one-image' }],
    ['overlay-a-one-image', [6]],
    ['overlay-b-two-images', [5, 5]],
    ['overlay-c-three-images-dense', [14, 14, 14]],
    ['overlay-d-zero-corrections', [0]]
  ];
  try {
    for (const [name, pageCounts, options] of fixtures) {
      await generateSubmissionFeedbackPdf(makeViewModel(name, pageCounts, options), path.join(outputDir, `${name}.pdf`));
    }
  } finally { await browserManager.closeBrowser(); }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
