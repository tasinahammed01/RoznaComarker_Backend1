'use strict';
// Dataset loader tests. They build throwaway folders in the OS temp directory (outside the repository)
// from synthetic bytes; no real photos or ground truth are involved.
const fs = require('fs');
const os = require('os');
const path = require('path');
const dataset = require('../scripts/ocr-eval/lib/dataset.cjs');

let dir;
const put = (name, content = 'x') => fs.writeFileSync(path.join(dir, name), content);
const pair = (name, ext = '.jpeg', text = 'some handwriting') => { put(name + ext, 'not-a-real-image'); put(`${name}.txt`, text); };
const listing = () => fs.readdirSync(dir).sort();
const names = () => dataset.loadDataset(dir).items.map(i => i.name);

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-eval-dataset-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('naturalCompare', () => {
  test('orders numbers by value, so image2 comes before image10', () => {
    expect(['image10', 'image2', 'image1'].sort(dataset.naturalCompare)).toEqual(['image1', 'image2', 'image10']);
  });
  test('is deterministic for names that only differ by case or zero padding', () => {
    expect(['b', 'B', 'a'].sort(dataset.naturalCompare)).toEqual(['a', 'B', 'b']);
    expect(dataset.naturalCompare('image01', 'image1')).not.toBe(0);
  });
});

describe('resolveEvalDir', () => {
  test('requires OCR_EVAL_DIR', () => {
    expect(() => dataset.resolveEvalDir({})).toThrow(dataset.DatasetError);
    expect(() => dataset.resolveEvalDir({ OCR_EVAL_DIR: '   ' })).toThrow(/OCR_EVAL_DIR is not set/);
  });
  test('returns an absolute path', () => {
    expect(path.isAbsolute(dataset.resolveEvalDir({ OCR_EVAL_DIR: dir }))).toBe(true);
  });
});

describe('loadDataset', () => {
  test('accepts image1.jpeg ... image10.jpeg with matching .txt, sorted naturally', () => {
    for (let n = 10; n >= 1; n--) pair(`image${n}`);
    expect(names()).toEqual(['image1', 'image2', 'image3', 'image4', 'image5', 'image6', 'image7', 'image8', 'image9', 'image10']);
  });
  test('accepts .jpg, .jpeg and .png in any letter case, and any base name', () => {
    pair('essay-a', '.jpg'); pair('Scan_B', '.PNG'); pair('page.3', '.JpEg');
    const { items } = dataset.loadDataset(dir);
    expect(items.map(i => [i.name, i.imageExtension])).toEqual([['essay-a', '.jpg'], ['page.3', '.jpeg'], ['Scan_B', '.png']]);
  });
  test('reads the ground truth without a BOM and keeps its line breaks', () => {
    put('image1.jpeg'); put('image1.txt', '﻿first line\r\nsecond line');
    expect(dataset.loadDataset(dir).items[0].groundTruth).toBe('first line\r\nsecond line');
  });
  test('loads an optional mistakes sidecar', () => {
    pair('image1'); put('image1.mistakes.tsv', '# note\npowerfull\tpowerful\n');
    const [item] = dataset.loadDataset(dir).items;
    expect(item.mistakes.entries.map(e => [e.student, e.correct])).toEqual([['powerfull', 'powerful']]);
    expect(item.mistakesPath).toBe(path.join(dir, 'image1.mistakes.tsv'));
  });
  test('an item without a sidecar has mistakes = null (metric unavailable, not zero)', () => {
    pair('image1');
    expect(dataset.loadDataset(dir).items[0].mistakes).toBeNull();
  });
  test('skips an image without ground truth and an orphan .txt, with warnings', () => {
    pair('image1'); put('image2.jpeg'); put('image3.txt', 'orphan');
    const result = dataset.loadDataset(dir);
    expect(result.items.map(i => i.name)).toEqual(['image1']);
    expect(result.warnings.some(w => w.includes('image2.jpeg') && w.includes('no matching image2.txt'))).toBe(true);
    expect(result.warnings.some(w => w.includes('image3.txt') && w.includes('no matching image'))).toBe(true);
  });
  test('warns about a sidecar with no matching image', () => {
    pair('image1'); put('image9.mistakes.tsv', 'a\tb\n');
    expect(dataset.loadDataset(dir).warnings.some(w => w.includes('image9.mistakes.tsv'))).toBe(true);
  });
  test('ignores hidden files, sub-folders and unrelated files; a sidecar is never mistaken for ground truth', () => {
    pair('image1'); put('._image1.jpeg'); put('notes.md'); put('image1.mistakes.tsv', 'a\tb\n'); fs.mkdirSync(path.join(dir, 'results'));
    put(path.join('results', 'image7.jpeg'));
    expect(names()).toEqual(['image1']);
  });
  test('two images with the same name are ambiguous and rejected', () => {
    pair('image1', '.jpg'); put('image1.png');
    expect(() => dataset.loadDataset(dir)).toThrow(dataset.DatasetError);
    expect(() => dataset.loadDataset(dir)).toThrow(/image1: more than one image/);
  });
  test('empty ground truth is rejected', () => {
    put('image1.jpeg'); put('image1.txt', '  \n ');
    expect(() => dataset.loadDataset(dir)).toThrow(/image1\.txt: ground truth is empty/);
  });
  test('a malformed mistakes line is rejected with file and line number', () => {
    pair('image1'); put('image1.mistakes.tsv', 'ok\tfine\nbroken line\n');
    expect(() => dataset.loadDataset(dir)).toThrow(/image1\.mistakes\.tsv line 2/);
  });
  test('reports every problem at once', () => {
    pair('image1'); put('image1.mistakes.tsv', 'x\n'); put('image2.jpeg'); put('image2.txt', '');
    try { dataset.loadDataset(dir); throw new Error('expected failure'); } catch (error) {
      expect(error).toBeInstanceOf(dataset.DatasetError);
      expect(error.problems).toHaveLength(2);
    }
  });
  test('warns when ground truth is not valid UTF-8', () => {
    put('image1.jpeg'); fs.writeFileSync(path.join(dir, 'image1.txt'), Buffer.from([0x68, 0x69, 0xff, 0x20, 0x74, 0x68, 0x65, 0x72, 0x65]));
    expect(dataset.loadDataset(dir).warnings.some(w => w.includes('image1.txt') && w.includes('UTF-8'))).toBe(true);
  });
  test('warns about images over the size limit but still lists them', () => {
    pair('image1');
    const result = dataset.loadDataset(dir, { maxImageBytes: 4 });
    expect(result.items).toHaveLength(1);
    expect(result.warnings.some(w => w.includes('image1.jpeg') && w.includes('production limit'))).toBe(true);
  });
  test('fails clearly for an empty folder, a folder without pairs, a missing folder and a file', () => {
    expect(() => dataset.loadDataset(dir)).toThrow(/No usable image \+ \.txt pairs/);
    put('image1.jpeg');
    expect(() => dataset.loadDataset(dir)).toThrow(/No usable image \+ \.txt pairs/);
    expect(() => dataset.loadDataset(path.join(dir, 'missing'))).toThrow(/Folder not found/);
    expect(() => dataset.loadDataset(path.join(dir, 'image1.jpeg'))).toThrow(/Not a folder/);
  });
});

describe('read-only guarantees', () => {
  test('loading creates, changes and copies nothing', () => {
    pair('image1'); pair('image2', '.png'); put('image1.mistakes.tsv', 'a\tb\n');
    const before = listing(), contents = Object.fromEntries(before.map(f => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
    dataset.loadDataset(dir);
    expect(listing()).toEqual(before);
    for (const f of before) expect(fs.readFileSync(path.join(dir, f), 'utf8')).toBe(contents[f]);
  });
  test('every path points inside the given folder, and image bytes are only read on request', () => {
    pair('image1');
    const [item] = dataset.loadDataset(dir).items;
    for (const p of [item.imagePath, item.groundTruthPath]) expect(dataset.isInsideDirectory(p, dir)).toBe(true);
    expect(item.imageBytes).toBe('not-a-real-image'.length);
    expect(dataset.readImageBytes(item).toString()).toBe('not-a-real-image');
  });
  test('the temp folder is not flagged as being inside the repository', () => {
    pair('image1');
    expect(dataset.loadDataset(dir).warnings.some(w => w.includes('inside the repository'))).toBe(false);
  });
  test('isInsideDirectory recognises folders under the backend directory', () => {
    const backend = path.resolve(__dirname, '..');
    expect(dataset.isInsideDirectory(path.join(backend, 'tmp', 'x'), backend)).toBe(true);
    expect(dataset.isInsideDirectory(backend, backend)).toBe(true);
    expect(dataset.isInsideDirectory(path.join(backend, '..', 'elsewhere'), backend)).toBe(false);
    expect(dataset.isInsideDirectory(path.join(os.tmpdir(), 'x'), backend)).toBe(false);
  });
});
