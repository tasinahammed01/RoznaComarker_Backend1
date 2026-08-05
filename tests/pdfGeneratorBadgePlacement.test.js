'use strict';

const { chooseOverlayBadgePosition } = require('../src/modules/pdfGenerator');

const imageBounds = { x: 10, y: 20, w: 180, h: 260 };
const target = { x: 70, y: 100, w: 30, h: 8 };

describe('legacy PDF image badge placement', () => {
  test('keeps the original above-target position when the space is clear', () => {
    expect(chooseOverlayBadgePosition({
      target, badgeW: 24, badgeH: 12, imageBounds
    })).toEqual({ x: 70, y: 86, w: 24, h: 12, placement: 'above' });
  });

  test('places the badge below when another highlighted line occupies the space above', () => {
    const badge = chooseOverlayBadgePosition({
      target,
      badgeW: 24,
      badgeH: 12,
      imageBounds,
      contentRects: [{ x: 60, y: 82, w: 80, h: 16 }]
    });
    expect(badge).toEqual({ x: 70, y: 110, w: 24, h: 12, placement: 'below' });
  });

  test('uses the below position instead of clipping a badge at the image top', () => {
    const badge = chooseOverlayBadgePosition({
      target: { x: 30, y: 22, w: 20, h: 7 },
      badgeW: 24,
      badgeH: 12,
      imageBounds
    });
    expect(badge).toEqual({ x: 30, y: 31, w: 24, h: 12, placement: 'below' });
  });

  test('clamps the badge on the right and avoids an already placed badge', () => {
    const badge = chooseOverlayBadgePosition({
      target: { x: 184, y: 100, w: 6, h: 8 },
      badgeW: 24,
      badgeH: 12,
      imageBounds,
      placedBadges: [{ x: 166, y: 86, w: 24, h: 12 }]
    });
    expect(badge).toEqual({ x: 166, y: 110, w: 24, h: 12, placement: 'below' });
  });
});
