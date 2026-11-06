'use strict';
// F8: EXIF-rotated photos. Measured on a real rotated page (EXIF 3): lossless PNG output is 5-9x the JPEG and can pass the 20 MB
// source limit for phone-size photos. Rotated JPEGs are re-encoded as high-quality JPEG instead; everything else is unchanged.
const sharp = require('sharp');
const { orientImage } = require('../src/services/gptVisionExact/imageInput');
const LIMIT = 20 * 1024 * 1024;

// A 120x80 test page: a red block in the top-left corner on grey, stored with the given EXIF orientation.
async function page(orientation, { width = 120, height = 80, format = 'jpeg' } = {}) {
  const block = await sharp({ create: { width: 30, height: 20, channels: 3, background: { r: 255, g: 0, b: 0 } } }).png().toBuffer();
  let image = sharp({ create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } } }).composite([{ input: block, left: 0, top: 0 }]);
  image = format === 'jpeg' ? image.jpeg({ quality: 95, chromaSubsampling: '4:4:4' }) : image.webp({ lossless: true });
  return image.withMetadata({ orientation }).toBuffer();
}
const pixel = async (bytes, x, y) => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const i = (y * info.width + x) * info.channels;
  return [data[i], data[i + 1], data[i + 2]];
};
const isRed = ([r, g, b]) => r > 200 && g < 60 && b < 60;

test('an unrotated image is returned untouched, byte for byte', async () => {
  for (const orientation of [undefined, 1]) {
    const bytes = orientation ? await page(orientation) : await sharp({ create: { width: 40, height: 40, channels: 3, background: '#fff' } }).jpeg().toBuffer();
    const out = await orientImage(bytes);
    expect(out.data).toBe(bytes);
    expect(out.info.format).toBe('jpeg');
  }
});

test.each([[3, 120, 80], [6, 80, 120], [8, 80, 120]])('a rotated JPEG (EXIF %i) comes out upright as a JPEG with the right size', async (orientation, width, height) => {
  const out = await orientImage(await page(orientation));
  expect(out.info.format).toBe('jpeg');
  expect([out.info.width, out.info.height]).toEqual([width, height]);
  expect([...out.data.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);     // the source reader recognises it as image/jpeg
  const meta = await sharp(out.data).metadata();
  expect(meta.orientation === undefined || meta.orientation === 1).toBe(true);   // no second rotation downstream
  // where the red corner must be after the rotation: EXIF 3 -> bottom-right, 6 (90 deg clockwise) -> top-right, 8 (90 deg anticlockwise) -> bottom-left
  const corner = { 3: [width - 5, height - 5], 6: [width - 5, 5], 8: [5, height - 5] }[orientation];
  expect(isRed(await pixel(out.data, ...corner))).toBe(true);
});

test('the JPEG output stays close to the input size, where lossless PNG would be many times larger', async () => {
  const noisy = await sharp({ create: { width: 2000, height: 1500, channels: 3, background: { r: 128, g: 128, b: 128 }, noise: { type: 'gaussian', mean: 128, sigma: 20 } } })
    .jpeg({ quality: 90 }).withMetadata({ orientation: 6 }).toBuffer();
  const out = await orientImage(noisy);
  const png = await sharp(noisy).rotate().png().toBuffer();
  expect(out.info.format).toBe('jpeg');
  expect(out.data.length).toBeLessThan(noisy.length * 2.5);
  expect(png.length).toBeGreaterThan(out.data.length * 3);          // the old behaviour, for comparison
  expect(out.data.length).toBeLessThan(LIMIT);
});

test('quality is high: the rotated JPEG is visually identical to a lossless rotation', async () => {
  const bytes = await page(6, { width: 400, height: 300 });
  const out = await orientImage(bytes);
  const reference = await sharp(bytes).rotate().raw().toBuffer({ resolveWithObject: true });
  const actual = await sharp(out.data).raw().toBuffer({ resolveWithObject: true });
  expect([actual.info.width, actual.info.height]).toEqual([reference.info.width, reference.info.height]);
  let worst = 0;
  for (let i = 0; i < reference.data.length; i += 97) worst = Math.max(worst, Math.abs(reference.data[i] - actual.data[i]));
  expect(worst).toBeLessThan(40);   // block edges only; flat areas are exact
});

test('only rotated JPEGs change: a rotated non-JPEG keeps the lossless PNG path', async () => {
  const out = await orientImage(await page(6, { format: 'webp' }));
  expect(out.info.format).toBe('png');
  expect([out.info.width, out.info.height]).toEqual([80, 120]);
});

test('an undecodable image still fails loudly', async () => {
  await expect(orientImage(Buffer.from('not an image'))).rejects.toThrow();
});
