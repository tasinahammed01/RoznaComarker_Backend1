'use strict';
// Plain-text extraction for reference files: PDF (pdf-parse), DOCX (mammoth), DOC (word-extractor), PPTX (slide XML). Runs inside the extraction
// worker (extract.worker.js); call runExtraction (extractRunner.js), not this module, from request or job code. The bytes are checked again here
// (signature, macros, password, archive limits) so the worker never trusts a stored file it did not check itself.
const path = require('path');
const { LIMITS, ReferenceFileError, INVISIBLE, CONTROL } = require('./policy');
const { checkContent } = require('./fileCheck');
const { readEntry } = require('./zipArchive');

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/giu, (whole, name) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()];
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

/** The text of one slide: each <a:p> paragraph on its own line, its <a:t> runs joined. */
function slideText(xml) {
  const paragraphs = [];
  for (const paragraph of xml.match(/<a:p[\s>][\s\S]*?<\/a:p>/gu) || []) {
    const runs = [...paragraph.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gu)].map(match => decodeXml(match[1]));
    if (runs.length) paragraphs.push(runs.join(''));
  }
  return paragraphs.join('\n');
}

async function pptxText(buffer) {
  const { zip, entries } = await checkContent(buffer, 'pptx');
  try {
    const slides = entries.map(item => ({ item, number: Number(/^ppt\/slides\/slide(\d+)\.xml$/u.exec(item.name)?.[1]) }))
      .filter(slide => Number.isInteger(slide.number)).sort((a, b) => a.number - b.number);
    const texts = [];
    for (const slide of slides) texts.push(slideText((await readEntry(zip, slide.item)).toString('utf8')));
    return { text: texts.filter(Boolean).join('\n\n'), units: slides.length };
  } finally { zip.close(); }
}

async function docxText(buffer) {
  const { zip } = await checkContent(buffer, 'docx');
  zip.close();
  const mammoth = require('mammoth');
  try { return { text: (await mammoth.extractRawText({ buffer })).value || '', units: null }; } catch { throw new ReferenceFileError('REFERENCE_FILE_CORRUPT'); }
}

async function docText(buffer) {
  await checkContent(buffer, 'doc');
  const WordExtractor = require('word-extractor');
  try { return { text: (await new WordExtractor().extract(buffer)).getBody() || '', units: null }; } catch { throw new ReferenceFileError('REFERENCE_FILE_CORRUPT'); }
}

const MAX_PDF_PAGES = 300;
// pdfjs-dist (already used for PDF rasterizing), not pdf-parse 1.1.1: its bundled 2017 pdf.js rejects valid modern PDFs ("bad XRef entry").
// isEvalSupported:false as in rasterPdf: pdfjs-dist 3.x can run code from a crafted font otherwise (CVE-2024-4367).
async function pdfText(buffer) {
  await checkContent(buffer, 'pdf');
  const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
  const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true, isEvalSupported: false, disableFontFace: true,
    useSystemFonts: false, verbosity: 0, cMapUrl: path.join(root, 'cmaps') + path.sep, cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts') + path.sep });
  let document;
  try { document = await task.promise; } catch (error) {
    throw new ReferenceFileError(error?.name === 'PasswordException' ? 'REFERENCE_FILE_PASSWORD' : 'REFERENCE_FILE_CORRUPT');
  }
  try {
    const pages = [];
    for (let number = 1; number <= Math.min(document.numPages, MAX_PDF_PAGES); number += 1) {
      const content = await (await document.getPage(number)).getTextContent();
      pages.push(content.items.map(item => `${item.str || ''}${item.hasEOL ? '\n' : ''}`).join(''));
    }
    return { text: pages.join('\n\n'), units: document.numPages };
  } catch { throw new ReferenceFileError('REFERENCE_FILE_CORRUPT'); } finally { await document.destroy().catch(() => {}); }
}

/**
 * Plain text for storage: NFC, no control or invisible/direction characters, single spaces, at most one blank line in a row, capped at
 * maxChars on a word boundary. Returns { text, truncated }.
 */
function normalizeReferenceText(raw, maxChars = LIMITS.maxStoredTextChars) {
  let text = String(raw || '').normalize('NFC').replace(/\r\n?/gu, '\n').replace(/[\t\u00a0\u2000-\u200a\u202f\u205f\u3000]/gu, ' ')
    .replace(INVISIBLE, '').replace(CONTROL, '').replace(/[\u2028\u2029]/gu, '\n')
    .split('\n').map(line => line.replace(/ {2,}/gu, ' ').trim()).join('\n').replace(/\n{3,}/gu, '\n\n').trim();
  const truncated = text.length > maxChars;
  if (truncated) {
    const cut = text.slice(0, maxChars);
    // Already at a word end when the next character is a space or line break; otherwise go back to the last one, if it is near the cap.
    const boundary = /\s/u.test(text[maxChars]) ? maxChars : Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
    text = (boundary > maxChars * 0.9 ? cut.slice(0, boundary) : cut).trim();
    if (/[\ud800-\udbff]$/u.test(text)) text = text.slice(0, -1);
  }
  return { text, truncated };
}

const EXTRACTORS = { pdf: pdfText, docx: docxText, doc: docText, pptx: pptxText };

/** { text, truncated, chars, units } for a checked kind. Throws ReferenceFileError (NO_TEXT_PDF for a PDF without a text layer). */
async function extractText(buffer, kind) {
  const extractor = EXTRACTORS[kind];
  if (!extractor) throw new ReferenceFileError('REFERENCE_FILE_TYPE');
  const raw = await extractor(buffer);
  const { text, truncated } = normalizeReferenceText(raw.text);
  if ((text.match(/\p{L}/gu) || []).length < LIMITS.minReadableLetters)
    throw new ReferenceFileError(kind === 'pdf' ? 'REFERENCE_FILE_NO_TEXT_PDF' : 'REFERENCE_FILE_NO_TEXT');
  return { text, truncated, chars: text.length, units: raw.units };
}

module.exports = { extractText, normalizeReferenceText, slideText, decodeXml };
