'use strict';

const ANNOTATION_COLORS = Object.freeze({
  CONTENT: '#b9474d',
  GRAMMAR: '#287a55',
  ORGANIZATION: '#2f6f9f',
  VOCABULARY: '#7445a2',
  MECHANICS: '#946b00'
});

const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const round = (value) => Math.round(Number(value) * 1000) / 1000;
const overlap = (a, b, gap = 0) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
  && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;

function normalizePercentBox(box) {
  if (!box || !['x', 'y', 'w', 'h'].every((key) => finite(box[key]))) return null;
  const rawX = Number(box.x); const rawY = Number(box.y); const rawW = Number(box.w); const rawH = Number(box.h);
  if (rawW <= 0 || rawH <= 0) return null;
  const x1 = clamp(rawX, 0, 100); const y1 = clamp(rawY, 0, 100);
  const x2 = clamp(rawX + rawW, 0, 100); const y2 = clamp(rawY + rawH, 0, 100);
  return x2 > x1 && y2 > y1 ? { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) } : null;
}

function imageGeometry({ imageWidth, imageHeight, correctionCount }, options = {}) {
  const sourceWidth = finite(imageWidth) && Number(imageWidth) > 0 ? Number(imageWidth) : 900;
  const sourceHeight = finite(imageHeight) && Number(imageHeight) > 0 ? Number(imageHeight) : 1200;
  const maxWidthMm = Number(options.maxWidthMm || 180); const maxHeightMm = Number(options.maxHeightMm || 218);
  const density = correctionCount === 0 ? 'clean' : correctionCount <= 12 ? 'sparse' : correctionCount <= 25 ? 'medium' : 'dense';
  const gutterMm = density === 'clean' ? 0 : 13;
  const imageMaxWidth = maxWidthMm - gutterMm * 2;
  const scale = Math.min(imageMaxWidth / sourceWidth, maxHeightMm / sourceHeight);
  const imageWidthMm = sourceWidth * scale; const imageHeightMm = sourceHeight * scale;
  return { density, sourceWidth, sourceHeight, stageWidthMm: round(imageWidthMm + gutterMm * 2),
    stageHeightMm: round(imageHeightMm), imageXmm: gutterMm, imageYmm: 0,
    imageWidthMm: round(imageWidthMm), imageHeightMm: round(imageHeightMm), gutterMm };
}

function mapPercentBoxToStage(box, geometry) {
  const valid = normalizePercentBox(box); if (!valid) return null;
  return {
    x: round(geometry.imageXmm + valid.x / 100 * geometry.imageWidthMm),
    y: round(geometry.imageYmm + valid.y / 100 * geometry.imageHeightMm),
    w: round(valid.w / 100 * geometry.imageWidthMm),
    h: round(valid.h / 100 * geometry.imageHeightMm)
  };
}

function nearestSlots(desiredY, markerHeight, stageHeight, gap) {
  const step = markerHeight + gap; const slots = [];
  for (let y = 0; y <= stageHeight - markerHeight + 0.001; y += step) slots.push(round(y));
  return slots.sort((a, b) => Math.abs((a + markerHeight / 2) - desiredY)
    - Math.abs((b + markerHeight / 2) - desiredY) || a - b);
}

function markerDimensions(density, symbol, useNumberOnly = false) {
  if (useNumberOnly) {
    return { width: round(7.8), height: density === 'dense' ? 3.2 : density === 'medium' ? 3.5 : 3.8,
      fontPt: density === 'dense' ? 5.8 : density === 'medium' ? 6.2 : 6.6 };
  }
  const textLength = `#00 ${String(symbol || '')}`.length;
  const baseWidth = density === 'dense' ? 11.6 : 12.2;
  return { width: round(Math.max(baseWidth, Math.min(12.5, 7.2 + textLength * 0.62))),
    height: density === 'dense' ? 3.65 : density === 'medium' ? 3.9 : 4.2,
    fontPt: density === 'dense' ? 5.1 : density === 'medium' ? 5.4 : 5.8 };
}

function generateLocalCandidates(target, dimensions, geometry, gap = 0.8) {
  const candidates = [
    { placement: 'above-right', x: target.x + target.w - dimensions.width * 0.25, y: target.y - dimensions.height - gap },
    { placement: 'above-center', x: target.x + target.w / 2 - dimensions.width / 2, y: target.y - dimensions.height - gap },
    { placement: 'right', x: target.x + target.w + gap, y: target.y + target.h / 2 - dimensions.height / 2 },
    { placement: 'below-right', x: target.x + target.w - dimensions.width * 0.25, y: target.y + target.h + gap },
    { placement: 'above-left', x: target.x - dimensions.width * 0.75, y: target.y - dimensions.height - gap },
    { placement: 'below-left', x: target.x - dimensions.width * 0.75, y: target.y + target.h + gap },
    { placement: 'left', x: target.x - dimensions.width - gap, y: target.y + target.h / 2 - dimensions.height / 2 }
  ];
  return candidates.map((c) => ({
    ...c,
    x: round(c.x),
    y: round(c.y)
  }));
}

function calculateTightTargetRect(boxes) {
  if (!boxes || boxes.length === 0) return null;
  if (boxes.length === 1) return { ...boxes[0] };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.w));
  const maxY = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: round(minX), y: round(minY), w: round(maxX - minX), h: round(maxY - minY) };
}

function selectPrimaryAnchorBox(boxes) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  return { ...boxes[0] };
}

function distanceFromTarget(candidateRect, targetRect) {
  const candidateCenterX = candidateRect.x + candidateRect.w / 2;
  const candidateCenterY = candidateRect.y + candidateRect.h / 2;
  const targetCenterX = targetRect.x + targetRect.w / 2;
  const targetCenterY = targetRect.y + targetRect.h / 2;
  return Math.sqrt(Math.pow(candidateCenterX - targetCenterX, 2) + Math.pow(candidateCenterY - targetCenterY, 2));
}

function scoreCandidate(candidateRect, targetRect, currentTargetBoxes, otherCorrectionBoxes, textObstacles, placedMarkers, markerGap, dimensions) {
  const DISTANCE_WEIGHT = 10.0;
  const OVERLAP_PENALTY = 50.0;
  const MARKER_COLLISION_PENALTY = 40.0;
  const OTHER_CORRECTION_PENALTY = 35.0;
  const HANDWRITING_PENALTY = 15.0;
  const BOUNDARY_PENALTY = 20.0;
  
  const distance = distanceFromTarget(candidateRect, targetRect);
  let score = distance * DISTANCE_WEIGHT;
  
  // HARD REJECT: overlaps current target word significantly
  const overlapsCurrentTarget = currentTargetBoxes.some((box) => overlap(candidateRect, box, 0.5));
  if (overlapsCurrentTarget) score += OVERLAP_PENALTY;
  
  // HARD REJECT: overlaps another marker significantly
  const overlapsMarker = placedMarkers.some((marker) => overlap(candidateRect, marker.rect, markerGap));
  if (overlapsMarker) score += MARKER_COLLISION_PENALTY;
  
  // STRONG PENALTY: overlaps another correction target
  const overlapsOtherCorrection = otherCorrectionBoxes.some((box) => overlap(candidateRect, box, 0.5));
  if (overlapsOtherCorrection) score += OTHER_CORRECTION_PENALTY;
  
  // SOFT PENALTY: overlaps generic handwriting/text obstacle slightly
  const overlapsTextObstacle = textObstacles.some((box) => overlap(candidateRect, box, 0.65));
  if (overlapsTextObstacle) score += HANDWRITING_PENALTY;
  
  return score;
}

function applyNudges(candidate, dimensions, nudges) {
  return nudges.map((nudge) => ({
    placement: candidate.placement,
    x: round(candidate.x + (nudge.dx || 0)),
    y: round(candidate.y + (nudge.dy || 0))
  }));
}

function findNearestTargetEdge(rect, targetRect) {
  const rectCenterX = rect.x + rect.w / 2;
  const rectCenterY = rect.y + rect.h / 2;
  const targetCenterX = targetRect.x + targetRect.w / 2;
  const targetCenterY = targetRect.y + targetRect.h / 2;
  
  const leftDist = Math.abs(rectCenterX - targetRect.x);
  const rightDist = Math.abs(rectCenterX - (targetRect.x + targetRect.w));
  const topDist = Math.abs(rectCenterY - targetRect.y);
  const bottomDist = Math.abs(rectCenterY - (targetRect.y + targetRect.h));
  
  const minDist = Math.min(leftDist, rightDist, topDist, bottomDist);
  
  if (minDist === leftDist) return { x: targetRect.x, y: targetCenterY };
  if (minDist === rightDist) return { x: targetRect.x + targetRect.w, y: targetCenterY };
  if (minDist === topDist) return { x: targetCenterX, y: targetRect.y };
  return { x: targetCenterX, y: targetRect.y + targetRect.h };
}

function findBestLocalPlacement({ targetRect, dimensions, geometry, currentTargetBoxes, otherCorrectionBoxes, textObstacles, placedMarkers, markerGap, maxDistanceMm, nudges }) {
  const localCandidates = generateLocalCandidates(targetRect, dimensions, geometry, 0.8);
  let bestCandidate = null;
  let bestScore = Infinity;
  
  for (const candidate of localCandidates) {
    const nudgedCandidates = applyNudges(candidate, dimensions, nudges);
    
    for (const nudged of nudgedCandidates) {
      const candidateRect = { x: nudged.x, y: nudged.y, w: dimensions.width, h: dimensions.height };
      const inBounds = candidateRect.x >= geometry.imageXmm && candidateRect.x + dimensions.width <= geometry.imageXmm + geometry.imageWidthMm
        && candidateRect.y >= geometry.imageYmm && candidateRect.y + dimensions.height <= geometry.imageYmm + geometry.imageHeightMm;
      
      // HARD REJECT: outside image
      if (!inBounds) continue;
      
      // HARD REJECT: overlaps current target word significantly
      const overlapsCurrentTarget = currentTargetBoxes.some((box) => overlap(candidateRect, box, 0.5));
      if (overlapsCurrentTarget) continue;
      
      // HARD REJECT: overlaps another marker significantly
      const overlapsMarker = placedMarkers.some((marker) => overlap(candidateRect, marker.rect, markerGap));
      if (overlapsMarker) continue;

      // OCR words are occupied regions. A nearby badge is useful only when it
      // sits in actual whitespace; otherwise the gutter is the safe fallback.
      const overlapsOcrWord = textObstacles.some((box) => overlap(candidateRect, box, 0.25));
      if (overlapsOcrWord) continue;
      
      const distance = distanceFromTarget(candidateRect, targetRect);
      if (distance <= maxDistanceMm) {
        const score = scoreCandidate(candidateRect, targetRect, currentTargetBoxes, otherCorrectionBoxes, textObstacles, placedMarkers, markerGap, dimensions);
        if (score < bestScore) {
          bestScore = score;
          bestCandidate = { rect: candidateRect, placement: candidate.placement, distance };
        }
      }
    }
  }
  
  return bestCandidate;
}

function createSubmittedImageLayout(page, options = {}) {
  const DEBUG = process.env.DEBUG_ANNOTATION_LAYOUT === 'true';
  const MAX_LOCAL_DISTANCE_MM = 8;
  const NUDGES = [
    { dx: 0, dy: 0 },
    { dx: 0, dy: 1.5 },
    { dx: 0, dy: -1.5 },
    { dx: 0, dy: 3 },
    { dx: 0, dy: -3 },
    { dx: 2, dy: 0 },
    { dx: -2, dy: 0 }
  ];
  
  const corrections = (Array.isArray(page?.corrections) ? page.corrections : []).map((correction) => {
    const boxes = (Array.isArray(correction?.bboxList) ? correction.bboxList : []).map(normalizePercentBox).filter(Boolean);
    return { correction, boxes };
  }).filter((entry) => entry.boxes.length);
  const geometry = imageGeometry({ imageWidth: page?.imageWidth, imageHeight: page?.imageHeight,
    correctionCount: corrections.length }, options);
  const mapped = corrections.map((entry) => ({ ...entry,
    mappedBoxes: entry.boxes.map((box) => mapPercentBoxToStage(box, geometry)).filter(Boolean) }));
  const obstacles = mapped.flatMap((entry) => entry.mappedBoxes);
  const textObstacles = (Array.isArray(page?.annotationObstacles) ? page.annotationObstacles : [])
    .map((box) => mapPercentBoxToStage(box, geometry)).filter(Boolean);
  const sorted = mapped.sort((a, b) => {
    const aa = a.mappedBoxes[0]; const bb = b.mappedBoxes[0];
    return (aa.y + aa.h / 2) - (bb.y + bb.h / 2) || (aa.x + aa.w / 2) - (bb.x + bb.w / 2)
      || String(a.correction.reportId || a.correction.id || '').localeCompare(String(b.correction.reportId || b.correction.id || ''));
  });
  const placed = []; const overflowMarkers = []; const markerGap = geometry.density === 'dense' ? 0.55 : 0.8;
  const correctionCount = corrections.length;
  const densityMode = correctionCount <= 10 ? 'LOW' : correctionCount <= 20 ? 'MEDIUM' : 'HIGH';

  for (const entry of sorted) {
    // BUG 1 FIX: Use primary anchor box for marker placement, not union of all boxes
    const primaryAnchorBox = selectPrimaryAnchorBox(entry.mappedBoxes);
    if (!primaryAnchorBox) continue;
    
    // Keep entry.mappedBoxes intact for underlines
    const currentTargetBoxes = entry.mappedBoxes;
    
    // Separate other correction boxes for collision model
    const otherCorrectionBoxes = mapped
      .filter(other => other !== entry)
      .flatMap(other => other.mappedBoxes);
    
    // BUG 2 FIX: Start HIGH density with number-only immediately
    const useNumberOnlyInitially = densityMode === 'HIGH';
    let useNumberOnly = useNumberOnlyInitially;
    let dimensions = markerDimensions(geometry.density, entry.correction.symbol, useNumberOnly);
    
    const targetCenterX = primaryAnchorBox.x + primaryAnchorBox.w / 2;
    const targetCenterY = primaryAnchorBox.y + primaryAnchorBox.h / 2;
    let rectangle = null; let placement = null; let finalDistance = null;

    // BUG 3 FIX: Use unified placement function that regenerates candidates with current dimensions
    let bestCandidate = findBestLocalPlacement({
      targetRect: primaryAnchorBox,
      dimensions,
      geometry,
      currentTargetBoxes,
      otherCorrectionBoxes,
      textObstacles,
      placedMarkers: placed,
      markerGap,
      maxDistanceMm: MAX_LOCAL_DISTANCE_MM,
      nudges: NUDGES
    });
    
    if (bestCandidate) {
      rectangle = bestCandidate.rect;
      placement = bestCandidate.placement;
      finalDistance = bestCandidate.distance;
    } else if (!useNumberOnly) {
      // Fallback to number-only if not already tried
      useNumberOnly = true;
      dimensions = markerDimensions(geometry.density, entry.correction.symbol, true);
      
      // BUG 3 FIX: Regenerate candidates with new dimensions
      bestCandidate = findBestLocalPlacement({
        targetRect: primaryAnchorBox,
        dimensions,
        geometry,
        currentTargetBoxes,
        otherCorrectionBoxes,
        textObstacles,
        placedMarkers: placed,
        markerGap,
        maxDistanceMm: MAX_LOCAL_DISTANCE_MM,
        nudges: NUDGES
      });
      
      if (bestCandidate) {
        rectangle = bestCandidate.rect;
        placement = bestCandidate.placement;
        finalDistance = bestCandidate.distance;
      }
    }

    // Gutter fallback - absolute last resort
    if (!rectangle) {
      const preferred = targetCenterX <= geometry.imageXmm + geometry.imageWidthMm / 2 ? 'gutter-left' : 'gutter-right';
      for (const side of [preferred, preferred === 'gutter-left' ? 'gutter-right' : 'gutter-left']) {
        const x = side === 'gutter-left' ? Math.max(0, geometry.imageXmm - dimensions.width - 0.45)
          : Math.min(geometry.stageWidthMm - dimensions.width, geometry.imageXmm + geometry.imageWidthMm + 0.45);
        const y = nearestSlots(targetCenterY, dimensions.height, geometry.stageHeightMm, markerGap)
          .find((slot) => !placed.some((marker) => overlap({ x, y: slot, w: dimensions.width, h: dimensions.height }, marker.rect, markerGap)));
        if (y !== undefined) { rectangle = { x, y, w: dimensions.width, h: dimensions.height }; placement = side; break; }
      }
    }
    const color = ANNOTATION_COLORS[entry.correction.category] || '#536273';
    if (!rectangle) { overflowMarkers.push({ correction: entry.correction, color }); continue; }
    
    const targetText = entry.mappedBoxes.length === 1 
      ? (entry.correction.quotedText || '') 
      : (entry.correction.quotedText || '');
    
    const marker = { correction: entry.correction, color, rect: Object.fromEntries(Object.entries(rectangle).map(([key, value]) => [key, round(value)])),
      placement, fontPt: dimensions.fontPt, target: { x: round(targetCenterX), y: round(primaryAnchorBox.y + primaryAnchorBox.h) }, boxes: entry.mappedBoxes, useNumberOnly };
    
    if (placement === 'gutter-left' || placement === 'gutter-right') {
      // Leader line targets primary anchor box, not union
      const nearestEdge = findNearestTargetEdge(rectangle, primaryAnchorBox);
      marker.leader = { 
        x1: placement === 'gutter-left' ? rectangle.x + rectangle.w : rectangle.x,
        y1: rectangle.y + rectangle.h / 2, 
        x2: nearestEdge.x, 
        y2: nearestEdge.y 
      };
    }
    
    if (DEBUG) {
      const distanceMm = finalDistance !== null ? `${finalDistance.toFixed(1)}mm` : 'N/A';
      const gutterUsed = placement?.startsWith('gutter') ? 'true' : 'false';
      console.log(`#${String(entry.correction.displayNumber || '?').padStart(2, '0')} ${entry.correction.symbol || ''}`);
      console.log(`  targetText: "${targetText}"`);
      console.log(`  wordIds: [${entry.correction.wordIds?.slice(0, 3).join(', ') || 'none'}${entry.correction.wordIds?.length > 3 ? '...' : ''}]`);
      console.log(`  bboxList: ${entry.mappedBoxes.length} boxes`);
      console.log(`  primaryAnchorBox: x=${primaryAnchorBox.x.toFixed(1)}, y=${primaryAnchorBox.y.toFixed(1)}, w=${primaryAnchorBox.w.toFixed(1)}, h=${primaryAnchorBox.h.toFixed(1)}`);
      console.log(`  placement: ${placement}`);
      console.log(`  distance: ${distanceMm}`);
      console.log(`  gutter fallback: ${gutterUsed}`);
      console.log(`  useNumberOnly: ${useNumberOnly}`);
      if (finalDistance !== null && finalDistance > 10) {
        console.warn(`  WARNING: Distance ${finalDistance.toFixed(1)}mm exceeds 10mm threshold`);
      }
    }
    
    placed.push(marker);
  }

  return { ...geometry, textObstacles, underlines: mapped.flatMap((entry) => entry.mappedBoxes.map((box) => ({
    correction: entry.correction, color: ANNOTATION_COLORS[entry.correction.category] || '#536273', box
  }))), markers: placed, overflowMarkers };
}

function percent(value, total) { return round(total ? value / total * 100 : 0); }
function stageStyle(rect, geometry) { return { left: percent(rect.x, geometry.stageWidthMm), top: percent(rect.y, geometry.stageHeightMm),
  width: percent(rect.w, geometry.stageWidthMm), height: percent(rect.h, geometry.stageHeightMm) }; }

module.exports = { ANNOTATION_COLORS, normalizePercentBox, imageGeometry, mapPercentBoxToStage,
  createSubmittedImageLayout, markerDimensions, stageStyle };
