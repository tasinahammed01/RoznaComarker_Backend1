'use strict';

const mockExtractContent = jest.fn();
const mockExtractWorksheetStructure = jest.fn();

jest.mock('../src/services/fileContentExtractor.service', () => ({
  validateFile: () => ({ valid: true }),
  extractContent: mockExtractContent,
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
    mockExtractContent.mockReset();
    mockExtractWorksheetStructure.mockReset();
  });

  test('does not call structure AI when OCR/extraction fails', async () => {
    mockExtractContent.mockRejectedValue(Object.assign(new Error('private provider detail'), {
      code: 'WORKSHEET_OCR_FAILED',
      userMessage: 'Please upload a clearer worksheet image.',
    }));
    const res = response();
    await controller.extractWorksheetStructure(request(), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ success: false, message: 'Please upload a clearer worksheet image.' });
    expect(JSON.stringify(res.body)).not.toContain('private provider detail');
    expect(mockExtractWorksheetStructure).not.toHaveBeenCalled();
  });

  test('calls structure AI only after extraction succeeds', async () => {
    mockExtractContent.mockResolvedValue('Extracted worksheet text');
    mockExtractWorksheetStructure.mockResolvedValue({
      title: 'Math', description: 'Practice', subject: 'Math', activities: [], answerKey: {},
      extractedStructure: { sections: [] },
    });
    const res = response();
    await controller.extractWorksheetStructure(request(), res);
    expect(mockExtractContent).toHaveBeenCalledTimes(1);
    expect(mockExtractWorksheetStructure).toHaveBeenCalledWith('Extracted worksheet text', {
      language: 'English', subject: 'Math', gradeLevel: '4',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
