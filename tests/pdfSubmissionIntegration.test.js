'use strict';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'pdf-submission-integration-test';
jest.mock('@google-cloud/vision', () => ({ ImageAnnotatorClient: jest.fn(() => ({ documentTextDetection: mockDetect })) }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn(async () => {}) }));
const mockDetect = jest.fn();
const fs = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const { PDFDocument, StandardFonts } = require('pdf-lib');
const app = require('../src/app');
const File = require('../src/models/File');
const User = require('../src/models/user.model');
const Class = require('../src/models/class.model');
const Submission = require('../src/models/Submission');
const { runOcrAndPersistForFiles } = require('../src/services/ocrPipeline.service');
const { preparePdfPages, digest } = require('../src/services/pdfSubmissionPages.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { buildCanonicalSubmissionTranscript } = require('../src/utils/ocrTranscriptNormalizer');
const { connectInMemoryMongo, disconnectInMemoryMongo } = require('./helpers/testServer');
const { signTestJwt } = require('./helpers/auth');

describe('PDF OCR private assets and page identity', () => {
  jest.setTimeout(120000);
  let source, submission, tokens, originalPath;
  beforeAll(async () => {
    await connectInMemoryMongo();
    const users = await User.create(['student', 'teacher', 'student', 'teacher'].map((role, i) => ({
      role, firebaseUid: `pdf-pages-${i}`, email: `pdf-pages-${i}@example.test` })));
    tokens = users.map(u => signTestJwt({ id: u._id, role: u.role, firebaseUid: u.firebaseUid }));
    const classroom = await Class.create({ teacher: users[1]._id, name: 'PDF test', joinCode: 'PDFTEST', qrCodeUrl: 'data:,' });
    const doc = await PDFDocument.create(); const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const n of [1, 2]) doc.addPage().drawText(`Students was ready on page ${n}.`, { x: 40, y: 600, size: 20, font });
    const filename = `${crypto.randomUUID()}.pdf`;
    originalPath = path.resolve(__dirname, '../uploads/submissions', filename);
    await fs.mkdir(path.dirname(originalPath), { recursive: true }); await fs.writeFile(originalPath, await doc.save());
    source = await File.create({ originalName: 'two-pages.pdf', filename, path: originalPath, url: `/files/submissions/${filename}`,
      type: 'submissions', role: 'student', uploadedBy: users[0]._id });
    submission = await Submission.create({ student: users[0]._id, class: classroom._id, assignment: new (require('mongoose').Types.ObjectId)(),
      file: source._id, files: [source._id], status: 'submitted', isLate: false, submittedAt: new Date(), ocrJobId: 'pdf-test-job', ocrStatus: 'pending' });
  });
  afterAll(async () => {
    const files = await File.find().lean();
    for (const file of files) if (file.path.startsWith(path.resolve(__dirname, '../uploads') + path.sep)) await fs.unlink(file.path).catch(() => {});
    await disconnectInMemoryMongo();
  });
  test('persists exact OCR bytes privately, page-specific text, dimensions, and unique word IDs; retry reuses assets', async () => {
    const hashes = [];
    mockDetect.mockImplementation(async ({ image }) => {
      hashes.push(digest(image.content)); const text = hashes.length === 1 ? 'First page text.' : 'Second page text.';
      return [{ fullTextAnnotation: { text, pages: [{ width: 1654, height: 2339, blocks: [{ paragraphs: [{ words: text.split(' ').map((text, i) => ({
        symbols: [...text].map(text => ({ text, confidence: .99 })), boundingBox: { vertices: [{ x: 50 + i * 120, y: 50 }, { x: 150 + i * 120, y: 90 }] }
      })) }] }] }] } }];
    });
    await runOcrAndPersistForFiles({ fileIds: [source._id], targetDoc: submission, jobId: submission.ocrJobId });
    const saved = await Submission.findById(submission._id).lean();
    expect(saved.ocrStatus).toBe('completed'); expect(saved.ocrPages).toHaveLength(2);
    expect(saved.ocrPages.map(p => p.text)).toEqual(['First page text.', 'Second page text.']);
    const canonical = buildCanonicalSubmissionTranscript(saved);
    expect(canonical.text).toContain('First page text.'); expect(canonical.text).toContain('Second page text.');
    const ids = canonical.pages.flatMap(p => p.words.map(w => w.id)); expect(new Set(ids).size).toBe(ids.length);
    for (const [i, page] of saved.ocrPages.entries()) {
      expect(page.width).toBeGreaterThan(1500); expect(page.height).toBeGreaterThan(2000); expect(page.rasterHash).toBe(hashes[i]);
      for (const token of tokens.slice(0, 2)) {
        const res = await request(app).get(page.pageImageUrl).set('Authorization', `Bearer ${token}`);
        expect(res.status).toBe(200); expect(digest(res.body)).toBe(hashes[i]); expect(res.headers['cache-control']).toContain('no-store');
      }
      for (const token of tokens.slice(2)) expect((await request(app).get(page.pageImageUrl).set('Authorization', `Bearer ${token}`)).status).toBe(403);
      expect((await request(app).get(page.pageImageUrl)).status).toBe(401);
    }
    const pagesAgain = await preparePdfPages(originalPath, source);
    expect(pagesAgain.map(p => p.rasterHash)).toEqual(hashes);
    expect(await File.countDocuments({ sourceFileId: source._id })).toBe(2);
  });
  test('page two provider failure prevents assessment of partial document', async () => {
    mockDetect.mockReset(); pipeline.generateAndPersist.mockClear();
    mockDetect.mockResolvedValueOnce([{ fullTextAnnotation: { text: 'First page', pages: [] } }])
      .mockRejectedValueOnce({ code: 4 });
    const doc = await Submission.findById(submission._id);
    await runOcrAndPersistForFiles({ fileIds: [source._id], targetDoc: doc, jobId: doc.ocrJobId });
    expect((await Submission.findById(doc._id)).ocrStatus).toBe('failed');
    expect(pipeline.generateAndPersist).not.toHaveBeenCalled();
  });
  test('superseded job cannot OCR or write pages', async () => {
    mockDetect.mockClear();
    await Submission.updateOne({ _id: submission._id }, { $set: { ocrJobId: 'replacement' } });
    expect(await runOcrAndPersistForFiles({ fileIds: [source._id], targetDoc: submission, jobId: 'pdf-test-job' }))
      .toEqual({ ocrStatus: 'superseded' });
    expect(mockDetect).not.toHaveBeenCalled();
  });
});
