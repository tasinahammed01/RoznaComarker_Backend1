'use strict';
const mockWorkers = [];
jest.mock('worker_threads', () => ({ Worker: jest.fn().mockImplementation(() => {
  const worker = new (require('events').EventEmitter)();
  worker.terminate = jest.fn(async () => 0); mockWorkers.push(worker); return worker;
}) }));
const { rasterize } = require('../src/services/pdfSubmissionPages.service');
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
describe('bounded PDF raster worker', () => {
  beforeEach(() => { jest.useFakeTimers(); mockWorkers.length = 0; });
  afterEach(() => jest.useRealTimers());
  test('terminates timed out work and releases the serial queue', async () => {
    const first = rasterize(Buffer.from('one'));
    const rejected = expect(first).rejects.toMatchObject({ code: 'OCR_PDF_TIMEOUT', retryable: true });
    const second = rasterize(Buffer.from('two'));
    await flush(); expect(mockWorkers).toHaveLength(1);
    jest.advanceTimersByTime(90000); await rejected; await flush();
    expect(mockWorkers[0].terminate).toHaveBeenCalled(); expect(mockWorkers).toHaveLength(2);
    mockWorkers[1].emit('message', { pages: [{ buffer: Buffer.from('page'), pageNumber: 1 }] });
    expect(await second).toHaveLength(1);
  });
  test('worker crash becomes a retryable safe error', async () => {
    const pending = rasterize(Buffer.from('pdf'));
    const rejected = expect(pending).rejects.toMatchObject({ code: 'OCR_PDF_RASTER_FAILED', retryable: true });
    await flush(); mockWorkers[0].emit('error', new Error('private parser detail'));
    await rejected; expect(mockWorkers[0].terminate).toHaveBeenCalled();
  });
  test('expires queued work and skips its worker after the queue drains', async () => {
    const first = rasterize(Buffer.from('one'));
    const firstRejected = expect(first).rejects.toMatchObject({ code: 'OCR_PDF_TIMEOUT' });
    const second = rasterize(Buffer.from('two'));
    const third = rasterize(Buffer.from('three'));
    const thirdRejected = expect(third).rejects.toMatchObject({ code: 'OCR_PDF_BUSY', retryable: true });
    await flush(); jest.advanceTimersByTime(90000); await firstRejected; await flush();
    jest.advanceTimersByTime(30000); await thirdRejected;
    mockWorkers[1].emit('message', { pages: [] }); await second; await flush();
    expect(mockWorkers).toHaveLength(2);
  });
});
