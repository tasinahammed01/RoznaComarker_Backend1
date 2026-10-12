jest.mock('../src/services/imageOrientation.service', () => { const actual=jest.requireActual('../src/services/imageOrientation.service'); return {...actual, ORIENTATION_POLICY:{...actual.ORIENTATION_POLICY}}; });
jest.mock('../src/services/visionOcr.service', () => ({ detectOrientationAnnotation: jest.fn() }));
const sharp = require('sharp');
const vision = require('../src/services/visionOcr.service');
const { annotation } = require('./fixtures/orientationAnnotation');
const { pageImage } = require('./fixtures/imagePreflightPage');
const { evaluateImage, PREFLIGHT_CACHE } = require('../src/services/imagePreflight.service');
let bytes;
beforeAll(async () => { bytes = await pageImage(); });
beforeEach(() => { vision.detectOrientationAnnotation.mockReset().mockResolvedValue(annotation()); });
afterEach(() => jest.restoreAllMocks());
test.each([90,180,270])('rotated %s blocks required orientation', async angle => {
  vision.detectOrientationAnnotation.mockResolvedValue(annotation(Array(6).fill(angle)));
  const result = await evaluateImage(bytes);
  expect(result.ready).toBe(false);
  expect(result.checks[0]).toMatchObject({required:true,status:'fail',orientation:'rotated_'+angle});
});
test('weak evidence blocks without calling it rotated', async () => {
  vision.detectOrientationAnnotation.mockResolvedValue(annotation([0,0]));
  const result = await evaluateImage(bytes);
  expect(result.ready).toBe(false);
  expect(result.checks[0]).toMatchObject({status:'unavailable',orientation:'undetermined'});
});
test('provider errors preserve basic passes and give technical retry', async () => {
  vision.detectOrientationAnnotation.mockRejectedValue(new Error('private provider error'));
  const result = await evaluateImage(bytes);
  expect(result.ready).toBe(false);
  expect(result.checks[0]).toMatchObject({status:'unavailable'});
  expect(result.checks[0].message).toContain('try again');
  expect(result.checks.filter(c=>['resolution','lighting'].includes(c.id)).every(c=>c.status==='pass')).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private');
});
test('skips paid analysis when basic checks fail', async () => {
  await evaluateImage(await pageImage({width:160,height:200}));
  await evaluateImage(await pageImage({gain:0.03}));
  expect(vision.detectOrientationAnnotation).not.toHaveBeenCalled();
});
test('normalizes EXIF in analysis only', async () => {
  const original=await pageImage({format:'jpeg',exif:6}); const copy=Buffer.from(original);
  await evaluateImage(original);
  const input=vision.detectOrientationAnnotation.mock.calls[0][0];
  const normalized=await sharp(input).metadata(); const source=await sharp(original).metadata();
  expect(normalized.orientation).toBeUndefined();
  expect(normalized.width/normalized.height).toBeCloseTo(source.height/source.width,2);
  expect(original.equals(copy)).toBe(true);
});
test('cache binds exact bytes and user; returned results cannot mutate it', async () => {
  const first=await evaluateImage(bytes,'cache-a'); first.ready=false;
  expect((await evaluateImage(bytes,'cache-a')).ready).toBe(true);
  expect(vision.detectOrientationAnnotation).toHaveBeenCalledTimes(1);
  await evaluateImage(Buffer.concat([bytes,Buffer.from([0])]),'cache-a');
  await evaluateImage(bytes,'cache-b');
  expect(vision.detectOrientationAnnotation).toHaveBeenCalledTimes(3);
});
test('expired decisions trigger another call', async () => {
  await evaluateImage(bytes,'expiry');
  const future=Date.now()+PREFLIGHT_CACHE.ttlMs+1; jest.spyOn(Date,'now').mockReturnValue(future);
  await evaluateImage(bytes,'expiry');
  expect(vision.detectOrientationAnnotation).toHaveBeenCalledTimes(2);
});
test('policy change invalidates cached success', async () => {
  const policy = require('../src/services/imageOrientation.service');
  await evaluateImage(bytes,'version');
  const original=policy.ORIENTATION_POLICY.version;
  try {
    policy.ORIENTATION_POLICY.version='next';
    await evaluateImage(bytes,'version');
    expect(vision.detectOrientationAnnotation).toHaveBeenCalledTimes(2);
  } finally {policy.ORIENTATION_POLICY.version=original;}
});
