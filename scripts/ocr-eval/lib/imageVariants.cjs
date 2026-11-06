'use strict';
/**
 * Image variants sent to the models.
 *   original      exactly what production sends today (EXIF-orient only, otherwise the untouched bytes)
 *   preprocessed  grayscale, contrast stretch, light sharpen
 *   client-export approximation of what the new frontend crop export now uploads (JPEG, size-fitted)
 * Everything is computed in memory; nothing is written to disk.
 */
const crypto = require('crypto');
const sharp = require('sharp');
// Read-only reuse of the production normalisation so "original" is byte-for-byte what is sent today.
const { orientImage } = require('../../../src/services/gptVisionExact/imageInput.js');

const VARIANTS = Object.freeze(['original', 'preprocessed', 'client-export']);
const DEFAULT_VARIANTS = Object.freeze(['original', 'preprocessed']);
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // production limit

const PREPROCESS = Object.freeze({ percentileLow: 1, percentileHigh: 99, sharpenSigma: 0.8, jpegQuality: 92 });
// Mirrors the frontend export constants (image-crop.util.ts). Browser canvas scaling differs slightly from sharp.
const CLIENT_EXPORT = Object.freeze({ startQuality: 92, minQuality: 85, qualityStep: 3, targetBytes: 8 * 1024 * 1024, minLongEdge: 2000, minShortEdge: 480, scaleStep: 0.85 });

class ImageError extends Error {
  constructor(code, message) { super(message || code); this.name = 'ImageError'; this.code = code; }
}

function mimeOf(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function preprocessed(bytes) {
  return sharp(bytes, { failOn: 'error' }).rotate().grayscale()
    .normalise({ lower: PREPROCESS.percentileLow, upper: PREPROCESS.percentileHigh })
    .sharpen({ sigma: PREPROCESS.sharpenSigma })
    .toColourspace('srgb') // three-channel gray: widest provider compatibility
    .jpeg({ quality: PREPROCESS.jpegQuality }).toBuffer();
}

async function clientExport(bytes) {
  const c = CLIENT_EXPORT;
  const { data, info } = await sharp(bytes, { failOn: 'error' }).rotate().toBuffer({ resolveWithObject: true });
  const long = Math.max(info.width, info.height), short = Math.min(info.width, info.height);
  const floorScale = Math.min(1, Math.max(c.minLongEdge / long, c.minShortEdge / short));
  const encode = (scale, quality) => {
    const pipeline = sharp(data);
    if (scale < 1) pipeline.resize(Math.max(1, Math.round(info.width * scale)), Math.max(1, Math.round(info.height * scale)), { kernel: 'lanczos3' });
    return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality }).toBuffer();
  };
  let scale = 1, out = await encode(scale, c.startQuality);
  while (out.length > c.targetBytes && scale > floorScale) {
    const predicted = scale * Math.sqrt(c.targetBytes / out.length) * 0.95;
    scale = Math.max(floorScale, Math.min(scale * c.scaleStep, predicted));
    out = await encode(scale, c.startQuality);
  }
  for (let q = c.startQuality - c.qualityStep; out.length > c.targetBytes && q > c.minQuality; q -= c.qualityStep) out = await encode(scale, q);
  if (out.length > c.targetBytes) out = await encode(scale, c.minQuality);
  return out;
}

async function prepareVariant(variant, originalBytes) {
  if (!VARIANTS.includes(variant)) throw new ImageError('UNKNOWN_VARIANT', `Unknown image variant: ${variant}`);
  if (!Buffer.isBuffer(originalBytes) || !originalBytes.length) throw new ImageError('IMAGE_EMPTY', 'The image file is empty.');
  if (originalBytes.length > MAX_IMAGE_BYTES) throw new ImageError('IMAGE_TOO_LARGE', 'The image is over the 20 MB production limit.');
  if (!mimeOf(originalBytes)) throw new ImageError('IMAGE_FORMAT', 'The file is not a JPEG, PNG or WebP image.');
  const started = Date.now();
  let bytes;
  try {
    if (variant === 'original') bytes = (await orientImage(originalBytes)).data;
    else if (variant === 'preprocessed') bytes = await preprocessed(originalBytes);
    else bytes = await clientExport(originalBytes);
    const meta = await sharp(bytes).metadata();
    return { variant, bytes, mimeType: mimeOf(bytes), width: meta.width, height: meta.height, channels: meta.channels,
      byteLength: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), prepareMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ImageError) throw error;
    throw new ImageError('IMAGE_PREPARE_FAILED', 'The image could not be processed.');
  }
}

module.exports = { VARIANTS, DEFAULT_VARIANTS, PREPROCESS, CLIENT_EXPORT, MAX_IMAGE_BYTES, ImageError, mimeOf, prepareVariant };
