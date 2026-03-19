// Puppeteer v24+ smoke test for Windows.
//
// What this script does:
// 1) Launches Chromium via Puppeteer.
// 2) Opens https://example.com.
// 3) Takes a screenshot (example.png) in this folder.
// 4) Prints the detected Puppeteer + Chromium paths.
//
// Run:
//   node test.js

const fs = require('fs');
const path = require('path');

async function main() {
  // Require puppeteer from the local project (node_modules).
  const puppeteer = require('puppeteer');

  // `executablePath()` tells you which Chromium binary Puppeteer will use.
  const chromiumPath = puppeteer.executablePath();

  console.log('Puppeteer package:', require.resolve('puppeteer'));
  console.log('Chromium executablePath():', chromiumPath);
  console.log('Chromium exists on disk:', fs.existsSync(chromiumPath));

  // Launch Chromium.
  const browser = await puppeteer.launch({
    headless: true
  });

  try {
    const page = await browser.newPage();

    // Navigate to a known-good URL.
    await page.goto('https://example.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // Save the screenshot in the project root.
    const screenshotPath = path.join(__dirname, 'example.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });

    console.log('Screenshot saved:', screenshotPath);
    console.log('Screenshot exists on disk:', fs.existsSync(screenshotPath));
  } finally {
    // Always close the browser.
    await browser.close();
  }
}

main().catch((err) => {
  console.error('Puppeteer test failed. Full error:');
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
