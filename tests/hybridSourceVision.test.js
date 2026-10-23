jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({
  documentTextDetection: jest.fn(async () => [{ fullTextAnnotation: { text: 'preception', pages: [{
    width: 800, height: 1000, blocks: [{ paragraphs: [{ words: [{
      boundingBox: { vertices: [{ x: 10, y: 10 }, { x: 200, y: 10 }, { x: 200, y: 50 }, { x: 10, y: 50 }] },
      symbols: [...'preception'].map(text => ({ text, confidence: 0.99 }))
    }] }] }] }] } }])
}) ) }));
jest.mock('../src/services/hybridSource/shadow', () => ({ rawEvidence: Symbol('test private evidence'), observe: jest.fn() }));
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const vision = require('../src/services/visionOcr.service');
const shadow = require('../src/services/hybridSource/shadow');
let directory, file;
const originalMode = process.env.OCR_SOURCE_MODE;
const originalOrder = process.env.OCR_READING_ORDER;
beforeAll(async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hybrid-source-unit-'));
  file = path.join(directory, 'synthetic-geometry.png');
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: 'white' } }).png().toFile(file);
});
afterAll(() => {
  fs.unlinkSync(file); fs.rmdirSync(directory);
  if (originalMode === undefined) delete process.env.OCR_SOURCE_MODE; else process.env.OCR_SOURCE_MODE = originalMode;
  if (originalOrder === undefined) delete process.env.OCR_READING_ORDER; else process.env.OCR_READING_ORDER = originalOrder;
});
test('actual Vision adapter preserves identical native legacy output in shadow/rollback', async () => {
  // Shadow historically observes native Google output; the newer opt-in
  // handwriting layout/source gate is a separate legacy mode, not shadow output.
  process.env.OCR_READING_ORDER = 'native';
  const options = { sourceFile: { _id: 'file' }, hybridIdentity: { submissionId: 'submission', runId: 'run' } };
  process.env.OCR_SOURCE_MODE = 'legacy';
  const legacy = await vision.extractOcrFromImageFile(file, options);
  expect(shadow.observe).not.toHaveBeenCalled();
  process.env.OCR_SOURCE_MODE = 'hybrid_shadow';
  shadow.observe.mockReturnValue(new Promise(() => {})); // pending reader MUST NOT hold OCR response
  const current = await vision.extractOcrFromImageFile(file, options);
  expect(JSON.stringify(current)).toBe(JSON.stringify(legacy));
  expect(current[shadow.rawEvidence][0].words[0]).toMatchObject({ text: 'preception',
    nativeId: 'word_1_1', polygon: expect.any(Array), symbols: expect.any(Array) });
  expect(shadow.observe.mock.calls[0][0].identity).toMatchObject({ width: 800, height: 1000,
    pageNumber: 1, sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
  process.env.OCR_SOURCE_MODE = 'legacy';
  expect(JSON.stringify(await vision.extractOcrFromImageFile(file, options))).toBe(JSON.stringify(legacy));
  expect(shadow.observe).toHaveBeenCalledTimes(1);
});
test('unvalidated hybrid publishing fails before requesting Google', async () => {
  process.env.OCR_SOURCE_MODE = 'hybrid';
  await expect(vision.extractOcrFromImageFile(file)).rejects.toThrow('NOT_VALIDATED');
});
