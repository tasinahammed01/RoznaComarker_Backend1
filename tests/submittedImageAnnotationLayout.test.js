const {
  normalizePercentBox, imageGeometry, mapPercentBoxToStage, unionBoxes,
  createSubmittedImageLayout, createSubmittedImageLayouts, markerDimensions,
  circleIntersectsRect, circleIntersectsCircle, TEXT_PROTECTION_MARGIN_MM,
  MINIMUM_BUBBLE_DIAMETER_MM, LOCAL_MARKER_GAP_MM
} = require('../src/pdf/submittedImageAnnotationLayout');
const { renderSubmissionFeedbackReportHtml } = require('../src/pdf/submissionFeedbackReportTemplate');

const correction = (id, x, y, overrides = {}) => ({ reportId: id, id, displayNumber: Number(id.replace(/\D/g, '')) || 1,
  category: 'GRAMMAR', symbol: 'AGR', symbolLabel: 'Agreement', bboxList: [{ x, y, w: 9, h: 2 }], ...overrides });
const page = (corrections, overrides = {}) => ({ fileId: 'file-a', fileIndex: 0, pageNumber: 1, displayPageNumber: 1,
  imageDataUrl: 'data:image/png;base64,AA==', imageWidth: 900, imageHeight: 1180, corrections,
  transcript: { highlightedSegments: [] }, ...overrides });

const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
const markerCircle = (marker) => ({
  cx: marker.rect.x + marker.rect.w / 2,
  cy: marker.rect.y + marker.rect.h / 2,
  radius: marker.diameter / 2
});
const assertSafe = (layout, expectedIds) => {
  expect(layout.markers).toHaveLength(expectedIds.length);
  expect(layout.overflowMarkers).toHaveLength(0);
  expect(layout.markers.map((marker) => marker.correction.id).sort()).toEqual([...expectedIds].sort());
  for (const marker of layout.markers) {
    expect(marker.rect.x).toBeGreaterThanOrEqual(0); expect(marker.rect.y).toBeGreaterThanOrEqual(0);
    expect(marker.rect.x + marker.rect.w).toBeLessThanOrEqual(layout.stageWidthMm + 0.001);
    expect(marker.rect.y + marker.rect.h).toBeLessThanOrEqual(layout.stageHeightMm + 0.001);
  }
};

describe('submitted image annotation layout', () => {
  test('maps one correction to one protected above-target bubble and one exact underline', () => {
    const layout = createSubmittedImageLayout(page([correction('c1', 30, 30)]));
    expect(layout.density).toBe('sparse'); expect(layout.markers).toHaveLength(1); expect(layout.underlines).toHaveLength(1);
    expect(layout.markers[0].correction.displayNumber).toBe(1); expect(layout.gutterMm).toBe(0);
    expect(layout.imageWidthMm).toBeGreaterThan(165);
    expect(layout.markers[0].placement).toBe('above');
    const target = unionBoxes(layout.markers[0].boxes);
    expect(circleIntersectsRect(markerCircle(layout.markers[0]), target, 0)).toBe(false);
    expect(layout.markers[0].rect.x + layout.markers[0].rect.w / 2)
      .toBeCloseTo(target.x + target.w / 2, 3);
    expect(target.y - (layout.markers[0].rect.y + layout.markers[0].rect.h))
      .toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
  });

  test('uses a compact circular bubble with the selected PDF diameter and font size', () => {
    const compact = markerDimensions();
    const diameterPt = compact.diameter * 72 / 25.4;
    expect(diameterPt).toBeGreaterThanOrEqual(10);
    expect(diameterPt).toBeLessThanOrEqual(14);
    expect(compact.fontPt).toBe(4.2);
    expect(compact).toEqual({
      diameter: 4.8, width: 4.8, height: 4.8, fontPt: 4.2
    });
  });

  test('uses the canonical correction color for marker and underline', () => {
    const layout = createSubmittedImageLayout(page([correction('c1', 30, 30, { color: '#123456' })]));
    expect(layout.markers[0].color).toBe('#123456'); expect(layout.underlines[0].color).toBe('#123456');
  });

  test('uses high-contrast text and renders the correction number plus symbol', () => {
    const input = page([correction('c1', 30, 30, {
      color: '#f4d35e', symbol: 'SP', message: 'Do not render this explanation in the image.'
    })]);
    const layout = createSubmittedImageLayout(input);
    const html = renderSubmissionFeedbackReportHtml({ submission: { uploadedPageCount: 1 },
      result: { maximumScore: 100 }, statistics: { content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 1 },
      categoryScores: [], submittedPages: [input], detailedFeedback: {}, teacherComments: '',
      activeLegendItems: [], completeLegend: [] });
    expect(layout.markers[0].textColor).toBe('#17212b');
    const markerHtml = html.match(/<b class="marker"[^>]*>.*?<\/b>/)[0];
    expect(markerHtml).toContain('background:#f4d35e;color:#17212b');
    expect(markerHtml).toContain('border-radius:50%');
    expect(markerHtml).toMatch(/>1 SP<\/b>$/);
    expect(markerHtml).not.toMatch(/>#[0-9]/);
    expect(markerHtml).not.toContain('Do not render this explanation');
  });

  test('keeps multiple bbox segments but creates only one marker per canonical correction', () => {
    const item = correction('c1', 20, 20, { bboxList: [{ x: 20, y: 20, w: 8, h: 2 }, { x: 29, y: 20, w: 11, h: 2 }] });
    const layout = createSubmittedImageLayout(page([item]));
    expect(layout.underlines).toHaveLength(2); expect(layout.markers).toHaveLength(1);
  });

  test('keeps same-position corrections deterministically centered on their shared target', () => {
    const input = page([correction('c2', 45, 40), correction('c1', 45, 40)]);
    const first = createSubmittedImageLayout(input); const second = createSubmittedImageLayout(input);
    expect(first).toEqual(second); expect(first.markers).toHaveLength(2);
    expect(first.markers[0].rect).toEqual(first.markers[1].rect);
    expect(first.markers.map((marker) => marker.correction.id)).toEqual(['c1', 'c2']);
  });

  test('keeps every dense label local without density omissions', () => {
    const corrections = Array.from({ length: 35 }, (_, index) => correction(`c${index + 1}`, 8 + index % 7 * 13, 4 + Math.floor(index / 7) * 17));
    const layout = createSubmittedImageLayout(page(corrections));
    expect(layout.density).toBe('dense'); expect(layout.overflowMarkers).toHaveLength(0);
    expect(layout.markers).toHaveLength(35);
    expect(layout.omitted.filter((item) => item.reason === 'NO_LOCAL_SPACE')).toHaveLength(0);
    expect(new Set(layout.markers.map((marker) => marker.correction.id)).size).toBe(35);
    for (let i = 0; i < layout.markers.length; i += 1) for (let j = i + 1; j < layout.markers.length; j += 1)
      expect(intersects(layout.markers[i].rect, layout.markers[j].rect)).toBe(false);
  });

  test.each([
    ['sparse portrait', 900, 1180],
    ['sparse landscape', 1400, 850]
  ])('keeps bubbles exactly anchored on a %s page', (_name, imageWidth, imageHeight) => {
    const corrections = [correction('c1', 42, 48), correction('c2', 62, 48)];
    const annotationObstacles = [{ x: 5, y: 48, w: 90, h: 2 }, { x: 5, y: 55, w: 90, h: 2 }];
    const layout = createSubmittedImageLayout(page(corrections, { imageWidth, imageHeight, annotationObstacles }));
    layout.markers.forEach((marker) => {
      const target = unionBoxes(marker.boxes);
      expect(marker.rect.x + marker.rect.w / 2).toBeCloseTo(target.x + target.w / 2, 3);
      expect(target.y - (marker.rect.y + marker.rect.h)).toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
    });
    expect(layout.markers.map((marker) => marker.correction.displayNumber)).toEqual([1, 2]);
  });

  test('does not relocate an anchored marker when unrelated OCR boxes are nearby', () => {
    const annotationObstacles = [
      { x: 35, y: 38, w: 30, h: 6 },
      { x: 35, y: 45, w: 8, h: 4 },
      { x: 56, y: 45, w: 9, h: 4 }
    ];
    const layout = createSubmittedImageLayout(page([correction('c1', 45, 45)], { annotationObstacles }));
    expect(layout.markers).toHaveLength(1);
    const target = unionBoxes(layout.markers[0].boxes);
    expect(layout.markers[0].rect.x + layout.markers[0].rect.w / 2)
      .toBeCloseTo(target.x + target.w / 2, 3);
    expect(target.y - (layout.markers[0].rect.y + layout.markers[0].rect.h))
      .toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
    expect(layout.gutterMm).toBe(0);
    expect(layout.omitted).toEqual([]);
    expect(layout.overflowMarkers).toHaveLength(0);
  });

  test('keeps every correction exactly once across a two-image submission', () => {
    const pages = [page([correction('c1', 20, 20), correction('c2', 70, 70)]),
      page([correction('c3', 5, 50), correction('c4', 90, 50)], { fileId: 'file-b', fileIndex: 1, displayPageNumber: 2 })];
    const layouts = pages.map((item) => createSubmittedImageLayout(item));
    expect(layouts.flatMap((layout) => layout.markers.map((marker) => marker.correction.id))).toEqual(['c1', 'c2', 'c3', 'c4']);
  });

  test('does not move edge-target markers into side rows or gutters', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 0, 0), correction('c2', 91, 0), correction('c3', 0, 97), correction('c4', 91, 97),
      ...Array.from({ length: 9 }, (_, index) => correction(`c${index + 5}`, 45, 10 + index * 8))
    ]));
    for (const marker of layout.markers) {
      const target = unionBoxes(marker.boxes);
      expect(marker.placement).toBe('above');
      expect(marker.rect.x + marker.rect.w / 2).toBeCloseTo(target.x + target.w / 2, 3);
      expect(target.y - (marker.rect.y + marker.rect.h)).toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
    }
    expect(layout.gutterMm).toBe(0);
  });

  test('rejects invalid and fully out-of-range boxes while clamping safe intersections', () => {
    expect(normalizePercentBox({ x: NaN, y: 2, w: 3, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: 10, y: 10, w: 0, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: -10, y: 10, w: 5, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: 98, y: 99, w: 8, h: 4 })).toBeNull();
    expect(normalizePercentBox({ x: 98, y: 99, w: 2.2, h: 1.2 })).toEqual({ x: 98, y: 99, w: 2, h: 1 });
  });

  test('normalizes canonical corner and legacy width-height bbox shapes identically', () => {
    expect(normalizePercentBox({ x0: 12, y0: 23, x1: 30, y1: 28 })).toEqual({ x: 12, y: 23, w: 18, h: 5 });
    expect(normalizePercentBox({ x: 12, y: 23, w: 18, h: 5 })).toEqual({ x: 12, y: 23, w: 18, h: 5 });
  });

  test('uses fallback geometry to create markers and underlines when image dimensions are missing', () => {
    const layout = createSubmittedImageLayout(page([correction('c1', 20, 20)], { imageWidth: 0, imageHeight: 0 }));
    expect(layout.sourceWidth).toBe(900); expect(layout.sourceHeight).toBe(1200);
    expect(layout.markers).toHaveLength(1); expect(layout.underlines).toHaveLength(1);
  });

  test('renders valid bbox marker HTML without invalid style values and keeps unboxed corrections in notes only', () => {
    const boxed = correction('c1', 20, 20, { displayNumber: 1, symbol: 'AGR', color: '#287a55' });
    const unboxed = correction('c2', 30, 30, { displayNumber: 2, symbol: 'SP', color: '#946b00', bboxList: [] });
    const input = page([boxed, unboxed], { imageWidth: undefined, imageHeight: undefined });
    const html = renderSubmissionFeedbackReportHtml({
      submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 }, statistics: {
        content: 0, grammar: 2, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [input], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: []
    });
    expect((html.match(/class="marker"/g) || [])).toHaveLength(1);
    expect((html.match(/class="underline"/g) || [])).toHaveLength(1);
    expect(html).toContain('>1 AGR</b>');
    expect(html).toContain('#02 &middot; SP');
    expect(html).not.toMatch(/class="marker"[^>]*data-correction-id="c2"/);
    expect(html.match(/style="[^"]*"/g).join('')).not.toMatch(/NaN|undefined/);
  });

  test('renders a zero-correction image without markers or errors', () => {
    const input = page([]); const layout = createSubmittedImageLayout(input); const html = renderSubmissionFeedbackReportHtml({
      submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 }, statistics: {
        content: 0, grammar: 0, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [input], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: []
    });
    expect(layout.markers).toEqual([]); expect(html).not.toContain('class="marker"');
  });

  test('coordinate conversion includes image gutter offset and preserves proportional box width', () => {
    const geometry = imageGeometry({ imageWidth: 1000, imageHeight: 1000, correctionCount: 20 });
    const mapped = mapPercentBoxToStage({ x: 25, y: 20, w: 10, h: 5 }, geometry);
    expect(mapped.x).toBeCloseTo(geometry.imageXmm + geometry.imageWidthMm * .25, 2);
    expect(mapped.y).toBeCloseTo(geometry.imageHeightMm * .2, 2);
    expect(mapped.w).toBeCloseTo(geometry.imageWidthMm * .1, 2);
  });

  test('resizing the same aspect ratio does not double-scale normalized marker coordinates', () => {
    const box = { x: 25, y: 20, w: 10, h: 5 };
    const source = createSubmittedImageLayout(page([correction('c1', 25, 20, { bboxList: [box] })],
      { imageWidth: 3000, imageHeight: 4000 }));
    const optimized = createSubmittedImageLayout(page([correction('c1', 25, 20, { bboxList: [box] })],
      { imageWidth: 1800, imageHeight: 2400 }));
    expect(optimized.underlines[0].box).toEqual(source.underlines[0].box);
    expect(optimized.markers[0].correction.displayNumber).toBe(source.markers[0].correction.displayNumber);
  });

  test('HTML keeps exact underlines, compact references, escaped symbols, and no full-width leaders', () => {
    const unsafe = correction('c1', 20, 20, { symbol: '<AGR>', bboxList: [{ x: 20, y: 20, w: 8, h: 2 }, { x: 30, y: 20, w: 5, h: 2 }] });
    const vm = { submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 }, statistics: {
      content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [page([unsafe])], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: [] };
    const html = renderSubmissionFeedbackReportHtml(vm);
    expect((html.match(/class="underline"/g) || [])).toHaveLength(2);
    expect((html.match(/class="marker"/g) || [])).toHaveLength(1);
    expect(html).toContain('>1 &lt;AGR&gt;</b>'); expect(html).toContain('#01 &middot; &lt;AGR&gt;'); expect(html).not.toContain('#1 <AGR>');
    expect(html).not.toMatch(/class="underline"[^>]*width:100%/);
    expect(html).not.toContain('<polyline');
    expect(html).not.toContain('<line ');
    expect(html).not.toContain('<circle ');
    expect(html).toMatch(/class="marker"[^>]*background:#287a55;color:#ffffff[^>]*border-radius:50%[^>]*>1 &lt;AGR&gt;<\/b>/);
  });

  test('keeps image, underlines, and markers inside the full image stage in layer order', () => {
    const input = page([correction('c1', 20, 20, { color: '#287a55' })]);
    const html = renderSubmissionFeedbackReportHtml({ submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 },
      statistics: { content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [input], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: [] });
    const stage = html.match(/<div class="full-image-stage[\s\S]*?<\/div>/)[0];
    expect(stage.indexOf('<img')).toBeLessThan(stage.indexOf('class="underline"'));
    expect(stage.indexOf('class="underline"')).toBeLessThan(stage.indexOf('class="marker"'));
    expect(stage).not.toContain('class="leader-layer"');
  });

  test('uses natural correction pagination without columns or forced review and feedback breaks', () => {
    const input = page([correction('c1', 20, 20, { color: '#287a55' })]);
    const html = renderSubmissionFeedbackReportHtml({ submission: { uploadedPageCount: 1 }, result: { maximumScore: 100 },
      statistics: { content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0 }, categoryScores: [],
      submittedPages: [input], detailedFeedback: {}, teacherComments: '', activeLegendItems: [], completeLegend: [] });
    expect(html).toContain('.annotated-image-page{break-after:page;page-break-after:always}');
    expect(html).toContain('.page-review-details{break-before:auto;page-break-before:auto}');
    expect(html).toContain('.feedback-section{page:auto;break-before:auto;page-break-before:auto;margin-top:3mm}');
    expect(html).toContain('.correction-table tbody{break-inside:auto;page-break-inside:auto}');
    expect(html).toContain('.correction-table tr{break-inside:avoid;page-break-inside:avoid}');
    expect(html).not.toMatch(/column-count\s*:/);
    expect(html).not.toContain('page:feedback');
  });

  test('places ordinary bubbles directly above their targets without touching text', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 10, 20), correction('c2', 80, 30)
    ]));
    for (const marker of layout.markers) {
      const target = unionBoxes(marker.boxes);
      expect(marker).toMatchObject({ side: null, placement: 'above', localVariant: 'above' });
      expect(marker.rect.x + marker.rect.w / 2).toBeCloseTo(target.x + target.w / 2, 3);
      expect(circleIntersectsRect(markerCircle(marker), target, 0)).toBe(false);
    }
  });

  test('target metadata matches the transformed union-box upper-right anchor without a connector', () => {
    const bboxList = [{ x: 10, y: 20, w: 8, h: 2 }, { x: 20, y: 22, w: 12, h: 2 }];
    const layout = createSubmittedImageLayout(page([correction('c1', 10, 20, { bboxList })]));
    const mapped = bboxList.map((box) => mapPercentBoxToStage(box, layout));
    const union = unionBoxes(mapped);
    expect(layout.markers[0].target).toEqual(expect.objectContaining({
      x: roundForTest(union.x + union.w),
      y: roundForTest(union.y + union.h * .15)
    }));
    expect(layout.markers[0]).toMatchObject({
      targetLeft: union.x, targetTop: union.y, targetWidth: union.w, targetHeight: union.h
    });
    expect(layout.markers[0].leader).toBeNull();
  });

  test('sorts labels in top-to-bottom then left-to-right reading order', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c3', 70, 60), correction('c2', 60, 20), correction('c1', 20, 20)
    ]));
    expect(layout.markers.map((marker) => marker.correction.id)).toEqual(['c1', 'c2', 'c3']);
  });

  test('nearby labels are shifted without overlap and remain inside vertical bounds', () => {
    const layout = createSubmittedImageLayout(page(
      Array.from({ length: 3 }, (_, index) => correction(`c${index + 1}`, 10 + index * 7, 48))
    ));
    const markers = layout.markers;
    for (let index = 1; index < markers.length; index += 1) {
      expect(intersects(markers[index - 1].rect, markers[index].rect)).toBe(false);
    }
    markers.forEach((marker) => {
      expect(marker.rect.y).toBeGreaterThanOrEqual(0);
      expect(marker.rect.y + marker.rect.h).toBeLessThanOrEqual(layout.stageHeightMm + .001);
    });
  });

  test('bottom-edge labels remain visible inside the image-height range', () => {
    const layout = createSubmittedImageLayout(page(
      Array.from({ length: 8 }, (_, index) => correction(`c${index + 1}`, 4 + index * 12, 96))
    ));
    const markers = layout.markers;
    expect(markers).toHaveLength(8);
    expect(markers[markers.length - 1].rect.y + markers[markers.length - 1].rect.h)
      .toBeLessThanOrEqual(layout.stageHeightMm + .001);
    for (let index = 0; index < markers.length; index += 1) {
      expect(markers[index].rect.y).toBeGreaterThanOrEqual(0);
      for (let other = index + 1; other < markers.length; other += 1)
        expect(intersects(markers[index].rect, markers[other].rect)).toBe(false);
    }
  });

  test('center targets use deterministic local collision placement', () => {
    const input = page([
      correction('c1', 10, 10), correction('c2', 49, 20), correction('c3', 49, 30)
    ]);
    const first = createSubmittedImageLayout(input);
    const second = createSubmittedImageLayout(input);
    expect(first.markers.map((marker) => marker.placement)).toEqual(second.markers.map((marker) => marker.placement));
    expect(first.markers.find((marker) => marker.correction.id === 'c2').placement).toBe('above');
  });

  test('transforms percentage and explicit pixel coordinates correctly', () => {
    const geometry = imageGeometry({ imageWidth: 1000, imageHeight: 800, correctionCount: 2 });
    const percentBox = mapPercentBoxToStage({ x: 25, y: 25, w: 10, h: 10 }, geometry);
    const pixelBox = mapPercentBoxToStage({ x: 250, y: 200, w: 100, h: 80, unit: 'px' }, geometry);
    expect(pixelBox).toEqual(percentBox);
  });

  test('records invalid boxes as omitted diagnostics without inventing a target', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 20, 20), correction('c2', 0, 0, { bboxList: [{ x: -20, y: 4, w: 2, h: 2 }] })
    ]));
    expect(layout.markers.map((marker) => marker.correction.id)).toEqual(['c1']);
    expect(layout.omitted).toEqual([
      expect.objectContaining({ annotationId: 'c2', reason: 'Missing or invalid annotation bounding box' })
    ]);
  });

  test('keeps local labels inside the image without changing image geometry or aspect ratio', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 10, 15), correction('c2', 85, 40), correction('c3', 50, 70)
    ], { imageWidth: 1400, imageHeight: 850 }));
    const imageRect = { x: layout.imageXmm, y: layout.imageYmm, w: layout.imageWidthMm, h: layout.imageHeightMm };
    layout.markers.forEach((marker) => {
      expect(marker.rect.x).toBeGreaterThanOrEqual(imageRect.x);
      expect(marker.rect.x + marker.rect.w).toBeLessThanOrEqual(imageRect.x + imageRect.w);
    });
    expect(layout).toMatchObject(imageGeometry({ imageWidth: 1400, imageHeight: 850, correctionCount: 3 }));
    expect(layout.renderedAspectRatio).toBeCloseTo(layout.sourceAspectRatio, 3);
  });

  test('renders every correction on a dense line without gutters, pagination, or distant labels', () => {
    const corrections = Array.from({ length: 14 }, (_, index) =>
      correction(`c${index + 1}`, 1 + index * 7.5, 45, { bboxList: [{ x: 1 + index * 7.5, y: 45, w: 3, h: 2 }] }));
    const layouts = createSubmittedImageLayouts(page(corrections, {
      imageWidth: 1400, imageHeight: 400
    }),
      { maxWidthMm: 180, maxHeightMm: 80 });
    expect(layouts).toHaveLength(1);
    expect(layouts[0].markers).toHaveLength(14);
    expect(layouts[0].gutterMm).toBe(0);
    expect(layouts[0].overflowMarkers).toHaveLength(0);
    expect(layouts[0].omitted.filter((item) => item.reason === 'NO_LOCAL_SPACE')).toHaveLength(0);
    for (let index = 0; index < layouts[0].markers.length; index += 1) {
      for (let other = index + 1; other < layouts[0].markers.length; other += 1)
        expect(intersects(layouts[0].markers[index].rect, layouts[0].markers[other].rect)).toBe(false);
    }
  });

  test('two nearby targets use a small local horizontal offset', () => {
    const layout = createSubmittedImageLayout(page([
      correction('c1', 45, 55), correction('c2', 50, 55)
    ]));
    expect(layout.markers.map((marker) => marker.placement)).toEqual(['above', 'above']);
    expect(layout.markers[0].localVariant).toBe('above');
    expect(layout.markers[1].localLevel).toBeLessThanOrEqual(2);
    layout.markers.forEach((marker) => {
      const targetCenter = unionBoxes(marker.boxes).x + unionBoxes(marker.boxes).w / 2;
      expect(Math.abs(marker.rect.x + marker.rect.w / 2 - targetCenter))
        .toBeLessThanOrEqual(marker.rect.w * 1.5);
    });
    assertSafe(layout, ['c1', 'c2']);
  });

  test('a dense REP/P/FRAG correction group remains anchored to the exact shared target', () => {
    const symbols = ['REP', 'P', 'FRAG'];
    const annotationObstacles = [
      { x: 30, y: 70, w: 12, h: 2 },
      { x: 45, y: 70, w: 9, h: 2 },
      { x: 58, y: 70, w: 13, h: 2 },
      { x: 30, y: 76, w: 40, h: 2 }
    ];
    const layout = createSubmittedImageLayout(page(
      symbols.map((symbol, index) => correction(`c${index + 1}`, 45, 70, { symbol })),
      { annotationObstacles }
    ));
    expect(layout.markers.map((marker) => marker.localVariant)).toEqual(['above', 'above', 'above']);
    expect(layout.markers.every((marker) => marker.localLevel === 1)).toBe(true);
    const target = unionBoxes(layout.markers[0].boxes);
    const mappedObstacles = annotationObstacles.map((box) => mapPercentBoxToStage(box, layout));
    layout.markers.forEach((marker) => {
      const centerX = marker.rect.x + marker.rect.w / 2;
      expect(centerX).toBeCloseTo(target.x + target.w / 2, 3);
      expect(target.y - (marker.rect.y + marker.rect.h)).toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
    });
    assertSafe(layout, ['c1', 'c2', 'c3']);
  });

  test('dense annotations remain local without distant fallback or omission', () => {
    const corrections = Array.from({ length: 30 }, (_, index) =>
      correction(`c${index + 1}`, 8 + index % 6 * 16, 18 + Math.floor(index / 6) * 15));
    const layout = createSubmittedImageLayout(page(corrections));
    expect(layout.markers).toHaveLength(30);
    expect(layout.markers.every((marker) =>
      ['above', 'above-right', 'above-left', 'right', 'left', 'below-right', 'below-left', 'below'].includes(marker.placement))).toBe(true);
    expect(layout.omitted.filter((item) => item.reason === 'NO_LOCAL_SPACE')).toHaveLength(0);
    expect(layout.gutterMm).toBe(0);
    expect(layout.overflowMarkers).toHaveLength(0);
  });

  test('keeps the preferred marker height when line spacing is tight', () => {
    const annotationObstacles = [
      { x: 0, y: 47, w: 100, h: .8 },
      { x: 0, y: 53, w: 100, h: 1 },
      { x: 0, y: 50, w: 43, h: 2 },
      { x: 56, y: 50, w: 44, h: 2 }
    ];
    const layout = createSubmittedImageLayout(page([
      correction('c1', 45, 50, { symbol: 'P' })
    ], { annotationObstacles }));
    expect(layout.markers).toHaveLength(1);
    expect(layout.markers[0].diameter).toBe(4.8);
    expect(layout.markers[0].fontPt).toBe(4.2);
    expect(layout.gutterMm).toBe(0);
    const target = unionBoxes(layout.markers[0].boxes);
    expect(target.y - (layout.markers[0].rect.y + layout.markers[0].rect.h))
      .toBeCloseTo(LOCAL_MARKER_GAP_MM, 3);
  });

  test('does not render connector geometry for a locally attached label', () => {
    const input = page([correction('c1', 30, 30, { color: '#123456' })]);
    const layout = createSubmittedImageLayout(input, { maxWidthMm: 180, maxHeightMm: 235 });
    const html = renderSubmissionFeedbackReportHtml({ submission: { uploadedPageCount: 1 },
      result: { maximumScore: 100 }, statistics: { content: 0, grammar: 1, organization: 0, vocabulary: 0, mechanics: 0 },
      categoryScores: [], submittedPages: [input], detailedFeedback: {}, teacherComments: '',
      activeLegendItems: [], completeLegend: [] });
    expect(layout.markers[0].leader).toBeNull();
    expect(html).not.toContain('<line ');
    expect(html).not.toContain('<circle ');
    expect(html).not.toContain('class="leader-layer"');
  });

  test('does not render connectors or second-ring placement for anchored markers', () => {
    const corrections = Array.from({ length: 9 }, (_, index) =>
      correction(`c${index + 1}`, 45, 60, { symbol: 'FRAG' }));
    const input = page(corrections);
    const layout = createSubmittedImageLayout(input);
    const connectors = layout.markers.map((marker) => marker.leader).filter(Boolean);
    const html = renderSubmissionFeedbackReportHtml({ submission: { uploadedPageCount: 1 },
      result: { maximumScore: 100 }, statistics: { content: 0, grammar: 9, organization: 0, vocabulary: 0, mechanics: 0 },
      categoryScores: [], submittedPages: [input], detailedFeedback: {}, teacherComments: '',
      activeLegendItems: [], completeLegend: [] });
    expect(layout.markers).toHaveLength(9);
    expect(connectors).toEqual([]);
    expect(html).not.toContain('class="leader-layer"');
    expect(html).not.toContain('<line ');
    assertSafe(layout, corrections.map((item) => item.id));
  });
});

function roundForTest(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function cssPixelForTest(value) {
  return Number(value) * 25.4 / 96;
}
