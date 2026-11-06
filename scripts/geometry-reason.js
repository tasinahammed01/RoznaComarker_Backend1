#!/usr/bin/env node
'use strict';
/**
 * Replays the geometry step for ONE image and prints which condition withheld (or kept) the boxes. Counts and codes only:
 * no word text, no file name, no path.
 *
 *   node scripts/geometry-reason.js <path-to-the-uploaded-image> --yes-call-google
 *
 * It makes exactly ONE paid Google Cloud Vision call (about $0.0015 per page; the first 1,000 a month are free), and refuses to
 * run without --yes-call-google. It is read-only: nothing is written anywhere and no database is opened.
 * The image goes through the same preparation as production (EXIF rotation only), Google's words are turned into boxes the same
 * way, and the same layout builder runs in the same mode (geometryEvidenceOnly) that decides GEOMETRY_LAYOUT_WITHHELD.
 * The Google credentials come from GOOGLE_CLOUD_KEY_FILE or GOOGLE_APPLICATION_CREDENTIALS (environment, or backend/.env when it
 * runs on your machine) and are never printed.
 */
const fs = require('fs');
const path = require('path');

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const CODE = /^[A-Z][A-Z_]{0,59}$/;
const count = value => (Number.isFinite(value) && value >= 0 && value <= 1000000 ? Math.round(value) : null);
const measure = value => (Number.isFinite(value) && value >= 0 && value <= 1000000 ? Math.round(value * 1000) / 1000 : null);
const code = value => (typeof value === 'string' && CODE.test(value) ? value : null);

/** { image, google, layout, wouldProduce }. `client` is a Google Vision ImageAnnotatorClient (injected for tests). */
async function analyze({ bytes, client }) {
  const { orientImage } = require('../src/services/gptVisionExact/imageInput');
  const { bboxFromVertices } = require('../src/services/visionOcr.service');
  const { buildHandwritingGeometryTranscript } = require('../src/utils/ocrTranscriptNormalizer');
  const oriented = await orientImage(bytes);
  const { width, height } = oriented.info;
  const [result] = await client.documentTextDetection({ image: { content: oriented.data } });
  const pages = Array.isArray(result?.fullTextAnnotation?.pages) ? result.fullTextAnnotation.pages : [];
  const boxes = [];
  let wordCount = 0;
  for (const page of pages) for (const block of page.blocks || []) for (const paragraph of block.paragraphs || []) for (const word of paragraph.words || []) {
    const text = (word.symbols || []).map(symbol => symbol?.text || '').join('').trim();
    if (!text) continue;
    wordCount++;
    const bbox = bboxFromVertices(word.boundingBox?.vertices, width, height);
    if (bbox) boxes.push({ id: `word_${boxes.length + 1}`, page: 1, text, bbox });          // production skips words without a usable box
  }
  // Production requires every reported page to match the prepared image; no page at all counts as a mismatch.
  const dimensionsMatch = pages.length > 0 && pages.every(page => Number(page.width) === width && Number(page.height) === height);
  const layout = buildHandwritingGeometryTranscript(boxes, { geometryEvidenceOnly: true });
  const degraded = layout.layoutDegraded === true;
  const wouldProduce = !dimensionsMatch ? 'GEOMETRY_DIMENSIONS_MISMATCH' : degraded ? 'GEOMETRY_LAYOUT_WITHHELD' : layout.unresolvedWordCount > 0 ? 'GEOMETRY_PARTIAL' : 'GEOMETRY_ORDERED';
  return {
    image: { width: count(width), height: count(height) },
    google: { pages: pages.length, pageWidth: count(Number(pages[0]?.width)), pageHeight: count(Number(pages[0]?.height)), dimensionsMatch, words: count(wordCount), wordsWithValidBox: count(boxes.length) },
    layout: { degraded, reason: degraded ? code(layout.reason) : null, detectedWordCount: count(layout.detectedWordCount), geometricWordCount: count(layout.geometricWordCount),
      resolvedWordCount: count(layout.resolvedWordCount), unresolvedWordCount: count(layout.unresolvedWordCount), ambiguousWordCount: count(layout.ambiguousWordCount),
      lineCount: count(layout.lineCount), medianWordHeightPercent: measure(layout.medianWordHeight) },
    wouldProduce,
  };
}

function defaultClient() {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });   // does not override variables already set
  const { ImageAnnotatorClient } = require('@google-cloud/vision');
  const key = process.env.GOOGLE_CLOUD_KEY_FILE || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const file = key && (path.isAbsolute(key) ? key : path.resolve(__dirname, '..', key));
  return file && fs.existsSync(file) ? new ImageAnnotatorClient({ keyFilename: file }) : new ImageAnnotatorClient();
}

const safeName = error => String(error?.name || 'Error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 60) || 'Error';

/** Exit code: 0 printed, 1 error, 2 usage. */
async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout, stderr = io.stderr || process.stderr, createClient = io.createClient || defaultClient;
  const confirmed = argv.includes('--yes-call-google'), rest = argv.filter(arg => arg !== '--yes-call-google');
  const usage = () => { stderr.write('Usage: node scripts/geometry-reason.js <path-to-the-uploaded-image> --yes-call-google\n'); return 2; };
  if (rest.length !== 1 || rest[0].startsWith('--')) return usage();
  let info;
  try { info = fs.statSync(rest[0]); } catch { stderr.write('The image file was not found.\n'); return 2; }
  if (!info.isFile() || info.size < 1 || info.size > MAX_IMAGE_BYTES) { stderr.write('That is not a usable image file (it must be a file of at most 20 MB).\n'); return 2; }
  if (!confirmed) {
    stderr.write('This makes ONE paid Google Cloud Vision call (about $0.0015 per page). Nothing was sent. Re-run with --yes-call-google to confirm.\n');
    return 2;
  }
  try {
    const result = await analyze({ bytes: fs.readFileSync(rest[0]), client: createClient() });
    stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  } catch (error) {
    stderr.write(`The replay failed (${safeName(error)}).\n`);
    return 1;
  }
}

if (require.main === module) main(process.argv.slice(2)).then(exitCode => { process.exitCode = exitCode; });

module.exports = { analyze, main };
