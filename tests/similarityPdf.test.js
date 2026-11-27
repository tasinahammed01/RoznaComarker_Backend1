'use strict';
// The teacher-only similarity PDF: built from the same view as the page (the saved exclusions apply), every text escaped, numbered
// highlights (colour is never the only signal), no provider name, and the route (owner only, a report needed). One real render.
process.env.JWT_SECRET = 'similarity-pdf-secret';
process.env.NODE_ENV = 'test';
const fs = require('fs');
const request = require('supertest');
const { connectInMemoryMongo, disconnectInMemoryMongo, clearDatabase } = require('./helpers/testServer');
const check = require('../src/services/similarity/check.service');
const internal = require('../src/services/similarity/internal.service');
const { renderSimilarityHtml } = require('../src/services/similarity/pdfHtml');
const { words, classWithEssay, student, essay } = require('./helpers/similarityFixtures');

jest.setTimeout(300000);
let app;
beforeAll(async () => { await connectInMemoryMongo(); app = require('../src/app'); });
afterAll(async () => { delete process.env.SIMILARITY_ENABLED; delete process.env.ENABLE_TEST_PDF_HTTP; await disconnectInMemoryMongo(); });
beforeEach(async () => { await clearDatabase(); process.env.SIMILARITY_ENABLED = 'true'; delete process.env.ENABLE_TEST_PDF_HTTP; jest.restoreAllMocks(); });

const VIEW = {
  state: 'completed', checkedAt: '2026-11-27T10:00:00.000Z', outdated: false, overallPercent: 30, matchedWords: 3, totalWords: 10,
  text: 'one <script>two</script> three & four five six seven eight nine ten',
  external: { state: 'completed', reason: null }, audit: { provider: 'copyleaks', units: 1, costUsd: 0.05, resultCount: 2 },
  highlights: [{ start: 0, end: 3, sourceId: 's1' }, { start: 4, end: 24, sourceId: 's2' }],
  sources: [
    { sourceId: 's1', number: 1, kind: 'web', label: 'Internet source', title: 'A <b>page</b>', url: 'https://example.test/p?a=1&b=2', percent: 20, words: 2, excluded: false, compared: true },
    { sourceId: 's2', number: 2, kind: 'internal', label: 'Another submission in Rubrilo', percent: 10, words: 1, excluded: false, compared: true },
    { sourceId: 's3', number: null, kind: 'web', label: 'Internet source', title: 'Not compared', url: 'https://example.test/n', percent: null, words: 0, excluded: false, compared: false, approxWords: 9 },
    { sourceId: 's4', number: null, kind: 'repository', label: 'Published or institutional source', percent: null, words: 0, excluded: true, compared: true }]
};

describe('renderSimilarityHtml', () => {
  const html = renderSimilarityHtml(VIEW, { generatedAt: new Date('2026-11-27T12:00:00Z'), title: 'Essay <1>' });
  test('escapes every text: the essay, titles, URLs and the assignment title', () => {
    expect(html).not.toContain('<script>two');
    expect(html).toContain('&lt;script&gt;two&lt;/script&gt;');
    expect(html).toContain('three &amp; four');
    expect(html).toContain('A &lt;b&gt;page&lt;/b&gt;');
    expect(html).toContain('https://example.test/p?a=1&amp;b=2');
    expect(html).toContain('Essay &lt;1&gt;');
  });
  test('the overall percentage, the numbered sources, the found-but-not-compared and the excluded lists', () => {
    expect(html).toContain('30%');
    expect(html).toMatch(/data-number="1"[^>]*>[\s\S]*?Internet source[\s\S]*?20%/);
    expect(html).toMatch(/data-number="2"[^>]*>[\s\S]*?Another submission in Rubrilo[\s\S]*?10%/);
    expect(html).toMatch(/Found but not compared[\s\S]*Not compared/);
    expect(html).toMatch(/Excluded by the teacher[\s\S]*Published or institutional source/);
  });
  test('each highlight carries its source number as text, not only a colour', () => {
    expect(html).toMatch(/<mark class="m1"[^>]*>one<sup>1<\/sup><\/mark>/);
    expect(html).toMatch(/<mark class="m2"[^>]*>&lt;script&gt;two&lt;\/script&gt;<sup>2<\/sup><\/mark>/);
  });
  test('a highlight of a source that does not count (no number) is not marked', () => {
    const out = renderSimilarityHtml({ ...VIEW, highlights: [{ start: 0, end: 3, sourceId: 's4' }] }, { generatedAt: new Date() });
    expect(out).not.toContain('<mark');
  });
  test('never a provider name; signals readiness for the renderer', () => {
    expect(html).not.toMatch(/copyleaks|copyscape/i);
    expect(html).toContain('window.__REPORT_READY__ = true');
  });
  test('an outdated report says so; a report without matches says no matching text', () => {
    expect(renderSimilarityHtml({ ...VIEW, outdated: true }, { generatedAt: new Date() })).toContain('The essay changed after this check');
    expect(renderSimilarityHtml({ ...VIEW, sources: [], highlights: [], overallPercent: 0, matchedWords: 0 }, { generatedAt: new Date() }))
      .toContain('No matching text was found');
  });
});

describe('GET /api/similarity/submissions/:id/pdf', () => {
  async function scene() {
    const a = await classWithEssay({ label: 'a' });
    const sa = await student(a.klass, 'sa');
    const sb = await student(a.klass, 'sb');
    const shared = words('s', 20);
    const mine = await essay({ ...a, studentUser: sa.user, text: `${words('a', 30)} ${shared}` });
    const other = await essay({ ...a, studentUser: sb.user, text: `${words('b', 10)} ${shared}` });
    await internal.indexSubmission(other._id);
    return { a, mine, teacher: a.teacher };
  }
  const pdf = (s, token) => request(app).get(`/api/similarity/submissions/${s.mine._id}/pdf`).set('Authorization', `Bearer ${token}`);

  test('404 for another teacher; 409 before a check; the generator gets the saved exclusions', async () => {
    const s = await scene();
    const other = await classWithEssay({ label: 'o' });
    expect((await pdf(s, other.teacher.token)).status).toBe(404);
    expect((await pdf(s, s.teacher.token)).status).toBe(409);
    await request(app).post(`/api/similarity/submissions/${s.mine._id}/checks`).set('Authorization', `Bearer ${s.teacher.token}`).set('Idempotency-Key', 'k1').send({});
    await check.runQueued({ env: process.env });
    process.env.ENABLE_TEST_PDF_HTTP = 'true';
    const generator = require('../src/modules/assignmentReportPdfGenerator');
    const seen = [];
    jest.spyOn(generator, 'generateAssignmentReportPdf').mockImplementation(async (html, outputPath, options) => {
      seen.push({ html, options }); await fs.promises.writeFile(outputPath, Buffer.from('%PDF-1.4 fake')); return { path: outputPath, pageCount: 1 };
    });
    const first = await pdf(s, s.teacher.token);
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toBe('application/pdf');
    expect(first.headers['content-disposition']).toMatch(/^attachment; filename="similarity-report-\d{4}-\d{2}-\d{2}\.pdf"$/);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(seen[0].html).toContain('<mark class="m1"');
    expect(seen[0].options.headerTitle).toBe('Similarity Report');
    const view = (await request(app).get(`/api/similarity/submissions/${s.mine._id}`).set('Authorization', `Bearer ${s.teacher.token}`)).body.data;
    await request(app).patch(`/api/similarity/submissions/${s.mine._id}/sources/s1`).set('Authorization', `Bearer ${s.teacher.token}`)
      .send({ excluded: true, revision: view.revision, requestId: 'x1' });
    await pdf(s, s.teacher.token);
    expect(seen[1].html).not.toContain('<mark class="m1"');
    expect(seen[1].html).toMatch(/Excluded by the teacher/);
  });

  test('a real render: a PDF whose text has the overall percentage', async () => {
    const s = await scene();
    await request(app).post(`/api/similarity/submissions/${s.mine._id}/checks`).set('Authorization', `Bearer ${s.teacher.token}`).set('Idempotency-Key', 'k2').send({});
    await check.runQueued({ env: process.env });
    process.env.ENABLE_TEST_PDF_HTTP = 'true';
    const res = await pdf(s, s.teacher.token).buffer(true).parse((r, cb) => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => cb(null, Buffer.concat(c))); });
    expect(res.status).toBe(200);
    const text = (await require('pdf-parse')(res.body)).text.replace(/\s+/g, ' ');
    expect(text).toContain('40%');
    expect(text).toContain('Another submission in Rubrilo');
  });
});
