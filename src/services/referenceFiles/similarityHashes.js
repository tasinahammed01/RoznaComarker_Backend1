'use strict';
// The one bridge from Similarity Reporting to reference files: the 32-bit hashes of every 5-word sequence of the ACTIVE reference files of
// an assignment (its own files and its class's), so that words a teacher gave as material never count as a similarity match. It returns
// numbers only: no file text, name or id ever leaves this module (tests/referenceFileIsolation.test.js).
const ReferenceFile = require('../../models/ReferenceFile');
const { tokenize } = require('../similarity/normalize');
const { shingleHashes } = require('../similarity/fingerprints');

/** [hash, ...] (unique numbers) for the ready, active reference files of this class and assignment. At most 10 files are read. */
async function referenceSequenceHashes({ classId, assignmentId }) {
  const files = await ReferenceFile.find({ status: 'ready', activeSlot: { $exists: true },
    $or: [{ scope: 'class', class: classId }, { scope: 'assignment', assignment: assignmentId }] }).select('+text').limit(10).lean();
  const out = new Set();
  for (const file of files) for (const hash of shingleHashes(tokenize(String(file.text || '')))) if (hash !== null) out.add(hash);
  return [...out];
}

module.exports = { referenceSequenceHashes };
