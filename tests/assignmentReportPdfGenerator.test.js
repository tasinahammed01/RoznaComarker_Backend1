'use strict';
// Assignment report PDF generator: the shared browser manager's render slot, A4 with header/footer and page numbers, network blocked,
// and the existing cancel pattern (timeout and request abort close the context and remove partial output). Puppeteer is mocked.
const fs = require('fs');
const os = require('os');
const path = require('path');

const close = jest.fn(async () => {});
const page = {
  setRequestInterception: jest.fn(async () => {}),
  on: jest.fn(),
  setContent: jest.fn(async () => {}),
  waitForFunction: jest.fn(async () => true),
  evaluate: jest.fn(async () => true),
  pdf: jest.fn(async () => {})
};
const context = { newPage: jest.fn(async () => page), close };
const browser = { createBrowserContext: jest.fn(async () => context) };
const manager = {
  // A real render budget; the page-ready step is short so the "hung page" tests time out quickly.
  withRenderSlot: jest.fn(async (task) => task({ renderTimeoutMs: 5000, imageLoadTimeoutMs: 40, pageReadyTimeoutMs: 40 })),
  getBrowser: jest.fn(async () => browser),
  recordTimeout: jest.fn()
};
jest.mock('../src/services/pdfBrowserManager.service', () => manager);

const { PDFDocument } = require('pdf-lib');
const { generateAssignmentReportPdf } = require('../src/modules/assignmentReportPdfGenerator');

const HTML = '<html><body><p>report</p><script>window.__REPORT_READY__=true</script></body></html>';
async function writeA4(target) {
  const doc = await PDFDocument.create();
  doc.addPage([595.28, 841.89]); doc.addPage([595.28, 841.89]);
  fs.writeFileSync(target, await doc.save());
}

describe('assignment report PDF generator', () => {
  let root; let output;
  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'report-pdf-'));
    output = path.join(root, 'out', 'report.pdf');
    page.setContent.mockImplementation(async () => {});
    page.pdf.mockImplementation(async ({ path: target }) => writeA4(target));
    manager.getBrowser.mockResolvedValue(browser);
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('renders in the shared slot: A4, header and footer with page numbers, external requests blocked', async () => {
    await expect(generateAssignmentReportPdf(HTML, output)).resolves.toMatchObject({ path: output, pageCount: 2 });
    expect(manager.withRenderSlot).toHaveBeenCalledTimes(1);
    expect(page.setRequestInterception).toHaveBeenCalledWith(true);
    const options = page.pdf.mock.calls[0][0];
    expect(options).toMatchObject({ format: 'A4', printBackground: true, displayHeaderFooter: true, path: output });
    expect(options.headerTemplate).toContain('RUBRILO');
    expect(options.headerTemplate).toContain('Assignment Report');
    expect(options.footerTemplate).toContain('class="pageNumber"');
    expect(options.footerTemplate).toContain('class="totalPages"');
    expect(`${options.headerTemplate}${options.footerTemplate}`).not.toMatch(/rozna/i);
    const handler = page.on.mock.calls.find(([event]) => event === 'request')[1];
    const request = url => ({ url: () => url, continue: jest.fn(), abort: jest.fn() });
    const external = request('https://example.com/x.png'); handler(external);
    expect(external.abort).toHaveBeenCalled();
    const data = request('data:image/png;base64,AA=='); handler(data);
    expect(data.continue).toHaveBeenCalled();
    expect(close).toHaveBeenCalled();
  });

  test('timeout closes the browser context, removes partial output and records the timeout', async () => {
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, 'partial');
    page.setContent.mockImplementation(() => new Promise(() => {}));
    await expect(generateAssignmentReportPdf(HTML, output)).rejects.toMatchObject({ statusCode: 504 });
    expect(close).toHaveBeenCalled();
    expect(fs.existsSync(output)).toBe(false);
    expect(manager.recordTimeout).toHaveBeenCalled();
  });

  test('request abort closes the context and answers 499', async () => {
    page.setContent.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = generateAssignmentReportPdf(HTML, output, { abortSignal: controller.signal });
    for (let i = 0; i < 20 && !context.newPage.mock.calls.length; i += 1) await new Promise(r => setTimeout(r, 2));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ statusCode: 499 });
    expect(close).toHaveBeenCalled();
    expect(fs.existsSync(output)).toBe(false);
  });

  test('an oversized document is refused before the browser is used (413)', async () => {
    const huge = `<html><body>${'x'.repeat(13 * 1024 * 1024)}</body></html>`;
    await expect(generateAssignmentReportPdf(huge, output)).rejects.toMatchObject({ statusCode: 413 });
    expect(manager.getBrowser).not.toHaveBeenCalled();
  });

  test('a busy browser pool passes its 503 through unchanged', async () => {
    const { ApiError } = require('../src/middlewares/error.middleware');
    manager.withRenderSlot.mockRejectedValueOnce(new ApiError(503, 'PDF service is busy. Please try again shortly.'));
    await expect(generateAssignmentReportPdf(HTML, output)).rejects.toMatchObject({ statusCode: 503 });
  });
});
