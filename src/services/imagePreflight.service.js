'use strict';

const sharp = require('sharp');
const fs = require('fs/promises');
const { createHash } = require('crypto');
const vision = require('./visionOcr.service');
const { estimateDocumentOrientation, ORIENTATION_POLICY } = require('./imageOrientation.service');
const decisions = new Map();
const PREFLIGHT_CACHE = Object.freeze({ ttlMs: 5 * 60 * 1000, maxEntries: 512 });

// Conservative rejection floor, below Vision's 1024x768 OCR recommendation.
// This is a processability screen, not a guarantee of text recognition.
const IMAGE_PREFLIGHT = Object.freeze({
  minShortEdge: 480, minLongEdge: 640, workingEdge: 1024,
  darkPixel: 20, darkFraction: 0.99,
  whitePixel: 254, whiteFraction: 0.9999
});

function checksTemplate() {
  return [
    { id: 'orientation', label: 'Upright image', required: true, status: 'unavailable',
      message: 'Fix the resolution or exposure first, then retry the image check.' },
    { id: 'resolution', label: 'Image resolution', required: true, status: 'unavailable' },
    { id: 'clarity', label: 'Image clarity', required: false, status: 'unavailable',
      message: 'Check yourself: zoom in and make sure the photo is not blurry.' },
    { id: 'lighting', label: 'Exposure (basic check)', required: true, status: 'unavailable' },
    { id: 'pageVisibility', label: 'Full assignment content', required: false, status: 'unavailable',
      message: 'Check yourself: include all assignment content without cut-off edges.' },
    { id: 'writingVisibility', label: 'Writing is visible', required: false, status: 'unavailable',
      message: 'Check yourself: the writing should be visible when you zoom in. Handwriting style is not assessed.' }
  ];
}

async function evaluateImage(input, userId) {
  const checks = checksTemplate();
  try {
    const bytes = Buffer.isBuffer(input) ? input : await fs.readFile(input);
    // Only server-authenticated user identity is supplied by middleware.
    const key = userId ? JSON.stringify([String(userId), ORIENTATION_POLICY.version,
      IMAGE_PREFLIGHT, createHash('sha256').update(bytes).digest('hex')]) : null;
    const now = Date.now();
    for (const [id, decision] of decisions) if (decision.expires <= now) decisions.delete(id);
    if (key && decisions.has(key)) return structuredClone(decisions.get(key).result);
    const image = sharp(bytes, { failOn: 'error' });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format)) throw new Error('Unsupported image');
    // autoOrient only affects the disposable analysis copy. Never rewrite source bytes.
    const { data, info } = await image.autoOrient().flatten({ background: '#ffffff' })
      .resize({ width: IMAGE_PREFLIGHT.workingEdge, height: IMAGE_PREFLIGHT.workingEdge,
        fit: 'inside', withoutEnlargement: true }).greyscale().raw().toBuffer({ resolveWithObject: true });
    const width = metadata.width;
    const height = metadata.height;
    const resolution = checks.find(check => check.id === 'resolution');
    const dimensionsPass = Math.min(width, height) >= IMAGE_PREFLIGHT.minShortEdge
      && Math.max(width, height) >= IMAGE_PREFLIGHT.minLongEdge;
    resolution.status = dimensionsPass ? 'pass' : 'fail';
    resolution.message = dimensionsPass ? 'Enough pixels for the basic resolution check.'
      : 'Image resolution is too low. Please upload a clearer photo (at least 640 by 480 pixels in either orientation).';
    let dark = 0; let white = 0;
    const pixels = info.width * info.height;
    for (let i = 0; i < data.length; i += info.channels) {
      if (data[i] < IMAGE_PREFLIGHT.darkPixel) dark++;
      if (data[i] >= IMAGE_PREFLIGHT.whitePixel) white++;
    }
    const tooDark = dark / pixels >= IMAGE_PREFLIGHT.darkFraction;
    const tooWhite = white / pixels >= IMAGE_PREFLIGHT.whiteFraction;
    const lighting = checks.find(check => check.id === 'lighting');
    lighting.status = tooDark || tooWhite ? 'fail' : 'pass';
    lighting.message = tooDark ? 'The page is too dark. Please retake the photo in better lighting.'
      : tooWhite ? 'The image is almost entirely white. Check for glare or a blank photo and retake it.'
        : 'No extreme whole-image darkness or white-out detected. Check shadows and glare yourself.';
    if (dimensionsPass && lighting.status === 'pass') {
      const orientation = checks.find(check => check.id === 'orientation');
      try {
        const analysis = await sharp(data, { raw: info }).png().toBuffer();
        const decision = estimateDocumentOrientation(await vision.detectOrientationAnnotation(analysis));
        Object.assign(orientation, decision);
        orientation.status = decision.orientation === 'upright' ? 'pass'
          : decision.orientation === 'undetermined' ? 'unavailable' : 'fail';
        orientation.message = decision.orientation === 'upright' ? 'The writing appears upright.'
          : decision.orientation === 'undetermined'
            ? "We couldn't verify the image orientation. Please make sure the writing is upright and try again."
            : 'Please rotate the image so the writing is upright.';
      } catch {
        orientation.message = "We couldn't check the image orientation. Please try again.";
      }
    }
    const result = { ready: checks.filter(check => check.required).every(check => check.status === 'pass'), checks };
    if (key && result.ready) {
      if (decisions.size >= PREFLIGHT_CACHE.maxEntries) decisions.delete(decisions.keys().next().value);
      decisions.set(key, { expires: Date.now() + PREFLIGHT_CACHE.ttlMs, result: structuredClone(result) });
    }
    return result;
  } catch {
    for (const check of checks.filter(check => check.required)) {
      check.status = 'unavailable';
      check.message = 'We could not check this image. Retry, or choose another JPG or PNG photo.';
    }
  }
  return { ready: checks.filter(check => check.required).every(check => check.status === 'pass'), checks };
}

module.exports = { evaluateImage, IMAGE_PREFLIGHT, PREFLIGHT_CACHE };
