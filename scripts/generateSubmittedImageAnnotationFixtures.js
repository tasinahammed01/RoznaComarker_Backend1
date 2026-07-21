'use strict';

// Dense fixture rendering is intentionally heavier than normal reports. Keep
// this test-only override out of production defaults.
process.env.PUPPETEER_PROTOCOL_TIMEOUT_MS ||= '120000';
process.env.PUPPETEER_LAUNCH_TIMEOUT_MS ||= '120000';
process.env.PDF_RENDER_TIMEOUT_MS ||= '120000';

const fs = require('fs');
const shellRoot = `${process.env.USERPROFILE}\\.cache\\puppeteer\\chrome-headless-shell`;
if (!process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(shellRoot)) {
  const versions = fs.readdirSync(shellRoot).sort().reverse();
  const executable = versions.map((version) => `${shellRoot}\\${version}\\chrome-headless-shell-win64\\chrome-headless-shell.exe`)
    .find((candidate) => fs.existsSync(candidate));
  if (executable) process.env.PUPPETEER_EXECUTABLE_PATH = executable;
}

const path = require('path');
const { vm: productionVm } = require('./generateProductionSubmissionFeedbackPdf');
const { generateSubmissionFeedbackPdf } = require('../src/modules/submissionFeedbackPdfGenerator');
const browserManager = require('../src/services/pdfBrowserManager.service');

const root = path.resolve(__dirname, '..', '..');
const output = (name) => path.join(root, 'output', 'pdf', name);
const clone = (value) => JSON.parse(JSON.stringify(value));
const encodedSvg = (body) => `data:image/svg+xml;base64,${Buffer.from(body).toString('base64')}`;

function handwrittenImage(title, dense = false) {
  const lines = dense ? Array.from({ length: 23 }, (_, index) => `A handwritten sentence ${index + 1} develops the response with evidence and transitions.`) : [
    'Technology can support learning when it is used thoughtfully.',
    'Students benefit from examples, feedback, and careful guidance.',
    'Teachers should protect privacy and explain responsible use.',
    'In conclusion, balanced use can improve access and confidence.'
  ];
  return encodedSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="1180"><rect width="900" height="1180" fill="#f5f1e8"/><rect x="38" y="26" width="824" height="1128" rx="8" fill="#fffdfa" stroke="#d8d0c2"/><g font-family="Comic Sans MS, cursive" font-size="22" fill="#24364a"><text x="64" y="72" font-size="18" fill="#718096">${title}</text>${lines.map((line, index) => `<text x="70" y="${126 + index * 42}" transform="rotate(${index % 3 - 1} 70 ${126 + index * 42})">${line}</text>`).join('')}</g></svg>`);
}

const marker = (index, x, y, category = 'GRAMMAR', symbol = 'AGR') => ({
  id: `visual-${index}`, reportId: `visual-${index}`, displayNumber: index, fileId: 'fixture-file', page: 1,
  category, symbol, symbolLabel: symbol === 'AGR' ? 'Agreement' : symbol, color: '#39956b',
  quotedText: `Synthetic evidence ${index}`, message: 'Synthetic visual-regression correction.', suggestedText: 'Suggested revision.',
  bboxList: [{ x, y, w: 11, h: 2.25 }]
});

function handwritingObstacles(lineCount, landscape = false) {
  const startY = landscape ? 14 : 8.8; const step = landscape ? 7.2 : 3.56;
  return [{ x: 6.5, y: 3.4, w: 42, h: 2.4 }, ...Array.from({ length: lineCount }, (_, index) => ({
    x: 7.2, y: startY + index * step, w: 86, h: landscape ? 3.2 : 2.35
  }))];
}

function page(corrections, imageDataUrl, overrides = {}) {
  return { fileId: 'fixture-file', fileIndex: 0, pageNumber: 1, displayPageNumber: 1, imageDataUrl,
    imageWidth: 900, imageHeight: 1180, corrections, transcriptText: '',
    transcript: { highlightedSegments: [] }, ...overrides };
}

function fixtureVm(corrections, imageDataUrl) {
  const vm = clone(productionVm); vm.submission.uploadedPageCount = 1; vm.submittedPages = [page(corrections, imageDataUrl)];
  vm.statistics = { content: corrections.filter((item) => item.category === 'CONTENT').length,
    grammar: corrections.filter((item) => item.category === 'GRAMMAR').length,
    organization: corrections.filter((item) => item.category === 'ORGANIZATION').length,
    vocabulary: corrections.filter((item) => item.category === 'VOCABULARY').length,
    mechanics: corrections.filter((item) => item.category === 'MECHANICS').length, total: corrections.length };
  return vm;
}

async function main() {
  const sparse = fixtureVm([marker(1, 35, 22)], handwrittenImage('Sparse submitted page'));
  sparse.submittedPages[0].annotationObstacles = handwritingObstacles(4);
  const edge = fixtureVm([marker(1, 0, 0), marker(2, 89, 0, 'CONTENT', 'DEV'),
    marker(3, 0, 97, 'VOCABULARY', 'WW'), marker(4, 89, 97, 'MECHANICS', 'P')], handwrittenImage('Edge placement page'));
  const categories = [['GRAMMAR', 'AGR'], ['CONTENT', 'DEV'], ['ORGANIZATION', 'TR'], ['VOCABULARY', 'WW'], ['MECHANICS', 'P']];
  const denseCorrections = Array.from({ length: 38 }, (_, index) => {
    const [category, symbol] = categories[index % categories.length];
    return marker(index + 1, 4 + index % 6 * 15.5, 7 + Math.floor(index / 6) * 13.5, category, symbol);
  });
  const dense = fixtureVm(denseCorrections, handwrittenImage('Dense handwritten submitted page', true));
  dense.submittedPages[0].annotationObstacles = handwritingObstacles(23);
  const landscape = fixtureVm([marker(1, 3, 3), marker(2, 88, 3), marker(3, 3, 91), marker(4, 88, 91)],
    handwrittenImage('Landscape submitted page'));
  Object.assign(landscape.submittedPages[0], { imageWidth: 1400, imageHeight: 850, annotationObstacles: handwritingObstacles(4, true) });
  const twoUpload = clone(productionVm);
  twoUpload.submittedPages.forEach((submittedPage) => {
    submittedPage.annotationObstacles = [
      { x: 4, y: 2.5, w: 35, h: 2.5 },
      { x: 4, y: 6.8, w: 92, h: 3.1 },
      { x: 4, y: 10.3, w: 92, h: 3.1 },
      { x: 4, y: 13.8, w: 92, h: 3.1 },
      { x: 4, y: 17.3, w: 92, h: 3.1 },
    ];
  });
  const outputs = {
    sparse: output('submission-feedback-image-sparse.pdf'),
    dense: output('submission-feedback-image-dense.pdf'),
    edges: output('submission-feedback-image-edges.pdf'),
    landscape: output('submission-feedback-image-landscape.pdf'),
    twoUpload: output('submission-feedback-image-two-upload.pdf')
  };
  await generateSubmissionFeedbackPdf(sparse, outputs.sparse);
  await generateSubmissionFeedbackPdf(dense, outputs.dense);
  await generateSubmissionFeedbackPdf(edge, outputs.edges);
  await generateSubmissionFeedbackPdf(landscape, outputs.landscape);
  await generateSubmissionFeedbackPdf(twoUpload, outputs.twoUpload);
  console.log(JSON.stringify(outputs));
}

main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => browserManager.closeBrowser());
