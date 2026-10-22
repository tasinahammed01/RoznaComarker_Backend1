'use strict';
jest.mock('@google-cloud/vision',()=>({ImageAnnotatorClient:jest.fn(()=>({documentTextDetection:mockDetect}))}));
const mockDetect=jest.fn();
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const vision=require('../src/services/visionOcr.service');
const {HANDWRITING_LAYOUT_VERSION}=require('../src/utils/ocrTranscriptNormalizer');
const filename=path.resolve(__dirname,'../tmp/handwriting-order-'+process.pid+'.png');
function word(text,x,y){return {symbols:[...text].map(text=>({text,confidence:.9})),boundingBox:{vertices:[{x,y},{x:x+18,y},{x:x+18,y:y+10},{x,y:y+10}]}};}
const annotation=()=>({text:'Second line\nFirst line',pages:[{width:200,height:200,blocks:[{paragraphs:[{words:[word('Second',5,60),word('line',35,60)]}]},{paragraphs:[{words:[word('line',35,20),word('First',5,20)]}]}]}]});
beforeAll(async()=>fs.writeFileSync(filename,await sharp({create:{width:200,height:200,channels:3,background:'white'}}).png().toBuffer()));
beforeEach(()=>{process.env.OCR_SOURCE_MODE='legacy';delete process.env.OCR_READING_ORDER;delete process.env.OCR_LANGUAGE_HINTS;delete process.env.GOOGLE_CLOUD_KEY_FILE;delete process.env.GOOGLE_APPLICATION_CREDENTIALS;mockDetect.mockReset();mockDetect.mockResolvedValue([{fullTextAnnotation:annotation()}]);});
afterAll(()=>{fs.unlinkSync(filename);delete process.env.OCR_SOURCE_MODE;delete process.env.OCR_READING_ORDER;delete process.env.OCR_LANGUAGE_HINTS;});
test('legacy image ignores scrambled native block order; native text is private diagnostic only',async()=>{
  const r=await vision.extractOcrFromImageFile(filename);expect(r.fullText).toBe('First line\nSecond line');expect(r.transcriptText).toBe(r.fullText);
  expect(r.pages[0].ocrPipelineVersion).toBe(HANDWRITING_LAYOUT_VERSION);
  const d=r[vision.READING_ORDER_DIAGNOSTICS];expect(d.nativeGoogleText).toBe('Second line\nFirst line');expect(d.geometryTranscript).toBe(r.fullText);expect(d.lineCount).toBe(2);expect(d.geometryCoverage[0].ratio).toBe(1);
  expect(JSON.stringify(r)).not.toContain('Second line\\nFirst line');expect(mockDetect).toHaveBeenCalledTimes(1);
  expect(mockDetect.mock.calls[0][0].imageContext).toBeUndefined();
});
test('incomplete Google geometry fails without silently falling back to native text',async()=>{
  const a=annotation();delete a.pages[0].blocks[0].paragraphs[0].words[0].boundingBox;mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});expect(mockDetect).toHaveBeenCalledTimes(1);
});
test('explicit native printed-text compatibility and configurable language hints',async()=>{
  process.env.OCR_READING_ORDER='native';process.env.OCR_LANGUAGE_HINTS='en, fr';
  const r=await vision.extractOcrFromImageFile(filename);expect(r.fullText).toBe('Second line\nFirst line');expect(r.pages[0].ocrPipelineVersion).not.toBe(HANDWRITING_LAYOUT_VERSION);
  expect(mockDetect.mock.calls[0][0].imageContext.languageHints).toEqual(['en','fr']);
});
test('one unusable polygon between immediate same-line anchors survives service and canonical reconstruction',async()=>{
  const a=annotation();a.pages[0].blocks=[{paragraphs:[{words:[word('relize',5,20),{symbols:[{text:'Social,'}]},word('preception',70,20)]}]}];
  mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);const r=await vision.extractOcrFromImageFile(filename);
  expect(r.fullText).toBe('relize Social, preception');expect(r.words).toHaveLength(3);expect(r.pages[0].words).toHaveLength(3);expect(r.pages[0].words[1].bbox).toBeNull();
  const d=r[vision.READING_ORDER_DIAGNOSTICS];expect(d.rawGeometryCoverage).toBeCloseTo(2/3);expect(d.resolvedPlacementCoverage).toBe(1);expect(d.fallbackPlacementCount).toBe(1);
  const page={...r.pages[0],fileId:'f'};expect(require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[page]}).text).toBe(r.fullText);
});
test('development rejection logs only bounded non-text descriptors and safe counts',async()=>{
  const logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{});const prior=process.env.NODE_ENV;process.env.NODE_ENV='development';
  const a=annotation();a.text='SECRET_TRANSCRIPT';a.pages[0].blocks[0].paragraphs[0].words.unshift({symbols:[{text:'SECRET_WORD'}]});mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  try{await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});
    const logs=spy.mock.calls.map(([v])=>v).filter(v=>v.event==='ocr_handwriting_layout_rejected');expect(logs).toHaveLength(1);
    expect(Object.keys(logs[0]).sort()).toEqual(['event','reasonCode','detectedWordCount','geometricWordCount','rawGeometryCoverage','resolvedWordCount','resolvedPlacementCoverage','fallbackPlacementCount','ambiguousWordCount','unresolvedWordCount','lineCount','medianWordHeight','unresolvedDescriptors'].sort());
    expect(logs[0].reasonCode).toBe('MISSING_GEOMETRY_UNRESOLVED');expect(logs[0].unresolvedDescriptors.length).toBeLessThanOrEqual(20);
    expect(Object.keys(logs[0].unresolvedDescriptors[0]).sort()).toEqual(['inputIndex','textLength','hasGeometry','candidateLineCount','reason'].sort());expect(JSON.stringify(logs)).not.toContain('SECRET');
  }finally{process.env.NODE_ENV=prior;spy.mockRestore();}
});
test('descriptor logs are capped at twenty and logging failure cannot alter rejection',async()=>{
  const logger=require('../src/utils/logger'),prior=process.env.NODE_ENV,spy=jest.spyOn(logger,'info').mockImplementation(()=>{});process.env.NODE_ENV='development';
  const a=annotation();a.pages[0].blocks=[{paragraphs:[{words:Array.from({length:50},()=>({symbols:[{text:'DO_NOT_LOG'}]}))}]}];mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  try{
    await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});
    const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='ocr_handwriting_layout_rejected');expect(log.unresolvedDescriptors).toHaveLength(20);expect(log.unresolvedWordCount).toBe(50);expect(JSON.stringify(log)).not.toContain('DO_NOT_LOG');
    spy.mockImplementation(()=>{throw Error('logger unavailable');});await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});
  }finally{process.env.NODE_ENV=prior;spy.mockRestore();}
});
test('production never emits development layout rejection diagnostics',async()=>{
  const logger=require('../src/utils/logger'),prior=process.env.NODE_ENV,spy=jest.spyOn(logger,'info').mockImplementation(()=>{});process.env.NODE_ENV='production';
  const a=annotation();delete a.pages[0].blocks[0].paragraphs[0].words[0].boundingBox;mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  try{await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});expect(spy.mock.calls.some(([v])=>v.event==='ocr_handwriting_layout_rejected')).toBe(false);}
  finally{process.env.NODE_ENV=prior;spy.mockRestore();}
});
test('an imperfect polygon with three finite observed corners still supplies usable word geometry',async()=>{
  const a=annotation();a.pages[0].blocks[0].paragraphs[0].words[0].boundingBox.vertices[3]=null;mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  const r=await vision.extractOcrFromImageFile(filename);expect(r.fullText).toBe('First line\nSecond line');expect(r[vision.READING_ORDER_DIAGNOSTICS].resolvedPlacementCoverage).toBe(1);
});
test('sole-outlier rejection metrics contain only safe numbers/booleans; private success counter is retained',async()=>{
  const box=(text,x,y,width,height)=>({symbols:[{text}],boundingBox:{vertices:[{x,y},{x:x+width,y},{x:x+width,y:y+height},{x,y:y+height}]}});
  const a=annotation();a.pages[0].blocks=[{paragraphs:[{words:[box('SECRET_WORD',30,28,5,10),box('left',5,20,40,10),box('right',70,20,18,10)]}]}];
  const prior=process.env.NODE_ENV,logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{});process.env.NODE_ENV='development';
  mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  try{
    await expect(vision.extractOcrFromImageFile(filename)).rejects.toMatchObject({code:'OCR_READING_ORDER_UNRELIABLE'});
    const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='ocr_handwriting_layout_rejected'),d=log.unresolvedDescriptors[0];
    expect(d.candidateLineCount).toBe(1);expect(typeof d.normalizedCenterDistance).toBe('number');expect(typeof d.horizontalInsertionResolved).toBe('boolean');expect(typeof d.neighboringLineConflict).toBe('boolean');expect(JSON.stringify(log)).not.toContain('SECRET');
    a.pages[0].blocks[0].paragraphs[0].words[0]=box('SECRET_WORD',30,24,5,3);mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
    const r=await vision.extractOcrFromImageFile(filename);expect(r[vision.READING_ORDER_DIAGNOSTICS].soleCandidateOutlierPlacementCount).toBe(1);expect(JSON.stringify(r)).not.toContain('soleCandidateOutlierPlacementCount');
    expect(require('../src/utils/ocrTranscriptNormalizer').buildCanonicalSubmissionTranscript({files:['f'],ocrPages:[{...r.pages[0],fileId:'f'}]}).text).toBe(r.fullText);
  }finally{process.env.NODE_ENV=prior;spy.mockRestore();}
});
test('stored assignment prompt is excluded after unchanged geometry ordering and retained only as private evidence',async()=>{
  const question='How do social and cultural expectations shape Louise Mallard choices feelings and sense of self';
  const lines=['How do social and cultural expectations','shape Louise Mallard choices feelings','and sense of self','Social and cultural expectations','shape Louise Mallard because the'];
  const a=annotation();a.text=lines.join('\n');a.pages[0].blocks=[{paragraphs:[{words:lines.flatMap((line,row)=>line.split(' ').map((s,col)=>word(s,5+col*25,5+row*20)))}]}];mockDetect.mockResolvedValue([{fullTextAnnotation:a}]);
  const r=await vision.extractOcrFromImageFile(filename,{sourceFile:{_id:'f'},sourceAssignment:{instructions:question}});
  expect(r.fullText).toBe('Social and cultural expectations\nshape Louise Mallard because the');expect(r.studentSourceVersion).toBe('legacy-student-source-v1');
  expect(r[vision.STUDENT_SOURCE_EVIDENCE].boundary).toMatchObject({promptLinesExcluded:3,studentTranscriptStartLine:4,promptCandidateDetected:true});
  expect(JSON.stringify(r)).not.toContain('excludedPromptCount');expect(r.words[0].id).toBe('word_f_1_16');
});
