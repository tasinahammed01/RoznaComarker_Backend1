const {
  normalizePercentBox, imageGeometry, mapPercentBoxToStage, createSubmittedImageLayout
} = require('../src/pdf/submittedImageAnnotationLayout');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');

const correction = (id, x, y, overrides = {}) => ({ reportId: id, id, displayNumber: Number(id.replace(/\D/g, '')) || 1,
  category: 'GRAMMAR', symbol: 'AGR', symbolLabel: 'Agreement', bboxList: [{ x, y, w: 9, h: 2 }], ...overrides });
const page = (corrections, overrides = {}) => ({ fileId: 'file-a', fileIndex: 0, pageNumber: 1, displayPageNumber: 1,
  imageDataUrl: 'data:image/png;base64,AA==', imageWidth: 900, imageHeight: 1180, corrections,
  transcript: { highlightedSegments: [] }, ...overrides });

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const assertSafe = (layout, expectedIds) => {
  expect(layout.markers).toHaveLength(expectedIds.length);
  expect(layout.overflowMarkers).toHaveLength(0);
  expect(layout.markers.map((marker) => marker.correction.id).sort()).toEqual([...expectedIds].sort());
  for (const marker of layout.markers) {
    expect(marker.rect.x).toBeGreaterThanOrEqual(0); expect(marker.rect.y).toBeGreaterThanOrEqual(0);
    expect(marker.rect.x + marker.rect.w).toBeLessThanOrEqual(layout.stageWidthMm + 0.001);
    expect(marker.rect.y + marker.rect.h).toBeLessThanOrEqual(layout.stageHeightMm + 0.001);
    for (const obstacle of layout.textObstacles || []) expect(intersects(marker.rect, obstacle)).toBe(false);
  }
  for (let i = 0; i < layout.markers.length; i += 1) for (let j = i + 1; j < layout.markers.length; j += 1)
    expect(intersects(layout.markers[i].rect, layout.markers[j].rect)).toBe(false);
};

describe('submitted image annotation layout', () => {
  test('maps one correction to one compact marker and one exact underline', () => {
    const layout = createSubmittedImageLayout(page([correction('c1', 30, 30)]));
    expect(layout.density).toBe('sparse'); expect(layout.markers).toHaveLength(1); expect(layout.underlines).toHaveLength(1);
    expect(layout.markers[0].correction.displayNumber).toBe(1); expect(layout.imageWidthMm).toBeGreaterThan(142);
  });

  test('keeps multiple bbox segments but creates only one marker per canonical correction', () => {
    const item = correction('c1', 20, 20, { bboxList: [{ x: 20, y: 20, w: 8, h: 2 }, { x: 29, y: 20, w: 11, h: 2 }] });
    const layout = createSubmittedImageLayout(page([item]));
    expect(layout.underlines).toHaveLength(2); expect(layout.markers).toHaveLength(1);
  });

  test('places same-position corrections without marker collisions and deterministically', () => {
    const input = page([correction('c2', 45, 40), correction('c1', 45, 40)]);
    const first = createSubmittedImageLayout(input); const second = createSubmittedImageLayout(input);
    expect(first).toEqual(second); expect(first.markers).toHaveLength(2);
    expect(intersects(first.markers[0].rect, first.markers[1].rect)).toBe(false);
    expect(first.markers.map((marker) => marker.correction.id)).toEqual(['c1', 'c2']);
  });

  test('renders a dense 35-correction page without omissions, collisions, or unreadable overflow', () => {
    const corrections = Array.from({ length: 35 }, (_, index) => correction(`c${index + 1}`, 8 + index % 7 * 13, 4 + Math.floor(index / 7) * 17));
    const words = Array.from({ length: 20 }, (_, row) => ({ x: 5, y: 3 + row * 4.7, w: 90, h: 2.2 }));
    const layout = createSubmittedImageLayout(page(corrections, { annotationObstacles: words }));
    expect(layout.density).toBe('dense'); expect(layout.markers).toHaveLength(35); expect(layout.overflowMarkers).toHaveLength(0);
    expect(new Set(layout.markers.map((marker) => marker.correction.id)).size).toBe(35);
    expect(layout.markers.map((marker) => marker.correction.displayNumber).sort((a, b) => a - b)).toEqual(Array.from({ length: 35 }, (_, index) => index + 1));
    layout.markers.forEach((marker) => layout.textObstacles.forEach((box) => expect(intersects(marker.rect, box)).toBe(false)));
    for (let i = 0; i < layout.markers.length; i += 1) for (let j = i + 1; j < layout.markers.length; j += 1)
      expect(intersects(layout.markers[i].rect, layout.markers[j].rect)).toBe(false);
  });

  test.each([
    ['sparse portrait', 900, 1180],
    ['sparse landscape', 1400, 850]
  ])('avoids OCR words on a %s page', (_name, imageWidth, imageHeight) => {
    const corrections = [correction('c1', 42, 48), correction('c2', 62, 48)];
    const annotationObstacles = [{ x: 5, y: 44, w: 90, h: 9 }, { x: 5, y: 55, w: 90, h: 5 }];
    const layout = createSubmittedImageLayout(page(corrections, { imageWidth, imageHeight, annotationObstacles }));
    const mappedObstacles = annotationObstacles.map((box) => mapPercentBoxToStage(box, layout));
    layout.markers.forEach((marker) => mappedObstacles.forEach((box) => expect(intersects(marker.rect, box)).toBe(false)));
    expect(layout.markers.map((marker) => marker.correction.displayNumber)).toEqual([1, 2]);
  });

  test('keeps every correction exactly once across a two-image submission', () => {
    const pages = [page([correction('c1', 20, 20), correction('c2', 70, 70)]),
      page([correction('c3', 5, 50), correction('c4', 90, 50)], { fileId: 'file-b', fileIndex: 1, displayPageNumber: 2 })];
    const layouts = pages.map((item) => createSubmittedImageLayout(item));
    expect(layouts.flatMap((layout) => layout.markers.map((marker) => marker.correction.id))).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  test('keeps edge markers inside the printable stage and chooses the nearest gutter', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 0, 0), correction('c2', 91, 0), correction('c3', 0, 97), correction('c4', 91, 97),
      ...Array.from({ length: 9 }, (_, index) => correction(`c${index + 5}`, 45, 10 + index * 8))
    ]));
    for (const marker of layout.markers) {
      expect(marker.rect.x).toBeGreaterThanOrEqual(0); expect(marker.rect.y).toBeGreaterThanOrEqual(0);
      expect(marker.rect.x + marker.rect.w).toBeLessThanOrEqual(layout.stageWidthMm + 0.001);
      expect(marker.rect.y + marker.rect.h).toBeLessThanOrEqual(layout.stageHeightMm + 0.001);
    }
    // Edge markers at (0,0) and (91,0) fall back to gutter due to insufficient local space
    expect(layout.markers.find((marker) => marker.correction.id === 'c1').placement).toBe('gutter-left');
    expect(layout.markers.find((marker) => marker.correction.id === 'c2').placement).toBe('gutter-right');
  });

  test('rejects invalid and fully out-of-range boxes while clamping safe intersections', () => {
    expect(normalizePercentBox({ x: NaN, y: 2, w: 3, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: 10, y: 10, w: 0, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: -10, y: 10, w: 5, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: 98, y: 99, w: 8, h: 4 })).toEqual({ x: 98, y: 99, w: 2, h: 1 });
  });

  test('coordinate conversion includes image gutter offset and preserves proportional box width', () => {
    const geometry = imageGeometry({ imageWidth: 1000, imageHeight: 1000, correctionCount: 20 });
    const mapped = mapPercentBoxToStage({ x: 25, y: 20, w: 10, h: 5 }, geometry);
    expect(mapped.x).toBeCloseTo(geometry.imageXmm + geometry.imageWidthMm * .25, 2);
    expect(mapped.y).toBeCloseTo(geometry.imageHeightMm * .2, 2);
    expect(mapped.w).toBeCloseTo(geometry.imageWidthMm * .1, 2);
  });

  test('HTML keeps exact underlines, compact references, escaped symbols, and no full-width leaders', () => {
    const unsafe = correction('c1', 20, 20, { symbol: '<AGR>', bboxList: [{ x: 20, y: 20, w: 8, h: 2 }, { x: 30, y: 20, w: 5, h: 2 }] });
    const vm = { submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 }, statistics: {
      content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [page([unsafe])], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: [] };
    const html = renderSubmissionFeedbackReportHtml(vm);
    expect((html.match(/class="underline"/g) || [])).toHaveLength(2);
    expect((html.match(/class="marker"/g) || [])).toHaveLength(1);
    expect(html).toContain('#01 &lt;AGR&gt;'); expect(html).not.toContain('#01 <AGR>');
    expect(html).not.toMatch(/class="underline"[^>]*width:100%/);
    expect(html).toContain('stroke-dasharray:7 86 7');
  });
});
