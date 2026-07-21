const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');

const ROOT = path.resolve(__dirname, '..', '..');
const pdfPath = process.argv[2] ? path.resolve(process.argv[2]) : path.join(ROOT, 'output', 'pdf', 'RoznaHub-Submission-Feedback-Report-Sample.pdf');
const artifactPrefix = process.argv[3] || 'submission-feedback';
const renderDir = path.join(ROOT, 'tmp', 'pdfs', 'rendered');
const textPath = path.join(ROOT, 'tmp', 'pdfs', `${artifactPrefix}-text.txt`);

(async () => {
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const bytes = new Uint8Array(fs.readFileSync(pdfPath));
  const document = await pdfjs.getDocument({ data: bytes, disableWorker: true }).promise;
  fs.mkdirSync(renderDir, { recursive: true });

  const extracted = [];
  const pages = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.7 });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    const imagePath = path.join(renderDir, `${artifactPrefix}-${String(pageNumber).padStart(2, '0')}.png`);
    fs.writeFileSync(imagePath, canvas.toBuffer('image/png'));
    const text = await page.getTextContent();
    const pageText = text.items.map((item) => item.str).join(' ');
    extracted.push(`--- PAGE ${pageNumber} ---\n${pageText}`);
    pages.push({ pageNumber, width: viewport.width, height: viewport.height, imagePath, textCharacters: pageText.length });
  }
  fs.writeFileSync(textPath, extracted.join('\n\n'));
  const thumbWidth = 300;
  const thumbHeight = 425;
  const gap = 16;
  const contactSheet = createCanvas((thumbWidth * 2) + (gap * 3), (thumbHeight * 4) + (gap * 5));
  const contactContext = contactSheet.getContext('2d');
  contactContext.fillStyle = '#e8eef2';
  contactContext.fillRect(0, 0, contactSheet.width, contactSheet.height);
  for (let index = 0; index < pages.length; index += 1) {
    const source = await require('canvas').loadImage(pages[index].imagePath);
    const x = gap + ((index % 2) * (thumbWidth + gap));
    const y = gap + (Math.floor(index / 2) * (thumbHeight + gap));
    contactContext.drawImage(source, x, y, thumbWidth, thumbHeight);
  }
  const contactSheetPath = path.join(renderDir, `${artifactPrefix}-contact-sheet.png`);
  fs.writeFileSync(contactSheetPath, contactSheet.toBuffer('image/png'));
  console.log(JSON.stringify({ pdfPath, pageCount: document.numPages, textPath, contactSheetPath, pages }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
