'use strict';

const mammoth = require('mammoth');
const JSZip = require('jszip');
const {
  WorksheetOcrError,
  googleOcrPages,
  extractTextFromPages,
} = require('../src/services/worksheetOcr.service');
const {
  extractContent,
  extractFromPDF,
  extractFromImage,
  extractDocumentContent,
  normalizedDocxFromHtml,
  validateFile,
  SAFE_PDF_OCR_MESSAGE,
} = require('../src/services/fileContentExtractor.service');

async function docxFixture(documentBody) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.folder('_rels').file('.rels', `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.folder('word').file('document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${documentBody}</w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

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
    jest.spyOn(mammoth, 'convertToHtml').mockResolvedValue({ value: '<p>DOCX worksheet text</p>' });
    await expect(extractContent(Buffer.from('docx'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'work.docx'))
      .resolves.toBe('DOCX worksheet text');
  });

  test('extracts a real DOCX fixture while preserving paragraph order', async () => {
    const buffer = await docxFixture('<w:p><w:r><w:t>Spelling Rules</w:t></w:r></w:p><w:p><w:r><w:t>1. Add the suffix.</w:t></w:r></w:p><w:p><w:r><w:t>hope ______</w:t></w:r></w:p>');
    const result = await extractDocumentContent(buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Spelling Rules.docx');
    expect(result.plainText).toContain('Spelling Rules');
    expect(result.plainText.indexOf('1. Add')).toBeLessThan(result.plainText.indexOf('hope ______'));
  });

  test('preserves headings, numbered lists, MCQ choices, blanks, answer keys and table cells', () => {
    const result = normalizedDocxFromHtml(`<h1>Spelling Rules</h1><p>Choose the answer.</p>
      <ol><li>Which spelling is correct?<ul><li>A) hoping</li><li>B) hopeing</li></ul></li></ol>
      <p>Complete: hope ______</p><table><tr><th>No</th><th>Question</th><th>Answer</th></tr>
      <tr><td>1</td><td>True or false: drop final e.</td><td>True</td></tr></table><h2>Answer Key</h2><p>1. A</p>`);
    expect(result.plainText).toContain('[HEADING 1] Spelling Rules');
    expect(result.plainText).toContain('1. Which spelling is correct?');
    expect(result.plainText).toContain('A) hoping');
    expect(result.plainText).toContain('hope ______');
    expect(result.plainText).toContain('Question: True or false: drop final e.');
    expect(result.plainText).toContain('[HEADING 2] Answer Key');
    expect(result.stats.tables).toBe(1);
  });

  test('returns controlled failures for corrupt and mostly empty DOCX files', async () => {
    await expect(extractDocumentContent(Buffer.from('not a zip'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'broken.docx'))
      .rejects.toMatchObject({ code: 'WORKSHEET_DOCX_PARSE_FAILED' });
    const empty = await docxFixture('<w:p><w:r><w:t> </w:t></w:r></w:p>');
    await expect(extractDocumentContent(empty,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'empty.docx'))
      .rejects.toMatchObject({ code: 'WORKSHEET_DOCX_TEXT_EMPTY' });
  });

  test('does not claim legacy binary DOC is supported by the DOCX parser', () => {
    expect(validateFile({ originalname: 'legacy.doc', mimetype: 'application/msword', size: 100 }))
      .toMatchObject({ valid: false });
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
