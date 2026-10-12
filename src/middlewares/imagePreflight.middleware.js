'use strict';

const fs = require('fs/promises');
const { evaluateImage } = require('../services/imagePreflight.service');

function requestFiles(req) {
  return [req.file, ...(Array.isArray(req.files) ? req.files : Object.values(req.files || {}).flat())].filter(Boolean);
}

async function cleanup(files) {
  // Only server-created Multer paths; never accept a client-provided path.
  await Promise.all(files.filter(file => file.path).map(file => fs.unlink(file.path).catch(() => {})));
}

async function preflightImage(req, res) {
  const files = requestFiles(req);
  try {
    const file = files[0];
    if (files.length !== 1 || !file?.detectedMime?.startsWith('image/')) {
      return res.status(400).json({ success: false, message: 'Choose one JPG, PNG or WEBP image.' });
    }
    const result = await evaluateImage(file.buffer || file.path, req.user?._id);
    return res.json({ success: true, data: result });
  } finally {
    await cleanup(files);
  }
}

async function enforceImagePreflight(req, res, next) {
  const files = requestFiles(req);
  const results = [];
  for (let index = 0; index < files.length; index++) {
    const file = files[index];
    // PDFs retain their existing validation and processing behavior.
    if (!(file.detectedMime || file.mimetype || '').startsWith('image/')) continue;
    const result = await evaluateImage(file.buffer || file.path, req.user?._id);
    results.push({ index, ...result });
  }
  if (results.some(result => !result.ready)) {
    await cleanup(files);
    const failed = results.some(result => result.checks.some(check => check.required && check.status === 'fail'));
    const unavailable = !failed && results.some(result => result.checks.some(check => check.required && check.status === 'unavailable'));
    return res.status(unavailable ? 503 : 422).json({ success: false,
      code: unavailable ? 'IMAGE_PREFLIGHT_UNAVAILABLE' : 'IMAGE_PREFLIGHT_FAILED',
      message: unavailable ? 'We could not check an image. Please retry or choose another photo.'
        : 'An image needs attention. Please check its orientation, resolution and lighting before uploading.',
      data: { images: results } });
  }
  return next();
}

module.exports = { preflightImage, enforceImagePreflight };
