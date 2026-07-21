'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { ApiError } = require('../middlewares/error.middleware');

const numberEnv = (name, fallback, min = 1) => { const value = Number(process.env[name]); return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback; };
const config = () => ({ maxConcurrent: numberEnv('PDF_MAX_CONCURRENT_RENDERS', 2), queueLimit: numberEnv('PDF_RENDER_QUEUE_LIMIT', 8, 0), queueWaitMs: numberEnv('PDF_QUEUE_WAIT_TIMEOUT_MS', 15000), renderTimeoutMs: numberEnv('PDF_RENDER_TIMEOUT_MS', 60000), imageLoadTimeoutMs: numberEnv('PDF_IMAGE_LOAD_TIMEOUT_MS', 15000), pageReadyTimeoutMs: numberEnv('PDF_PAGE_READY_TIMEOUT_MS', 15000) });

let browser = null; let launchPromise = null; let coldStarts = 0; let restarts = 0; let timeouts = 0; let active = 0; const queue = [];

function getPuppeteer() { try { return require('puppeteer'); } catch (error) { if (process.env.NODE_ENV === 'production') throw error; return require('../../../RoznaComarker/node_modules/puppeteer'); } }
function usable(candidate) { try { return Boolean(candidate) && fs.statSync(candidate).isFile(); } catch { return false; } }
function resolveBrowserExecutable() {
  const explicit = String(process.env.PUPPETEER_EXECUTABLE_PATH || '').trim();
  if (explicit) { if (!usable(explicit)) throw new Error('Configured Puppeteer executable is not usable.'); return { executablePath: explicit, strategy: 'configured' }; }
  const puppeteer = getPuppeteer(); let bundled = ''; try { bundled = puppeteer.executablePath(); } catch { /* unavailable */ }
  if (usable(bundled)) return { executablePath: bundled, strategy: 'bundled' };
  const candidates = process.platform === 'win32' ? [path.join(process.env.PROGRAMFILES || '', 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe')] : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  const system = candidates.find(usable); if (system) return { executablePath: system, strategy: 'system' };
  throw new Error('No usable Chromium executable is available for PDF rendering.');
}
function validateBrowserRuntime() { const resolved = resolveBrowserExecutable(); logger.metric({ event: 'pdf_browser_runtime', strategy: resolved.strategy }); return resolved.strategy; }

async function getBrowser() {
  if (browser?.connected) return browser;
  if (launchPromise) return launchPromise;
  launchPromise = (async () => {
    const puppeteer = getPuppeteer(); const resolved = resolveBrowserExecutable(); const isRestart = Boolean(browser);
    const instance = await puppeteer.launch({ headless: true, executablePath: resolved.executablePath,
      timeout: numberEnv('PUPPETEER_LAUNCH_TIMEOUT_MS', 30000),
      protocolTimeout: numberEnv('PUPPETEER_PROTOCOL_TIMEOUT_MS', 30000) });
    browser = instance; coldStarts += isRestart ? 0 : 1; restarts += isRestart ? 1 : 0;
    instance.once('disconnected', () => { if (browser === instance) browser = null; logger.metric({ event: 'pdf_browser_disconnected' }); });
    logger.metric({ event: isRestart ? 'pdf_browser_restarted' : 'pdf_browser_started', strategy: resolved.strategy, coldStarts, restarts }); return instance;
  })().finally(() => { launchPromise = null; });
  return launchPromise;
}

function release() { active = Math.max(0, active - 1); while (queue.length) { const next = queue.shift(); if (!next.done) { next.done = true; clearTimeout(next.timer); active += 1; next.resolve({ waitMs: Date.now() - next.enqueuedAt }); break; } } }
function acquire() {
  const limits = config(); if (active < limits.maxConcurrent) { active += 1; return Promise.resolve({ waitMs: 0 }); }
  if (queue.length >= limits.queueLimit) return Promise.reject(new ApiError(503, 'PDF service is busy. Please try again shortly.'));
  return new Promise((resolve, reject) => { const item = { resolve, reject, enqueuedAt: Date.now(), done: false }; item.timer = setTimeout(() => { if (item.done) return; item.done = true; const index = queue.indexOf(item); if (index >= 0) queue.splice(index, 1); reject(new ApiError(503, 'PDF generation queue timed out. Please try again.')); }, limits.queueWaitMs); queue.push(item); });
}
async function withRenderSlot(task) { const ticket = await acquire(); logger.metric({ event: 'pdf_render_started', active, queueDepth: queue.length, queueWaitMs: ticket.waitMs }); try { return await task(config()); } finally { release(); } }
async function closeBrowser() { const current = browser; browser = null; if (current) await current.close().catch(() => {}); }
function recordTimeout() { timeouts += 1; logger.metric({ event: 'pdf_render_timeout', timeoutCount: timeouts }); }
function state() { return { active, queueDepth: queue.length, connected: Boolean(browser?.connected), coldStarts, restarts, timeouts, config: config() }; }

module.exports = { config, resolveBrowserExecutable, validateBrowserRuntime, getBrowser, withRenderSlot, closeBrowser, recordTimeout, state, _test: { release, acquire, reset: async () => { queue.splice(0).forEach((item) => clearTimeout(item.timer)); active = 0; await closeBrowser(); launchPromise = null; coldStarts = 0; restarts = 0; timeouts = 0; } } };
