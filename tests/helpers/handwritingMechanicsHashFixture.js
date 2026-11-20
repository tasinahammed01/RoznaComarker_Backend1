'use strict';
// Fixed inputs for the D3 proof: the correction source hash and the runtime contract fingerprint must stay byte-identical to the
// base commit (b439c267) while the handwriting mechanics check is off, or for typed essays. Synthetic text only.
const inputs = Object.freeze({
  transcript: 'Kids these days , they win.',
  pages: [{ fileId: 'file-1', fileOrder: 0, pageNumber: 1, pageIndex: 0, startChar: 0, endChar: 27 }],
  assignment: { title: 'Essay', instructions: 'Write about your week.' },
  fileContentIdentity: 'content-identity-1',
  legend: { version: 'legend-fixture-v1', contentHash: 'legend-content-fixture' }
});
const typedDoc = Object.freeze({ _id: 'typed-1' });
const exactDoc = Object.freeze({ _id: 'exact-1', sourceFidelityMode: 'gpt_vision_exact' });
const envOff = Object.freeze({ NODE_ENV: 'test' });
const envOn = Object.freeze({ NODE_ENV: 'test', HANDWRITING_MECHANICS_CHECK_ENABLED: 'true' });
// Recorded on the base commit, before any S3 code existed (see the S3 report).
const BASE_CORRECTION_SOURCE_HASH = '5575f162c8e6563d782f8c74d89686752e0d5cacd24f61f40d6a90d1de579227';
const BASE_CONTRACT_HASH = 'ee563cb145c7d0a2';
module.exports = { inputs, typedDoc, exactDoc, envOff, envOn, BASE_CORRECTION_SOURCE_HASH, BASE_CONTRACT_HASH };
