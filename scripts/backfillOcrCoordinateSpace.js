'use strict';
const { annotationImageGeometry } = require('../src/services/annotationImageGeometry.service');
async function decidePage(page, loadFile) {
  if (page.coordinateSpace) return { action: 'keep', coordinateSpace: page.coordinateSpace };
  const geometry = await annotationImageGeometry(page, loadFile);
  if (!geometry || geometry.ambiguous) return { action: 'review', reason: 'coordinate_space_not_proven' };
  return { action: 'set', coordinateSpace: geometry.coordinateSpace,
    ocrImageWidth: geometry.width, ocrImageHeight: geometry.height, ocrExifOrientation: geometry.orientation };
}
async function main() {
  const apply = process.argv.includes('--apply');
  const id = process.argv[process.argv.indexOf('--submission') + 1];
  if (process.argv.includes('--submission') && !/^[a-f\d]{24}$/i.test(id || '')) throw new Error('Invalid submission ID');
  require('dotenv').config({ quiet: true });
  const mongoose = require('mongoose');
  try {
    await mongoose.connect(process.env.MONGO_URI, { autoIndex: false });
    const Submission = require('../src/models/Submission'); const File = require('../src/models/File');
    const counts = { scanned: 0, provenPages: 0, reviewRequired: 0, changed: 0 };
    const query = process.argv.includes('--submission') ? { _id: id } : { 'ocrPages.0': { $exists: true } };
    for await (const submission of Submission.find(query).lean().cursor()) {
      counts.scanned++; let review = false;
      const set = {};
      const pages = [];
      for (let i = 0; i < (submission.ocrPages || []).length; i++) {
        const page = submission.ocrPages[i];
        const decision = await decidePage(page, fileId => File.findById(fileId).select('path').lean());
        pages.push({ pageNumber: page.pageNumber, ...decision });
        if (decision.action === 'review') review = true;
        if (decision.action === 'set') {
          counts.provenPages++;
          for (const key of ['coordinateSpace', 'ocrImageWidth', 'ocrImageHeight', 'ocrExifOrientation']) set[`ocrPages.${i}.${key}`] = decision[key];
        }
      }
      if (review) { counts.reviewRequired++; set.ocrCoordinateSpaceReviewRequired = true; }
      if (apply && Object.keys(set).length) {
        const result = await Submission.updateOne({ _id: submission._id, updatedAt: submission.updatedAt,
          ocrJobId: submission.ocrJobId || null }, { $set: set }); counts.changed += result.modifiedCount;
      }
      console.log(JSON.stringify({ submissionId: String(submission._id), pages,
        reviewRequired: review, nextStep: review ? 'Teacher must review and explicitly request regenerateCanonicalCorrections; flagged records will re-OCR the original source.' : null }));
    }
    console.log(JSON.stringify({ dryRun: !apply, ...counts }));
  } finally { await mongoose.disconnect(); }
}
if (require.main === module) main().catch(() => { console.error('Coordinate-space backfill stopped. Verify access and scope; uploads and OCR providers are never modified/called.'); process.exitCode = 1; });
module.exports = { decidePage };
