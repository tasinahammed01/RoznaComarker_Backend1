"use strict";

const ANNOTATION_COLORS = Object.freeze({
  CONTENT: "#b9474d",
  GRAMMAR: "#287a55",
  ORGANIZATION: "#2f6f9f",
  VOCABULARY: "#7445a2",
  MECHANICS: "#946b00",
});

const finite = (value) => Number.isFinite(Number(value));
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value)));
const round = (value) => Math.round(Number(value) * 1000) / 1000;

function rawBox(box) {
  if (!box) return null;
  const corners = ["x0", "y0", "x1", "y1"].every((key) => finite(box[key]));
  const legacy = ["x", "y", "w", "h"].every((key) => finite(box[key]));
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
  const unit = String(
    box?.unit || box?.coordinateSpace || box?.units || "",
  ).toLowerCase();
  const pixelCoordinates =
    ["pixel", "pixels", "px", "image"].includes(unit) ||
    raw.x + raw.w > 100.5 ||
    raw.y + raw.h > 100.5;
  let normalized = raw;
  if (pixelCoordinates) {
    if (
      !finite(imageWidth) ||
      Number(imageWidth) <= 0 ||
      !finite(imageHeight) ||
      Number(imageHeight) <= 0
    )
      return null;
    normalized = {
      x: (raw.x / Number(imageWidth)) * 100,
      y: (raw.y / Number(imageHeight)) * 100,
      w: (raw.w / Number(imageWidth)) * 100,
      h: (raw.h / Number(imageHeight)) * 100,
    };
  }
  if (
    normalized.x < -0.5 ||
    normalized.y < -0.5 ||
    normalized.x + normalized.w > 100.5 ||
    normalized.y + normalized.h > 100.5
  )
    return null;
  const x1 = clamp(normalized.x, 0, 100);
  const y1 = clamp(normalized.y, 0, 100);
  const x2 = clamp(normalized.x + normalized.w, 0, 100);
  const y2 = clamp(normalized.y + normalized.h, 0, 100);
  return x2 > x1 && y2 > y1
    ? { x: round(x1), y: round(y1), w: round(x2 - x1), h: round(y2 - y1) }
    : null;
}

function imageGeometry(
  { imageWidth, imageHeight, correctionCount },
  options = {},
) {
  const sourceWidth =
    finite(imageWidth) && Number(imageWidth) > 0 ? Number(imageWidth) : 900;
  const sourceHeight =
    finite(imageHeight) && Number(imageHeight) > 0 ? Number(imageHeight) : 1200;
  const maxWidthMm = Number(options.maxWidthMm || 180);
  const maxHeightMm = Number(options.maxHeightMm || 218);
  const density =
    correctionCount === 0
      ? "clean"
      : correctionCount <= 12
        ? "sparse"
        : correctionCount <= 25
          ? "medium"
          : "dense";
  const gutterMm = 0;
  const imageMaxWidth = Math.max(1, maxWidthMm - gutterMm * 2);
  const scale = Math.min(
    imageMaxWidth / sourceWidth,
    maxHeightMm / sourceHeight,
  );
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
    renderedAspectRatio: round(imageWidthMm / imageHeightMm),
  };
}

function mapPercentBoxToStage(box, geometry) {
  const valid = normalizePercentBox(
    box,
    geometry.sourceWidth,
    geometry.sourceHeight,
  );
  if (!valid) return null;
  return {
    x: round(geometry.imageXmm + (valid.x / 100) * geometry.imageWidthMm),
    y: round(geometry.imageYmm + (valid.y / 100) * geometry.imageHeightMm),
    w: round((valid.w / 100) * geometry.imageWidthMm),
    h: round((valid.h / 100) * geometry.imageHeightMm),
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

const TEXT_PROTECTION_MARGIN_MM = 0.55;
const MARKER_COLLISION_GAP_MM = 0.2;
const MARKER_ANCHOR_Y_RATIO = 0.08;
const MARKER_WORD_SAFE_GAP_MM = 0.05;
const LOCAL_TEXT_COLLISION_PADDING_MM = 0.12;
const OWN_TARGET_TOP_ALLOWANCE_RATIO = 0.32;
const MAX_TARGET_RAISE_MM = 2;
const MAX_LOCAL_HORIZONTAL_SHIFT_MM = 10;
const LOCAL_MARKER_EXTRA_RAISE_MM = 0.75;
const MINIMUM_BUBBLE_DIAMETER_MM = 3.0;
const BUBBLE_DIAMETERS_MM = Object.freeze([
  3.6,
  3.3,
  MINIMUM_BUBBLE_DIAMETER_MM,
]);
const LOCAL_MARKER_GAP_MM = cssPxToMm(0.1);

function markerDimensions(diameter = 3.8) {
  const safeDiameter =
    finite(diameter) && Number(diameter) > 0
      ? Number(diameter)
      : 3.8;
  return {
    diameter: safeDiameter,
    width: safeDiameter,
    height: safeDiameter,
    fontPt: 3.8,
  };
}

function markerLabel(correction) {
  const displayNumber = finite(correction?.displayNumber)
    ? String(Number(correction.displayNumber))
    : "";
  return `${displayNumber} ${String(correction?.symbol || "").trim()}`.trim();
}

function anchoredMarkerDimensions(correction, diameter) {
  const base = markerDimensions(diameter);
  const label = markerLabel(correction);
  return {
    ...base,
    width: round(Math.max(base.width, 2 + label.length * 1.05)),
    label,
  };
}

function readingOrder(a, b) {
  const ay = a.target.y + a.target.h / 2;
  const by = b.target.y + b.target.h / 2;
  const sameLineTolerance = Math.max(a.target.h, b.target.h, 1.5);
  if (Math.abs(ay - by) > sameLineTolerance) return ay - by;
  const ax = a.target.x + a.target.w / 2;
  const bx = b.target.x + b.target.w / 2;
  return (
    ax - bx ||
    String(a.correction.reportId || a.correction.id || "").localeCompare(
      String(b.correction.reportId || b.correction.id || ""),
    )
  );
}

function sideCapacity(stageHeight, height, minimumGap) {
  return Math.max(
    1,
    Math.floor((stageHeight + minimumGap) / (height + minimumGap)),
  );
}

function assignSides(entries, geometry, dimensions, minimumGap) {
  const midpoint = geometry.imageXmm + geometry.imageWidthMm / 2;
  const centerBand = geometry.imageWidthMm * 0.08;
  const capacity = sideCapacity(
    geometry.stageHeightMm,
    dimensions.height,
    minimumGap,
  );
  const sides = { left: [], right: [] };
  const overflow = [];
  for (const entry of entries) {
    const centerX = entry.target.x + entry.target.w / 2;
    const natural = centerX <= midpoint ? "left" : "right";
    const alternative = natural === "left" ? "right" : "left";
    const nearCenter = Math.abs(centerX - midpoint) <= centerBand;
    let side = natural;
    if (nearCenter && sides[natural].length > sides[alternative].length)
      side = alternative;
    if (
      sides[side].length >= capacity &&
      nearCenter &&
      sides[alternative].length < capacity
    )
      side = alternative;
    if (sides[side].length >= capacity) {
      overflow.push(entry);
      continue;
    }
    sides[side].push(entry);
  }
  return { sides, overflow };
}

function placeVertically(
  entries,
  stageHeight,
  dimensions,
  preferredGap,
  minimumGap,
) {
  if (!entries.length) return [];
  const availableGap =
    entries.length > 1
      ? (stageHeight - entries.length * dimensions.height) /
      (entries.length - 1)
      : preferredGap;
  const gap = clamp(
    Math.min(preferredGap, availableGap),
    minimumGap,
    preferredGap,
  );
  const maxY = stageHeight - dimensions.height;
  const placed = entries.map((entry) => ({
    entry,
    y: clamp(
      entry.target.y + entry.target.h / 2 - dimensions.height / 2,
      0,
      maxY,
    ),
  }));
  for (let index = 1; index < placed.length; index += 1) {
    placed[index].y = Math.max(
      placed[index].y,
      placed[index - 1].y + dimensions.height + gap,
    );
  }
  if (placed[placed.length - 1].y > maxY) {
    placed[placed.length - 1].y = maxY;
    for (let index = placed.length - 2; index >= 0; index -= 1) {
      placed[index].y = Math.min(
        placed[index].y,
        placed[index + 1].y - dimensions.height - gap,
      );
    }
  }
  if (placed[0].y < 0) {
    const shift = -placed[0].y;
    placed.forEach((item) => {
      item.y += shift;
    });
  }
  return placed.map((item) => ({ ...item, y: round(item.y), gap: round(gap) }));
}

function intersects(a, b, gap = 0) {
  return (
    a.x < b.x + b.w + gap &&
    a.x + a.w + gap > b.x &&
    a.y < b.y + b.h + gap &&
    a.y + a.h + gap > b.y
  );
}

function intersectionArea(a, b) {
  const width = Math.max(
    0,
    Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
  );
  const height = Math.max(
    0,
    Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
  );
  return width * height;
}

function scoreFallbackCandidate(
  rect,
  primaryRect,
  ownTarget,
  protectedRects,
  placedMarkers,
) {
  const ownTargetPenalty =
    intersectionArea(rect, protectedOwnTargetRect(ownTarget)) * 1000000;
  const unrelatedTextPenalty = protectedRects.reduce((penalty, wordRect) => {
    if (intersects(wordRect, ownTarget, -0.01)) return penalty;
    const paddedWordRect = {
      x: wordRect.x - LOCAL_TEXT_COLLISION_PADDING_MM,
      y: wordRect.y - LOCAL_TEXT_COLLISION_PADDING_MM,
      w: wordRect.w + LOCAL_TEXT_COLLISION_PADDING_MM * 2,
      h: wordRect.h + LOCAL_TEXT_COLLISION_PADDING_MM * 2,
    };
    return penalty + intersectionArea(rect, paddedWordRect) * 100000;
  }, 0);
  const markerPenalty = placedMarkers.reduce(
    (penalty, placed) => penalty + intersectionArea(rect, placed) * 100000,
    0,
  );
  const distancePenalty = Math.hypot(
    rect.x - primaryRect.x,
    rect.y - primaryRect.y,
  );
  return ownTargetPenalty + unrelatedTextPenalty + markerPenalty + distancePenalty;
}

function inside(rect, bounds) {
  return (
    rect.x >= bounds.x &&
    rect.y >= bounds.y &&
    rect.x + rect.w <= bounds.x + bounds.w &&
    rect.y + rect.h <= bounds.y + bounds.h
  );
}

function markerOverlapsPlaced(rect, placedMarkers) {
  return placedMarkers.some((placed) =>
    intersects(rect, placed, MARKER_COLLISION_GAP_MM),
  );
}

function protectedOwnTargetRect(ownTarget) {
  return {
    x: ownTarget.x,
    y: ownTarget.y + ownTarget.h * OWN_TARGET_TOP_ALLOWANCE_RATIO,
    w: ownTarget.w,
    h: ownTarget.h * (1 - OWN_TARGET_TOP_ALLOWANCE_RATIO),
  };
}

function markerCoversUnrelatedWord(rect, protectedRects, ownTarget) {
  const protectedOwnTarget = protectedOwnTargetRect(ownTarget);
  if (intersects(rect, protectedOwnTarget)) return true;

  return protectedRects.some((wordRect) => {
    // The target is checked explicitly above with the word-safe gap. Avoid
    // treating duplicate/overlapping OCR boxes for that same word twice.
    const isOwnTarget = intersects(wordRect, ownTarget, -0.01);
    if (isOwnTarget) {
      return false;
    }

    return intersects(rect, wordRect, LOCAL_TEXT_COLLISION_PADDING_MM);
  });
}

function cssPxToMm(px) {
  return round((Number(px) * 25.4) / 96);
}

function contrastTextColor(color) {
  const value = String(color || "").trim();
  const match = /^#([0-9a-f]{6})$/i.exec(value);
  if (!match) return "#ffffff";
  const rgb = [0, 2, 4]
    .map((offset) => parseInt(match[1].slice(offset, offset + 2), 16) / 255)
    .map((channel) =>
      channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  const luminance = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  return luminance > 0.48 ? "#17212b" : "#ffffff";
}

function circleIntersectsRect(circle, rect, margin = 0) {
  const left = rect.x - margin;
  const top = rect.y - margin;
  const right = rect.x + rect.w + margin;
  const bottom = rect.y + rect.h + margin;
  const closestX = clamp(circle.cx, left, right);
  const closestY = clamp(circle.cy, top, bottom);
  const dx = circle.cx - closestX;
  const dy = circle.cy - closestY;
  return dx * dx + dy * dy <= circle.radius * circle.radius;
}

function circleIntersectsCircle(a, b, gap = 0) {
  const dx = a.cx - b.cx;
  const dy = a.cy - b.cy;
  const minimumDistance = a.radius + b.radius + gap;
  return dx * dx + dy * dy < minimumDistance * minimumDistance;
}

function circleInsideBounds(circle, bounds, margin = 0) {
  return (
    circle.cx - circle.radius - margin >= bounds.x &&
    circle.cy - circle.radius - margin >= bounds.y &&
    circle.cx + circle.radius + margin <= bounds.x + bounds.w &&
    circle.cy + circle.radius + margin <= bounds.y + bounds.h
  );
}

function bubbleCandidate(cx, cy, dimensions, variant, ring, target) {
  const radius = dimensions.diameter / 2;
  return {
    cx: round(cx),
    cy: round(cy),
    radius,
    x: round(cx - radius),
    y: round(cy - radius),
    w: dimensions.diameter,
    h: dimensions.diameter,
    placement: variant,
    level: ring,
    localOffsetX: round(cx - (target.x + target.w / 2)),
    localOffsetY: round(cy - (target.y + target.h / 2)),
    variant,
  };
}

function buildLocalBubbleCandidates(entry, dimensions, level = 0) {
  const target = entry.target;
  const centerX = target.x + target.w / 2;

  // Keep the marker attached to the upper part of its exact wrong word.
  const baseY =
    target.y +
    target.h * 0.15 -
    dimensions.height / 2;

  // Small local movement only.
  const horizontalStep = dimensions.width + MARKER_COLLISION_GAP_MM;
  const verticalStep = dimensions.height + MARKER_COLLISION_GAP_MM;
  const y = baseY - level * verticalStep;

  return [
    {
      x: round(centerX - dimensions.width / 2),
      y: round(y),
      w: dimensions.width,
      h: dimensions.height,
      placement: "above",
      level: level + 1,
      variant: "above",
    },
    {
      x: round(centerX - dimensions.width / 2 - horizontalStep),
      y: round(y),
      w: dimensions.width,
      h: dimensions.height,
      placement: "above-left",
      level: level + 1,
      variant: "above-left",
    },
    {
      x: round(centerX - dimensions.width / 2 + horizontalStep),
      y: round(y),
      w: dimensions.width,
      h: dimensions.height,
      placement: "above-right",
      level: level + 1,
      variant: "above-right",
    },
  ];
}

function buildSameLineBlankCandidates(entry, dimensions) {
  const target = entry.target;
  const radius = dimensions.diameter / 2;
  const gap = TEXT_PROTECTION_MARGIN_MM + 0.02;
  const centerX = target.x + target.w / 2;
  const centerY = target.y + target.h / 2;
  const immediateLeft = target.x - radius - gap;
  const immediateRight = target.x + target.w + radius + gap;
  const immediateAbove = target.y - radius - gap;
  const immediateBelow = target.y + target.h + radius + gap;
  const offsets = [
    dimensions.diameter * 0.5,
    dimensions.diameter,
    dimensions.diameter * 1.4,
  ];
  const candidates = [];
  offsets.forEach((offset, index) => {
    candidates.push(
      bubbleCandidate(
        immediateRight + offset,
        centerY,
        dimensions,
        `right-blank-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        immediateLeft - offset,
        centerY,
        dimensions,
        `left-blank-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        immediateRight,
        centerY - offset,
        dimensions,
        `right-up-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        immediateLeft,
        centerY - offset,
        dimensions,
        `left-up-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        immediateRight,
        centerY + offset,
        dimensions,
        `right-down-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        immediateLeft,
        centerY + offset,
        dimensions,
        `left-down-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        centerX + offset,
        immediateAbove,
        dimensions,
        `above-shift-right-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        centerX - offset,
        immediateAbove,
        dimensions,
        `above-shift-left-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        centerX + offset,
        immediateBelow,
        dimensions,
        `below-shift-right-${index + 1}`,
        3,
        target,
      ),
      bubbleCandidate(
        centerX - offset,
        immediateBelow,
        dimensions,
        `below-shift-left-${index + 1}`,
        3,
        target,
      ),
    );
  });
  return candidates;
}

function buildNearestBlankCandidates(entry, dimensions) {
  const target = entry.target;
  const maximumDistance = 4.8 * 1.5;
  const step = dimensions.diameter * 0.35;
  const candidates = [];
  for (
    let cy = target.y - maximumDistance;
    cy <= target.y + target.h + maximumDistance;
    cy += step
  ) {
    for (
      let cx = target.x - maximumDistance;
      cx <= target.x + target.w + maximumDistance;
      cx += step
    ) {
      const nearest = nearestTargetPoint({ cx, cy }, target);
      const edgeDistance = Math.max(
        0,
        Math.hypot(cx - nearest.x, cy - nearest.y) - dimensions.diameter / 2,
      );
      if (edgeDistance > maximumDistance) continue;
      const candidate = bubbleCandidate(
        cx,
        cy,
        dimensions,
        "nearest-blank",
        4,
        target,
      );
      const sameLineDistance =
        cy >= target.y && cy <= target.y + target.h
          ? 0
          : Math.min(
            Math.abs(cy - target.y),
            Math.abs(cy - (target.y + target.h)),
          );
      candidates.push({ candidate, edgeDistance, sameLineDistance });
    }
  }
  return candidates
    .sort(
      (a, b) =>
        a.sameLineDistance - b.sameLineDistance ||
        a.edgeDistance - b.edgeDistance ||
        a.candidate.cy - b.candidate.cy ||
        a.candidate.cx - b.candidate.cx,
    )
    .map((item) => item.candidate);
}

function buildPageBlankCandidates(entry, dimensions, imageBounds) {
  const radius = dimensions.diameter / 2;
  const step = Math.max(0.5, radius / 2);
  const targetCenterX = entry.target.x + entry.target.w / 2;
  const targetCenterY = entry.target.y + entry.target.h / 2;
  const candidates = [];
  for (
    let cy = imageBounds.y + radius;
    cy <= imageBounds.y + imageBounds.h - radius;
    cy += step
  ) {
    for (
      let cx = imageBounds.x + radius;
      cx <= imageBounds.x + imageBounds.w - radius;
      cx += step
    ) {
      const candidate = bubbleCandidate(
        cx,
        cy,
        dimensions,
        "nearest-blank",
        5,
        entry.target,
      );
      candidates.push({
        candidate,
        lineDistance: Math.abs(cy - targetCenterY),
        targetDistance: Math.hypot(cx - targetCenterX, cy - targetCenterY),
      });
    }
  }
  return candidates
    .sort(
      (a, b) =>
        a.lineDistance - b.lineDistance ||
        a.targetDistance - b.targetDistance ||
        a.candidate.cy - b.candidate.cy ||
        a.candidate.cx - b.candidate.cx,
    )
    .map((item) => item.candidate);
}

function nearestTargetPoint(circle, target) {
  return {
    x: clamp(circle.cx, target.x, target.x + target.w),
    y: clamp(circle.cy, target.y, target.y + target.h),
  };
}

function shortConnector(circle, target, annotationId, color) {
  const targetPoint = nearestTargetPoint(circle, target);
  const dx = targetPoint.x - circle.cx;
  const dy = targetPoint.y - circle.cy;
  const distance = Math.hypot(dx, dy);
  if (!distance) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  const startDistance = circle.radius;
  const endDistance = Math.max(
    startDistance,
    distance - TEXT_PROTECTION_MARGIN_MM,
  );
  const length = endDistance - startDistance;
  if (length > 4.8 * 1.5) return null;
  if (length < 0.35) return null;
  return {
    annotationId,
    kind: "local",
    startX: round(circle.cx + ux * startDistance),
    startY: round(circle.cy + uy * startDistance),
    endX: round(circle.cx + ux * endDistance),
    endY: round(circle.cy + uy * endDistance),
    length: round(length),
    color,
  };
}

function segmentIntersectsRect(segment, rect, margin = 0) {
  const left = rect.x - margin;
  const right = rect.x + rect.w + margin;
  const top = rect.y - margin;
  const bottom = rect.y + rect.h + margin;
  const dx = segment.endX - segment.startX;
  const dy = segment.endY - segment.startY;
  const p = [-dx, dx, -dy, dy];
  const q = [
    segment.startX - left,
    right - segment.startX,
    segment.startY - top,
    bottom - segment.startY,
  ];
  let minimum = 0;
  let maximum = 1;
  for (let index = 0; index < p.length; index += 1) {
    if (Math.abs(p[index]) < 0.000001) {
      if (q[index] < 0) return false;
      continue;
    }
    const ratio = q[index] / p[index];
    if (p[index] < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return false;
  }
  return true;
}

function connectorAvoidsProtectedText(circle, target, protectedRects) {
  const connector = shortConnector(circle, target, "", "");
  if (!connector) return true;
  return !protectedRects.some(
    (rect) =>
      !intersects(rect, target) &&
      segmentIntersectsRect(connector, rect, TEXT_PROTECTION_MARGIN_MM),
  );
}

function chooseCollisionFreeBubblePosition(
  entry,
  dimensions,
  imageBounds,
  protectedRects,
  placedCircles,
  bubbleGap,
  rings = [1, 2],
) {
  for (const ring of rings) {
    const candidates = buildLocalBubbleCandidates(entry, dimensions, ring);
    for (const candidate of candidates) {
      if (
        !circleInsideBounds(candidate, imageBounds, TEXT_PROTECTION_MARGIN_MM)
      )
        continue;
      if (
        protectedRects.some((rect) =>
          circleIntersectsRect(candidate, rect, TEXT_PROTECTION_MARGIN_MM),
        )
      )
        continue;
      if (
        placedCircles.some((circle) =>
          circleIntersectsCircle(candidate, circle, bubbleGap),
        )
      )
        continue;
      if (
        !connectorAvoidsProtectedText(candidate, entry.target, protectedRects)
      )
        continue;
      return candidate;
    }
  }
  return null;
}

function buildWordEdgeMarkerCandidates(
  entry,
  dimensions,
  imageBounds,
  placedMarkers = [],
) {
  const target = entry.target;
  const anchorX = target.x + target.w;
  const originalX = anchorX - dimensions.width / 2;
  const baseX = clamp(
    originalX,
    imageBounds.x,
    imageBounds.x + imageBounds.w - dimensions.width,
  );
  const originalY =
    target.y +
    target.h * MARKER_ANCHOR_Y_RATIO -
    dimensions.height / 2;
  const protectedTargetTop =
    target.y + target.h * OWN_TARGET_TOP_ALLOWANCE_RATIO;
  const requiredBottom = protectedTargetTop - MARKER_WORD_SAFE_GAP_MM;
  const overlapCorrection = Math.max(
    0,
    originalY + dimensions.height - requiredBottom,
  );
  const correctedY = Math.max(
    imageBounds.y,
    originalY - Math.min(overlapCorrection, MAX_TARGET_RAISE_MM),
  );
  const slightlyHigherY = Math.max(
    imageBounds.y,
    correctedY - LOCAL_MARKER_EXTRA_RAISE_MM,
  );
  const widestPlacedMarker = placedMarkers.reduce(
    (widest, placed) => Math.max(widest, placed.w || 0),
    dimensions.width,
  );
  const localShift = Math.min(
    (dimensions.width + widestPlacedMarker) / 2 + MARKER_COLLISION_GAP_MM,
    MAX_LOCAL_HORIZONTAL_SHIFT_MM,
  );

  return [
    { x: baseX, y: correctedY, variant: "above", level: 0 },
    { x: baseX - localShift, y: correctedY, variant: "above-left", level: 1 },
    { x: baseX + localShift, y: correctedY, variant: "above-right", level: 1 },
    { x: baseX, y: slightlyHigherY, variant: "above", level: 1 },
    { x: baseX - localShift, y: slightlyHigherY, variant: "above-left", level: 2 },
    { x: baseX + localShift, y: slightlyHigherY, variant: "above-right", level: 2 },
  ];
}

function markerRectIsSafe(rect, imageBounds, protectedRects, ownTarget, placedMarkers) {
  return (
    inside(rect, imageBounds) &&
    !markerOverlapsPlaced(rect, placedMarkers) &&
    !markerCoversUnrelatedWord(rect, protectedRects, ownTarget)
  );
}

function markerRectIsLocallyAcceptable(
  rect,
  imageBounds,
  ownTarget,
  placedMarkers,
) {
  if (!inside(rect, imageBounds)) return false;
  if (
    intersects(rect, protectedOwnTargetRect(ownTarget)) &&
    rect.y > imageBounds.y + 0.001
  ) return false;
  if (placedMarkers.some((placed) => intersects(rect, placed))) return false;
  return true;
}

function createSubmittedImageLayout(page, options = {}) {
  const allCorrections = Array.isArray(page?.corrections)
    ? page.corrections
    : [];
  const geometry = imageGeometry(
    {
      imageWidth: page?.imageWidth,
      imageHeight: page?.imageHeight,
      correctionCount: Number(
        options.correctionCountOverride ?? allCorrections.length,
      ),
    },
    options,
  );
  const omitted = [];
  const entries = [];
  for (const correction of allCorrections) {
    const boxes = (
      Array.isArray(correction?.bboxList) ? correction.bboxList : []
    )
      .map((box) =>
        normalizePercentBox(box, geometry.sourceWidth, geometry.sourceHeight),
      )
      .filter(Boolean);
    const mappedBoxes = boxes
      .map((box) => mapPercentBoxToStage(box, geometry))
      .filter(Boolean);
    const target = unionBoxes(mappedBoxes);
    if (!target) {
      omitted.push({
        annotationId: String(correction?.reportId || correction?.id || ""),
        correction,
        reason: "Missing or invalid annotation bounding box",
      });
      continue;
    }
    entries.push({ correction, boxes, mappedBoxes, target });
  }
  entries.sort(readingOrder);
  const exactTargetCounts = new Map();
  entries.forEach((entry) => {
    const key = `${round(entry.target.x)}:${round(entry.target.y)}:${round(entry.target.w)}:${round(entry.target.h)}`;
    entry.targetKey = key;
    exactTargetCounts.set(key, (exactTargetCounts.get(key) || 0) + 1);
  });
  entries.forEach((entry) => {
    entry.sameTargetCount = exactTargetCounts.get(entry.targetKey) || 1;
  });

  const textObstacles = (
    Array.isArray(page?.annotationObstacles) ? page.annotationObstacles : []
  )
    .map((box) => mapPercentBoxToStage(box, geometry))
    .filter(Boolean);
  const protectedRects = [
    ...textObstacles,
    ...entries.map((entry) => entry.target),
  ];

  const imageBounds = {
    x: geometry.imageXmm,
    y: geometry.imageYmm,
    w: geometry.imageWidthMm,
    h: geometry.imageHeightMm,
  };

  const markers = [];
const overflowEntries = [];
const placedMarkers = [];

for (const entry of entries) {
  const annotationId = String(
    entry.correction.reportId || entry.correction.id || "",
  );

  const color =
    entry.correction.color ||
    ANNOTATION_COLORS[entry.correction.category] ||
    "#536273";

  let chosenRect = null;
  let chosenDimensions = null;
  let chosenCandidate = null;

  // Try the existing marker sizes, largest first.
  for (const diameter of BUBBLE_DIAMETERS_MM) {
    const dimensions = anchoredMarkerDimensions(
      entry.correction,
      diameter,
    );

    const candidates = buildWordEdgeMarkerCandidates(
      entry,
      dimensions,
      imageBounds,
      placedMarkers,
    );

    for (const candidate of candidates) {
      const rect = {
        x: round(candidate.x),
        y: round(candidate.y),
        w: dimensions.width,
        h: dimensions.height,
      };

      // Validate the complete pill rectangle, including its own target word.
      if (!markerRectIsSafe(
        rect,
        imageBounds,
        protectedRects,
        entry.target,
        placedMarkers,
      )) {
        continue;
      }

      chosenRect = rect;
      chosenDimensions = dimensions;
      chosenCandidate = candidate;
      break;
    }

    if (chosenRect) {
      break;
    }
  }

  if (!chosenRect || !chosenDimensions || !chosenCandidate) {
    const dimensions = anchoredMarkerDimensions(
      entry.correction,
      MINIMUM_BUBBLE_DIAMETER_MM,
    );
    const localCandidates = buildWordEdgeMarkerCandidates(
      entry,
      dimensions,
      imageBounds,
      placedMarkers,
    );

    // If conservative OCR padding occupies every local candidate, remain at
    // the word edge rather than searching for distant empty page space.
    for (const candidate of localCandidates) {
      const rect = {
        x: round(candidate.x),
        y: round(candidate.y),
        w: dimensions.width,
        h: dimensions.height,
      };
      if (!markerRectIsLocallyAcceptable(
        rect,
        imageBounds,
        entry.target,
        placedMarkers,
      )) continue;
      chosenRect = rect;
      chosenDimensions = dimensions;
      chosenCandidate = candidate;
      break;
    }

    if (!chosenRect) {
      const scoredCandidates = localCandidates.map((candidate) => ({
        candidate,
        rect: {
          x: round(clamp(
            candidate.x,
            imageBounds.x,
            imageBounds.x + imageBounds.w - dimensions.width,
          )),
          y: round(clamp(
            candidate.y,
            imageBounds.y,
            imageBounds.y + imageBounds.h - dimensions.height,
          )),
          w: dimensions.width,
          h: dimensions.height,
        },
      }));
      const primaryRect = scoredCandidates[0].rect;
      const bestFallback = scoredCandidates.reduce((best, current) => {
        const score = scoreFallbackCandidate(
          current.rect,
          primaryRect,
          entry.target,
          protectedRects,
          placedMarkers,
        );
        return !best || score < best.score
          ? { ...current, score }
          : best;
      }, null);
      chosenRect = bestFallback.rect;
      chosenDimensions = dimensions;
      chosenCandidate = bestFallback.candidate;
    }
  }

  placedMarkers.push({ ...chosenRect });

  const target = {
    annotationId,
    color,
    x: round(entry.target.x + entry.target.w),
    y: round(
      entry.target.y +
      entry.target.h * MARKER_ANCHOR_Y_RATIO
    ),
  };

  const targetCenterX =
    entry.target.x + entry.target.w / 2;

  const targetCenterY =
    entry.target.y + entry.target.h / 2;

  markers.push({
    correction: entry.correction,
    annotationId,
    symbol: entry.correction.symbol,
    label: chosenDimensions.label,
    color,
    rect: chosenRect,
    x: chosenRect.x,
    y: chosenRect.y,
    width: chosenRect.w,
    height: chosenRect.h,
    targetX: target.x,
    targetY: target.y,
    placement: chosenCandidate.variant,
    localLevel: chosenCandidate.level,
    localOffsetX: round(
      chosenRect.x +
      chosenRect.w / 2 -
      targetCenterX,
    ),
    localOffsetY: round(
      chosenRect.y +
      chosenRect.h / 2 -
      targetCenterY,
    ),
    localVariant: chosenCandidate.variant,
    side: null,
    fontPt: chosenDimensions.fontPt,
    diameter: chosenDimensions.height,
    textColor: contrastTextColor(color),
    boxes: entry.mappedBoxes,
    targetLeft: entry.target.x,
    targetTop: entry.target.y,
    targetWidth: entry.target.w,
    targetHeight: entry.target.h,
    target,
    leader: null,
  });
}

  markers.sort((a, b) =>
    readingOrder(
      { target: unionBoxes(a.boxes), correction: a.correction },
      { target: unionBoxes(b.boxes), correction: b.correction },
    ),
  );
  const markerIds = new Set(markers.map((marker) => marker.annotationId));
  const underlines = entries
    .filter((entry) =>
      markerIds.has(
        String(entry.correction.reportId || entry.correction.id || ""),
      ),
    )
    .flatMap((entry) =>
      entry.mappedBoxes.map((box) => ({
        correction: entry.correction,
        color:
          entry.correction.color ||
          ANNOTATION_COLORS[entry.correction.category] ||
          "#536273",
        box,
      })),
    );
  const overflowMarkers = overflowEntries.map((entry) => ({
    correction: entry.correction,
  }));
  return {
    ...geometry,
    markers,
    underlines,
    overflowMarkers,
    omitted,
    textObstacles,
  };
}

function createSubmittedImageLayouts(page, options = {}) {
  const original = Array.isArray(page?.corrections) ? page.corrections : [];
  const layouts = [];
  let remaining = original;
  let guard = 0;
  do {
    const layout = createSubmittedImageLayout(
      { ...page, corrections: remaining },
      {
        ...options,
        correctionCountOverride: original.length,
      },
    );
    layouts.push(layout);
    const next = layout.overflowMarkers.map((item) => item.correction);
    if (!next.length || next.length >= remaining.length) break;
    remaining = next;
    guard += 1;
  } while (guard < 20);
  return layouts;
}

function percent(value, total) {
  return round(total ? (value / total) * 100 : 0);
}

function stageStyle(rect, geometry) {
  return {
    left: percent(rect.x, geometry.stageWidthMm),
    top: percent(rect.y, geometry.stageHeightMm),
    width: percent(rect.w, geometry.stageWidthMm),
    height: percent(rect.h, geometry.stageHeightMm),
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
  anchoredMarkerDimensions,
  circleIntersectsRect,
  circleIntersectsCircle,
  buildLocalBubbleCandidates,
  chooseCollisionFreeBubblePosition,
  MARKER_COLLISION_GAP_MM,
  MARKER_WORD_SAFE_GAP_MM,
  LOCAL_TEXT_COLLISION_PADDING_MM,
  MAX_LOCAL_HORIZONTAL_SHIFT_MM,
  TEXT_PROTECTION_MARGIN_MM,
  MINIMUM_BUBBLE_DIAMETER_MM,
  LOCAL_MARKER_GAP_MM,
  stageStyle,
};
