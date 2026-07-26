'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const close = jest.fn(async () => {});
const page = {
  setRequestInterception: jest.fn(async () => {}),
  on: jest.fn(),
  setContent: jest.fn(() => new Promise(() => {})),
  waitForFunction: jest.fn(async () => true),
  evaluate: jest.fn(async () => true),
  pdf: jest.fn(async () => {})
};
const context = { newPage: jest.fn(async () => page), close };
const browser = { createBrowserContext: jest.fn(async () => context) };
const manager = {
  withRenderSlot: jest.fn(async (task) => task({
    renderTimeoutMs: 25, imageLoadTimeoutMs: 25, pageReadyTimeoutMs: 25
  })),
  getBrowser: jest.fn(async () => browser),
  recordTimeout: jest.fn()
};
jest.mock('../src/services/pdfBrowserManager.service', () => manager);
jest.mock('../src/pdf/submissionFeedbackReportTemplate', () => ({
  renderSubmissionFeedbackReportHtml: () => '<html><body><script>window.__REPORT_READY__=true</script></body></html>'
}));

const { generateSubmissionFeedbackPdf } = require('../src/modules/submissionFeedbackPdfGenerator');

describe('submission feedback PDF generator cancellation', () => {
  let root; let output;
  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdf-cancel-'));
    output = path.join(root, 'partial.pdf');
    fs.writeFileSync(output, 'partial');
    page.setContent.mockImplementation(() => new Promise(() => {}));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('timeout closes the browser context and removes partial output', async () => {
    await expect(generateSubmissionFeedbackPdf({ submittedPages: [] }, output))
      .rejects.toMatchObject({ statusCode: 504 });
    expect(close).toHaveBeenCalled();
    expect(fs.existsSync(output)).toBe(false);
    expect(manager.recordTimeout).toHaveBeenCalled();
  });

  test('request abort closes the associated context and removes partial output', async () => {
    const controller = new AbortController();
    const pending = generateSubmissionFeedbackPdf({ submittedPages: [] }, output, { abortSignal: controller.signal });
    for (let attempt = 0; attempt < 20 && !context.newPage.mock.calls.length; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    controller.abort();
    await expect(pending).rejects.toBeDefined();
    expect(close).toHaveBeenCalled();
    expect(fs.existsSync(output)).toBe(false);
  });
});
