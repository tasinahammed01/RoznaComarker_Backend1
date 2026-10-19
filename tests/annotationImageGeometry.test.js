jest.mock('fs', () => ({ promises: { readFile: jest.fn() } }));
jest.mock('image-size', () => jest.fn());
const fs = require('fs');
const sizeOf = require('image-size');
const { annotationImageGeometry } = require('../src/services/annotationImageGeometry.service');
const page = { fileId: 'source-file', pageNumber: 1, width: 1600, height: 1200 };
describe('read-only annotation image geometry', () => {
  beforeEach(() => { jest.resetAllMocks(); fs.promises.readFile.mockResolvedValue(Buffer.from('fixture')); });
  test.each([1, 3, 6, 8])('exposes existing EXIF %s without touching OCR geometry', async orientation => {
    sizeOf.mockReturnValue({ type: 'jpg', width: 1600, height: 1200, orientation });
    const before = JSON.stringify(page), loadFile = jest.fn().mockResolvedValue({ path: 'uploads/source.jpg' });
    const result = await annotationImageGeometry(page, loadFile);
    expect(result).toEqual({ version: 1, fileId: 'source-file', pageNumber: 1, width: 1600, height: 1200,
      orientation, coordinateSpace: 'encoded-image', ambiguous: orientation === 3 });
    expect(JSON.stringify(page)).toBe(before); expect(loadFile).toHaveBeenCalledTimes(1);
  });
  test('retains identity for PNG and explicitly oriented legacy pages', async () => {
    sizeOf.mockReturnValue({ type: 'png', width: 1600, height: 1200 });
    const loadFile = async () => ({ path: 'uploads/source.png' });
    expect((await annotationImageGeometry(page, loadFile)).orientation).toBe(1);
    expect((await annotationImageGeometry({ ...page, coordinateSpace: 'display-image' }, loadFile)).coordinateSpace).toBe('display-image');
  });
  test('does not guess for missing dimensions, PDF rasters, changed source dimensions or unavailable files', async () => {
    const loadFile = jest.fn().mockResolvedValue({ path: 'uploads/source.jpg' });
    expect(await annotationImageGeometry({ ...page, width: undefined }, loadFile)).toBeUndefined();
    expect(await annotationImageGeometry({ ...page, derivedImageFileId: 'raster', rasterizationVersion: 'v1' }, loadFile)).toMatchObject({ coordinateSpace: 'display-image', ambiguous: false });
    expect(loadFile).not.toHaveBeenCalled();
    sizeOf.mockReturnValue({ type: 'jpg', width: 1200, height: 1600, orientation: 6 });
    expect(await annotationImageGeometry(page, loadFile)).toMatchObject({ coordinateSpace: 'display-image', ambiguous: false });
    expect(await annotationImageGeometry(page, async () => null)).toMatchObject({ ambiguous: true });
    expect(await annotationImageGeometry(page, async () => { throw Error('unavailable'); })).toMatchObject({ ambiguous: true });
  });
  test('rejects unsupported orientation and paths outside the backend root', async () => {
    sizeOf.mockReturnValue({ type: 'jpg', width: 1600, height: 1200, orientation: 2 });
    expect(await annotationImageGeometry(page, async () => ({ path: 'uploads/source.jpg' }))).toMatchObject({ ambiguous: true });
    fs.promises.readFile.mockClear();
    expect(await annotationImageGeometry(page, async () => ({ path: '../outside.jpg' }))).toMatchObject({ ambiguous: true });
    expect(fs.promises.readFile).not.toHaveBeenCalled();
  });
  test('EXIF-3 is projected only when a persisted encoded coordinate space proves its axes', async () => {
    sizeOf.mockReturnValue({ type: 'jpg', width: 1600, height: 1200, orientation: 3 });
    const load = async () => ({ path: 'uploads/source.jpg' });
    expect((await annotationImageGeometry(page, load)).ambiguous).toBe(true);
    expect((await annotationImageGeometry({ ...page, coordinateSpace: 'encoded-image' }, load)).ambiguous).toBe(false);
    const { decidePage } = require('../scripts/backfillOcrCoordinateSpace');
    expect(await decidePage(page, load)).toMatchObject({ action: 'review' });
    sizeOf.mockReturnValue({ type: 'png', width: 1600, height: 1200, orientation: 1 });
    expect(await decidePage(page, load)).toMatchObject({ action: 'set' });
  });
});
