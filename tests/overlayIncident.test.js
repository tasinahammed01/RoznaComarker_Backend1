'use strict';
const mockDetection = jest.fn();
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockDetection })) }));
const sharp = require('sharp'); const fs = require('fs/promises'); const path = require('path'); const crypto = require('crypto');
const { extractOcrFromImageFile } = require('../src/services/visionOcr.service');
const { annotationImageGeometry } = require('../src/services/annotationImageGeometry.service');
const { buildCanonicalCorrectionRenderModels } = require('../src/services/canonicalCorrectionRender.service');
const { buildCanonicalSubmissionTranscript, CANONICAL_TRANSCRIPT_LAYOUT_VERSION } = require('../src/utils/ocrTranscriptNormalizer');
const { normalizeOcrWordsFromStored } = require('../src/services/ocrCorrections.service');
const { canonicalOcrWordId } = require('../src/utils/ocrWordIdentity');
let folder;
beforeAll(async () => { await fs.mkdir(path.resolve(__dirname, '../tmp'), { recursive: true }); folder = await fs.mkdtemp(path.resolve(__dirname, '../tmp/overlay-incident-')); });
afterAll(async () => { for (const name of await fs.readdir(folder)) await fs.unlink(path.join(folder, name)); await fs.rmdir(folder); });
beforeEach(() => {
  mockDetection.mockReset().mockImplementation(async ({ image }) => {
    const content = image.content || await fs.readFile(image.source.filename);
    const m = await sharp(content).metadata();
    const width = m.width, height = m.height;
    return [{ fullTextAnnotation: { text: 'blindely', pages: [{ width: width + 11, height: height + 11,
      blocks: [{ paragraphs: [{ words: [{ symbols: [...'blindely'].map(text => ({ text })),
        boundingBox: { vertices: [{ x: width * .1, y: height * .2 }, { x: width * .25, y: height * .2 },
          { x: width * .25, y: height * .25 }, { x: width * .1, y: height * .25 }] } }] }] }] }] } }];
  });
});
for (const [width, height] of [[800, 600], [600, 800], [700, 680]]) for (const orientation of [1, 3, 6, 8]) {
  test(`normalized OCR -> render -> source geometry preserves target: EXIF ${orientation}, ${width}x${height}`, async () => {
    const absolute = path.join(folder, `${width}-${height}-${orientation}.jpg`);
    const displayWidth = [6, 8].includes(orientation) ? height : width;
    const displayHeight = [6, 8].includes(orientation) ? width : height;
    const visible = await sharp({ create: { width: displayWidth, height: displayHeight, channels: 3, background: 'white' } })
      .composite([{ input: Buffer.from(`<svg width="${displayWidth}" height="${displayHeight}"><rect x="${displayWidth * .1}" y="${displayHeight * .2}" width="${displayWidth * .15}" height="${displayHeight * .05}" fill="#00c800"/></svg>`) }]).png().toBuffer();
    await sharp(visible).rotate(({ 1: 0, 3: 180, 6: 270, 8: 90 })[orientation]).jpeg({ quality: 95 }).withMetadata({ orientation }).toFile(absolute);
    const before = crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex');
    const result = await extractOcrFromImageFile(absolute);
    expect(Buffer.isBuffer(mockDetection.mock.calls[0][0].image.content)).toBe(true);
    const image = await sharp(mockDetection.mock.calls[0][0].image.content).metadata();
    expect(image.orientation || 1).toBe(1);
    expect(image.width).toBe([6, 8].includes(orientation) ? height : width);
    const sample = await sharp(mockDetection.mock.calls[0][0].image.content)
      .extract({ left: Math.floor(image.width * .175), top: Math.floor(image.height * .225), width: 1, height: 1 }).removeAlpha().raw().toBuffer();
    expect(sample[1]).toBeGreaterThan(sample[0] + 80); expect(sample[1]).toBeGreaterThan(sample[2] + 80);
    const detected = result.pages[0];
    expect(detected.coordinateSpace).toBe('display-image');
    expect(detected.width).toBe(image.width); expect(detected.height).toBe(image.height);
    const words = detected.words.map((word, index) => ({ ...word, id: canonicalOcrWordId({ fileId: 'f', pageNumber: 1, wordIndex: index }),
      bbox: { x0: word.bbox.x, y0: word.bbox.y, x1: word.bbox.x + word.bbox.w, y1: word.bbox.y + word.bbox.h } }));
    const page = { ...detected, fileId: 'f', words };
    const submission = { files: ['f'], ocrPages: [page], correctionTranscriptLayoutVersion: CANONICAL_TRANSCRIPT_LAYOUT_VERSION };
    const canonical = buildCanonicalSubmissionTranscript(submission);
    const [correction] = buildCanonicalCorrectionRenderModels([{ fileId: 'f', page: 1, symbol: 'SP', quotedText: 'blindely', wordIds: [words[0].id] }], canonical, [page], { submission });
    expect(correction.renderTarget.wordIds).toEqual([words[0].id]);
    for (const [key, value] of Object.entries({ x: 10, y: 20, w: 15, h: 5 })) expect(Math.abs(correction.renderTarget.boxes[0][key] - value)).toBeLessThan(.5);
    const geometry = await annotationImageGeometry(page, async () => ({ path: path.relative(path.resolve(__dirname, '..'), absolute) }));
    expect(geometry.coordinateSpace).toBe('display-image'); expect(geometry.orientation).toBe(orientation);
    expect(crypto.createHash('sha256').update(await fs.readFile(absolute)).digest('hex')).toBe(before);
  });
}
const word = (id, text, x, y, paragraphIndex = 1) => ({ id, text, paragraphIndex, bbox: { x, y, w: 10, h: 4 } });
test('word IDs pointing at another paragraph never draw the misspelling there', () => {
  const page = { fileId: 'f', pageNumber: 1, words: [word('word_f_1_1', 'blindely', 10, 10), word('word_f_1_2', 'when', 60, 60, 2)] };
  const canonical = buildCanonicalSubmissionTranscript({ files: ['f'], ocrPages: [page] });
  const [rendered] = buildCanonicalCorrectionRenderModels([{ fileId: 'f', page: 1, symbol: 'SP', quotedText: 'blindely', wordIds: ['word_f_1_2'] }], canonical, [page]);
  expect(rendered.renderTarget.source).toBe('none'); expect(rendered.renderTarget.boxes).toEqual([]);
});
test('stale bbox-only coordinates are not used after layout/OCR changes', () => {
  const correction = { fileId: 'f', page: 1, symbol: 'SP', quotedText: 'missing', bboxList: [{ x: 70, y: 80, w: 10, h: 3 }] };
  const page = { fileId: 'f', pageNumber: 1, words: [word('word_f_1_1', 'essay', 10, 10)] };
  const canonical = buildCanonicalSubmissionTranscript({ files: ['f'], ocrPages: [page] });
  const [rendered] = buildCanonicalCorrectionRenderModels([correction], canonical, [page], {
    submission: { correctionTranscriptLayoutVersion: 'old-layout', ocrUpdatedAt: new Date(2000), correctionUpdatedAt: new Date(1000) } });
  expect(rendered.renderTarget.source).toBe('none');
});
test('IDs remain stable across normalization/persistence/GET with empty words removed', () => {
  const stored = [{ text: '', bbox: { x0: 0, y0: 0, x1: 1, y1: 1 } },
    { text: 'blindely', bbox: { x0: 10, y0: 20, x1: 20, y1: 25 } }];
  const canonical = buildCanonicalSubmissionTranscript({ files: ['f'], ocrPages: [{ fileId: 'f', pageNumber: 1, words: stored }] });
  const get = normalizeOcrWordsFromStored(canonical.pages[0].words, { fileId: 'f' });
  const twice = normalizeOcrWordsFromStored(canonical.pages[0].words, { fileId: 'f' });
  expect(get.map(w => w.id)).toEqual(twice.map(w => w.id));
  expect(get.map(w => w.id)).toEqual(canonical.pages[0].words.map(w => w.id));
  expect(get[0].id).toBe(canonicalOcrWordId({ fileId: 'f', pageNumber: 1, wordIndex: 1 }));
});
test('verified transcript offsets survive missing image geometry without granting marker authority', () => {
  const page = { fileId: 'f', pageNumber: 1, startChar: 16, text: 'Page two text.', words: [] };
  const correction = { fileId: 'f', page: 1, symbol: 'AGR', quotedText: 'two', startChar: 21, endChar: 24 };
  const [rendered] = buildCanonicalCorrectionRenderModels([correction], { pages: [page], wordSpans: [] });
  expect(rendered.renderTarget).toMatchObject({ source: 'none', boxes: [], textRanges: [{ start: 21, end: 24 }] });
  const [wrong] = buildCanonicalCorrectionRenderModels([{ ...correction, quotedText: 'different' }], { pages: [page], wordSpans: [] });
  expect(wrong.renderTarget.textRanges).toEqual([]);
});
test('independent stored spelling corrections remain distinct and target their own words', () => {
  const texts = ['blindely', 'blindely', 'quetioning', 'stalt', 'wherl'];
  const page = { fileId: 'f', pageNumber: 1, words: texts.map((text, index) => word(`word_f_1_${index + 1}`, text, 10, 10 + index * 15, index + 1)) };
  const canonical = buildCanonicalSubmissionTranscript({ files: ['f'], ocrPages: [page] });
  const corrections = texts.map((text, index) => ({ id: `c${index}`, symbol: 'SP', quotedText: text, fileId: 'f', page: 1, wordIds: [page.words[index].id] }));
  const rendered = buildCanonicalCorrectionRenderModels(corrections, canonical, [page]);
  expect(rendered).toHaveLength(5);
  rendered.forEach((correction, index) => expect(correction.renderTarget.boxes[0].y).toBe(10 + index * 15));
});
test('a unique same-paragraph text match without exact offsets grants no marker authority', () => {
  const page = { fileId: 'f', pageNumber: 1, words: [word('word_f_1_1', 'blindely', 10, 10), word('word_f_1_2', 'when', 60, 12)] };
  const canonical = buildCanonicalSubmissionTranscript({ files: ['f'], ocrPages: [page] });
  const correction = { symbol: 'SP', quotedText: 'blindely', fileId: 'f', page: 1, wordIds: ['word_f_1_2'] };
  const before = JSON.stringify(correction);
  const [rendered] = buildCanonicalCorrectionRenderModels([correction], canonical, [page]);
  expect(rendered.renderTarget.source).toBe('none');
  expect(JSON.stringify(correction)).toBe(before);
});
