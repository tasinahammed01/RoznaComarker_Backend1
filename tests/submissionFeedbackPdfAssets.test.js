'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');
const logger = require('../src/utils/logger');
const { resolvePersistedPageAssets, _test } = require('../src/services/submissionFeedbackReport.service');

describe('submission feedback PDF asset normalization', () => {
  let root;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-normalize-'));
    process.env.UPLOAD_BASE_PATH = root;
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    for (const name of ['PDF_ASSET_MAX_WIDTH', 'PDF_ASSET_MAX_HEIGHT', 'PDF_ASSET_JPEG_QUALITY',
      'PDF_MAX_EMBEDDED_ASSET_BYTES', 'PDF_MAX_TOTAL_EMBEDDED_ASSET_BYTES']) delete process.env[name];
    jest.restoreAllMocks();
  });

  const image = (width, height, options = {}) => sharp({
    create: { width, height, channels: 4, background: options.background || { r: 20, g: 30, b: 40, alpha: 0.4 } }
  }).png().withMetadata(options.metadata || {}).toBuffer();

  test('resizes JPEG within A4 limits, uses optimized JPEG and never enlarges', async () => {
    const large = await sharp(await image(3000, 4000)).jpeg({ quality: 95 }).toBuffer();
    const normalized = await _test.optimizeImageBuffer(large);
    expect(normalized.mime).toBe('image/jpeg');
    expect(normalized.width).toBeLessThanOrEqual(1900);
    expect(normalized.height).toBeLessThanOrEqual(2700);
    const small = await _test.optimizeImageBuffer(await image(600, 800));
    expect(small.width).toBe(600);
    expect(small.height).toBe(800);
  });

  test('applies EXIF orientation and reports the rotated output dimensions', async () => {
    const oriented = await sharp(await image(1200, 800)).jpeg().withMetadata({ orientation: 6 }).toBuffer();
    const normalized = await _test.optimizeImageBuffer(oriented);
    expect(normalized.exifRotationApplied).toBe(true);
    expect(normalized.width).toBe(800);
    expect(normalized.height).toBe(1200);
  });

  test('flattens transparency onto white', async () => {
    const transparent = await image(20, 20, { background: { r: 0, g: 0, b: 0, alpha: 0 } });
    const normalized = await _test.optimizeImageBuffer(transparent);
    const pixel = await sharp(normalized.buffer).raw().toBuffer();
    expect(pixel[0]).toBeGreaterThan(245);
    expect(pixel[1]).toBeGreaterThan(245);
    expect(pixel[2]).toBeGreaterThan(245);
  });

  test('quality and individual byte limits are configurable', async () => {
    const noisy = await sharp(crypto.randomBytes(1800 * 2400 * 3),
      { raw: { width: 1800, height: 2400, channels: 3 } }).png().toBuffer();
    process.env.PDF_MAX_EMBEDDED_ASSET_BYTES = String(20 * 1024 * 1024);
    process.env.PDF_ASSET_JPEG_QUALITY = '45';
    const low = await _test.optimizeImageBuffer(noisy);
    process.env.PDF_ASSET_JPEG_QUALITY = '90';
    const high = await _test.optimizeImageBuffer(noisy);
    expect(low.buffer.length).toBeLessThan(high.buffer.length);
    process.env.PDF_MAX_EMBEDDED_ASSET_BYTES = '100';
    await expect(_test.optimizeImageBuffer(noisy)).rejects.toMatchObject({ statusCode: 413 });
  }, 30000);

  test('enforces multi-image total embedded bytes and never logs image content', async () => {
    const metric = jest.spyOn(logger, 'metric').mockImplementation(() => {});
    const files = [];
    for (let index = 0; index < 2; index += 1) {
      const filePath = path.join(root, `page-${index}.jpg`);
      fs.writeFileSync(filePath, await sharp(await image(800, 1000)).jpeg().toBuffer());
      files.push({ _id: `f${index}`, path: filePath, originalName: `page-${index}.jpg` });
    }
    const assets = await resolvePersistedPageAssets(files, { submissionId: 'safe-id' });
    expect(assets.metrics).toHaveLength(2);
    expect(assets.totalEmbeddedBytes).toBe(
      Object.values(assets.byPageKey).reduce((sum, value) => sum + Buffer.byteLength(value), 0)
    );
    expect(JSON.stringify(metric.mock.calls)).not.toMatch(/base64|data:image/i);
    process.env.PDF_MAX_TOTAL_EMBEDDED_ASSET_BYTES = '100';
    await expect(resolvePersistedPageAssets(files)).rejects.toMatchObject({ statusCode: 413 });
  });

  test('corrupt images and cancellation fail in a controlled way', async () => {
    const corruptPath = path.join(root, 'corrupt.jpg');
    fs.writeFileSync(corruptPath, 'not an image');
    await expect(resolvePersistedPageAssets([{ _id: 'bad', path: corruptPath, originalName: 'corrupt.jpg' }]))
      .rejects.toMatchObject({ statusCode: 422 });
    const controller = new AbortController();
    controller.abort();
    await expect(_test.optimizeImageBuffer(await image(100, 100), { signal: controller.signal }))
      .rejects.toMatchObject({ statusCode: 499 });
  });
});
