'use strict';
jest.setTimeout(60000);
process.env.NODE_ENV='test';process.env.JWT_SECRET='source-website-offline-test';
process.env.UPLOAD_BASE_PATH='uploads/source-website-test-'+process.pid;
process.env.OCR_ASTRA_MODEL='openai/gpt-6-astra';process.env.OCR_FABLE_MODEL='anthropic/claude-fable-5.1';process.env.OPENROUTER_API_KEY='mock-only';
jest.mock('../src/services/assessmentRecovery.service',()=>({scheduleSubmissionAnalysis:jest.fn()}));
jest.mock('../src/services/canonicalCorrectionsPipeline.service',()=>({generateAndPersist:jest.fn(async()=>{})}));
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:jest.fn(async()=>({ready:true,checks:[]}))}));
jest.mock('../src/services/assessmentCreditRouter.service',()=>({canRunAssessment:jest.fn(async()=>({allowed:true}))}));
jest.mock('../src/services/aiGateway.service',()=>({providerAttempt:jest.fn()}));
const mockDetect=jest.fn(async()=>[{fullTextAnnotation:{text:'sense (Google evidence only)',pages:[{width:800,height:1000,
  blocks:[{paragraphs:[{words:[{boundingBox:{vertices:[{x:10,y:10},{x:100,y:10},{x:100,y:40},{x:10,y:40}]},
    symbols:[...'sense'].map(text=>({text,confidence:0.99}))}]}]}]}]}}]);
jest.mock('@google-cloud/vision',()=>({ImageAnnotatorClient:jest.fn(()=>({documentTextDetection:mockDetect}))}));
const fs=require('fs'),path=require('path'),sharp=require('sharp'),request=require('supertest');
const app=require('../src/app');
const {connectInMemoryMongo,disconnectInMemoryMongo}=require('./helpers/testServer');
const {seedTestPlans}=require('./helpers/seedTestPlans');
const {signTestJwt}=require('./helpers/auth');
const User=require('../src/models/user.model'),Class=require('../src/models/class.model'),Assignment=require('../src/models/assignment.model');
const Submission=require('../src/models/Submission');
const Snapshot=require('../src/models/SourceFidelitySnapshot');
const Evidence=require('../src/models/SourceFidelityEvidence');
const gateway=require('../src/services/aiGateway.service');
const corrections=require('../src/services/canonicalCorrectionsPipeline.service');
const {runOcrAndPersistForFiles}=require('../src/services/ocrPipeline.service');
const source=require('../src/utils/sourceFidelity');
let token,assignment,png;
test.each([true,false])('GPT upload keeps normal result/error API, private evidence and durable one-read reservation (success=%s)',async success=>{
  process.env.OCR_SOURCE_MODE='gpt_vision_exact';process.env.OCR_GPT_VISION_MODEL='openai/gpt-5.6-sol';
  corrections.generateAndPersist.mockClear();gateway.providerAttempt.mockClear();mockDetect.mockClear();
  const c=require('../src/services/gptVisionExact/contract');
  const opening='Social and cultural expectations shape Louise Mallard because the society'.split(' ');
  const active=Array.from({length:100},(_,i)=>opening[i]||`word${String(i).padStart(3,'0')}`);
  const exact=active.map((t,i)=>(i?i%10===0?'\n':' ':'')+t).join('');
  if(success)mockDetect.mockResolvedValueOnce([{fullTextAnnotation:{text:'GOOGLE TEXT IS NOT SOURCE',pages:[{width:800,height:1000,blocks:[{paragraphs:[{words:active.slice(20,80).map((text,i)=>{
    const x=(3+i%10*8)*8,y=(10+Math.floor(i/10)*10)*10;
    return {symbols:[...(i===0?text.toUpperCase():text)].map(text=>({text,confidence:1})),boundingBox:{vertices:[{x,y},{x:x+48,y},{x:x+48,y:y+50},{x,y:y+50}]}};
  })}]}]}]}}]);
  const payload={version:c.VERSION,activeTranscript:exact,physicalLines:[{segments:[{classification:'PROMPT_OR_INSTRUCTION',text:'PRIVATE_PHOTOGRAPHED_PROMPT',confidence:1}]},
    ...exact.split('\n').map(text=>({segments:[{classification:'STUDENT_ACTIVE_TEXT',text,confidence:1}]})),{segments:[{classification:'STUDENT_CROSSED_OUT',text:null,confidence:1}]}],uncertainties:[]};
  gateway.providerAttempt.mockImplementation(async o=>{if(!success)throw Object.assign(Error('PRIVATE_PROVIDER_BODY'),{code:'AI_PROVIDER_PAYMENT_REQUIRED'});return {returnedModel:o.entry.model,content:JSON.stringify(payload)};});
  const a=await Assignment.create({title:'GPT case '+success,class:assignment.class,teacher:assignment.teacher,qrToken:'gpt-case-'+success});
  const checked=await request(app).post('/api/submissions/image-preflight').set('Authorization','Bearer '+token).field('assignmentId',String(a._id)).attach('file',png,{filename:'writing.png',contentType:'image/png'});
  expect(checked.body.data.sourceReadStatus).toBe(success?'PASSED':'FAILED_SERVICE');
  if(!success){expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect(corrections.generateAndPersist).not.toHaveBeenCalled();expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);return;}
  const accepted=await request(app).post('/api/submissions/'+a._id).set('Authorization','Bearer '+token).attach('file',png,{filename:'writing.png',contentType:'image/png'});
  expect(accepted.status).toBe(200);const d=await Submission.findOne({assignment:a._id});await runOcrAndPersistForFiles({fileIds:d.files,targetDoc:d,jobId:d.ocrJobId});
  const saved=await Submission.findById(d._id);expect(source.eligible(saved)).toBe(success);expect(corrections.generateAndPersist).toHaveBeenCalledTimes(success?1:0);
  const view=await request(app).get('/api/submissions/assignment/'+a._id+'/my').set('Authorization','Bearer '+token);
  const response=await request(app).get('/api/submissions/'+d._id+'/ocr-corrections').set('Authorization','Bearer '+token);
  expect(view.status).toBe(200);expect(view.body.data.sourceFidelity).toBeUndefined();expect(response.body.data.sourceFidelity).toBeUndefined();
  if(success){expect(response.status).toBe(200);expect(response.body.data).toMatchObject({transcript:exact,transcriptComplete:true});expect(response.body.data.ocr).toHaveLength(1);expect(response.body.data.transcriptPages).toHaveLength(1);
    const words=response.body.data.ocr[0].words;expect(words).toHaveLength(100);expect(words.filter(w=>w.bbox===null)).toHaveLength(40);
    expect(words.map(w=>w.text)).toEqual(active);expect(words.map(w=>w.separatorBefore+w.text).join('')).toBe(exact);
    expect(words.map(w=>w.id)).toEqual(response.body.data.transcriptWordSpans.map(s=>s.wordId));
    expect(words.every(w=>w.fileId===String(d.files[0])&&w.page===1)).toBe(true);
    expect(new Set(words.map(w=>w.id)).size).toBe(100);expect(words[20].bbox).toBeTruthy();expect(words[20].text).toBe('word020');
    const file=await require('../src/models/File').findById(d.files[0]).select('+gptSourcePreflight');
    const reuseIdentity={submissionId:String(d._id),assignmentId:String(a._id),studentId:String(d.student),runId:'another-recovery-job'};
    const again=await require('../src/services/gptVisionExact.service').readPage({bytes:png,mimeType:'image/png',assignment:a,reservation:require('../src/services/gptVisionExact/preflight').claimReservation(file,reuseIdentity),identity:{...reuseIdentity,fileId:String(file._id),pageNumber:1,sourceSha256:c.sha(png)}});
    expect(again.fullText).toBe(exact);
  }else{expect(response.status).toBe(422);expect(response.body.data.ocrErrorCode).toBe('OCR_GPT_PROVIDER_PAYMENT_REQUIRED');
    await expect(require('../src/services/gptVisionExact/attempt').acquire({submissionId:String(d._id),fileId:String(d.files[0]),runId:'recovery',pageNumber:1,inputSha256:c.sha(png),sourceSha256:c.sha(png),model:process.env.OCR_GPT_VISION_MODEL,promptSha256:'changed'})).rejects.toThrow('RESERVED');
  }
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);const evidence=await Evidence.findOne({'identity.assignmentId':String(a._id),'identity.preSubmission':true}).lean();expect(evidence.expiresAt).toBeNull();expect(evidence.payload).toBeUndefined();
  for(const body of [view.body,response.body])expect(JSON.stringify(body)).not.toMatch(/PRIVATE_PHOTOGRAPHED_PROMPT|PRIVATE_PROVIDER_BODY|mock-only/);
});
beforeAll(async()=>{
  await connectInMemoryMongo({replicaSet:true});await Snapshot.init();await seedTestPlans();
  const [student,teacher]=await User.create(['student','teacher'].map(role=>({role,firebaseUid:'source-offline-'+role,email:role+'@source.invalid'})));
  token=signTestJwt({id:student._id,role:'student',firebaseUid:student.firebaseUid});
  const classroom=await Class.create({name:'Source offline',teacher:teacher._id,joinCode:'SOURCE-OFFLINE',qrCodeUrl:'data:,'});
  await require('../src/models/membership.model').create({student:student._id,class:classroom._id});
  assignment=await Assignment.create({title:'Offline source',class:classroom._id,teacher:teacher._id,qrToken:'source-test-token',allowResubmission:true});
  png=await sharp({create:{width:800,height:1000,channels:3,background:'white'}}).png().toBuffer();
});
afterAll(async()=>{
  delete process.env.OCR_SOURCE_MODE;
  const folder=path.resolve(__dirname,'..',process.env.UPLOAD_BASE_PATH,'submissions');
  if(fs.existsSync(folder))for(const name of fs.readdirSync(folder))if(/^[a-f\d-]+\.png$/i.test(name))fs.unlinkSync(path.join(folder,name));
  for(let attempt=0;;attempt++){
    try{await disconnectInMemoryMongo();break;}
    catch(error){if(error.code!=='EBUSY'||attempt>=3)throw error;await new Promise(resolve=>setTimeout(resolve,300));}
  }
});
test.each([true,false])('ordinary registered upload persists exact source and authorized result (agreement=%s)',async agreed=>{
  process.env.OCR_SOURCE_MODE='astra_verified';corrections.generateAndPersist.mockClear();gateway.providerAttempt.mockClear();mockDetect.mockClear();
  const exact='  sence \nSocial ,free\n';
  gateway.providerAttempt.mockImplementation(async options=>{
    const text=!agreed&&options.entry.model.startsWith('anthropic/')?'sense':exact;
    return {returnedModel:options.entry.model,content:JSON.stringify({activeTranscript:text,
      segments:text.split('\n').map(text=>({type:'ACTIVE_STUDENT_TEXT',text,confidence:0.99,notes:''})),uncertainSpans:[]})};
  });
  // Use a fresh assignment to avoid changing normal resubmission policy in this integration fixture.
  const a=await Assignment.create({title:'Source case '+agreed,class:assignment.class,teacher:assignment.teacher,qrToken:'source-case-'+agreed});
  const accepted=await request(app).post('/api/submissions/'+a._id).set('Authorization','Bearer '+token).attach('file',png,{filename:'writing.png',contentType:'image/png'});
  expect(accepted.status).toBe(200);
  const doc=await Submission.findOne({assignment:a._id});expect(doc.ocrStatus).toBe('pending');
  await runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  const saved=await Submission.findById(doc._id);expect(saved.sourceTranscriptExact).toBe(exact);
  expect(saved.sourceFidelityStatus).toBe(agreed?'MODEL_AGREED':'OCR_UNCERTAIN');
  expect(corrections.generateAndPersist).toHaveBeenCalledTimes(agreed?1:0);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(2);
  const calls=gateway.providerAttempt.mock.calls.map(c=>c[0]);expect(calls[0].messages).toEqual(calls[1].messages);
  const modelImage=Buffer.from(calls[0].messages[1].content[1].image_url.url.split(',')[1],'base64');
  expect(source.sha(modelImage)).toBe(saved.ocrPages[0].sourceInputSha256);
  expect(source.sha(mockDetect.mock.calls[0][0].image.content)).toBe(source.sha(modelImage));
  expect(mockDetect.mock.calls[0][1].retry).toBeNull();
  const view=await request(app).get('/api/submissions/assignment/'+a._id+'/my').set('Authorization','Bearer '+token);
  expect(view.status).toBe(200);expect(view.body.data.sourceFidelity.transcriptExact).toBe(exact);
  const ocr=await request(app).get('/api/submissions/'+doc._id+'/ocr-corrections').set('Authorization','Bearer '+token);
  expect(ocr.status).toBe(200);expect(ocr.body.data.sourceFidelity.transcriptExact).toBe(exact);
  if(!agreed)expect(ocr.body.data.evaluationStatus).toBe('blocked');
  expect(JSON.stringify(view.body)).not.toContain('mock-only');expect(JSON.stringify(view.body)).not.toContain('secondary');
  expect((await Evidence.findOne({'identity.submissionId':String(doc._id)}).lean()).payload).toBeUndefined();
  expect((await request(app).get('/api/submissions/'+doc._id+'/ocr-corrections')).status).toBe(401);
});


test('urgent normal upload uses one Astra source call, no Google, and blocks correction',async()=>{
  process.env.OCR_SOURCE_MODE='astra_human_confirm';corrections.generateAndPersist.mockClear();gateway.providerAttempt.mockClear();mockDetect.mockClear();
  const exact='  wemen, Social sence.\n';
  gateway.providerAttempt.mockImplementation(async options=>({returnedModel:options.entry.model,content:JSON.stringify({activeTranscript:exact,segments:[{type:'ACTIVE_STUDENT_TEXT',text:exact,confidence:1,notes:''}],uncertainSpans:[]})}));
  const a=await Assignment.create({title:'Urgent source',class:assignment.class,teacher:assignment.teacher,qrToken:'urgent-source'});
  const accepted=await request(app).post('/api/submissions/'+a._id).set('Authorization','Bearer '+token).attach('file',png,{filename:'writing.png',contentType:'image/png'});
  expect(accepted.status).toBe(200);const doc=await Submission.findOne({assignment:a._id});
  await runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  const saved=await Submission.findById(doc._id);expect(saved.sourceTranscriptExact).toBe(exact);expect(saved.sourceFidelityMode).toBe('astra_human_confirm');
  expect(saved.sourceFidelityStatus).toBe('HUMAN_REVIEW_REQUIRED');expect(saved.ocrPages[0].sourceFidelityStatus).toBe('ASTRA_PROVISIONAL');
  expect(saved.ocrPages[0].ocrProvider).toBe('openrouter');expect(source.eligible(saved)).toBe(false);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(gateway.providerAttempt.mock.calls[0][0].entry.model).toBe('openai/gpt-6-astra');
  expect(mockDetect).not.toHaveBeenCalled();expect(corrections.generateAndPersist).not.toHaveBeenCalled();
  const normalized=await sharp(png).rotate().toBuffer();
  const identity={submissionId:String(doc._id),runId:doc.ocrJobId,fileId:String(doc.files[0]),pageNumber:1};
  const recovered=await require('../src/services/sourceFidelityOcr.service').readPage({bytes:normalized,mimeType:'image/png',identity});
  expect(recovered.fullText).toBe(exact);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  const intent=await require('../src/services/sourceFidelity/urgentAttempt').acquire({...identity,pageNumber:2,inputSha256:source.sha(normalized)});
  await expect(require('../src/services/sourceFidelity/urgentAttempt').acquire({...identity,pageNumber:2,inputSha256:source.sha(normalized)})).rejects.toMatchObject({code:'OCR_SOURCE_ATTEMPT_RESERVED'});
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});
