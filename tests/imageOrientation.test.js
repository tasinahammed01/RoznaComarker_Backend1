const { estimateDocumentOrientation: estimate } = require('../src/services/imageOrientation.service');
const { annotation } = require('./fixtures/orientationAnnotation');
test.each([[0,'upright'],[90,'rotated_90'],[180,'rotated_180'],[270,'rotated_270'],[8,'upright'],[-10,'upright'],[12,'upright']])(
  'aggregates ordered word polygons at %s degrees', (angle, orientation) => {
    expect(estimate(annotation(Array(8).fill(angle)))).toMatchObject({ orientation, evidenceCount: 8 });
  });
test('handles circular wraparound', () => expect(estimate(annotation([179,-179,178,-178,180,180])).orientation).toBe('rotated_180'));
test.each([[0], [0,0], [0,0,90,90,180,270], [45,45,45,45]])('weak/conflicting evidence stays undetermined: %j', (...angles) => {
  expect(estimate(annotation(angles)).orientation).toBe('undetermined');
});
test.each([4, 12, 60, 200])('handles a sentence, two lines, paragraphs and dense page (%s words)', count => {
  expect(estimate(annotation(Array(count).fill(3))).orientation).toBe('upright');
});
test('ignores missing, tiny, crossed and degenerate polygons', () => {
  const a = annotation();
  a.pages[0].blocks[0].paragraphs[0].words.push({}, {boundingBox:{vertices:[null,null,null,null]}},
    {boundingBox:{vertices:[{x:1,y:1},{x:2,y:1},{x:2,y:2},{x:1,y:2}]}},
    {boundingBox:{vertices:[{},{},{},{}]}});
  expect(estimate(a)).toMatchObject({ orientation:'upright', evidenceCount:6 });
  expect(estimate(null)).toMatchObject({orientation:'undetermined',confidence:null});
  expect(estimate({pages:[null,{blocks:{}}]}).orientation).toBe('undetermined');
});
