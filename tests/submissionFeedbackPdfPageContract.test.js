'use strict';

const { PDFDocument, degrees } = require('pdf-lib');
const { assertUniformA4Portrait } = require('../src/modules/submissionFeedbackPdfGenerator');

describe('submission feedback PDF page contract', () => {
  test('accepts uniform A4 portrait pages', async () => {
    const document = await PDFDocument.create();
    document.addPage([595.28, 841.89]);
    document.addPage([595.28, 841.89]);
    expect(() => assertUniformA4Portrait(document)).not.toThrow();
  });

  test('rejects landscape dimensions and page rotation', async () => {
    const landscape = await PDFDocument.create();
    landscape.addPage([841.89, 595.28]);
    expect(() => assertUniformA4Portrait(landscape)).toThrow(/not A4 portrait/);

    const rotated = await PDFDocument.create();
    const page = rotated.addPage([595.28, 841.89]);
    page.setRotation(degrees(90));
    expect(() => assertUniformA4Portrait(rotated)).toThrow(/not A4 portrait/);
  });
});
