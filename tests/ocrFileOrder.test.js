'use strict';

jest.mock('fs', () => ({ existsSync: jest.fn(() => true) }));
jest.mock('../src/models/File', () => ({ findById: jest.fn() }));
jest.mock('../src/models/assignment.model', () => ({ findById: jest.fn() }));
jest.mock('../src/services/visionOcr.service', () => ({ extractOcrFromImageFile: jest.fn() }));
jest.mock('../src/services/canonicalCorrectionsPipeline.service', () => ({ generateAndPersist: jest.fn(async () => {}) }));

const File = require('../src/models/File');
const vision = require('../src/services/visionOcr.service');
const pipeline = require('../src/services/canonicalCorrectionsPipeline.service');
const { runOcrAndPersistForFiles } = require('../src/services/ocrPipeline.service');

const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const result = (text) => ({ transcriptText: text, fullText: text, words: [],
  pages: [{ pageNumber: 1, words: [] }] });

describe('OCR authoritative upload order', () => {
  test('reverse provider completion cannot reverse persisted files or pages', async () => {
    const first = deferred(); const second = deferred();
    File.findById.mockImplementation(async (id) => ({ _id: id, path: `${id}.jpg` }));
    vision.extractOcrFromImageFile.mockImplementation((path) => path.endsWith('first.jpg') ? first.promise : second.promise);
    const updateOne = jest.fn(async (_query, update) => {
      if (update?.$set) Object.assign(targetDoc, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    });
    const targetDoc = { _id: 'submission', assignment: null, ocrJobId: 'job',
      constructor: { exists: jest.fn(async () => true), updateOne },
      toObject() { const { constructor, toObject, ...values } = this; return values; } };

    const pending = runOcrAndPersistForFiles({ fileIds: ['first', 'second'], targetDoc, jobId: 'job' });
    await Promise.resolve(); await Promise.resolve();
    second.resolve(result('Continuation page'));
    await Promise.resolve();
    first.resolve(result('Introduction page'));
    await pending;

    expect(targetDoc.ocrPages.map((page) => ({ fileId: page.fileId, fileOrder: page.fileOrder, pageIndex: page.pageIndex })))
      .toEqual([{ fileId: 'first', fileOrder: 0, pageIndex: 0 }, { fileId: 'second', fileOrder: 1, pageIndex: 0 }]);
    expect(targetDoc.combinedOcrText).toBe('Introduction page\n\nContinuation page');
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(1);
  });

  test('persists native full text instead of corrupted word reconstruction', async () => {
    const before = pipeline.generateAndPersist.mock.calls.length;
    File.findById.mockResolvedValue({ _id: 'photo', path: 'photo.jpg' });
    vision.extractOcrFromImageFile.mockResolvedValue({
      fullText: 'Another feature to compare between private cars and taking taxis is the comfort.',
      transcriptText: 'take Another with taxis feature own the cars comfort',
      words: [], pages: [{ pageNumber: 1, words: [] }]
    });
    const targetDoc = { _id: 'native-order', assignment: null, ocrJobId: 'job-native',
      constructor: { exists: jest.fn(async () => true), updateOne: jest.fn(async (_query, update) => {
        if (update?.$set) Object.assign(targetDoc, update.$set); return { matchedCount: 1, modifiedCount: 1 };
      }) }, toObject() { const { constructor, toObject, ...values } = this; return values; } };
    await runOcrAndPersistForFiles({ fileIds: ['photo'], targetDoc, jobId: 'job-native' });
    expect(targetDoc.ocrPages[0].text).toBe('Another feature to compare between private cars and taking taxis is the comfort.');
    expect(targetDoc.combinedOcrText).toBe(targetDoc.ocrPages[0].text);
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(before + 1);
  });
  test('handwriting geometry survives source persistence and canonical reconstruction literally',async()=>{
    const {HANDWRITING_LAYOUT_VERSION,buildCanonicalSubmissionTranscript}=require('../src/utils/ocrTranscriptNormalizer');
    const words=[{text:'  sence,',page:1,bbox:{x:5,y:10,w:10,h:5}},{text:'Social  ',page:1,bbox:{x:5,y:20,w:10,h:5}}];
    const literal='  sence,\nSocial  ';
    File.findById.mockResolvedValue({_id:'photo',path:'photo.jpg'});
    vision.extractOcrFromImageFile.mockResolvedValue({fullText:literal,transcriptText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words,
      pages:[{pageNumber:1,text:literal,rawText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words}]});
    const targetDoc={_id:'handwriting-order',files:['photo'],assignment:null,ocrJobId:'job-handwriting',constructor:{exists:jest.fn(async()=>true),updateOne:jest.fn(async(_q,u)=>{Object.assign(targetDoc,u.$set);return {matchedCount:1,modifiedCount:1};})},toObject(){const {constructor,toObject,...v}=this;return v;}};
    await runOcrAndPersistForFiles({fileIds:['photo'],targetDoc,jobId:'job-handwriting'});
    expect(targetDoc.ocrStatus).toBe('completed');expect(targetDoc.combinedOcrText).toBe(literal);expect(targetDoc.rawCombinedOcrText).toBe(literal);
    expect(targetDoc.ocrPages[0].text).toBe(literal);expect(targetDoc.ocrPages[0].rawText).toBe(literal);expect(buildCanonicalSubmissionTranscript(targetDoc).text).toBe(literal);
  });
  test('handwriting layout failure cannot silently omit a file and grade other files',async()=>{
    const before=pipeline.generateAndPersist.mock.calls.length;
    File.findById.mockImplementation(async id=>({_id:id,path:id+'.jpg'}));
    vision.extractOcrFromImageFile.mockImplementation(async p=>{if(p.endsWith('bad.jpg'))throw Object.assign(Error('geometry unavailable'),{code:'OCR_READING_ORDER_UNRELIABLE',retryable:false});return result('Printed readable file');});
    const targetDoc={_id:'layout-failure',files:['good','bad'],ocrJobId:'layout-job',constructor:{exists:jest.fn(async()=>true),updateOne:jest.fn(async(_q,u)=>{Object.assign(targetDoc,u.$set);return {matchedCount:1,modifiedCount:1};})},toObject(){const {constructor,toObject,...v}=this;return v;}};
    await runOcrAndPersistForFiles({fileIds:['good','bad'],targetDoc,jobId:'layout-job'});
    expect(targetDoc.ocrStatus).toBe('failed');expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(before);
  });
  test('structurally resolved missing-box words survive all stored word arrays and canonical rebuilding',async()=>{
    const {HANDWRITING_LAYOUT_VERSION,buildCanonicalSubmissionTranscript}=require('../src/utils/ocrTranscriptNormalizer');
    const literal='left MISSING, right',words=[{text:'left',page:1,bbox:{x:5,y:10,w:10,h:5}},{text:'MISSING,',page:1,bbox:null},{text:'right',page:1,bbox:{x:40,y:10,w:10,h:5}}];
    File.findById.mockResolvedValue({_id:'photo',path:'photo.jpg'});
    vision.extractOcrFromImageFile.mockResolvedValue({fullText:literal,transcriptText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words,pages:[{pageNumber:1,text:literal,rawText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words}]});
    const targetDoc={_id:'resolved-layout',files:['photo'],ocrJobId:'resolved-job',constructor:{exists:jest.fn(async()=>true),updateOne:jest.fn(async(_q,u)=>{Object.assign(targetDoc,u.$set);return {matchedCount:1,modifiedCount:1};})},toObject(){const {constructor,toObject,...v}=this;return v;}};
    await runOcrAndPersistForFiles({fileIds:['photo'],targetDoc,jobId:'resolved-job'});
    expect(targetDoc.ocrStatus).toBe('completed');expect(targetDoc.ocrPages[0].words).toHaveLength(3);expect(targetDoc.ocrData.words).toHaveLength(3);
    expect(buildCanonicalSubmissionTranscript(targetDoc).text).toBe(literal);expect(targetDoc.ocrPages[0].words[1].bbox).toBeNull();
  });
  test('selected student source, private excluded evidence and assignment reference survive persistence without reentry into correction input',async()=>{
    const boundary=require('../src/utils/legacyStudentSource'),{HANDWRITING_LAYOUT_VERSION,buildCanonicalSubmissionTranscript}=require('../src/utils/ocrTranscriptNormalizer');
    const literal='Social sence\nLouise Mallard',words=['Social','sence','Louise','Mallard'].map((text,i)=>({id:`word_photo_1_${i+8}`,text,page:1,bbox:{x:5+(i%2)*20,y:10+Math.floor(i/2)*10,w:10,h:5},separatorBefore:i?(i===2?'\n':' '):'',studentSourceStatus:'ACTIVE'}));
    const privateKey=Symbol('student evidence');vision.STUDENT_SOURCE_EVIDENCE=privateKey;
    const evidence={occurrences:[{wordId:'word_photo_1_1',text:'PRIVATE_PROMPT',status:'ASSIGNMENT_PROMPT'},{wordId:'word_photo_1_2',text:'other',status:'VISUALLY_DELETED'}]};
    const assignment={instructions:'How do social and cultural expectations shape Louise Mallard choices feelings and sense of self'};require('../src/models/assignment.model').findById.mockReturnValue({lean:async()=>assignment});
    File.findById.mockResolvedValue({_id:'photo',path:'photo.jpg'});vision.extractOcrFromImageFile.mockResolvedValue({[privateKey]:evidence,fullText:literal,transcriptText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words,pages:[{pageNumber:1,text:literal,rawText:literal,ocrPipelineVersion:HANDWRITING_LAYOUT_VERSION,words,studentSourceVersion:boundary.VERSION,studentSourceTextSha256:boundary.sha(literal)}]});
    const targetDoc={_id:'selected-student',assignment:'assignment',files:['photo'],ocrJobId:'selected-job',constructor:{exists:jest.fn(async()=>true),updateOne:jest.fn(async(_q,u)=>{Object.assign(targetDoc,u.$set);return {matchedCount:1,modifiedCount:1};})},toObject(){const {constructor,toObject,...v}=this;return v;}};
    await runOcrAndPersistForFiles({fileIds:['photo'],targetDoc,jobId:'selected-job'});
    expect(vision.extractOcrFromImageFile.mock.calls.at(-1)[1].sourceAssignment).toBe(assignment);
    expect(targetDoc.ocrPages[0].studentSourceEvidence).toEqual(evidence);expect(targetDoc.ocrPages[0].words.map(w=>w.id)).toEqual(words.map(w=>w.id));
    expect(buildCanonicalSubmissionTranscript(targetDoc).text).toBe(literal);expect(targetDoc.combinedOcrText).toBe(literal);
    const called=pipeline.generateAndPersist.mock.calls.at(-1)[0];expect(buildCanonicalSubmissionTranscript(called).text).not.toMatch(/PRIVATE_PROMPT|other/);
    delete vision.STUDENT_SOURCE_EVIDENCE;
  });

  test('retains readable native text while marking annotation geometry degraded', async () => {
    File.findById.mockResolvedValue({ _id: 'bad', path: 'bad.jpg' });
    const words = Array.from({ length: 10 }, (_, index) => ({ text: `unmapped${index}`, page: 1,
      bbox: { x: index, y: 1, w: 1, h: 1 } }));
    vision.extractOcrFromImageFile.mockResolvedValue({ fullText: 'This photographed paragraph has a stable readable order.',
      transcriptText: 'unmapped word bag', words, pages: [{ pageNumber: 1, words }] });
    const targetDoc = { _id: 'bad-order', assignment: null, ocrJobId: 'job-bad',
      constructor: { exists: jest.fn(async () => true), updateOne: jest.fn(async (_query, update) => {
        if (update?.$set) Object.assign(targetDoc, update.$set); return { matchedCount: 1, modifiedCount: 1 };
      }) }, toObject() { const { constructor, toObject, ...values } = this; return values; } };
    const before = pipeline.generateAndPersist.mock.calls.length;
    const resultValue = await runOcrAndPersistForFiles({ fileIds: ['bad'], targetDoc, jobId: 'job-bad' });
    expect(resultValue).toMatchObject({ ocrStatus: 'completed' });
    expect(targetDoc).toMatchObject({ ocrErrorCode: 'OCR_LAYOUT_DEGRADED' });
    expect(targetDoc.ocrError).toContain('annotations may be unavailable');
    expect(pipeline.generateAndPersist).toHaveBeenCalledTimes(before + 1);
  });
});
