'use strict';
const { PDFDocument, StandardFonts } = require('pdf-lib');
const sharp = require('sharp');
const { rasterize } = require('../src/services/pdfSubmissionPages.service');
const { rasterPdf } = require('../src/services/submissionFeedbackReport.service');
async function pdf(count, scanned = false) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let number = 1; number <= count; number++) {
    const page = doc.addPage([595, 842]);
    if (scanned) {
      const canvas = require('canvas').createCanvas(595, 842), context = canvas.getContext('2d');
      context.fillStyle = 'white'; context.fillRect(0, 0, 595, 842);
      context.fillStyle = 'black'; context.font = '20px cursive'; context.fillText(`Scanned writing page ${number}`, 40, 100);
      page.drawImage(await doc.embedPng(canvas.toBuffer('image/png')), { x: 0, y: 0, width: 595, height: 842 });
    } else page.drawText(`Students was ready. Page ${number}.`, { x: 40, y: 740, size: 20, font });
  }
  return Buffer.from(await doc.save());
}
describe('PDF submission rasterization', () => {
  jest.setTimeout(120000);
  test.each([1, 2, 5])('%i-page standard-font PDF preserves visible text and every page', async count => {
    const pages = await rasterize(await pdf(count));
    expect(pages.map(p => p.pageNumber)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
    for (const page of pages) {
      expect(page.width).toBeGreaterThan(1500); expect(page.height).toBeGreaterThan(2000);
      const stats = await sharp(page.buffer).stats();
      expect(stats.channels[0].min).toBeLessThan(100);
    }
  });
  test('scanned PDF pages retain image content', async () => {
    const pages = await rasterize(await pdf(2, true));
    expect(pages).toHaveLength(2); expect((await sharp(pages[1].buffer).stats()).channels[0].min).toBeLessThan(100);
  });
  test('controlled errors for corrupt PDF and page limit', async () => {
    await expect(rasterize(Buffer.from('%PDF-corrupt'))).rejects.toMatchObject({ code: 'OCR_PDF_INVALID' });
    await expect(rasterize(await pdf(21))).rejects.toMatchObject({ code: 'OCR_PDF_LIMIT' });
  });
  test('password protected PDF has a specific safe failure', async () => {
    const PDFKit = require('pdfkit');
    const bytes = await new Promise(resolve => {
      const doc = new PDFKit({ userPassword: 'test-password', ownerPassword: 'owner-password' }), chunks = [];
      doc.on('data', data => chunks.push(data)); doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.text('Private test PDF'); doc.end();
    });
    await expect(rasterize(bytes)).rejects.toMatchObject({ code: 'OCR_PDF_PASSWORD' });
  });
  test('rejects dangerous canvas dimensions before allocating canvas', async () => {
    const doc = await PDFDocument.create(); doc.addPage([20000, 20000]);
    await expect(rasterPdf(Buffer.from(await doc.save()), { dpi: 200 })).rejects.toMatchObject({ statusCode: 413 });
  });
  test('empty bytes and oversize files fail before processing', async () => {
    const fs = require('fs/promises'), os = require('os'), path = require('path');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pdf-size-test-'));
    const file = path.join(directory, 'test.pdf');
    const { preparePdfPages } = require('../src/services/pdfSubmissionPages.service');
    try {
      await fs.writeFile(file, '');
      await expect(preparePdfPages(file)).rejects.toMatchObject({ code: 'OCR_PDF_INVALID' });
      const handle = await fs.open(file, 'w'); await handle.truncate(11 * 1024 * 1024); await handle.close();
      await expect(preparePdfPages(file)).rejects.toMatchObject({ code: 'OCR_PDF_TOO_LARGE' });
    } finally { await fs.unlink(file); await fs.rmdir(directory); }
  });
});
