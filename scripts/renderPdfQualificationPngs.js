'use strict';

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const { loadImage } = require('canvas');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const outputDir = path.resolve(__dirname, '..', '..', 'output', 'pdf');

async function main() {
  const pdfs = (await fs.promises.readdir(outputDir)).filter((name) => /^overlay-.*\.pdf$/.test(name)).sort();
  for (const pdfName of pdfs) {
    const bytes = await fs.promises.readFile(path.join(outputDir, pdfName));
    const document = await pdfjs.getDocument({ data: new Uint8Array(bytes), disableWorker: true }).promise;
    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber); const viewport = page.getViewport({ scale: 1.5 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pngName = `${path.basename(pdfName, '.pdf')}-page-${String(pageNumber).padStart(2, '0')}.png`;
      await fs.promises.writeFile(path.join(outputDir, pngName), canvas.toBuffer('image/png'));
    }
    const renderedNames = Array.from({ length: document.numPages }, (_, index) => `${path.basename(pdfName, '.pdf')}-page-${String(index + 1).padStart(2, '0')}.png`);
    const rendered = await Promise.all(renderedNames.map((name) => loadImage(path.join(outputDir, name))));
    const scale = 0.42; const gap = 20; const cellWidth = Math.ceil(Math.max(...rendered.map((image) => image.width)) * scale);
    const cellHeight = Math.ceil(Math.max(...rendered.map((image) => image.height)) * scale); const columns = Math.min(2, rendered.length);
    const sheet = createCanvas(columns * cellWidth + (columns + 1) * gap, Math.ceil(rendered.length / columns) * cellHeight + (Math.ceil(rendered.length / columns) + 1) * gap);
    const context = sheet.getContext('2d'); context.fillStyle = '#cbd5e1'; context.fillRect(0, 0, sheet.width, sheet.height);
    rendered.forEach((image, index) => { const column = index % columns; const row = Math.floor(index / columns);
      context.drawImage(image, gap + column * (cellWidth + gap), gap + row * (cellHeight + gap), image.width * scale, image.height * scale); });
    await fs.promises.writeFile(path.join(outputDir, `${path.basename(pdfName, '.pdf')}-contact-sheet.png`), sheet.toBuffer('image/png'));
  }
}

main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
