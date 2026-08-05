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

function rawBox(box) {
  if (!box) return null;
  const corners = ['x0', 'y0', 'x1', 'y1'].every((key) => finite(box[key]));
  const legacy = ['x', 'y', 'w', 'h'].every((key) => finite(box[key]));
  if (!corners && !legacy) return null;
  const x = Number(corners ? box.x0 : box.x);
  const y = Number(corners ? box.y0 : box.y);
  const w = Number(corners ? box.x1 - box.x0 : box.w);
  const h = Number(corners ? box.y1 - box.y0 : box.h);
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function normalizePercentBox(box, imageWidth, imageHeight) {
  const raw = rawBox(box);
  if (!raw) return null;
  const unit = String(box?.unit || box?.coordinateSpace || box?.units || '').toLowerCase();
  const pixelCoordinates = ['pixel', 'pixels', 'px', 'image'].includes(unit)
    || raw.x + raw.w > 100.5 || raw.y + raw.h > 100.5;
  let normalized = raw;
  if (pixelCoordinates) {
    if (!finite(imageWidth) || Number(imageWidth) <= 0 || !finite(imageHeight) || Number(imageHeight) <= 0) return null;
    normalized = {
      x: raw.x / Number(imageWidth) * 100,
      y: raw.y / Number(imageHeight) * 100,
      w: raw.w / Number(imageWidth) * 100,
      h: raw.h / Number(imageHeight) * 100
    };
  }
  if (normalized.x < -0.5 || normalized.y < -0.5
    || normalized.x + normalized.w > 100.5 || normalized.y + normalized.h > 100.5) return null;
  const x1 = clamp(normalized.x, 0, 100);
  const y1 = clamp(normalized.y, 0, 100);
  const x2 = clamp(normalized.x + normalized.w, 0, 100);
  const y2 = clamp(normalized.y + normalized.h, 0, 100);
  return x2 > x1 && y2 > y1
    ? { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) }
    : null;
}

function imageGeometry({ imageWidth, imageHeight, correctionCount }, options = {}) {
  const sourceWidth = finite(imageWidth) && Number(imageWidth) > 0 ? Number(imageWidth) : 900;
  const sourceHeight = finite(imageHeight) && Number(imageHeight) > 0 ? Number(imageHeight) : 1200;
  const maxWidthMm = Number(options.maxWidthMm || 180);
  const maxHeightMm = Number(options.maxHeightMm || 218);
  const density = correctionCount === 0 ? 'clean' : correctionCount <= 12 ? 'sparse'
    : correctionCount <= 25 ? 'medium' : 'dense';
  const gutterMm = 0;
  const imageMaxWidth = Math.max(1, maxWidthMm - gutterMm * 2);
  const scale = Math.min(imageMaxWidth / sourceWidth, maxHeightMm / sourceHeight);
  const imageWidthMm = sourceWidth * scale;
  const imageHeightMm = sourceHeight * scale;
  return {
    density,
    sourceWidth,
    sourceHeight,
    stageWidthMm: round(imageWidthMm + gutterMm * 2),
    stageHeightMm: round(imageHeightMm),
    imageXmm: round(gutterMm),
    imageYmm: 0,
    imageWidthMm: round(imageWidthMm),
    imageHeightMm: round(imageHeightMm),
    gutterMm: round(gutterMm),
    sourceAspectRatio: round(sourceWidth / sourceHeight),
    renderedAspectRatio: round(imageWidthMm / imageHeightMm)
  };
}

function mapPercentBoxToStage(box, geometry) {
  const valid = normalizePercentBox(box, geometry.sourceWidth, geometry.sourceHeight);
  if (!valid) return null;
  return {
    x: round(geometry.imageXmm + valid.x / 100 * geometry.imageWidthMm),
    y: round(geometry.imageYmm + valid.y / 100 * geometry.imageHeightMm),
    w: round(valid.w / 100 * geometry.imageWidthMm),
    h: round(valid.h / 100 * geometry.imageHeightMm)
  };
}

function unionBoxes(boxes) {
  if (!Array.isArray(boxes) || !boxes.length) return null;
  const x1 = Math.min(...boxes.map((box) => box.x));
  const y1 = Math.min(...boxes.map((box) => box.y));
  const x2 = Math.max(...boxes.map((box) => box.x + box.w));
  const y2 = Math.max(...boxes.map((box) => box.y + box.h));
  return { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) };
}

function markerDimensions(density, symbol) {
  const textLength = `#00 ${String(symbol || '')}`.length;
  return {
    width: round(Math.max(10.8, Math.min(14.2, 3.7 + textLength * 1.05))),
    height: density === 'dense' ? 3.6 : density === 'medium' ? 3.8 : 4,
    fontPt: density === 'dense' ? 6.5 : 7
  };
}

function readingOrder(a, b) {
  const ay = a.target.y + a.target.h / 2;
  const by = b.target.y + b.target.h / 2;
  const sameLineTolerance = Math.max(a.target.h, b.target.h, 1.5);
  if (Math.abs(ay - by) > sameLineTolerance) return ay - by;
  const ax = a.target.x + a.target.w / 2;
  const bx = b.target.x + b.target.w / 2;
  return ax - bx || String(a.correction.reportId || a.correction.id || '')
    .localeCompare(String(b.correction.reportId || b.correction.id || ''));
}

function sideCapacity(stageHeight, height, minimumGap) {
  return Math.max(1, Math.floor((stageHeight + minimumGap) / (height + minimumGap)));
}

function assignSides(entries, geometry, dimensions, minimumGap) {
  const midpoint = geometry.imageXmm + geometry.imageWidthMm / 2;
  const centerBand = geometry.imageWidthMm * 0.08;
  const capacity = sideCapacity(geometry.stageHeightMm, dimensions.height, minimumGap);
  const sides = { left: [], right: [] };
  const overflow = [];
  for (const entry of entries) {
    const centerX = entry.target.x + entry.target.w / 2;
    const natural = centerX <= midpoint ? 'left' : 'right';
    const alternative = natural === 'left' ? 'right' : 'left';
    const nearCenter = Math.abs(centerX - midpoint) <= centerBand;
    let side = natural;
    if (nearCenter && sides[natural].length > sides[alternative].length) side = alternative;
    if (sides[side].length >= capacity && nearCenter && sides[alternative].length < capacity) side = alternative;
    if (sides[side].length >= capacity) {
      overflow.push(entry);
      continue;
    }
    sides[side].push(entry);
  }
  return { sides, overflow };
}

function placeVertically(entries, stageHeight, dimensions, preferredGap, minimumGap) {
  if (!entries.length) return [];
  const availableGap = entries.length > 1
    ? (stageHeight - entries.length * dimensions.height) / (entries.length - 1)
    : preferredGap;
  const gap = clamp(Math.min(preferredGap, availableGap), minimumGap, preferredGap);
  const maxY = stageHeight - dimensions.height;
  const placed = entries.map((entry) => ({
    entry,
    y: clamp(entry.target.y + entry.target.h / 2 - dimensions.height / 2, 0, maxY)
  }));
  for (let index = 1; index < placed.length; index += 1) {
    placed[index].y = Math.max(placed[index].y, placed[index - 1].y + dimensions.height + gap);
  }
  if (placed[placed.length - 1].y > maxY) {
    placed[placed.length - 1].y = maxY;
    for (let index = placed.length - 2; index >= 0; index -= 1) {
      placed[index].y = Math.min(placed[index].y, placed[index + 1].y - dimensions.height - gap);
    }
  }
  if (placed[0].y < 0) {
    const shift = -placed[0].y;
    placed.forEach((item) => { item.y += shift; });
  }
  return placed.map((item) => ({ ...item, y: round(item.y), gap: round(gap) }));
}

function intersects(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x
    && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

function inside(rect, bounds) {
  return rect.x >= bounds.x && rect.y >= bounds.y
    && rect.x + rect.w <= bounds.x + bounds.w
    && rect.y + rect.h <= bounds.y + bounds.h;
}

function cssPxToMm(px) {
  return round(Number(px) * 25.4 / 96);
}

function localCandidates(entry, dimensions, geometry, minimumGap) {
  const centerX = entry.target.x + entry.target.w / 2;
  const verticalGap = cssPxToMm(3);
  const baseX = centerX - dimensions.width / 2;
  const horizontalOffsets = [0, -4, 4, -7, 7].map(cssPxToMm);
  const aboveY = entry.target.y - verticalGap - dimensions.height;
  const upwardStep = entry.sameTargetIndex
    ? dimensions.height + minimumGap
    : (dimensions.height + minimumGap) / 2;
  const belowY = entry.target.y + entry.target.h + verticalGap;
  const imageMinX = geometry.imageXmm;
  const imageMaxX = geometry.imageXmm + geometry.imageWidthMm - dimensions.width;
  const positions = [];
  const addLevel = (placement, level) => {
    const y = placement === 'below'
      ? belowY + level * upwardStep
      : aboveY - level * upwardStep;
    horizontalOffsets.forEach((requestedOffset, offsetIndex) => {
      const x = clamp(baseX + requestedOffset, imageMinX, imageMaxX);
      positions.push({
        x: round(x),
        y: round(y),
        w: dimensions.width,
        h: dimensions.height,
        placement,
        level,
        localOffsetX: round(x - baseX),
        variant: level === 0 && offsetIndex === 0
          ? 'direct'
          : `${level ? `stack-${level}` : 'shift'}-${requestedOffset < 0 ? 'left' : requestedOffset > 0 ? 'right' : 'center'}`
      });
    });
  };
  const topEdge = aboveY < geometry.imageYmm;
  const placementOrder = topEdge ? ['below', 'above'] : ['above', 'below'];
  placementOrder.forEach((placement) => {
    for (let level = 0; level <= 2; level += 1) addLevel(placement, level);
  });
  return positions;
}

function withinLocalBounds(rect, entry, dimensions) {
  const targetCenterX = entry.target.x + entry.target.w / 2;
  const labelCenterX = rect.x + rect.w / 2;
  const horizontalDistance = Math.abs(labelCenterX - targetCenterX);
  const preferredGap = cssPxToMm(3);
  const verticalDistance = rect.placement === 'below'
    ? rect.y - (entry.target.y + entry.target.h) - preferredGap
    : entry.target.y - (rect.y + rect.h) - preferredGap;
  const maximumVerticalMovement = entry.sameTargetIndex
    ? (dimensions.height + cssPxToMm(1)) * 2
    : dimensions.height + cssPxToMm(1);
  return horizontalDistance <= cssPxToMm(8) + 0.001
    && verticalDistance >= -0.001
    && verticalDistance <= maximumVerticalMovement + 0.001;
}

function localLeader(rect, target, placement) {
  const below = String(placement).startsWith('below');
  const startX = round(rect.x + rect.w / 2);
  const startY = round(below ? rect.y : rect.y + rect.h);
  return {
    annotationId: target.annotationId,
    kind: 'local',
    startX,
    startY,
    endX: round(target.x),
    endY: round(target.y),
    color: target.color
  };
}

function overlapArea(a, b, gap = 0) {
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap);
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap);
  return width * height;
}

function createSubmittedImageLayout(page, options = {}) {
  const allCorrections = Array.isArray(page?.corrections) ? page.corrections : [];
  const geometry = imageGeometry({
    imageWidth: page?.imageWidth,
    imageHeight: page?.imageHeight,
    correctionCount: Number(options.correctionCountOverride ?? allCorrections.length)
  }, options);
  const omitted = [];
  const entries = [];
  for (const correction of allCorrections) {
    const boxes = (Array.isArray(correction?.bboxList) ? correction.bboxList : [])
      .map((box) => normalizePercentBox(box, geometry.sourceWidth, geometry.sourceHeight))
      .filter(Boolean);
    const mappedBoxes = boxes.map((box) => mapPercentBoxToStage(box, geometry)).filter(Boolean);
    const target = unionBoxes(mappedBoxes);
    if (!target) {
      omitted.push({
        annotationId: String(correction?.reportId || correction?.id || ''),
        correction,
        reason: 'Missing or invalid annotation bounding box'
      });
      continue;
    }
    entries.push({ correction, boxes, mappedBoxes, target });
  }
  entries.sort(readingOrder);
  const exactTargetCounts = new Map();
  entries.forEach((entry) => {
    const key = `${round(entry.target.x)}:${round(entry.target.y)}:${round(entry.target.w)}:${round(entry.target.h)}`;
    entry.sameTargetIndex = exactTargetCounts.get(key) || 0;
    exactTargetCounts.set(key, entry.sameTargetIndex + 1);
  });

  const minimumGap = cssPxToMm(1);
  const textObstacles = (Array.isArray(page?.annotationObstacles) ? page.annotationObstacles : [])
    .map((box) => mapPercentBoxToStage(box, geometry)).filter(Boolean);
  const targetObstacles = entries.flatMap((entry) => entry.mappedBoxes);
  const imageBounds = {
    x: geometry.imageXmm,
    y: geometry.imageYmm,
    w: geometry.imageWidthMm,
    h: geometry.imageHeightMm
  };
  const markers = [];
  const localRects = [];
  for (const entry of entries) {
    const dimensions = markerDimensions(geometry.density, entry.correction.symbol);
    const localOptions = localCandidates(entry, dimensions, geometry, minimumGap)
      .filter((rect) => inside(rect, imageBounds)
        && withinLocalBounds(rect, entry, dimensions)
        && !intersects(rect, entry.target, minimumGap));
    const collisionFree = (rect) =>
      !targetObstacles.some((obstacle) => intersects(rect, obstacle, minimumGap))
      && !textObstacles.some((obstacle) => intersects(rect, obstacle, minimumGap))
      && !localRects.some((occupied) => intersects(rect, occupied, minimumGap));
    let candidate = localOptions.find(collisionFree);
    if (!candidate) {
      candidate = localOptions
        .map((rect, index) => ({
          rect,
          score: localRects.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle, minimumGap) * 10000, 0)
            + targetObstacles.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle, minimumGap) * 1000, 0)
            + textObstacles.reduce((sum, obstacle) => sum + overlapArea(rect, obstacle, minimumGap) * 100, 0)
            + index
        }))
        .sort((a, b) => a.score - b.score)[0]?.rect;
    }
    if (!candidate) candidate = localCandidates(entry, dimensions, geometry, minimumGap)[0];
    const rect = { x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h };
    const annotationId = String(entry.correction.reportId || entry.correction.id || '');
    const color = entry.correction.color || ANNOTATION_COLORS[entry.correction.category] || '#536273';
    const target = {
      annotationId,
      color,
      x: round(entry.target.x + entry.target.w / 2),
      y: round(candidate.placement.startsWith('below')
        ? entry.target.y + entry.target.h
        : entry.target.y)
    };
    localRects.push(rect);
    markers.push({
      correction: entry.correction,
      annotationId,
      number: entry.correction.displayNumber,
      symbol: entry.correction.symbol,
      color,
      rect,
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      targetX: target.x,
      targetY: target.y,
      placement: candidate.placement,
      localLevel: candidate.level,
      localOffsetX: candidate.localOffsetX,
      localVariant: candidate.variant,
      side: null,
      fontPt: dimensions.fontPt,
      boxes: entry.mappedBoxes,
      target,
      leader: localLeader(rect, target, candidate.placement)
    });
  }

  markers.sort((a, b) => readingOrder(
    { target: unionBoxes(a.boxes), correction: a.correction },
    { target: unionBoxes(b.boxes), correction: b.correction }
  ));
  const markerIds = new Set(markers.map((marker) => marker.annotationId));
  const underlines = entries.filter((entry) => markerIds.has(String(entry.correction.reportId || entry.correction.id || '')))
    .flatMap((entry) => entry.mappedBoxes.map((box) => ({
      correction: entry.correction,
      color: entry.correction.color || ANNOTATION_COLORS[entry.correction.category] || '#536273',
      box
    })));
  const overflowMarkers = [];
  return { ...geometry, markers, underlines, overflowMarkers, omitted, textObstacles };
}

function createSubmittedImageLayouts(page, options = {}) {
  const original = Array.isArray(page?.corrections) ? page.corrections : [];
  const layouts = [];
  let remaining = original;
  let guard = 0;
  do {
    const layout = createSubmittedImageLayout({ ...page, corrections: remaining }, {
      ...options,
      correctionCountOverride: original.length
    });
    layouts.push(layout);
    const next = layout.overflowMarkers.map((item) => item.correction);
    if (!next.length || next.length >= remaining.length) break;
    remaining = next;
    guard += 1;
  } while (guard < 20);
  return layouts;
}

function percent(value, total) {
  return round(total ? value / total * 100 : 0);
}

function stageStyle(rect, geometry) {
  return {
    left: percent(rect.x, geometry.stageWidthMm),
    top: percent(rect.y, geometry.stageHeightMm),
    width: percent(rect.w, geometry.stageWidthMm),
    height: percent(rect.h, geometry.stageHeightMm)
  };
}

module.exports = {
  ANNOTATION_COLORS,
  normalizePercentBox,
  imageGeometry,
  mapPercentBoxToStage,
  unionBoxes,
  createSubmittedImageLayout,
  createSubmittedImageLayouts,
  markerDimensions,
  stageStyle
};
