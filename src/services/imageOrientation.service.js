'use strict';

// Consensus thresholds, not calibrated probabilities or OCR confidence.
const ORIENTATION_POLICY = Object.freeze({ version: 'vision-word-orientation-v1',
  minWords: 4, minWidth: 8, minHeight: 4, cardinalTolerance: 25,
  edgeTolerance: 20, minAgreement: 0.8, minConcentration: 0.95 });
const degrees = radians => radians * 180 / Math.PI;
const distance = (a, b) => Math.abs(((a - b + 540) % 360) - 180);
const list = value => Array.isArray(value) ? value : [];

function estimateDocumentOrientation(annotation) {
  const angles = [];
  for (const page of list(annotation?.pages)) for (const block of list(page?.blocks))
    for (const paragraph of list(block?.paragraphs)) for (const word of list(paragraph?.words)) {
      const vertices = word?.boundingBox?.vertices;
      if (!Array.isArray(vertices) || vertices.length !== 4) continue;
      // Protobuf omits zero coordinates. An empty vertex denotes (0,0).
      const points = vertices.map(v => v && typeof v === 'object'
        ? { x: v.x ?? 0, y: v.y ?? 0 } : null);
      if (points.some(p => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y))) continue;
      const edges = points.map((p, i) => ({ x: points[(i + 1) % 4].x - p.x, y: points[(i + 1) % 4].y - p.y }));
      if (edges.some((e, i) => e.x * edges[(i + 1) % 4].y - e.y * edges[(i + 1) % 4].x <= 0)) continue;
      if (edges.some((e, i) => Math.hypot(e.x, e.y) < (i % 2 ? ORIENTATION_POLICY.minHeight : ORIENTATION_POLICY.minWidth))) continue;
      const top = (degrees(Math.atan2(edges[0].y, edges[0].x)) + 360) % 360;
      const bottom = (degrees(Math.atan2(-edges[2].y, -edges[2].x)) + 360) % 360;
      if (distance(top, bottom) > ORIENTATION_POLICY.edgeTolerance) continue;
      angles.push((degrees(Math.atan2(edges[0].y - edges[2].y, edges[0].x - edges[2].x)) + 360) % 360);
    }
  const votes = [0, 0, 0, 0];
  for (const angle of angles) {
    const bin = Math.round(angle / 90) % 4;
    if (distance(angle, bin * 90) <= ORIENTATION_POLICY.cardinalTolerance) votes[bin]++;
  }
  const winner = votes.indexOf(Math.max(...votes));
  const agreement = angles.length ? votes[winner] / angles.length : 0;
  const winning = angles.filter(angle => distance(angle, winner * 90) <= ORIENTATION_POLICY.cardinalTolerance);
  const concentration = winning.length ? Math.hypot(
    winning.reduce((sum, a) => sum + Math.cos(a * Math.PI / 180), 0),
    winning.reduce((sum, a) => sum + Math.sin(a * Math.PI / 180), 0)) / winning.length : 0;
  const determined = winning.length >= ORIENTATION_POLICY.minWords
    && agreement >= ORIENTATION_POLICY.minAgreement && concentration >= ORIENTATION_POLICY.minConcentration;
  return { orientation: determined ? ['upright', 'rotated_90', 'rotated_180', 'rotated_270'][winner] : 'undetermined',
    confidence: angles.length ? agreement * concentration : null, evidenceCount: angles.length };
}
module.exports = { estimateDocumentOrientation, ORIENTATION_POLICY };
