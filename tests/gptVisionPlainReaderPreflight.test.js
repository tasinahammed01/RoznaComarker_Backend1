'use strict';
// Plain-first reader through the real upload preflight, submission claim and OCR worker (in-memory Mongo, mocked provider).
jest.setTimeout(90000);
process.env.GUEST_SUBMISSION_ENABLED='true';process.env.NODE_ENV='test';process.env.JWT_SECRET='plain-reader-offline';process.env.UPLOAD_USER_RATE_LIMIT_MAX='500';
process.env.AUTH_WRITE_RATE_LIMIT_MAX='1000';
process.env.UPLOAD_BASE_PATH='uploads/gpt-plain-reader-test-'+process.pid;
jest.mock('../src/services/assessmentRecovery.service',()=>({scheduleSubmissionAnalysis:jest.fn()}));
jest.mock('../src/services/canonicalCorrectionsPipeline.service',()=>({generateAndPersist:jest.fn(async()=>{})}));
jest.mock('../src/services/imagePreflight.service',()=>({evaluateImage:jest.fn(async()=>({ready:true,checks:[]}))}));
jest.mock('../src/services/aiGateway.service',()=>({providerAttempt:jest.fn()}));
jest.mock('../src/services/email.service',()=>({sendGuestSubmissionEmail:jest.fn(async()=>({success:true}))}));
jest.mock('../src/services/notification.service',()=>({createNotification:jest.fn(async()=>null)}));
jest.mock('@google-cloud/vision',()=>({ImageAnnotatorClient:jest.fn(()=>({documentTextDetection:jest.fn(async()=>[{fullTextAnnotation:{pages:[]}}])}))}));
const sharp=require('sharp'),request=require('supertest'),fs=require('fs'),path=require('path');
const app=require('../src/app');
const {connectInMemoryMongo,disconnectInMemoryMongo}=require('./helpers/testServer'),{seedTestPlans}=require('./helpers/seedTestPlans'),{signTestJwt}=require('./helpers/auth');
const User=require('../src/models/user.model'),Class=require('../src/models/class.model'),Assignment=require('../src/models/assignment.model'),Membership=require('../src/models/membership.model');
const Submission=require('../src/models/Submission'),File=require('../src/models/File'),Evidence=require('../src/models/SourceFidelityEvidence');
const gateway=require('../src/services/aiGateway.service'),scheduled=require('../src/services/assessmentRecovery.service').scheduleSubmissionAnalysis;
const c=require('../src/services/gptVisionExact/contract');
const PLAIN_PROFILE='gpt_vision_exact_plain_v1';
const COPY='Describe your favourite place and explain why you like it.';
const ANSWER='My favourite place is the park.\nI play footbal there.';
let token,student,teacher,cls,a,bytes,serial=0,plainReply;
const jsonWire={version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:[{classification:'PROMPT_OR_INSTRUCTION',text:COPY,confidence:1}]},
  ...ANSWER.split('\n').map(text=>({segments:[{classification:'STUDENT_ACTIVE_TEXT',text,confidence:1}]}))],uncertainties:[]};
const check=()=>request(app).post('/api/submissions/image-preflight').set('Authorization','Bearer '+token).field('assignmentId',String(a._id)).field('phase','source').attach('file',bytes,{filename:'page.png',contentType:'image/png'});
const submit=()=>request(app).post('/api/submissions/'+a._id).set('Authorization','Bearer '+token).field('canSubmit','true').attach('files',bytes,{filename:'page.png',contentType:'image/png'});
async function runWorker(){
  const doc=await Submission.findOne({assignment:a._id});
  await require('../src/services/ocrPipeline.service').runOcrAndPersistForFiles({fileIds:doc.files,targetDoc:doc,jobId:doc.ocrJobId});
  return Submission.findById(doc._id);
}
const reader=value=>{process.env.OCR_GPT_VISION_READER=value;};
beforeAll(async()=>{await connectInMemoryMongo();await seedTestPlans();
  [student,teacher]=await User.create(['student','teacher'].map(role=>({role,firebaseUid:'gpt-plain-'+role,email:role+'@gpt-plain.invalid'})));
  token=signTestJwt({id:student._id,role:'student',firebaseUid:student.firebaseUid});
  cls=await Class.create({name:'Plain reader',teacher:teacher._id,joinCode:'PLN',qrCodeUrl:'data:,'});await Membership.create({student:student._id,class:cls._id});
});
beforeEach(async()=>{await require('../src/models/SourceVerificationCircuit').deleteMany({});
  process.env.OCR_SOURCE_MODE='gpt_vision_exact';process.env.OCR_GPT_VISION_MODEL=c.QWEN_MODEL;process.env.OPENROUTER_API_KEY='mock-only';reader('plain_text');
  a=await Assignment.create({title:'Favourite place '+(++serial),instructions:COPY,class:cls._id,teacher:teacher._id,qrToken:'plain-'+serial});
  bytes=await sharp({create:{width:800,height:1000,channels:3,background:{r:200,g:40+serial,b:90}}}).png().toBuffer();
  plainReply=`${COPY}\n${ANSWER}`;
  gateway.providerAttempt.mockReset().mockImplementation(async o=>({returnedModel:o.entry.model,
    content:o.requestProfile===PLAIN_PROFILE?plainReply:JSON.stringify(jsonWire)}));
  scheduled.mockClear();
});
afterAll(async()=>{delete process.env.OCR_SOURCE_MODE;delete process.env.OCR_GPT_VISION_READER;
  const dir=path.resolve(__dirname,'..',process.env.UPLOAD_BASE_PATH,'submissions');
  if(fs.existsSync(dir))for(const name of fs.readdirSync(dir))if(/^[a-f\d-]+\.png$/i.test(name))fs.unlinkSync(path.join(dir,name));
  await disconnectInMemoryMongo();});

test('one paid plain read at upload; the worker reuses it; the copied question is excluded from the transcript',async()=>{
  expect((await check()).body.data).toMatchObject({canSubmit:true,sourceReadStatus:'PASSED'});
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  const call=gateway.providerAttempt.mock.calls[0][0];
  expect(call).toMatchObject({requestProfile:PLAIN_PROFILE,temperature:0});expect(call).not.toHaveProperty('responseSchema');
  expect((await submit()).status).toBe(200);
  expect((await runWorker()).sourceTranscriptExact).toBe(ANSWER);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
  const saved=await Evidence.findOne({'identity.assignmentId':String(a._id)}).select('+payload').lean();
  expect(saved.identity).toMatchObject({readerMode:'plain_text',readerVersion:require('../src/services/gptVisionExact/plainReader').VERSION});
});

test('rollback: plain evidence accepted at upload is still claimed and reused after switching back to json_contract',async()=>{
  expect((await check()).body.data.canSubmit).toBe(true);
  reader('json_contract');
  expect((await submit()).status).toBe(200);
  expect((await runWorker()).sourceTranscriptExact).toBe(ANSWER);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});

test('turning plain_text on keeps evidence accepted by the JSON reader valid, with no second read',async()=>{
  reader('json_contract');
  expect((await check()).body.data.canSubmit).toBe(true);
  expect(gateway.providerAttempt.mock.calls[0][0].requestProfile).toBe('gpt_vision_exact_v1');
  reader('plain_text');
  expect((await check()).body.data).toMatchObject({canSubmit:true,sourceReadStatus:'PASSED'});
  expect((await submit()).status).toBe(200);
  expect((await runWorker()).sourceTranscriptExact).toBe(ANSWER);
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});

test('[?] blocks the upload: no Submission, no File, no assessment, one call',async()=>{
  plainReply='My favourite place is the [?].';
  const files=await File.countDocuments();
  expect((await check()).body.data).toMatchObject({canSubmit:false,sourceReadStatus:'FAILED_IMAGE',sourceReadErrorCode:'OCR_GPT_SOURCE_UNCERTAIN'});
  expect((await submit()).status).not.toBe(200);
  expect(await Submission.countDocuments({assignment:a._id})).toBe(0);expect(await File.countDocuments()).toBe(files);
  expect(scheduled).not.toHaveBeenCalled();expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});

test('switching reader does not buy a second read of a page already rejected as unreadable',async()=>{
  reader('json_contract');
  gateway.providerAttempt.mockImplementation(async o=>({returnedModel:o.entry.model,content:JSON.stringify({...jsonWire,
    physicalLines:[{segments:[{classification:'UNCERTAIN',text:null,confidence:0}]}],uncertainties:[]})}));
  expect((await check()).body.data.canSubmit).toBe(false);
  reader('plain_text');
  expect((await check()).body.data).toMatchObject({canSubmit:false,sourceReadErrorCode:'OCR_GPT_SOURCE_UNCERTAIN'});
  expect(gateway.providerAttempt).toHaveBeenCalledTimes(1);
});
