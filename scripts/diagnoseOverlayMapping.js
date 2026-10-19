'use strict';
// Read-only: even --fixtures uses only in-memory synthetic media.
const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const sizeOf = require('image-size');
const { annotationImageGeometry } = require('../src/services/annotationImageGeometry.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
const clean = value => String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
async function diagnose(submission, loadFile) {
  const canonical = buildCanonicalSubmissionTranscript(submission);
  const corrections = buildCanonicalCorrectionRenderModels(submission.writingCorrections || [], canonical, submission.ocrPages || [], { submission });
  const pages = [];
  for (const page of submission.ocrPages || []) {
    const file = await loadFile(String(page.fileId));
    let real = null;
    if (Buffer.isBuffer(file?.buffer)) {
      const m = sizeOf(file.buffer); real = { encodedWidth: m.width, encodedHeight: m.height, exifOrientation: m.orientation || 1 };
    } else if (file?.path) {
      const absolute = path.resolve(__dirname, '..', file.path);
      const root = path.resolve(__dirname, '..') + path.sep;
      if (absolute.startsWith(root)) {
        try { const bytes = await fs.readFile(absolute); const m = sizeOf(bytes);
          real = { encodedWidth: m.width, encodedHeight: m.height, exifOrientation: m.orientation || 1 }; }
        catch { real = { unavailable: true }; }
      }
    }
    const geometry = await annotationImageGeometry(page, loadFile);
    const words = canonical.pages.find(p => String(p.fileId) === String(page.fileId) && p.pageNumber === page.pageNumber)?.words || [];
    pages.push({ fileId: String(page.fileId), pageNumber: page.pageNumber, real,
      stored: { width: page.width, height: page.height, coordinateSpace: page.coordinateSpace || null },
      geometry: geometry || null,
      corrections: corrections.filter(c => String(c.fileId) === String(page.fileId) && Number(c.page || 1) === Number(page.pageNumber || 1)).map(c => {
        const targetWords = c.renderTarget.wordIds.map(id => words.find(w => String(w.id) === id)?.text || '[unresolved]');
        const original = c.originalText || c.quotedText || /['“‘"]([^'”’"]+)['”’"]/.exec(c.message || '')?.[1] || '';
        return { symbol: c.symbol, original, message: c.message, wordIds: c.renderTarget.wordIds,
          requestedWordIds: c.wordIds || [], requestedTargetWords: (c.wordIds || []).map(id => words.find(w => String(w.id) === id)?.text || '[unresolved]'),
          targetWords, textMatches: !!clean(original) && clean(targetWords.join(' ')) === clean(original),
          source: c.renderTarget.source, boxes: c.renderTarget.boxes };
      }) });
  }
  return { submissionId: String(submission._id), pages };
}
async function fixtures() {
  const reports = [];
  for (const [width, height] of [[800, 600], [600, 800], [700, 680]]) {
    for (const orientation of [1, 3, 6, 8]) {
      const filename = `${width}-${height}-${orientation}.jpg`;
      const buffer = await sharp({ create: { width, height, channels: 3, background: '#ffffff' } }).jpeg().withMetadata({ orientation }).toBuffer();
      const fileId = `fixture-${filename}`;
      const word = { id: `word_${fileId}_1_1`, text: 'blindely', paragraphIndex: 1,
        bbox: { x0: 10, y0: 20, x1: 25, y1: 25 } };
      const wrong = { id: `word_${fileId}_1_2`, text: 'when', paragraphIndex: 2,
        bbox: { x0: 50, y0: 70, x1: 60, y1: 75 } };
      const submission = { _id: fileId, ocrPages: [{ fileId, pageNumber: 1, width, height, words: [word, wrong] }],
        writingCorrections: [{ fileId, page: 1, symbol: 'SP', originalText: 'blindely', quotedText: 'blindely',
          message: "Spelling error: 'blindely' should be 'blindly'", wordIds: [wrong.id] }] };
      reports.push(await diagnose(submission, async () => ({ buffer })));
    }
  }
  return { mode: 'synthetic-fixtures', liveSubmissionsAvailable: false, reports };
}
async function main() {
  if (process.argv.includes('--fixtures')) return console.log(JSON.stringify(await fixtures(), null, 2));
  const id = process.argv[2];
  if (!/^[a-f\d]{24}$/i.test(id || '')) throw new Error('Usage: node scripts/diagnoseOverlayMapping.js <submissionId> OR --fixtures');
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    const Submission = require('../src/models/Submission'); const File = require('../src/models/File');
    const submission = await Submission.findById(id).lean();
    if (!submission) throw new Error('Submission unavailable');
    console.log(JSON.stringify(await diagnose(submission, fileId => File.findById(fileId).lean()), null, 2));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Overlay diagnosis failed; verify the ID, media availability and database access. No data was changed.'); process.exitCode = 1; });
module.exports = { diagnose, fixtures };
