'use strict';
// Synthetic reference files for tests: real PDF (pdfkit), DOCX/PPTX (jszip) and Word 97 .doc (cfb) bytes built in memory. No real teacher files.
const JSZip = require('jszip');
const CFB = require('cfb');
const PDFDocument = require('pdfkit');

const CONTENT_TYPES = {
  docx: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  pptx: '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>'
};
const RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const esc = text => text.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

async function zipOf(files, compression = 'DEFLATE') {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return zip.generateAsync({ type: 'nodebuffer', compression });
}

function docx(paragraphs, { contentTypes = CONTENT_TYPES.docx, extra = {} } = {}) {
  const body = paragraphs.map(text => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`).join('');
  return zipOf({ '[Content_Types].xml': contentTypes, '_rels/.rels': RELS,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    ...extra });
}

/** slides: { [number]: [paragraph, ...] } so the order of slide numbers in the archive can be tested. */
function pptx(slides, { contentTypes = CONTENT_TYPES.pptx, extra = {} } = {}) {
  const files = { '[Content_Types].xml': contentTypes, 'ppt/presentation.xml': '<?xml version="1.0"?><p:presentation xmlns:p="p"/>', ...extra };
  for (const [number, paragraphs] of Object.entries(slides)) {
    files[`ppt/slides/slide${number}.xml`] = '<?xml version="1.0"?><p:sld xmlns:a="a" xmlns:p="p"><p:cSld><p:spTree>'
      + paragraphs.map(p => `<a:p>${(Array.isArray(p) ? p : [p]).map(run => `<a:r><a:t>${esc(run)}</a:t></a:r>`).join('')}</a:p>`).join('')
      + '</p:spTree></p:cSld></p:sld>';
  }
  return zipOf(files);
}

/** A minimal Word 97 binary: FIB + one Unicode piece. flags 0x0200 = 1Table; 0x0100 = encrypted. */
function doc(text, { flags = 0x0200, extra = {} } = {}) {
  const fib = Buffer.alloc(0x800);
  fib.writeUInt16LE(0xa5ec, 0); fib.writeUInt16LE(flags, 0x0a);
  fib.writeUInt32LE(0x800, 0x18); fib.writeUInt32LE(text.length, 0x4c);
  const word = Buffer.concat([fib, Buffer.from(text, 'utf16le')]);
  const clx = Buffer.alloc(1 + 4 + 8 + 8);
  clx.writeUInt8(2, 0); clx.writeUInt32LE(16, 1); clx.writeUInt32LE(0, 5); clx.writeUInt32LE(text.length, 9);
  clx.writeUInt16LE(0, 13); clx.writeUInt32LE(0x800, 15);
  word.writeUInt32LE(0, 0x1a2); word.writeUInt32LE(clx.length, 0x1a6);
  return ole({ WordDocument: word, '1Table': clx, ...extra });
}

function ole(streams) {
  const container = CFB.utils.cfb_new();
  for (const [name, content] of Object.entries(streams)) CFB.utils.cfb_add(container, `/${name}`, content);
  return Buffer.from(CFB.write(container, { type: 'buffer' }));
}

function pdf(lines, { userPassword } = {}) {
  return new Promise((resolve, reject) => {
    const document = new PDFDocument(userPassword ? { userPassword, pdfVersion: '1.4' } : {});
    const chunks = [];
    document.on('data', chunk => chunks.push(chunk)); document.on('end', () => resolve(Buffer.concat(chunks))); document.on('error', reject);
    if (lines.length) lines.forEach(line => document.text(line)); else document.rect(50, 50, 200, 200).fill('#333333');
    document.end();
  });
}

/** Rewrites a central-directory field of one entry (sizes are what the archive declares, not what it holds). */
function patchCentral(buffer, name, { uncompressedSize, compressedSize }) {
  const out = Buffer.from(buffer);
  for (let offset = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); offset >= 0; offset = out.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4)) {
    const nameLength = out.readUInt16LE(offset + 28);
    if (out.toString('utf8', offset + 46, offset + 46 + nameLength) !== name) continue;
    if (uncompressedSize != null) out.writeUInt32LE(uncompressedSize, offset + 24);
    if (compressedSize != null) out.writeUInt32LE(compressedSize, offset + 20);
    return out;
  }
  throw new Error(`entry ${name} not found`);
}

module.exports = { docx, pptx, doc, ole, pdf, zipOf, patchCentral, CONTENT_TYPES };
