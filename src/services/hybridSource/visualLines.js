'use strict';
const { polygonValid, validIdentity } = require('./reconcile');
const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};
function bounds(polygon) {
  const xs = polygon.map(p => p.x), ys = polygon.map(p => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  return { left, right, top, bottom, center: (top + bottom) / 2, height: bottom - top };
}
function groupVisualLines(words, identity) {
  if (!validIdentity(identity) || words.length > 600) throw Object.assign(new Error('OCR_SOURCE_GEOMETRY_LIMIT'), { code: 'OCR_SOURCE_GEOMETRY_LIMIT' });
  const rows = [], rejected = [];
  const seen = new Set();
  const usable = words.map((word, index) => {
    const reasons = [];
    if (word.id !== `word_${identity.fileId}_${identity.pageNumber}_${index + 1}` || seen.has(word.id)) reasons.push('FOREIGN_OR_DUPLICATE_WORD_ID');
    seen.add(word.id);
    if (!polygonValid(word.polygon, identity)) reasons.push('INVALID_POLYGON');
    if (reasons.length) { rejected.push({ index, wordId: word.id, reasons }); return null; }
    return { word, index, box: bounds(word.polygon), reasons: [] };
  }).filter(Boolean).sort((a, b) => a.box.center - b.box.center || a.box.left - b.box.left || a.index - b.index);
  const fits = (item, row) => Math.abs(item.box.center - median(row.items.map(i => i.box.center)))
    <= 0.45 * Math.min(item.box.height, median(row.items.map(i => i.box.height)));
  for (const item of usable) {
    const candidates = rows.filter(row => fits(item, row));
    if (candidates.length === 1) candidates[0].items.push(item);
    else { if (candidates.length > 1) item.reasons.push('AMBIGUOUS_VISUAL_LINE'); rows.push({ items: [item] }); }
  }
  rows.sort((a, b) => median(a.items.map(i => i.box.center)) - median(b.items.map(i => i.box.center)));
  rows.forEach((row, index) => {
    row.id = `line_${identity.fileId}_${identity.pageNumber}_${index + 1}`;
    row.items.sort((a, b) => a.box.left - b.box.left || a.index - b.index);
    for (const item of row.items) {
      if (rows.filter(other => fits(item, other)).length > 1) item.reasons.push('AMBIGUOUS_VISUAL_LINE');
    }
    for (let j = 1; j < row.items.length; j++) {
      const a = row.items[j - 1], b = row.items[j];
      const overlap = a.box.right - b.box.left;
      const punctuation = /^[\p{P}\p{S}]+$/u.test(a.word.text) || /^[\p{P}\p{S}]+$/u.test(b.word.text);
      if (!punctuation && overlap > 0.2 * Math.min(a.box.right - a.box.left, b.box.right - b.box.left)) {
        a.reasons.push('OVERLAPPING_WORD_GEOMETRY'); b.reasons.push('OVERLAPPING_WORD_GEOMETRY');
      }
    }
  });
  return { coordinateSpace: 'display-image', lines: rows.map(row => ({ id: row.id,
    items: row.items, wordIds: row.items.map(i => i.word.id),
    text: row.items.map(i => i.word.text).join(' '),
    center: median(row.items.map(i => i.box.center)), height: median(row.items.map(i => i.box.height)) })), rejected };
}
module.exports = { bounds, groupVisualLines };
