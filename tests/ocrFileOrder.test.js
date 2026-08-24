'use strict';

jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('../src/models/File', () => ({ findById: jest.fn() }));
jest.mock('../src/models/assignment.model', () => ({ findById: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn(async () => {}) }));

const File = require('../src/models/File');
const vision = require('../src/services/visionOcr.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { runOcrAndPersistForFiles } = require('../src/services/ocrPipeline.service');

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const result = (text) => ({ transcriptText: text, fullText: text, words: [],
  pages: [{ pageNumber: 1, words: [] }] });

describe('OCR authoritative upload order', () => {
  test('reverse provider completion cannot reverse persisted files or pages', async () => {
    const first = deferred(); const second = deferred();
    File.findById.mockImplementation(async (id) => ({ _id: id, path: `${id}.jpg` }));
    vision.extractOcrFromImageFile.mockImplementation((path) => path.endsWith('first.jpg') ? first.promise : second.promise);
    const updateOne = jest.fn(async (_query, update) => {
      if (update?.$set) Object.assign(targetDoc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    });
    const targetDoc = { _id: 'submission', assignment: null, ocrJobId: 'job',
      constructor: { exists: jest.fn(async () => true), updateOne },
      toObject() { const { constructor, toObject, ...values } = this; return values; } };

    const assignmentContext = { title: 'Essay', rubric: { criteria: [] } };
    const pending = runOcrAndPersistForFiles({ fileIds: ['first', 'second'], targetDoc, jobId: 'job', assignmentContext });
    await Promise.resolve(); await Promise.resolve();
    second.resolve(result('Continuation page'));
    await Promise.resolve();
    first.resolve(result('Introduction page'));
    await pending;

    expect(targetDoc.ocrPages.map((page) => ({ fileId: page.fileId, fileOrder: page.fileOrder, pageIndex: page.pageIndex })))
      .toEqual([{ fileId: 'first', fileOrder: 0, pageIndex: 0 }, { fileId: 'second', fileOrder: 1, pageIndex: 0 }]);
    expect(targetDoc.combinedOcrText).toBe('Introduction page\n\nContinuation page');
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(1);
    expect(pipeline.generateAndPersist).toHaveBeenLastCalledWith(targetDoc, { assignment: assignmentContext });
  });

  test('persists native full text instead of corrupted word reconstruction', async () => {
    const before = pipeline.generateAndPersist.mock.calls.length;
    File.findById.mockResolvedValue({ _id: 'photo', path: 'photo.jpg' });
    vision.extractOcrFromImageFile.mockResolvedValue({
      fullText: 'Another feature to compare between private cars and taking taxis is the comfort.',
      transcriptText: 'take Another with taxis feature own the cars comfort',
      words: [], pages: [{ pageNumber: 1, words: [] }]
    });
    const targetDoc = { _id: 'native-order', assignment: null, ocrJobId: 'job-native',
      constructor: { exists: jest.fn(async () => true), updateOne: jest.fn(async (_query, update) => {
        if (update?.$set) Object.assign(targetDoc, update.$set); return { matchedCount: 1, modifiedCount: 1 };
      }) }, toObject() { const { constructor, toObject, ...values } = this; return values; } };
    await runOcrAndPersistForFiles({ fileIds: ['photo'], targetDoc, jobId: 'job-native' });
    expect(targetDoc.ocrPages[0].text).toBe('Another feature to compare between private cars and taking taxis is the comfort.');
    expect(targetDoc.combinedOcrText).toBe(targetDoc.ocrPages[0].text);
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(before + 1);
  });

  test('quality gate stops analysis when OCR words cannot align to native text', async () => {
    File.findById.mockResolvedValue({ _id: 'bad', path: 'bad.jpg' });
    const words = Array.from({ length: 10 }, (_, index) => ({ text: `unmapped${index}`, page: 1,
      bbox: { x: index, y: 1, w: 1, h: 1 } }));
    vision.extractOcrFromImageFile.mockResolvedValue({ fullText: 'This photographed paragraph has a stable readable order.',
      transcriptText: 'unmapped word bag', words, pages: [{ pageNumber: 1, words }] });
    const targetDoc = { _id: 'bad-order', assignment: null, ocrJobId: 'job-bad',
      constructor: { exists: jest.fn(async () => true), updateOne: jest.fn(async (_query, update) => {
        if (update?.$set) Object.assign(targetDoc, update.$set); return { matchedCount: 1, modifiedCount: 1 };
      }) }, toObject() { const { constructor, toObject, ...values } = this; return values; } };
    const before = pipeline.generateAndPersist.mock.calls.length;
    const resultValue = await runOcrAndPersistForFiles({ fileIds: ['bad'], targetDoc, jobId: 'job-bad' });
    expect(resultValue).toMatchObject({ ocrStatus: 'failed' });
    expect(targetDoc.ocrError).toContain('OCR_READING_ORDER_UNRELIABLE');
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(before);
  });
});
