'use strict';

const mockExtractDocumentContent = jest.fn();
const mockExtractWorksheetStructure = jest.fn();

jest.mock('../src/services/fileContentExtractor.service', () => ({
  validateFile: () => ({ valid: true }),
  extractContent: jest.fn(),
  extractDocumentContent: mockExtractDocumentContent,
}));
jest.mock('../src/services/worksheetExtractor.service', () => ({
  extractWorksheetStructure: mockExtractWorksheetStructure,
}));

const controller = require('../src/controllers/worksheet.controller');

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
}

const request = () => ({
  file: { buffer: Buffer.from('upload'), mimetype: 'image/png', originalname: 'worksheet.png', size: 6 },
  body: { language: 'English', subject: 'Math', gradeLevel: '4' },
});

describe('worksheet extract-structure controller sequencing', () => {
  beforeEach(() => {
    mockExtractDocumentContent.mockReset();
    mockExtractWorksheetStructure.mockReset();
  });

  test('does not call structure AI when OCR/extraction fails', async () => {
    mockExtractDocumentContent.mockRejectedValue(Object.assign(new Error('private provider detail'), {
      code: 'WORKSHEET_OCR_FAILED',
      userMessage: 'Please upload a clearer worksheet image.',
    }));
    const res = response();
    await controller.extractWorksheetStructure(request(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, code: 'WORKSHEET_OCR_FAILED', message: 'Please upload a clearer worksheet image.' });
    expect(JSON.stringify(res.body)).not.toContain('private provider detail');
    expect(mockExtractWorksheetStructure).not.toHaveBeenCalled();
  });

  test('calls structure AI only after extraction succeeds', async () => {
    mockExtractDocumentContent.mockResolvedValue({ plainText: 'Extracted worksheet text', blocks: [], stats: {} });
    mockExtractWorksheetStructure.mockResolvedValue({
      title: 'Math', description: 'Practice', subject: 'Math', activities: [], answerKey: {},
      extractedStructure: { sections: [] },
    });
    const res = response();
    await controller.extractWorksheetStructure(request(), res);
    expect(mockExtractDocumentContent).toHaveBeenCalledTimes(1);
    expect(mockExtractWorksheetStructure).toHaveBeenCalledWith('Extracted worksheet text', expect.objectContaining({
      language: 'English', subject: 'Math', gradeLevel: '4', difficulty: 'medium', requestId: expect.any(String),
    }));
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test.each([
    ['AI_TOTAL_BUDGET_EXHAUSTED', null, 'Worksheet extraction timed out. Please try again.'],
    ['AI_PROVIDER_RATE_LIMIT', 429, 'AI service is temporarily busy. Please try again.'],
    ['AI_PROVIDER_PAYMENT_REQUIRED', 402, 'AI service credits are unavailable. Please contact admin.'],
    ['AI_PROVIDER_AUTH_ERROR', 401, 'AI service configuration error. Please contact admin.'],
    ['AI_OUTPUT_VALIDATION_FAILED', null, "We could read the document, but couldn't structure all worksheet questions reliably. Please review the document formatting or try again."],
  ])('maps %s to a safe client message', async (code, httpStatus, expected) => {
    mockExtractDocumentContent.mockResolvedValue({ plainText: 'Extracted worksheet text', blocks: [], stats: {} });
    mockExtractWorksheetStructure.mockRejectedValue(Object.assign(new Error('private provider detail'), {
      code: code === 'AI_TOTAL_BUDGET_EXHAUSTED' ? code : 'AI_CHAIN_EXHAUSTED',
      finalFailureCode: code,
      attempts: [{ provider: 'openrouter', model: 'test/model', code, httpStatus }],
      attemptCount: 1,
    }));
    const res = response();
    await controller.extractWorksheetStructure(request(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ success: false, code, message: expected });
    expect(JSON.stringify(res.body)).not.toContain('private provider detail');
  });
});
