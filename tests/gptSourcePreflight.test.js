'use strict';
jest.setTimeout(90000);
process.env.NODE_ENV='test';process.env.JWT_SECRET='preflight-offline';process.env.UPLOAD_USER_RATE_LIMIT_MAX='500';
process.env.UPLOAD_BASE_PATH='uploads/gpt-preflight-test-'+process.pid;
jest.mock('../src/services/assessmentRecovery.service',()=>({scheduleSubmissionAnalysis:jest.fn()}));
jest.mock('../src/services/canonicalCorrectionsPipeline.service',()=>({generateAndPersist:jest.fn(async()=>{})}));
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:jest.fn(async()=>({ready:true,checks:[]}))}));
jest.mock('../src/services/aiGateway.service',()=>({providerAttempt:jest.fn()}));
jest.mock('../src/services/email.service',()=>({sendGuestSubmissionEmail:jest.fn(async()=>({success:true}))}));
jest.mock('../src/services/notification.service',()=>({createNotification:jest.fn(async()=>null)}));
const mockGoogleGeometry=jest.fn(async()=>[{fullTextAnnotation:{pages:[]}}]);
jest.mock('@google-cloud/vision',()=>({ImageAnnotatorClient:jest.fn(()=>({documentTextDetection:mockGoogleGeometry}))}));
const sharp=require('sharp'),request=require('supertest'),fs=require('fs'),path=require('path');
const app=require('../src/app'),mongoose=require('mongoose');
const {connectInMemoryMongo,disconnectInMemoryMongo}=require('./helpers/testServer'),{seedTestPlans}=require('./helpers/seedTestPlans'),{signTestJwt}=require('./helpers/auth');
const User=require('../src/models/user.model'),Class=require('../src/models/class.model'),Assignment=require('../src/models/assignment.model'),Membership=require('../src/models/membership.model');
const Submission=require('../src/models/Submission'),File=require('../src/models/File'),Evidence=require('../src/models/SourceFidelityEvidence');
const gateway=require('../src/services/aiGateway.service'),basic=require('../src/services/imagePreflight.service'),scheduled=require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const corrections=require('../src/services/canonicalCorrectionsPipeline.service'),c=require('../src/services/gptVisionExact/contract'),source=require('../src/services/gptVisionExact/preflight');
let token,student,teacher,cls,a,bytes,serial=0;
const value=()=>({version:c.VERSION,activeTranscript:'Society always expect\npowerfull Say',physicalLines:['Society always expect','powerfull Say'].map(text=>({segments:[{classification:'STUDENT_ACTIVE_TEXT',text,confidence:1}]})),uncertainties:[]});
const check=(image=bytes,assignment=a,phase)=>request(app).post('/api/submissions/image-preflight').set('Authorization','Bearer '+token).field('assignmentId',String(assignment._id)).field('phase',phase||'source').attach('file',image,{filename:'same-name.png',contentType:'image/png'});
const submit=(images=[bytes],assignment=a)=>{let r=request(app).post('/api/submissions/'+assignment._id).set('Authorization','Bearer '+token).field('canSubmit','true');for(const image of images)r=r.attach('files',image,{filename:'same-name.png',contentType:'image/png'});return r;};
beforeAll(async()=>{await connectInMemoryMongo();await seedTestPlans();
  [student,teacher]=await User.create(['student','teacher'].map(role=>({role,firebaseUid:'gpt-pre-'+role,email:role+'@gpt-pre.invalid'})));
  token=signTestJwt({id:student._id,role:'student',firebaseUid:student.firebaseUid});cls=await Class.create({name:'Preflight',teacher:teacher._id,joinCode:'PRE',qrCodeUrl:'data:,'});await Membership.create({student:student._id,class:cls._id});
});
beforeEach(async()=>{process.env.OCR_SOURCE_MODE='gpt_vision_exact';process.env.OCR_GPT_VISION_MODEL='openai/gpt-6-astra';process.env.OPENROUTER_API_KEY='mock-only';
  mockGoogleGeometry.mockReset().mockResolvedValue([{fullTextAnnotation:{pages:[]}}]);
  a=await Assignment.create({title:'Reference '+(++serial),class:cls._id,teacher:teacher._id,qrToken:'pre-'+serial});
  bytes=await sharp({create:{width:800,height:1000,channels:3,background:{r:220,g:30+serial,b:90}}}).png().toBuffer();
  basic.evaluateImage.mockReset().mockResolvedValue({ready:true,checks:[]});gateway.providerAttempt.mockReset().mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(value())}));scheduled.mockClear();corrections.generateAndPersist.mockClear();
  require('../src/services/notification.service').createNotification.mockClear();require('../src/services/email.service').sendGuestSubmissionEmail.mockClear();
});
afterAll(async()=>{delete process.env.OCR_SOURCE_MODE;const dir=path.resolve(__dirname,'..',process.env.UPLOAD_BASE_PATH,'submissions');if(fs.existsSync(dir))for(const name of fs.readdirSync(dir))if(/^[a-f\d-]+\.png$/i.test(name))fs.unlinkSync(path.join(dir,name));await disconnectInMemoryMongo();});
test('basic failure never buys source; basic phase reports checking with no paid request',async()=>{
  basic.evaluateImage.mockResolvedValueOnce({ready:false,checks:[{id:'resolution',required:true,status:'fail'}]});expect((await check()).body.data.ready).toBe(false);expect(gateway.providerAttempt).not.toHaveBeenCalled();
  const r=await check(bytes,a,'basic');expect(r.body.data).toMatchObject({ready:false,basicChecksPassed:true,sourceReadStatus:'CHECKING',canSubmit:false});expect(gateway.providerAttempt).not.toHaveBeenCalled();
});
test('real worker persistence and result API preserve 110 GPT tokens with 95 mapped and 15 null boxes',async()=>{
  const tokens=Array.from({length:110},(_,i)=>'token'+String(i).padStart(3,'0'));
  const lines=Array.from({length:11},(_,i)=>tokens.slice(i*10,i*10+10).join(' '));
  const primary={version:c.VERSION,activeTranscript:lines.join('\n'),physicalLines:lines.map(text=>({segments:[{text,classification:'STUDENT_ACTIVE_TEXT',confidence:1}]})),uncertainties:[]};
  gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(primary)}));
  mockGoogleGeometry.mockResolvedValue([{fullTextAnnotation:{text:'Not source authority',pages:[{width:800,height:1000,blocks:[{paragraphs:[{words:
    tokens.slice(0,95).map((text,i)=>({symbols:[...text].map(text=>({text})),boundingBox:{vertices:[
      {x:20+i%10*70,y:40+Math.floor(i/10)*70},{x:70+i%10*70,y:40+Math.floor(i/10)*70},
      {x:70+i%10*70,y:80+Math.floor(i/10)*70},{x:20+i%10*70,y:80+Math.floor(i/10)*70}]}}))}]}]}]}}]);
  expect((await check()).body.data.ready).toBe(true);expect((await submit()).status).toBe(200);
  const doc=await Submission.findOne({assignment:a._id});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  const r=await request(app).get('/api/submissions/'+doc._id+'/ocr-corrections').set('Authorization','Bearer '+token);
  expect(r.status).toBe(200);expect(r.body.data.transcript).toBe(primary.activeTranscript);
  const words=r.body.data.ocr[0].words;expect(words).toHaveLength(110);
  expect(words.filter(w=>w.bbox)).toHaveLength(95);expect(words.filter(w=>w.bbox===null)).toHaveLength(15);
  expect(words.map(w=>w.text)).toEqual(tokens);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  expect(mockGoogleGeometry).toHaveBeenCalledTimes(1);
});
test('accepted private preflight then submission and worker use exactly one paid source request',async()=>{
  const usage=(await User.findById(student._id)).usage;
  const r=await check();expect(r.body.data).toMatchObject({sourceReadStatus:'PASSED',ready:true,canSubmit:true});
  expect(JSON.stringify(r.body)).not.toMatch(/powerfull|physicalLines|mock-only|sourceSha256/);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect((await User.findById(student._id)).usage).toEqual(usage);
  const accepted=await submit();expect(accepted.status).toBe(200);const doc=await Submission.findOne({assignment:a._id});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(corrections.generateAndPersist).toHaveBeenCalledTimes(1);
  expect((await Submission.findById(doc._id)).sourceTranscriptExact).toBe(value().activeTranscript);
  expect((await Submission.findById(doc._id)).ocrPages[0].sourceVerificationSummary.performance).toMatchObject({
    sourceReused:true,sourceProviderCallCount:0,geometryProviderCallCount:1});
  const privateFile=await File.findById(doc.files[0]).select('+gptSourcePreflight');expect(privateFile.gptSourcePreflight).toBeTruthy();expect(privateFile.toJSON().gptSourcePreflight).toBeUndefined();
  const evidence=await Evidence.findById(privateFile.gptSourcePreflight.bindings[0].key).select('+payload');expect(evidence.payload.claims).toHaveLength(1);
});
test('uncertain input remains blocked and cached, with no submission, assessment, notification, or repeated source charge',async()=>{
  const v=value();v.physicalLines[0].segments.push({classification:'UNCERTAIN',text:null,confidence:.3});gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(v)}));
  for(let i=0;i<2;i++){const r=await check();expect(r.body.data).toMatchObject({sourceReadStatus:'FAILED_IMAGE',ready:false,sourceReadErrorCode:'OCR_GPT_SOURCE_UNCERTAIN'});}
  const r=await submit();expect(r.status).toBe(422);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect(scheduled).not.toHaveBeenCalled();expect(corrections.generateAndPersist).not.toHaveBeenCalled();expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  expect(require('../src/services/notification.service').createNotification).not.toHaveBeenCalled();expect(require('../src/services/email.service').sendGuestSubmissionEmail).not.toHaveBeenCalled();
  const e=await Evidence.findOne({'identity.assignmentId':String(a._id)}).select('+payload');expect(e.payload).toMatchObject({sourceAmbiguityReason:'ACTIVE_TEXT_UNREADABLE',uncertainSegmentCount:1,activeLineCount:2});
  expect(JSON.stringify(e.payload)).not.toMatch(/powerfull|Society|mock-only/);
});
test.each(['AI_PROVIDER_PAYMENT_REQUIRED','AI_PROVIDER_AUTH_ERROR','AI_PROVIDER_PERMISSION_DENIED','AI_PROVIDER_RATE_LIMIT','AI_PROVIDER_UNAVAILABLE','AI_ATTEMPT_TIMEOUT'])('provider %s is service failure, cached and never blames image',async code=>{
  gateway.providerAttempt.mockRejectedValue(Object.assign(Error('PRIVATE secret body'),{code}));for(let i=0;i<2;i++){const r=await check();expect(r.body.data).toMatchObject({sourceReadStatus:'FAILED_SERVICE',canSubmit:false});expect(r.body.data.message).toMatch(/temporarily unavailable/);expect(r.body.data.message).not.toMatch(/clearer image/);}
  expect((await submit()).status).toBe(503);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);
});
test('forged client pass without evidence never buys GPT or creates a submission',async()=>{expect((await submit()).status).toBe(503);expect(gateway.providerAttempt).not.toHaveBeenCalled();expect(await Submission.countDocuments({assignment:a._id})).toBe(0);});
test.each(['image','reference','model','contract','ownership'])('changed %s cannot reuse previous accepted source',async change=>{
  expect((await check()).body.data.ready).toBe(true);
  let image=bytes;
  if(change==='image')image=await sharp(bytes).linear(.9).png().toBuffer();
  if(change==='reference')await Assignment.updateOne({_id:a._id},{$set:{instructions:'Changed actual question'}});
  if(change==='model')process.env.OCR_GPT_VISION_MODEL='openai/gpt-5.6-sol';
  if(change==='contract')await Evidence.updateOne({'identity.assignmentId':String(a._id)},{$set:{'payload.primary.version':'obsolete-contract'}});
  if(change==='ownership'){const other=await User.create({role:'student',firebaseUid:'other-'+serial,email:'other'+serial+'@gpt-pre.invalid'});await Membership.create({student:other._id,class:cls._id});const old=token;token=signTestJwt({id:other._id,role:'student',firebaseUid:other.firebaseUid});const r=await submit();token=old;expect(r.status).toBe(503);return;}
  expect((await submit([image])).status).toBe(503);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);
  if(change==='image'){expect((await check(image)).body.data.ready).toBe(true);expect(gateway.providerAttempt).toHaveBeenCalledTimes(2);}
});
test('multi-file submission requires all pages and then reuses every accepted page',async()=>{
  const second=await sharp(bytes).linear(.8).png().toBuffer();expect((await check()).body.data.ready).toBe(true);
  expect((await submit([bytes,second])).status).toBe(503);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  expect((await check(second)).body.data.ready).toBe(true);expect((await submit([bytes,second])).status).toBe(200);
  const doc=await Submission.findOne({assignment:a._id});await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});expect(gateway.providerAttempt).toHaveBeenCalledTimes(2);expect(doc.ocrPages).toHaveLength(2);
});
test('concurrent duplicate checks reserve once and return checking safely',async()=>{
  let release;const wait=new Promise(resolve=>{release=resolve;});gateway.providerAttempt.mockImplementation(async o=>{await wait;return {returnedModel:o.entry.model,content:JSON.stringify(value())};});
  const p=check().then(r=>r);while(!gateway.providerAttempt.mock.calls.length)await new Promise(resolve=>setTimeout(resolve,10));
  const duplicate=await check();expect(duplicate.body.data.sourceReadStatus).toBe('CHECKING');expect(duplicate.body.data.ready).toBe(false);release();expect((await p).body.data.ready).toBe(true);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});
test('lost accepted evidence after submit fails the worker safely without purchasing a replacement read',async()=>{
  expect((await check()).body.data.ready).toBe(true);expect((await submit()).status).toBe(200);
  const doc=await Submission.findOne({assignment:a._id});await Evidence.deleteMany({'identity.assignmentId':String(a._id)});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  expect(doc.ocrStatus).toBe('failed');expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(corrections.generateAndPersist).not.toHaveBeenCalled();
});
test('lost file proof after submit cannot fall through to the historical paid reader',async()=>{
  expect((await check()).body.data.ready).toBe(true);expect((await submit()).status).toBe(200);
  const doc=await Submission.findOne({assignment:a._id});await File.updateMany({_id:{$in:doc.files}},{$unset:{gptSourcePreflight:1}});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  expect(doc.ocrStatus).toBe('failed');expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(corrections.generateAndPersist).not.toHaveBeenCalled();
});
test('uncertainty list predicate reports safe reason/counts without logging handwriting or uncertainty prose',async()=>{
  const spy=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});
  try{const v=value();v.uncertainties=[{lineIndex:0,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'PRIVATE source prose'}];gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(v)}));
    expect((await check()).body.data.sourceReadStatus).toBe('FAILED_IMAGE');
    const log=spy.mock.calls.map(([v])=>v).find(v=>v.event==='gpt_vision_source_reader');expect(log).toMatchObject({sourceAmbiguityReason:'ACTIVE_TEXT_UNREADABLE',uncertaintyCount:1,uncertainSegmentCount:0,activeLineCount:2});
    expect(log.activeCharacterCount).toBe(value().activeTranscript.length);expect(JSON.stringify(log)).not.toMatch(/PRIVATE|Society|powerfull|mock-only|base64/);
  }finally{spy.mockRestore();}
});
test('PDF preflight checks every rasterized page and reuses each private accepted result',async()=>{
  const jpeg=await sharp(bytes).jpeg().toBuffer(),pdf=require('../src/services/pdfSubmissionPages.service');
  const raster=jest.spyOn(pdf,'rasterize').mockResolvedValue([{buffer:jpeg,pageNumber:1},{buffer:jpeg,pageNumber:2}]);
  try{const pages=await source.pagesFor({buffer:Buffer.from('%PDF-1.4 offline'),detectedMime:'application/pdf'}),context={assignment:a,ownerId:String(student._id),uploaderId:String(student._id)};
    const proof=await source.checkPages(pages,context,{run:true});expect(proof.bindings).toHaveLength(2);expect(gateway.providerAttempt).toHaveBeenCalledTimes(2);
    await source.checkPages(pages,context,{run:true});expect(gateway.providerAttempt).toHaveBeenCalledTimes(2);
  }finally{raster.mockRestore();}
});
test('guest server-side source check precedes creation and binds reusable evidence to normalized guest ownership',async()=>{
  await Submission.createIndexes();await Assignment.updateOne({_id:a._id},{$set:{allowGuestSubmission:true}});
  const send=(key=true)=>{let r=request(app).post('/api/guest/assignments/'+a.qrToken+'/submit').field('name','Guest writer').field('email','Reader@guest.invalid');
    if(key)r=r.set('Idempotency-Key','guest-preflight-idempotency-key-12345678');return r.attach('files',bytes,{filename:'guest.png',contentType:'image/png'});};
  expect((await send(false)).status).toBe(400);expect(gateway.providerAttempt).not.toHaveBeenCalled();
  expect((await send()).status).toBe(200);const doc=await Submission.findOne({assignment:a._id});
  const file=await File.findById(doc.files[0]).select('+gptSourcePreflight');expect(file.gptSourcePreflight.ownerId).toBe('guest:'+c.sha('reader@guest.invalid'));
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  expect(doc.ocrStatus).toBe('completed');expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});
test('v2 non-active uncertainties pass preflight, stay private, reuse source after submit and keep every active token',async()=>{
  const v=value();v.physicalLines[0].segments.push({classification:'STUDENT_CROSSED_OUT',text:null,confidence:.99});
  v.physicalLines.unshift({segments:[{classification:'PROMPT_OR_INSTRUCTION',text:'Prompt glyph uncertain',confidence:.99}]});
  v.uncertainties=[{lineIndex:0,segmentIndex:0,kind:'NON_ACTIVE_PROMPT_UNCERTAIN',reason:'PRIVATE punctuation'},
    {lineIndex:1,segmentIndex:1,kind:'NON_ACTIVE_DELETED_UNCERTAIN',reason:'PRIVATE deletion'}];
  gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(v)}));
  for(let i=0;i<2;i++){const r=await check();expect(r.body.data).toMatchObject({sourceReadStatus:'PASSED',ready:true,canSubmit:true});expect(JSON.stringify(r.body)).not.toMatch(/PRIVATE|nonActiveUncertainCount|blockingUncertaintyCount|Prompt glyph/);}
  expect((await submit()).status).toBe(200);const doc=await Submission.findOne({assignment:a._id});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  expect(doc.sourceFidelityVersion).toBe('gpt-vision-exact-v2');expect(doc.sourceTranscriptExact).toBe(v.activeTranscript);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  const r=await request(app).get('/api/submissions/'+doc._id+'/ocr-corrections').set('Authorization','Bearer '+token);
  expect(r.status).toBe(200);expect(r.body.data.transcript).toBe(v.activeTranscript);expect(r.body.data.ocr[0].words.length).toBe(v.activeTranscript.split(/\s+/u).length);
  expect(r.body.data.ocr[0].words.every(w=>w.bbox===null)).toBe(true);
  for(let poll=0;poll<2;poll++)expect((await request(app).get('/api/submissions/'+doc._id+'/ocr-corrections').set('Authorization','Bearer '+token)).status).toBe(200);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  const saved=await Evidence.findOne({'identity.assignmentId':String(a._id)}).select('+payload');expect(saved.payload).toMatchObject({nonActiveUncertainCount:2,blockingUncertaintyCount:0});
});
test.each(['ACTIVE_TEXT_UNCERTAIN','ACTIVE_ROLE_AMBIGUOUS','ACTIVE_REPLACEMENT_AMBIGUOUS','ACTIVE_PUNCTUATION'])('v2 %s still blocks preflight/upload and terminal repeats cost nothing',async kind=>{
  const v=value();v.uncertainties=[{lineIndex:0,segmentIndex:0,kind,reason:'PRIVATE active ambiguity'}];gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify(v)}));
  for(let i=0;i<2;i++){const r=await check();expect(r.body.data).toMatchObject({sourceReadStatus:'FAILED_IMAGE',ready:false,canSubmit:false,sourceReadErrorCode:'OCR_GPT_SOURCE_UNCERTAIN'});}
  expect((await submit()).status).toBe(422);expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(corrections.generateAndPersist).not.toHaveBeenCalled();
});
test('old v1 terminal evidence remains unchanged while the same pixels receive one fresh v2 identity/read',async()=>{
  const page=(await source.pagesFor({buffer:bytes,detectedMime:'image/png'}))[0],context={assignment:a,ownerId:String(student._id),uploaderId:String(student._id)};
  const current=source.binding(context,page),{key:unused,...legacy}=current;
  legacy.version='gpt-vision-exact-v1';legacy.promptSha256=c.sha('frozen v1 test prompt');
  const oldKey=c.sha(JSON.stringify(legacy)).slice(0,24);legacy.key=oldKey;
  const old=await Evidence.create({_id:oldKey,identity:legacy,status:'GPT_SOURCE_FAILED',expiresAt:null,payload:{safeFailureCode:'OCR_GPT_SOURCE_UNCERTAIN',sourceAmbiguityReason:'UNCERTAIN_SEGMENT_PRESENT'}});
  const before=await Evidence.findById(old._id).select('+payload').lean();expect(current.key).not.toBe(oldKey);
  for(let i=0;i<2;i++)expect((await check()).body.data.ready).toBe(true);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);expect(await Evidence.findById(old._id).select('+payload').lean()).toEqual(before);
  const fresh=await Evidence.findById(current.key).select('+payload');expect(fresh.identity.version).toBe('gpt-vision-exact-v2');expect(fresh.payload.primary.version).toBe('gpt-vision-exact-v2');
});
