const mockDetect = jest.fn();
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({documentTextDetection:mockDetect})) }));
const { detectOrientationAnnotation, OcrProviderError } = require('../src/services/visionOcr.service');
const { annotation } = require('./fixtures/orientationAnnotation');
beforeEach(() => mockDetect.mockReset());
test('returns untouched ordered geometry using the existing client', async () => {
  const geometry=annotation([180,180,180,180]);
  mockDetect.mockResolvedValue([{fullTextAnnotation:geometry}]);
  const bytes=Buffer.from('analysis copy');
  expect(await detectOrientationAnnotation(bytes)).toBe(geometry);
  expect(mockDetect).toHaveBeenCalledWith({image:{content:bytes}},expect.objectContaining({retry:null,timeout:expect.any(Number)}));
});
test('maps transport failure to the existing provider error type', async () => {
  mockDetect.mockRejectedValue({code:4});
  await expect(detectOrientationAnnotation(Buffer.alloc(0))).rejects.toBeInstanceOf(OcrProviderError);
});
test('does not accept an embedded provider error as text evidence', async () => {
  mockDetect.mockResolvedValue([{error:{message:'provider failed'},fullTextAnnotation:annotation()}]);
  await expect(detectOrientationAnnotation(Buffer.alloc(0))).rejects.toBeInstanceOf(OcrProviderError);
});
