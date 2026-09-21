// These auth/billing/profile suites do not perform OCR. Isolate the unrelated
// cloud client so they run without a production service-account file.
jest.mock('../../src/services/visionOcr.service', () => ({}));
