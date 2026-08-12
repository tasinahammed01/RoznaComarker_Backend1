'use strict';

const {
  MAX_WORKSHEET_HTML_BYTES,
  PREVIEW_CSP,
  sanitizeWorksheetHtml
} = require('../src/services/worksheetHtmlSanitizer.service');
const { validateHtml } = require('../src/services/geminiWorksheet.service');

function worksheet(body, styles = '.worksheet-container{width:794px;color:#123;background:linear-gradient(#fff,#eee)}') {
  return `<!DOCTYPE html><html><head><title>Test</title><style>${styles}</style></head>`
    + `<body><div class="worksheet-container">${body}</div></body></html>`;
}

describe('Security hardening Phase 3 - generated worksheet HTML', () => {
  test('retains printable allowlisted worksheet markup and injects an isolated preview CSP', () => {
    const safe = sanitizeWorksheetHtml(worksheet(
      '<h1>Ordering Activity</h1><table><tr><td style="padding: 8px">One</td></tr></table>'
    ));

    expect(safe).toMatch(/^<!DOCTYPE html>/u);
    expect(safe).toContain('class="worksheet-container"');
    expect(safe).toContain('<table>');
    expect(safe).toContain('padding:8px');
    expect(safe).toContain('linear-gradient');
    expect(safe).toContain('http-equiv="Content-Security-Policy"');
    expect(PREVIEW_CSP).toContain("script-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
  });

  test.each([
    ['scripts and event handlers', '<h1>Ordering</h1><script>alert(1)</script><p onclick="alert(2)">Text</p>', ['<script', 'onclick=']],
    ['embedded browsing contexts', '<h1>Ordering</h1><iframe srcdoc="<script>alert(1)</script>"></iframe><object data="x"></object>', ['<iframe', 'srcdoc=', '<object']],
    ['forms and dangerous navigation attributes', '<h1>Ordering</h1><form action="https://evil.test"><input formaction="javascript:alert(1)"></form>', ['<form', 'formaction=', 'javascript:']],
    ['SVG and MathML active content', '<h1>Ordering</h1><svg><a href="javascript:alert(1)">x</a></svg><math><mtext>x</mtext></math>', ['<svg', '<math', 'javascript:']]
  ])('removes %s', (_label, body, forbidden) => {
    const safe = sanitizeWorksheetHtml(worksheet(body)).toLowerCase();
    for (const token of forbidden) expect(safe).not.toContain(token);
  });

  test('removes CSS network/execution primitives while retaining safe declarations', () => {
    const safe = sanitizeWorksheetHtml(worksheet(
      '<h1 style="color:#123;background:url(https://evil.test/pixel);behavior:url(x)">Ordering</h1>',
      '@import "https://evil.test/x.css";.worksheet-container{color:#123;background:url(https://evil.test/x)}'
    ));
    expect(safe).toContain('color:#123');
    expect(safe).not.toMatch(/@import|url\s*\(|behavior\s*:/iu);
  });

  test('allows only narrow worksheet image sources', () => {
    const safe = sanitizeWorksheetHtml(worksheet(
      '<h1>Ordering</h1><img src="https://evil.test/pixel.png" alt="bad">'
      + '<img src="https://images.unsplash.com/photo-1" alt="allowed">'
    ));
    expect(safe).not.toContain('https://evil.test');
    expect(safe).toContain('https://images.unsplash.com/photo-1');
  });

  test('fails closed for missing worksheet structure and oversized output', () => {
    expect(() => sanitizeWorksheetHtml('<html><body><p>no worksheet root</p></body></html>'))
      .toThrow('unsafe or invalid worksheet');
    expect(() => sanitizeWorksheetHtml('x'.repeat(MAX_WORKSHEET_HTML_BYTES + 1)))
      .toThrow('unsafe or invalid worksheet');
  });

  test('validates requested activities after sanitization', () => {
    try {
      validateHtml(worksheet('<h1>Safe title</h1><script>Ordering</script>'), ['ordering']);
      throw new Error('Expected validation to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'WORKSHEET_ACTIVITY_COUNT_MISMATCH' });
    }
    expect(validateHtml(worksheet('<h1>Ordering Activity</h1>'), ['ordering']))
      .toContain('Ordering Activity');
  });
});
