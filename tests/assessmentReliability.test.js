'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const mockDocumentTextDetection = jest.fn();
jest.mock('@google-cloud/vision', () => ({
  ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockDocumentTextDetection }))
}));
jest.mock('../src/services/submissionFeedbackReport.service', () => ({
  rasterPdf: jest.fn(async () => [{ buffer: Buffer.from('page'), width: 100, height: 200 }])
}));

describe('assessment upload and OCR reliability contracts', () => {
  test('canonicalizes the stored extension and MIME from validated JPEG bytes', () => {
    const { canonicalizeValidatedFile } = require('../src/middlewares/upload.middleware');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-upload-'));
    const originalPath = path.join(root, 'random.pdf');
    fs.writeFileSync(originalPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const file = { filename: 'random.pdf', path: originalPath, mimetype: 'application/pdf' };
    canonicalizeValidatedFile(file, 'image/jpeg');
    expect(file).toMatchObject({ filename: 'random.jpg', mimetype: 'image/jpeg', detectedMime: 'image/jpeg' });
    expect(fs.existsSync(file.path)).toBe(true);
    expect(fs.existsSync(originalPath)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    [Buffer.from('%PDF-'), 'application/pdf'],
    [Buffer.from([0xff, 0xd8, 0xff, 0x00]), 'image/jpeg'],
    [Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]), 'image/png'],
    [Buffer.from('not-a-supported-file'), null]
  ])('detects actual content signatures independently of the browser claim', (bytes, expected) => {
    expect(require('../src/middlewares/upload.middleware').detectSignatureKind(bytes)).toBe(expected);
  });

  test('retains bounding boxes whose protobuf vertices omit zero coordinates', () => {
    const { bboxFromVertices } = require('../src/services/visionOcr.service');
    expect(bboxFromVertices([{}, { x: 50 }, { x: 50, y: 20 }, { y: 20 }], 100, 100))
      .toEqual({ x: 0, y: 0, w: 50, h: 20 });
  });

  test('rasterizes an accepted PDF and sends every page through document OCR', async () => {
    mockDocumentTextDetection.mockResolvedValueOnce([{ fullTextAnnotation: {
      text: 'Readable PDF text', pages: [{ width: 100, height: 200, blocks: [] }]
    } }]);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assessment-pdf-'));
    const pdfPath = path.join(root, 'submission.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\nfixture'));
    const result = await require('../src/services/visionOcr.service').extractOcrFromImageFile(pdfPath);
    expect(result.fullText).toBe('Readable PDF text');
    expect(result.pages).toHaveLength(1);
    expect(mockDocumentTextDetection).toHaveBeenCalledWith(
      { image: { content: Buffer.from('page') } }, expect.objectContaining({ timeout: expect.any(Number) })
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test.each([
    [{ code: 4, message: 'Deadline exceeded' }, 'OCR_PROVIDER_TIMEOUT', true],
    [{ code: 8, message: 'Resource exhausted' }, 'OCR_PROVIDER_RATE_LIMITED', true],
    [{ code: 16, message: 'Unauthenticated' }, 'OCR_PROVIDER_AUTH', false],
    [{ code: 13, message: 'Internal' }, 'OCR_PROVIDER_FAILED', false]
  ])('classifies provider failures without exposing provider details', (input, code, retryable) => {
    const result = require('../src/services/visionOcr.service').classifyVisionError(input);
    expect(result).toMatchObject({ code, retryable });
    expect(result.safeMessage).not.toContain(input.message);
  });

  test('exposes a bounded indexed recovery query rather than an unbounded collection scan', () => {
    const { dueWorkQuery, workerConfig } = require('../src/services/assessmentRecovery.service');
    const query = dueWorkQuery(new Date(), 3);
    expect(query.$and).toEqual(expect.arrayContaining([
      expect.objectContaining({ $or: expect.any(Array) })
    ]));
    expect(workerConfig().batchSize).toBeLessThanOrEqual(50);
    expect(workerConfig().intervalMs).toBeGreaterThanOrEqual(30000);
  });
});
