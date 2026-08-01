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

    const pending = runOcrAndPersistForFiles({ fileIds: ['first', 'second'], targetDoc, jobId: 'job' });
    await Promise.resolve(); await Promise.resolve();
    second.resolve(result('Continuation page'));
    await Promise.resolve();
    first.resolve(result('Introduction page'));
    await pending;

    expect(targetDoc.ocrPages.map((page) => ({ fileId: page.fileId, fileOrder: page.fileOrder, pageIndex: page.pageIndex })))
      .toEqual([{ fileId: 'first', fileOrder: 0, pageIndex: 0 }, { fileId: 'second', fileOrder: 1, pageIndex: 0 }]);
    expect(targetDoc.combinedOcrText).toBe('Introduction page\n\nContinuation page');
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(1);
  });
});
