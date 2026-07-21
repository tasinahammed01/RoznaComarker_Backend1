'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

async function render(pdfPath, outputDirectory) {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const bytes = await fs.promises.readFile(pdfPath);
  const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  const stem = path.basename(pdfPath, path.extname(pdfPath));
  const files = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber); const viewport = page.getViewport({ scale: 2 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const target = path.join(outputDirectory, `${stem}-${String(pageNumber).padStart(2, '0')}.png`);
    await fs.promises.writeFile(target, canvas.toBuffer('image/png')); files.push(target);
  }
  return files;
}

(async () => {
  const [, , pdfPath, outputDirectory] = process.argv;
  if (!pdfPath || !outputDirectory) throw new Error('Usage: node scripts/renderPdfPages.js <pdf> <output-directory>');
  console.log(JSON.stringify(await render(path.resolve(pdfPath), path.resolve(outputDirectory))));
})().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });

module.exports = { render };
