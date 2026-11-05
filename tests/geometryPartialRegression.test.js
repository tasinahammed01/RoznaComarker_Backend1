'use strict';
// Regression for the stored result GEOMETRY_LAYOUT_WITHHELD with 0 mapped words on a page that had a single word the layout could not place.
// Before commit 89f54c6a, alignGeometry used the STRICT layout builder: one unplaced word degraded the whole page (nothing mapped).
// Now it uses the evidence-only mode: the placed words are mapped and the outcome is GEOMETRY_PARTIAL. Synthetic boxes, no real text.
const {buildHandwritingGeometryTranscript} = require('../src/utils/ocrTranscriptNormalizer');
const {alignGeometry} = require('../src/services/gptVisionExact/alignment');

// Three lines of six words, 60 units apart, plus one stray word exactly between lines 1 and 2 (it fits both equally, so it is ambiguous).
function page({stray = true} = {}) {
  const words = [];
  [100, 160, 220].forEach((y, line) => {
    for (let i = 0; i < 6; i++) words.push({id: `w${line}${i}`, text: `w${line}x${i}`, bbox: {x0: 50 + i * 100, y0: y, x1: 100 + i * 100, y1: y + 40}});
  });
  if (stray) words.push({id: 'stray', text: 'stray', bbox: {x0: 355, y0: 130, x1: 395, y1: 170}});
  return words;
}
const transcript = [0, 1, 2].map(line => Array.from({length: 6}, (_, i) => `w${line}x${i}`).join(' ')).join('\n');
const identity = {fileId: 'f', pageNumber: 1};

test('the old strict layout builder withholds the whole page for one ambiguous word', () => {
  const strict = buildHandwritingGeometryTranscript(page());
  expect(strict).toMatchObject({layoutDegraded: true, reason: 'AMBIGUOUS_LINE_MEMBERSHIP', unresolvedWordCount: 1});
  expect(strict.spans).toEqual([]);                       // nothing to map: this is the stored "0 mapped" result
});

test('the evidence-only layout keeps the 18 placed words and reports the one it could not place', () => {
  const layout = buildHandwritingGeometryTranscript(page(), {geometryEvidenceOnly: true});
  expect(layout).toMatchObject({layoutDegraded: false, resolvedWordCount: 18, unresolvedWordCount: 1});
});

test('alignGeometry on that page is GEOMETRY_PARTIAL with the placed words mapped, not WITHHELD with none', () => {
  const result = alignGeometry(transcript, {words: page()}, identity);
  expect(result.diagnostics).toMatchObject({safeOutcomeCode: 'GEOMETRY_PARTIAL', layoutDegraded: false});
  expect(result.diagnostics.mappedTokenCount).toBeGreaterThan(0);
  expect(result.diagnostics.mappedTokenCount + result.diagnostics.unmappedTokenCount).toBe(18);
  expect(result.words.filter(w => w.bbox)).toHaveLength(result.diagnostics.mappedTokenCount);
});

test('a page with no unplaced word is GEOMETRY_ORDERED, and a page with no Google words stays unavailable or withheld', () => {
  expect(alignGeometry(transcript, {words: page({stray: false})}, identity).diagnostics.safeOutcomeCode).toBe('GEOMETRY_ORDERED');
  expect(alignGeometry(transcript, null, identity).diagnostics.safeOutcomeCode).toBe('GEOMETRY_UNAVAILABLE');
  expect(alignGeometry(transcript, {words: []}, identity)).toMatchObject({coverage: 0, diagnostics: {safeOutcomeCode: 'GEOMETRY_LAYOUT_WITHHELD', mappedTokenCount: 0}});
});
