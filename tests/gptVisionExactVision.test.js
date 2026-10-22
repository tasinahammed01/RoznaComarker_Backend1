'use strict';
const mockDetect=jest.fn();
jest.mock('@google-cloud/vision',()=>({ImageAnnotatorClient:jest.fn(()=>({documentTextDetection:mockDetect}))}));
jest.mock('../src/services/gptVisionExact/attempt',()=>({acquire:jest.fn(async()=>({_id:'r',cached:false})),complete:jest.fn(async()=>{})}));
// This image/transport unit suite supplies admitted evidence separately from the
// real upload/preflight integration suites, which exercise durable claim checks.
jest.mock('../src/services/gptVisionExact/preflight',()=>({claimReservation:()=>require('../src/services/gptVisionExact/attempt')}));
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const vision=require('../src/services/visionOcr.service'),gateway=require('../src/services/aiGateway.service'),contract=require('../src/services/gptVisionExact/contract');
const filename=path.resolve(__dirname,'../tmp/gpt-exact-orientation-'+process.pid+'.jpg');
let original,normalized,spy;const before={...process.env};
const text='Society always expect\npowerfull Say , society society';
const payload={version:contract.VERSION,activeTranscript:text,physicalLines:text.split('\n').map(text=>({segments:[{text,classification:'STUDENT_ACTIVE_TEXT',confidence:.99}]})),uncertainties:[]};
beforeAll(async()=>{
  original=await sharp({create:{width:40,height:80,channels:3,background:{r:220,g:30,b:90}}}).jpeg().withMetadata({orientation:6}).toBuffer();
  fs.writeFileSync(filename,original);normalized=await sharp(original,{failOn:'error'}).rotate().png().toBuffer();
});
beforeEach(()=>{
  process.env.OCR_SOURCE_MODE='gpt_vision_exact';process.env.OCR_GPT_VISION_MODEL='openai/gpt-5.6-sol';process.env.OPENROUTER_API_KEY='mock-only';process.env.OCR_PREPROCESS='handwriting';
  delete process.env.GOOGLE_CLOUD_KEY_FILE;delete process.env.GOOGLE_APPLICATION_CREDENTIALS;mockDetect.mockReset();mockDetect.mockResolvedValue([{fullTextAnnotation:{text:'GOOGLE CONFLICT',pages:[]}}]);
  spy=jest.spyOn(gateway,'providerAttempt').mockResolvedValue({returnedModel:process.env.OCR_GPT_VISION_MODEL,content:JSON.stringify(payload)});
});
afterEach(()=>{spy.mockRestore();for(const k of Object.keys(process.env))if(!(k in before))delete process.env[k];Object.assign(process.env,before);});
afterAll(()=>fs.unlinkSync(filename));
test('actual image entry point sends only orientation-normalized color pixels, one GPT request and exact source hashes',async()=>{
  const r=await vision.extractOcrFromImageFile(filename,{sourceFile:{_id:'f'},hybridIdentity:{submissionId:'s',runId:'j'},sourceAssignment:{instructions:'STORED REFERENCE'}});
  expect(spy).toHaveBeenCalledTimes(1);const request=spy.mock.calls[0][0],url=request.messages[1].content[1].image_url.url;
  expect(Buffer.from(url.split(',')[1],'base64').equals(normalized)).toBe(true);expect(request.requestProfile).toBe('gpt_vision_exact_v1');
  expect(r.fullText).toBe(text);expect(r.pages[0]).toMatchObject({width:80,height:40,sourceSha256:contract.sha(original),ocrInputSha256:contract.sha(normalized),ocrProvider:'openrouter'});
  expect(mockDetect).toHaveBeenCalledTimes(1);expect(r.words.every(w=>w.bbox===null)).toBe(true);expect(JSON.stringify(r)).not.toContain('GOOGLE CONFLICT');
});
test('entry point never calls Google after provider/schema failure or attempts legacy fallback',async()=>{
  spy.mockRejectedValue(Object.assign(Error('private'),{code:'AI_PROVIDER_PAYMENT_REQUIRED'}));
  await expect(vision.extractOcrFromImageFile(filename,{sourceFile:{_id:'f'},hybridIdentity:{submissionId:'s',runId:'j'}})).rejects.toMatchObject({code:'OCR_GPT_PROVIDER_PAYMENT_REQUIRED'});
  expect(spy).toHaveBeenCalledTimes(1);expect(mockDetect).not.toHaveBeenCalled();
});
test('mismatched Google image dimensions withhold boxes without rejecting or replacing GPT source',async()=>{
  mockDetect.mockResolvedValue([{fullTextAnnotation:{text:'Society',pages:[{width:999,height:999,blocks:[{paragraphs:[{words:[{symbols:[...'Society'].map(text=>({text})),boundingBox:{vertices:[{x:2,y:2},{x:20,y:2},{x:20,y:9},{x:2,y:9}]}}]}]}]}]}}]);
  const r=await vision.extractOcrFromImageFile(filename,{sourceFile:{_id:'f'},hybridIdentity:{submissionId:'s',runId:'j'}});
  expect(r.fullText).toBe(text);expect(r.words.every(w=>w.bbox===null)).toBe(true);expect(mockDetect.mock.calls[0][1].retry).toBeNull();expect(spy).toHaveBeenCalledTimes(1);
});
