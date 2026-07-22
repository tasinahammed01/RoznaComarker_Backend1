'use strict';

const mockBrowser = { connected: true, once: jest.fn(), close: jest.fn(async () => { mockBrowser.connected = false; }) };
const mockLaunch = jest.fn(async () => { mockBrowser.connected = true; return mockBrowser; });
jest.mock('puppeteer', () => ({ executablePath: () => process.execPath, launch: mockLaunch }), { virtual: true });

describe('PDF browser lifecycle and queue', () => {
  let manager;
  beforeEach(async () => { jest.resetModules(); process.env.PDF_MAX_CONCURRENT_RENDERS='1'; process.env.PDF_RENDER_QUEUE_LIMIT='0'; process.env.PUPPETEER_EXECUTABLE_PATH=process.execPath; manager=require('../src/services/pdfBrowserManager.service'); await manager._test.reset(); mockLaunch.mockClear(); mockBrowser.once.mockClear(); mockBrowser.close.mockClear(); });
  afterEach(async () => { await manager._test.reset(); delete process.env.PDF_MAX_CONCURRENT_RENDERS; delete process.env.PDF_RENDER_QUEUE_LIMIT; delete process.env.PUPPETEER_EXECUTABLE_PATH; delete process.env.PDF_CHROME_NO_SANDBOX; });
  test('simultaneous cold-start callers launch one shared browser', async () => { const [a,b]=await Promise.all([manager.getBrowser(),manager.getBrowser()]); expect(a).toBe(b); expect(mockLaunch).toHaveBeenCalledTimes(1); });
  test('configured executable is validated without exposing a hard-coded path', () => { expect(manager.resolveBrowserExecutable().strategy).toBe('configured'); process.env.PUPPETEER_EXECUTABLE_PATH='Z:\\missing-browser.exe'; expect(()=>manager.resolveBrowserExecutable()).toThrow(/not usable/); });
  test('queue capacity rejects excess work and releases active slots', async () => { let finish; const first=manager.withRenderSlot(()=>new Promise((resolve)=>{finish=resolve;})); await new Promise(setImmediate); await expect(manager.withRenderSlot(async()=>true)).rejects.toMatchObject({statusCode:503}); finish('done'); await expect(first).resolves.toBe('done'); expect(manager.state().active).toBe(0); });
  test('graceful close affects only the managed browser', async () => { await manager.getBrowser(); await manager.closeBrowser(); expect(mockBrowser.close).toHaveBeenCalledTimes(1); expect(manager.state().connected).toBe(false); });
  test('sandbox remains enabled by default without Chromium bypass arguments', async () => { await manager.getBrowser(); expect(mockLaunch.mock.calls[0][0]).not.toHaveProperty('args'); expect(manager.config().noSandbox).toBe(false); });
  test('explicit no-sandbox configuration applies only the two managed launch arguments', async () => { process.env.PDF_CHROME_NO_SANDBOX='true'; await manager.getBrowser(); expect(mockLaunch.mock.calls[0][0].args).toEqual(['--no-sandbox','--disable-setuid-sandbox']); expect(manager.config().noSandbox).toBe(true); });
});
