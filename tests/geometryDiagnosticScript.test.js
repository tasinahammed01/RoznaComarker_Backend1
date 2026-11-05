'use strict';
// scripts/geometry-diagnostic.js: read-only, prints ONLY the geometry diagnostic of each page of one submission.
const mongoose = require('mongoose');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const script = () => require('../scripts/geometry-diagnostic.js');

const SECRET_TEXT = 'PRIVATE-TRANSCRIPT-WORDS about my summer';
const SECRET_NAME = 'Zed Studentname';
let id;
const page = (n, geometry, extra = {}) => ({ pageNumber: n, sourceTextExact: SECRET_TEXT, ocrText: SECRET_TEXT, words: [{ text: SECRET_TEXT, bbox: null }],
  sourceVerificationSummary: { performance: { sourceMs: 1234, model: 'x/y', ...(geometry ? { geometry } : {}) }, review: { uncertain: [{ line: 0, word: SECRET_TEXT }] } }, ...extra });

beforeAll(async () => {
  await connectInMemoryMongo();
  const result = await mongoose.connection.db.collection('submissions').insertOne({ studentName: SECRET_NAME, email: 'a@b.invalid', sourceTranscriptExact: SECRET_TEXT, ocrText: SECRET_TEXT,
    ocrPages: [
      page(1, { strategy: 'gpt-monotonic-partial-geometry-v2', layoutDegraded: false, safeOutcomeCode: 'GEOMETRY_PARTIAL', mappedTokenCount: 55, unmappedTokenCount: 41, note: SECRET_TEXT }),
      page(2, { safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', mappedTokenCount: 0, unmappedTokenCount: 96 }),
      page(3, null),
      page(4, { safeOutcomeCode: `leaked ${SECRET_TEXT}`, mappedTokenCount: 'many', unmappedTokenCount: -3 }),
    ] });
  id = String(result.insertedId);
});
afterAll(() => disconnectInMemoryMongo());

test('prints the four values for every page and nothing else', async () => {
  const out = await script().readGeometry(mongoose.connection.db, id);
  expect(out).toEqual({ submissionId: id, found: true, pages: [
    { pageNumber: 1, safeOutcomeCode: 'GEOMETRY_PARTIAL', mappedTokenCount: 55, unmappedTokenCount: 41 },
    { pageNumber: 2, safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', mappedTokenCount: 0, unmappedTokenCount: 96 },
    { pageNumber: 3, safeOutcomeCode: null, mappedTokenCount: null, unmappedTokenCount: null },
    { pageNumber: 4, safeOutcomeCode: null, mappedTokenCount: null, unmappedTokenCount: null },
  ] });
});

describe('--details adds a few more NON-content fields', () => {
  let detailId;
  beforeAll(async () => {
    const result = await mongoose.connection.db.collection('submissions').insertOne({ studentName: SECRET_NAME,
      ocrPages: [{ pageNumber: 1, sourcePrimaryModel: 'qwen/qwen3.8-27b', ocrImageWidth: 1200, ocrImageHeight: 1600, sourceTextExact: SECRET_TEXT,
        sourceVerificationSummary: { performance: { geometryMs: 812, geometryProviderCallCount: 1, sourceMs: 99, geometry: { safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', layoutDegraded: true, mappedTokenCount: 0, unmappedTokenCount: 150 } } } },
      { pageNumber: 2, sourcePrimaryModel: `leaked ${SECRET_TEXT}`, ocrImageWidth: 'wide', sourceVerificationSummary: { performance: { geometryMs: -5, geometryProviderCallCount: 7 } } }] });
    detailId = String(result.insertedId);
  });
  test('the default output is unchanged; --details adds model, whether Google was called, its time, the image size and the degraded flag', async () => {
    const plain = await script().readGeometry(mongoose.connection.db, detailId);
    expect(Object.keys(plain.pages[0]).sort()).toEqual(['mappedTokenCount', 'pageNumber', 'safeOutcomeCode', 'unmappedTokenCount']);
    const detailed = await script().readGeometry(mongoose.connection.db, detailId, { details: true });
    expect(detailed.pages[0]).toEqual({ pageNumber: 1, safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', mappedTokenCount: 0, unmappedTokenCount: 150,
      layoutDegraded: true, model: 'qwen/qwen3.8-27b', geometryProviderCalls: 1, geometryMs: 812, imageWidth: 1200, imageHeight: 1600 });
  });
  test('detail values are checked too: anything that is not a model id, a small count or a flag is printed as null', async () => {
    const { pages } = await script().readGeometry(mongoose.connection.db, detailId, { details: true });
    expect(pages[1]).toEqual({ pageNumber: 2, safeOutcomeCode: null, mappedTokenCount: null, unmappedTokenCount: null,
      layoutDegraded: null, model: null, geometryProviderCalls: null, geometryMs: null, imageWidth: null, imageHeight: null });
    expect(JSON.stringify(await script().readGeometry(mongoose.connection.db, detailId, { details: true }))).not.toMatch(/PRIVATE|summer|Zed/);
  });
  test('the command line accepts --details after the id and rejects any other option', async () => {
    const out = [], err = [], close = jest.fn();
    const io = { stdout: { write: s => out.push(s) }, stderr: { write: s => err.push(s) }, connect: async () => ({ db: mongoose.connection.db, close }) };
    expect(await script().main([detailId, '--details'], io)).toBe(0);
    expect(JSON.parse(out.join('')).pages[0].model).toBe('qwen/qwen3.8-27b');
    expect(await script().main([detailId, '--everything'], io)).toBe(2);
  });
});

test('no transcript text, student name, e-mail or any other field can appear in the output', async () => {
  const text = JSON.stringify(await script().readGeometry(mongoose.connection.db, id));
  for (const secret of [SECRET_TEXT, 'PRIVATE', SECRET_NAME, 'a@b.invalid', 'summer', 'sourceMs', 'strategy', 'review']) expect(text).not.toContain(secret);
});

test('a value that is not a plain code or a count is withheld, never printed', async () => {
  const page4 = (await script().readGeometry(mongoose.connection.db, id)).pages[3];
  expect(page4).toEqual({ pageNumber: 4, safeOutcomeCode: null, mappedTokenCount: null, unmappedTokenCount: null });
});

test('an unknown submission, or a submission without pages, is reported without error or content', async () => {
  expect(await script().readGeometry(mongoose.connection.db, '0123456789abcdef01234567')).toEqual({ submissionId: '0123456789abcdef01234567', found: false, pages: [] });
  const empty = await mongoose.connection.db.collection('submissions').insertOne({ studentName: SECRET_NAME });
  expect(await script().readGeometry(mongoose.connection.db, String(empty.insertedId))).toEqual({ submissionId: String(empty.insertedId), found: true, pages: [] });
});

test('the query is read-only and asks the database for nothing but the four values', async () => {
  const seen = [];
  const spy = { collection: () => ({ aggregate: pipeline => { seen.push(pipeline); return { toArray: async () => [] }; } }) };
  await script().readGeometry(spy, id);
  const stages = seen[0].map(stage => Object.keys(stage)[0]);
  expect(stages).toEqual(['$match', '$project']);                       // no $out, $merge, $lookup or any write stage
  const projected = JSON.stringify(seen[0][1]);
  for (const forbidden of ['ocrText', 'sourceTextExact', 'words', 'studentName', 'email', 'review']) expect(projected).not.toContain(forbidden);
});

test('the command line refuses anything that is not a 24-character id before touching the database', async () => {
  const lines = [], err = [];
  const io = { stdout: { write: s => lines.push(s) }, stderr: { write: s => err.push(s) }, connect: jest.fn() };
  expect(await script().main(['not-an-id'], io)).toBe(2);
  expect(await script().main([], io)).toBe(2);
  expect(await script().main(['0123456789abcdef01234567', 'extra'], io)).toBe(2);
  expect(io.connect).not.toHaveBeenCalled();
  expect(err.join('')).toMatch(/24/);
});

test('errors never print the connection string or the message of the driver', async () => {
  const err = [];
  const io = { stdout: { write: () => {} }, stderr: { write: s => err.push(s) }, connect: async () => { throw Object.assign(new Error('mongodb://user:PASSWORD123@host/db failed'), { name: 'MongoServerSelectionError' }); } };
  expect(await script().main(['0123456789abcdef01234567'], io)).toBe(1);
  expect(err.join('')).not.toMatch(/PASSWORD123|mongodb:/);
  expect(err.join('')).toMatch(/MongoServerSelectionError/);
});

test('the command line prints the result as JSON and closes the connection', async () => {
  const out = [], close = jest.fn();
  const io = { stdout: { write: s => out.push(s) }, stderr: { write: () => {} }, connect: async () => ({ db: mongoose.connection.db, close }) };
  expect(await script().main([id], io)).toBe(0);
  expect(JSON.parse(out.join('')).pages).toHaveLength(4);
  expect(close).toHaveBeenCalled();
  expect(await script().main(['0123456789abcdef01234567'], { ...io, stdout: { write: () => {} } })).toBe(1);   // not found: exit 1
});
