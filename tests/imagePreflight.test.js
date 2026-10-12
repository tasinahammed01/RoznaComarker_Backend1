jest.mock('../src/services/visionOcr.service', () => ({ detectOrientationAnnotation: jest.fn(async () => require('./fixtures/orientationAnnotation').annotation()) }));
'use strict';
const sharp = require('sharp');
const { evaluateImage, IMAGE_PREFLIGHT } = require('../src/services/imagePreflight.service');
const { pageImage } = require('./fixtures/imagePreflightPage');
const check = (result, id) => result.checks.find(item => item.id === id);

describe('Conservative image preflight', () => {
  test.each(['png', 'jpeg', 'webp'])('accepts an ordinary document in %s without pretending to read it', async format => {
    const result = await evaluateImage(await pageImage({ format }));
    expect(result.ready).toBe(true);
    expect(check(result, 'resolution').status).toBe('pass');
    expect(check(result, 'lighting').status).toBe('pass');
    for (const id of ['clarity', 'pageVisibility', 'writingVisibility']) {
      expect(check(result, id)).toMatchObject({ status: 'unavailable', required: false });
    }
  });
  test('rejects a genuinely low-resolution document', async () => {
    const result = await evaluateImage(await pageImage({ width: 200, height: 250 }));
    expect(check(result, 'resolution').status).toBe('fail');
    expect(result.ready).toBe(false);
  });
  test('accepts the resolution boundary', async () => {
    expect((await evaluateImage(await pageImage({ width: IMAGE_PREFLIGHT.minShortEdge,
      height: IMAGE_PREFLIGHT.minLongEdge }))).ready).toBe(true);
  });
  test.each([0.3, 0.7, 1.02])('accepts imperfect but usable exposure, gain %s', async gain => {
    expect(check(await evaluateImage(await pageImage({ gain })), 'lighting').status).toBe('pass');
  });
  test('rejects a severely dark document', async () => {
    const result = await evaluateImage(await pageImage({ gain: 0.03 }));
    expect(check(result, 'lighting').status).toBe('fail');
    expect(result.ready).toBe(false);
  });
  test('rejects complete white-out, without claiming handwriting is unreadable', async () => {
    const whiteout = await sharp(await pageImage()).linear(0, 255).png().toBuffer();
    const result = await evaluateImage(whiteout);
    expect(check(result, 'lighting').status).toBe('fail');
    expect(check(result, 'lighting').message).toContain('almost entirely white');
  });
  test('does not invent clarity validation for a blurred image', async () => {
    expect(check(await evaluateImage(await pageImage({ blur: 12 })), 'clarity').status).toBe('unavailable');
  });
  test('reads EXIF-oriented photos without changing the original bytes', async () => {
    const original = await pageImage({ format: 'jpeg', exif: 6 });
    const copy = Buffer.from(original);
    expect((await evaluateImage(original)).ready).toBe(true);
    expect(original.equals(copy)).toBe(true);
    expect((await sharp(original).metadata()).orientation).toBe(6);
  });
  test('reports decode failure as unavailable rather than a quality failure', async () => {
    const result = await evaluateImage(Buffer.from('broken image'));
    expect(result.ready).toBe(false);
    expect(result.checks.filter(item => item.required).every(item => item.status === 'unavailable')).toBe(true);
  });
});
