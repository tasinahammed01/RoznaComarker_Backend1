'use strict';

const mammoth = require('mammoth');
const {
  WorksheetOcrError,
  googleOcrPages,
  extractTextFromPages,
} = require('../src/services/worksheetOcr.service');
const {
  extractContent,
  extractFromPDF,
  extractFromImage,
  validateFile,
  SAFE_PDF_OCR_MESSAGE,
} = require('../src/services/fileContentExtractor.service');

describe('worksheet upload text extraction', () => {
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['image/png', 'worksheet.png'],
    ['image/jpeg', 'worksheet.jpg'],
  ])('extracts %s through configured Google OCR', async (mimeType, originalName) => {
    const client = { documentTextDetection: jest.fn().mockResolvedValue([{
      fullTextAnnotation: { text: 'Name: ____\nSolve 2 + 2.' },
    }]) };
    const text = await extractContent(Buffer.from('image'), mimeType, originalName, {
      extractTextFromPages: (pages) => extractTextFromPages(pages, {
        googleOcrPages: (inputPages) => googleOcrPages(inputPages, { client }),
        aiOcrPages: jest.fn(),
      }),
    });
    expect(text).toContain('Solve 2 + 2');
    expect(client.documentTextDetection).toHaveBeenCalledTimes(1);
  });

  test('uses the AI OCR fallback when Google Vision is unavailable', async () => {
    const google = jest.fn().mockRejectedValue(
      new WorksheetOcrError('WORKSHEET_OCR_NOT_CONFIGURED', 'Google is unavailable.')
    );
    const fallback = jest.fn().mockResolvedValue([
      { pageNumber: 1, text: 'Fallback worksheet transcription' },
    ]);
    await expect(extractTextFromPages([{ pageNumber: 1, buffer: Buffer.from('x') }], {
      googleOcrPages: google,
      aiOcrPages: fallback,
    })).resolves.toBe('Fallback worksheet transcription');
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  test('allows a blank page when the multi-page OCR result has enough text overall', async () => {
    const client = { documentTextDetection: jest.fn()
      .mockResolvedValueOnce([{ fullTextAnnotation: { text: 'First worksheet page' } }])
      .mockResolvedValueOnce([{ fullTextAnnotation: { text: '' } }]) };
    await expect(googleOcrPages([
      { pageNumber: 1, buffer: Buffer.from('one') },
      { pageNumber: 2, buffer: Buffer.from('two') },
    ], { client })).resolves.toEqual([
      { pageNumber: 1, text: 'First worksheet page' },
      { pageNumber: 2, text: '' },
    ]);
  });

  test('returns a controlled OCR error when neither provider can read the image', async () => {
    const failure = new WorksheetOcrError('WORKSHEET_OCR_NOT_CONFIGURED', 'No fallback configured.');
    await expect(extractTextFromPages([{ pageNumber: 1, buffer: Buffer.from('x') }], {
      googleOcrPages: jest.fn().mockRejectedValue(failure),
      aiOcrPages: jest.fn().mockRejectedValue(failure),
    })).rejects.toMatchObject({
      code: 'WORKSHEET_OCR_NOT_CONFIGURED',
      userMessage: expect.stringContaining("couldn't read text"),
    });
  });

  test('returns a controlled failure for an empty or unclear image', async () => {
    const unclear = new WorksheetOcrError('WORKSHEET_OCR_TEXT_EMPTY', 'Provider returned only whitespace.');
    await expect(extractTextFromPages([{ pageNumber: 1, buffer: Buffer.from('blurred') }], {
      googleOcrPages: jest.fn().mockRejectedValue(unclear),
      aiOcrPages: jest.fn().mockRejectedValue(unclear),
    })).rejects.toMatchObject({
      code: 'WORKSHEET_OCR_TEXT_EMPTY',
      userMessage: expect.stringContaining('clearer image'),
    });
  });

  test('keeps text-based PDFs on pdf-parse without rasterizing or invoking OCR', async () => {
    const rasterPdf = jest.fn();
    const ocr = jest.fn();
    const text = await extractFromPDF(Buffer.from('pdf'), {
      pdfParse: jest.fn().mockResolvedValue({ text: 'Embedded worksheet text' }),
      rasterPdf,
      extractTextFromPages: ocr,
    });
    expect(text).toBe('Embedded worksheet text');
    expect(rasterPdf).not.toHaveBeenCalled();
    expect(ocr).not.toHaveBeenCalled();
  });

  test('rasterizes every scanned PDF page and preserves deterministic page order', async () => {
    const observedPages = [];
    const text = await extractFromPDF(Buffer.from('pdf'), {
      pdfParse: jest.fn().mockResolvedValue({ text: '  ' }),
      rasterPdf: jest.fn().mockResolvedValue([
        { pageNumber: 2, buffer: Buffer.from('page-2'), mime: 'image/jpeg' },
        { pageNumber: 1, buffer: Buffer.from('page-1'), mime: 'image/jpeg' },
      ]),
      extractTextFromPages: jest.fn(async (pages) => {
        observedPages.push(...pages);
        return 'First page transcription\n\nSecond page transcription';
      }),
    });
    expect(observedPages.map((page) => page.pageNumber)).toEqual([1, 2]);
    expect(observedPages.map((page) => page.buffer.toString())).toEqual(['page-1', 'page-2']);
    expect(text).toBe('First page transcription\n\nSecond page transcription');
  });

  test('maps scanned PDF OCR exhaustion to a safe PDF-specific error', async () => {
    await expect(extractFromPDF(Buffer.from('pdf'), {
      pdfParse: jest.fn().mockResolvedValue({ text: '' }),
      rasterPdf: jest.fn().mockResolvedValue([{ pageNumber: 1, buffer: Buffer.from('page') }]),
      extractTextFromPages: jest.fn().mockRejectedValue(
        new WorksheetOcrError('WORKSHEET_OCR_FAILED', 'private provider failure')
      ),
    })).rejects.toMatchObject({ code: 'WORKSHEET_OCR_FAILED', userMessage: SAFE_PDF_OCR_MESSAGE });
  });

  test('keeps TXT and DOCX extraction behavior intact', async () => {
    await expect(extractContent(Buffer.from('Plain worksheet text'), 'text/plain', 'work.txt'))
      .resolves.toBe('Plain worksheet text');
    jest.spyOn(mammoth, 'extractRawText').mockResolvedValue({ value: 'DOCX worksheet text' });
    await expect(extractContent(Buffer.from('docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'work.docx'))
      .resolves.toBe('DOCX worksheet text');
  });

  test('retains file-size and type validation', () => {
    expect(validateFile({ originalname: 'large.pdf', mimetype: 'application/pdf', size: 11 * 1024 * 1024 }))
      .toMatchObject({ valid: false });
    expect(validateFile({ originalname: 'unsafe.exe', mimetype: 'application/octet-stream', size: 10 }))
      .toMatchObject({ valid: false });
  });

  test('image extraction passes the uploaded MIME type to OCR', async () => {
    const ocr = jest.fn().mockResolvedValue('Readable worksheet image');
    await extractFromImage(Buffer.from('png'), { mimeType: 'image/png', extractTextFromPages: ocr });
    expect(ocr.mock.calls[0][0][0]).toMatchObject({ pageNumber: 1, mimeType: 'image/png' });
  });
});
