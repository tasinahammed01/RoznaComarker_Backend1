const fs = require('fs');
const path = require('path');

async function main() {
  // Minimal pdfkit smoke-test (writes a tiny PDF next to this script).
  const PDFDocument = require('pdfkit');

  const outPath = path.join(__dirname, 'pdfkit-smoke-test.pdf');
  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const stream = fs.createWriteStream(outPath);
    doc.pipe(stream);
    doc.font('Helvetica-Bold').fontSize(16).text('pdfkit smoke test');
    doc.moveDown(0.5);
    doc.font('Helvetica').fontSize(11).text('If you can open this file, pdfkit is working.');
    doc.end();
    stream.on('finish', resolve);
    stream.on('error', reject);
  });

  console.log('PDF saved:', outPath);
}

main().catch((err) => {
  console.error('pdfkit test failed. Full error:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
