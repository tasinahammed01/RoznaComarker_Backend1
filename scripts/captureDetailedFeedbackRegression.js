'use strict';

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

const workspace = path.resolve(__dirname, '..', '..');
const componentCss = fs.readFileSync(path.join(workspace, 'RoznaComarker', 'src', 'app', 'components',
  'canonical-detailed-feedback', 'canonical-detailed-feedback.css'), 'utf8');
const outputDirectory = path.join(workspace, 'output', 'detailed-feedback-regression');

const fixture = `
<main><section class="shell"><section class="detailed-feedback">
  <div class="section-title"><span class="title-icon">&#9679;</span><h3>Detailed Feedback &amp; Suggestions</h3></div>
  <section class="feedback-group"><h4>Areas for Improvement</h4><div class="feedback-grid">
    <article class="feedback-card" data-category="CONTENT"><header><h5>Content</h5><div class="card-badges"><span class="score-badge">12/20</span><span class="issue-badge">5 issues</span></div></header><p class="summary">5 distinct issues affected this category. The main recorded pattern is DEV.</p><div class="symbols"><span>DEV</span><span>SD</span></div><div class="evidence-panel"><div class="evidence-symbol"><b>DEV</b><small>Idea Development</small></div><blockquote>“Furthermore, AI makes education more accessible and inclusive.”</blockquote><p>Develop the idea with precise supporting evidence.</p><p class="suggestion"><strong>Suggested:</strong> Add a concrete example showing how the idea supports accessibility.</p></div></article>
    <article class="feedback-card" data-category="GRAMMAR"><header><h5>Grammar</h5><div class="card-badges"><span class="score-badge">20/25</span><span class="issue-badge">2 issues</span></div></header><p class="summary">2 distinct issues affected this category. The main recorded pattern is AGR.</p><div class="symbols"><span>AGR</span></div><div class="evidence-panel"><div class="evidence-symbol"><b>AGR</b><small>Agreement</small></div><blockquote>“students learns”</blockquote><p class="suggestion"><strong>Suggested:</strong> students learn</p></div></article>
    <article class="feedback-card" data-category="VOCABULARY"><header><h5>Vocabulary</h5><div class="card-badges"><span class="score-badge">16/20</span><span class="issue-badge">3 issues</span></div></header><p class="summary">3 distinct issues affected this category. The main recorded pattern is WW.</p><div class="symbols"><span>WW</span></div><div class="evidence-panel"><div class="evidence-symbol"><b>WW</b><small>Word Choice</small></div><blockquote>“a very big benefit”</blockquote><p class="suggestion"><strong>Suggested:</strong> a substantial benefit</p></div></article>
  </div></section>
  <section class="feedback-group"><h4>Evidence-based Strengths</h4><div class="feedback-grid strengths-grid"><article class="feedback-card strength-card" data-category="ORGANIZATION"><header><h5>Organization</h5><div class="card-badges"><span class="score-badge">18/20</span></div></header><p class="summary">The current evaluation records clear sequencing and logical progression.</p><p class="strength-evidence">&#10003; Paragraph transitions connect the main ideas.</p></article></div></section>
  <section class="actions-panel"><h4>Prioritized Action Steps for Improvement</h4><ol><li><span>1</span><div><strong>Revise the DEV corrections in the highlighted passages.</strong><p>Five current content issues have the greatest effect on the result.</p><div class="symbols"><span>DEV</span><span>SD</span></div></div></li><li><span>2</span><div><strong>Review agreement in the quoted examples.</strong><p>Correct the current AGR evidence before final proofreading.</p></div></li></ol></section>
</section></section></main>`;
const blankFixture = '<main><section class="shell"><section class="detailed-feedback"><div class="section-title"><span class="title-icon">&#9679;</span><h3>Detailed Feedback &amp; Suggestions</h3></div></section></section></main>';

async function capture(page, name, width, height, content = fixture) {
  await page.setViewport({ width, height, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#eef2f7;font-family:Arial,sans-serif}main{padding:28px}.shell{max-width:1200px;margin:auto;background:#fff;border-radius:20px;padding:24px}${componentCss}</style></head><body>${content}</body></html>`);
  await page.screenshot({ path: path.join(outputDirectory, name), fullPage: true });
}

(async () => {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await capture(page, 'detailed-feedback-before-heading-only.png', 1440, 500, blankFixture);
    await capture(page, 'detailed-feedback-desktop.png', 1440, 1000);
    await capture(page, 'detailed-feedback-mobile.png', 390, 844);
  } finally {
    await browser.close();
  }
  console.log(JSON.stringify({ before: path.join(outputDirectory, 'detailed-feedback-before-heading-only.png'), desktop: path.join(outputDirectory, 'detailed-feedback-desktop.png'),
    mobile: path.join(outputDirectory, 'detailed-feedback-mobile.png') }));
})().catch((error) => { console.error(error?.message || error); process.exitCode = 1; });
