'use strict';
jest.setTimeout(60000);
process.env.NODE_ENV='test';process.env.JWT_SECRET='human-review-test';
process.env.UPLOAD_BASE_PATH='tmp/human-review-test-'+process.pid;
jest.mock('../src/services/assessmentRecovery.service',()=>({scheduleSubmissionAnalysis:jest.fn()}));
const fs=require('fs'),path=require('path'),sharp=require('sharp'),request=require('supertest'),express=require('express'),mongoose=require('mongoose');
const {connectInMemoryMongo,disconnectInMemoryMongo}=require('./helpers/testServer');
const {signTestJwt}=require('./helpers/auth');
const User=require('../src/models/user.model'),Class=require('../src/models/class.model'),Assignment=require('../src/models/assignment.model'),File=require('../src/models/File');
const Submission=require('../src/models/Submission'),Review=require('../src/models/SourceHumanReview'),Evidence=require('../src/models/SourceFidelityEvidence');
const sf=require('../src/utils/sourceFidelity'),plan=require('../src/services/sourceFidelity/humanReviewPlan'),service=require('../src/services/sourceHumanReview.service');
const resume=require('../src/services/assessmentRecovery.service');
const golden=require('./fixtures/source-fidelity/golden-002.cjs');
const historical=require('./fixtures/source-fidelity/golden-002-readers.cjs');
const controller=require('../src/controllers/sourceHumanReview.controller');
const {verifyJwtToken}=require('../src/middlewares/jwtAuth.middleware');
const app=express();app.use(express.json({limit:'20kb'}));
app.post('/:submissionId/source-review',verifyJwtToken,controller.prepare);
app.get('/:submissionId/source-review/page/:pageIndex',verifyJwtToken,controller.page);
app.get('/:submissionId/source-review/page/:pageIndex/image',verifyJwtToken,controller.pageImage);
app.post('/:submissionId/source-review/page/:pageIndex/resolve',verifyJwtToken,controller.pageResolve);
app.get('/:submissionId/source-review/:itemId/crop',verifyJwtToken,controller.crop);
app.post('/:submissionId/source-review/:itemId/resolve',verifyJwtToken,controller.resolve);
let teacher,student,other,cls,assignment,file,png,token,studentToken,otherToken;
const directory=path.resolve(__dirname,'..',process.env.UPLOAD_BASE_PATH);
beforeAll(async()=>{
  await connectInMemoryMongo({replicaSet:true});await Promise.all([Review.init(),require('../src/models/SourceFidelitySnapshot').init(),Submission.init()]);
  [teacher,student,other]=await User.create(['teacher','student','teacher'].map((role,i)=>({role,firebaseUid:'hr-'+i,email:`hr${i}@example.invalid`})));
  token=signTestJwt({id:teacher._id,role:'teacher',firebaseUid:teacher.firebaseUid});studentToken=signTestJwt({id:student._id,role:'student',firebaseUid:student.firebaseUid});otherToken=signTestJwt({id:other._id,role:'teacher',firebaseUid:other.firebaseUid});
  cls=await Class.create({name:'Review',teacher:teacher._id,joinCode:'HUMANREVIEW',qrCodeUrl:'data:,'});
  assignment=await Assignment.create({title:'Human source',teacher:teacher._id,class:cls._id,qrToken:'human-source'});
  fs.mkdirSync(directory,{recursive:true});const raw=await sharp({create:{width:600,height:240,channels:3,background:'white'}}).png().toBuffer();
  fs.writeFileSync(path.join(directory,'test.png'),raw);png=await sharp(raw).rotate().toBuffer();
  file=await File.create({originalName:'test.png',filename:'test.png',path:path.join(directory,'test.png'),url:'/test.png',uploadedBy:student._id,role:'student',type:'submissions'});
});
afterAll(async()=>{await disconnectInMemoryMongo();if(fs.existsSync(path.join(directory,'test.png')))fs.unlinkSync(path.join(directory,'test.png'));if(fs.existsSync(directory))fs.rmdirSync(directory);});
beforeEach(()=>resume.scheduleSubmissionAnalysis.mockClear());
function page(text){return {fileId:file._id,fileOrder:0,pageNumber:1,pageIndex:0,width:600,height:240,sourceTextExact:text,sourceTextSha256:sf.sha(text),sourceInputSha256:sf.sha(png),
  sourceSha256:sf.sha(png),sourceFidelityMode:'astra_verified',sourceFidelityStatus:'OCR_UNCERTAIN',sourceFidelityVersion:'targeted-source-v2',words:[]};}
async function make(){
  const p=page('start sence end\nnext wemen last');
  const d={student:student._id,assignment:assignment._id,class:cls._id,files:[file._id],ocrJobId:new mongoose.Types.ObjectId().toString(),status:'submitted',submittedAt:new Date(),ocrStatus:'failed',ocrPages:[p],...sf.blockedState()};Object.assign(d,sf.aggregate(d));
  // Different assignment avoids the existing registered-student uniqueness constraint.
  d.assignment=(await Assignment.create({title:'Case',teacher:teacher._id,class:cls._id,qrToken:new mongoose.Types.ObjectId().toString()}))._id;
  const doc=await Submission.create(d),text=p.sourceTextExact;
  const items=['start sence end','next wemen last'].map((line,i)=>({id:sf.sha(doc._id+':'+i),pageKey:plan.key(p),fileId:String(file._id),pageNumber:1,pageIndex:0,regionId:'region'+i,
    reasonCodes:['READER_UNCERTAIN_SPAN'],rect:{left:10,top:20+i*100,width:550,height:50},geometryWordIds:['g1','g2','g3'],inputSha256:p.sourceInputSha256,
    originalTranscriptSha256:p.sourceTextSha256,provisionalText:line,state:'PENDING_HUMAN_REVIEW',mapping:{state:'UNIQUE_STRUCTURAL_SPAN',start:text.indexOf(line),end:text.indexOf(line)+line.length,
      original:line,leftAnchor:line.split(' ')[0],rightAnchor:line.split(' ').at(-1),sourceTranscriptSha256:p.sourceTextSha256}}));
  const review=await Review.create({_id:sf.sha(String(doc._id)),submissionId:doc._id,jobId:doc.ocrJobId,revision:0,currentHash:doc.sourceTranscriptSha256,
    payload:{basePages:[p],originalTranscriptExact:text,originalTranscriptSha256:sf.sha(text),baseIdentity:doc.sourceFidelityInputIdentity,items,unavailable:0,history:[]}});
  await Submission.updateOne({_id:doc._id},{$set:{sourceHumanReviewId:review._id,sourceHumanReviewSummary:plan.summary(review.payload),sourceFidelityStatus:'HUMAN_REVIEW_REQUIRED'}});
  return {doc:await Submission.findById(doc._id).lean(),review:await Review.findById(review._id).select('+payload').lean(),items};
}
const body=(d,text,revision=0,classification='ACTIVE_STUDENT_TEXT')=>({revision,sourceHash:d.sourceTranscriptSha256,text,classification,deletedText:''});
const full=require('../src/services/sourceFidelity/fullPageReview');
async function escalation(){
  const c=await make();c.review.payload.unavailable=3;c.review.payload.unavailableByPage={[plan.key(c.doc.ocrPages[0])]:3};
  c.review.payload.items[1].mapping={state:'MAPPING_WITHHELD'};c.review.payload.items[1].state='NEEDS_ESCALATION';
  await Review.updateOne({_id:c.review._id},{$set:{payload:c.review.payload}});
  await Submission.updateOne({_id:c.doc._id},{$set:{sourceHumanReviewSummary:plan.summary(c.review.payload)}});return c;
}
const fullBody=(doc,text=golden.text)=>({revision:0,sourceHash:doc.sourceTranscriptSha256,pageHash:doc.ocrPages[0].sourceTextSha256,pageIdentity:full.identity(doc,doc.ocrPages[0]),
  classification:'ACTIVE_PAGE_TRANSCRIPT',transcriptExact:text,confirmWholePage:true,reviewedDeletedMaterial:true});
const fullResolve=(c,b)=>service.resolve(c.doc._id,0,b||fullBody(c.doc),teacher,true);

async function urgent(count=1){
  const c=await make(),d=c.doc;d.sourceFidelityMode='astra_human_confirm';
  d.ocrPages=Array.from({length:count},(_,index)=>({...d.ocrPages[0],pageNumber:index+1,pageIndex:index,sourceFidelityMode:'astra_human_confirm',sourceFidelityVersion:'astra-human-confirm-v1',sourceFidelityStatus:'ASTRA_PROVISIONAL'}));
  delete d.sourceHumanReviewSummary;Object.assign(d,sf.aggregate(d));
  const payload=plan.build(d,[]),summary=plan.summary(payload);
  await Review.updateOne({_id:c.review._id},{$set:{payload,currentHash:d.sourceTranscriptSha256,revision:0}});
  await Submission.updateOne({_id:d._id},{$set:{ocrPages:d.ocrPages,...sf.aggregate(d),sourceHumanReviewSummary:summary}});
  return {doc:await Submission.findById(d._id).lean(),review:await Review.findById(c.review._id).select('+payload').lean()};
}
test('urgent mode always offers whole-page confirmation, transactionally resumes after every page and preserves Astra source',async()=>{
  const c=await urgent(2),original=c.review.payload.originalTranscriptExact;
  expect(service.present(c.doc,c.review).pages).toHaveLength(2);expect(sf.eligible(c.doc)).toBe(false);
  const literal='  wemen, Social sence.\r\nnot corrected\t';
  const b=fullBody(c.doc,literal),first=await fullResolve(c,b);
  expect(first.sourceFidelity.assessmentAllowed).toBe(false);expect(first.pages).toHaveLength(1);expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
  const d=await Submission.findById(c.doc._id).lean();expect(d.sourceFidelityMode).toBe('astra_human_confirm');expect(d.ocrPages[0].sourceTextExact).toBe(literal);
  expect(d.sourceFidelityInputIdentity).not.toBe(c.doc.sourceFidelityInputIdentity);expect(d.sourceTranscriptSha256).not.toBe(c.doc.sourceTranscriptSha256);
  const p=full.state(d,await Review.findById(c.review._id).select('+payload').lean(),1);
  const next={revision:p.revision,sourceHash:p.sourceHash,pageHash:p.pageHash,pageIdentity:p.pageIdentity,classification:'ACTIVE_PAGE_TRANSCRIPT',transcriptExact:'  second sence,\n',confirmWholePage:true};
  const last=await service.resolve(d._id,1,next,teacher,true);expect(last.sourceFidelity.assessmentAllowed).toBe(true);expect(last.sourceFidelity.status).toBe('HUMAN_VERIFIED');
  expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  await service.resolve(d._id,1,next,teacher,true);expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  const saved=await Review.findById(c.review._id).select('+payload').lean();expect(saved.payload.originalTranscriptExact).toBe(original);expect(saved.payload.history).toHaveLength(2);
  await expect(fullResolve(c,{...b,transcriptExact:'stale'})).rejects.toMatchObject({code:'SOURCE_VERSION_CONFLICT'});
});
test('urgent page review enforces teacher ownership for opening and saving',async()=>{
  const c=await urgent();await expect(service.pageReview(c.doc._id,0,teacher)).resolves.toMatchObject({eligible:true});
  for(const user of [student,other,{role:'guest'},null]){
    await expect(service.pageReview(c.doc._id,0,user)).rejects.toMatchObject({status:403});
    await expect(service.resolve(c.doc._id,0,fullBody(c.doc),user,true)).rejects.toMatchObject({status:403});
  }
});
test('urgent mode prepares the existing review ledger without dual-reader geometry',async()=>{
  const c=await urgent();await Review.deleteOne({_id:c.review._id});
  await Submission.updateOne({_id:c.doc._id},{$unset:{sourceHumanReviewId:1,sourceHumanReviewSummary:1}});
  const r=await service.ensure(c.doc._id,teacher);expect(r.pages).toHaveLength(1);expect(r.items).toEqual([]);
  expect(r.sourceFidelity.assessmentAllowed).toBe(false);expect(r.sourceFidelity.mode).toBe('astra_human_confirm');
});
test('urgent transaction failure rolls back page and receipt and never resumes',async()=>{
  const c=await urgent(),before=await Submission.findById(c.doc._id).lean();
  const spy=jest.spyOn(Review,'updateOne').mockRejectedValueOnce(Error('urgent rollback'));
  try{await expect(fullResolve(c)).rejects.toThrow('urgent rollback');}finally{spy.mockRestore();}
  const after=await Submission.findById(c.doc._id).lean();expect(after.sourceTranscriptSha256).toBe(before.sourceTranscriptSha256);
  expect((await Review.findById(c.review._id).select('+payload').lean()).payload.history).toHaveLength(0);expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});

test('full page fallback is server hidden for mapped-only and model-agreed source; unavailable and tiny regions enable escalation',async()=>{
  expect(service.present({ocrPages:[{},{}]},null).pages).toEqual([]);
  const c=await make();expect(service.present(c.doc,c.review).pages).toEqual([]);
  expect(()=>full.apply(c.doc,c.review,0,fullBody(c.doc),teacher)).toThrow('HUMAN_REVIEW_REGION_UNAVAILABLE');
  c.review.payload.items[0].rect.width=40;expect(full.state(c.doc,c.review,0).eligible).toBe(true);
  c.doc.ocrPages[0].sourceFidelityStatus='MODEL_AGREED';expect(full.state(c.doc,c.review,0).eligible).toBe(false);
  const e=await escalation();expect(service.present(e.doc,e.review).pages).toHaveLength(1);
});
test('page and original image require owning active teacher; no guest/student/admin/IDOR, coordinates or arbitrary index',async()=>{
  const c=await escalation(),foreign=await make(),url=`/${c.doc._id}/source-review/page/0`;
  for(const suffix of ['', '/image']){
    expect((await request(app).get(url+suffix)).status).toBe(401);
    for(const tok of [studentToken,otherToken])expect((await request(app).get(url+suffix).set('Authorization','Bearer '+tok)).status).toBe(403);
  }
  await expect(service.pageReview(c.doc._id,0,{...teacher.toObject(),role:'admin'})).rejects.toMatchObject({status:403});
  const r=await request(app).get(url).set('Authorization','Bearer '+token);expect(r.status).toBe(200);
  expect(Object.keys(r.body.data).sort()).toEqual(['pageIndex','pageNumber','pageHash','pageIdentity','sourceHash','revision','eligible','verificationState','blockerCount','provisionalTranscript'].sort());
  const image=await request(app).get(url+'/image').set('Authorization','Bearer '+token);expect(image.status).toBe(200);expect(image.headers['cache-control']).toBe('no-store');
  expect((await sharp(image.body).metadata()).width).toBe(600);
  for(const index of ['-1','00','1.5','99',String(file._id)])await expect(service.pageReview(c.doc._id,index,teacher)).rejects.toMatchObject({status:404});
  expect((await request(app).get(url+'?path=secret').set('Authorization','Bearer '+token)).status).toBe(400);
  await expect(service.pageReview(foreign.doc._id,0,teacher)).rejects.toMatchObject({code:'HUMAN_REVIEW_REGION_UNAVAILABLE'});
  const a=await Assignment.findById(c.doc.assignment);a.isActive=false;await a.save();await expect(service.pageReview(c.doc._id,0,teacher)).rejects.toMatchObject({status:403});
});
test('Golden 002 exact full-page authority is committed before one assessment continuation; evidence/history preserved and replay safe',async()=>{
  const c=await escalation(),b=fullBody(c.doc),e=await Evidence.create({identity:{submissionId:String(c.doc._id),runId:c.doc.ocrJobId,fileId:String(file._id),pageNumber:1,inputSha256:sf.sha(png)},payload:{primary:historical.astra,secondary:historical.fable}});
  const originalEvidence=await Evidence.findById(e._id).select('+payload').lean();
  let afterCommit;resume.scheduleSubmissionAnalysis.mockImplementationOnce(id=>{afterCommit=Submission.findById(id).lean().then(d=>expect(sf.eligible(d)).toBe(true));});
  const r=await fullResolve(c,b);await afterCommit;
  expect(r.sourceFidelity).toMatchObject({transcriptExact:golden.text,transcriptSha256:sf.sha(golden.text),assessmentAllowed:true,status:'HUMAN_VERIFIED'});
  const saved=await Submission.findById(c.doc._id).lean(),review=await Review.findById(c.review._id).select('+payload').lean();
  expect(saved.ocrPages[0]).toMatchObject({sourceVerificationStage:'PAGE_HUMAN_VERIFIED',sourceHumanReviewUnresolved:0,sourceTextExact:golden.text});
  expect(saved.sourceFidelityInputIdentity).not.toBe(c.doc.sourceFidelityInputIdentity);
  expect(review.payload.originalTranscriptExact).toBe(c.doc.sourceTranscriptExact);expect(review.payload.unavailable).toBe(0);
  expect(review.payload.items.every(i=>i.state==='SUPERSEDED_BY_FULL_PAGE_HUMAN_VERIFICATION')).toBe(true);
  expect(review.payload.history[0]).toMatchObject({reviewType:'FULL_PAGE_HUMAN_REVIEW',beforeTextExact:c.doc.sourceTranscriptExact,afterTextExact:golden.text,blockersSuperseded:5,priorRootSha256:b.sourceHash,resultingRootSha256:sf.sha(golden.text)});
  expect(await Evidence.findById(e._id).select('+payload').lean()).toEqual(originalEvidence);
  await fullResolve(c,b);expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  await expect(fullResolve(c,{...b,transcriptExact:golden.text+' '})).rejects.toMatchObject({code:'SOURCE_VERSION_CONFLICT'});
  expect(await require('../src/models/SourceFidelitySnapshot').countDocuments({submissionId:c.doc._id})).toBeGreaterThan(0);
});
test('full-page replacement preserves exact whitespace, literal HTML and prior mapped receipt',async()=>{
  const c=await escalation();await service.resolve(c.doc._id,c.items[0].id,body(c.doc,'start sence end'),teacher);
  const d=await Submission.findById(c.doc._id).lean(),literal='  <script>x</script>\r\n wEmen,\t\n';
  const r=await fullResolve(c,{...fullBody(d,literal),revision:1});expect(r.sourceFidelity.transcriptExact).toBe(literal);
  const review=await Review.findById(c.review._id).select('+payload').lean();expect(review.payload.history).toHaveLength(2);
  expect(review.payload.history[1].previousReceipt).toBe(d.ocrPages[0].sourceHumanReceiptHash);
});
test('cannot determine records private evidence but does not replace source, supersede blockers or resume assessment',async()=>{
  const c=await escalation(),r=await fullResolve(c,{...fullBody(c.doc),classification:'CANNOT_DETERMINE',confirmWholePage:false});
  expect(r.sourceFidelity.assessmentAllowed).toBe(false);expect(r.sourceFidelity.transcriptExact).toBe(c.doc.sourceTranscriptExact);
  const review=await Review.findById(c.review._id).select('+payload').lean();expect(review.payload.unavailable).toBe(3);expect(review.payload.history[0].classification).toBe('CANNOT_DETERMINE');
  expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});
test.each(['sourceHash','pageHash','pageIdentity','revision'])('full page rejects stale %s and cross-submission tokens',async field=>{
  const c=await escalation(),b=fullBody(c.doc);b[field]=field==='revision'?5:'f'.repeat(64);
  await expect(fullResolve(c,b)).rejects.toMatchObject({code:'SOURCE_VERSION_CONFLICT'});expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});
test.each([{transcriptExact:'x'.repeat(50001)},{transcriptExact:'\u0000'},{transcriptExact:'\u202eabc'},{transcriptExact:'\ud800'},{offset:1},{pageIndex:1},{confirmWholePage:false},{reviewedDeletedMaterial:'yes'}])('invalid whole-page payload fails closed: %j',async change=>{
  const c=await escalation();await expect(fullResolve(c,{...fullBody(c.doc),...change})).rejects.toMatchObject({code:'HUMAN_REVIEW_INVALID',status:400});
});
test('transaction failure rolls back source, immutable snapshots and review; standalone rejection fails closed',async()=>{
  const c=await escalation(),Snapshot=require('../src/models/SourceFidelitySnapshot'),before=await Snapshot.countDocuments({submissionId:c.doc._id});
  const spy=jest.spyOn(Review,'updateOne').mockRejectedValueOnce(Error('injected transaction failure'));
  await expect(fullResolve(c)).rejects.toThrow('injected transaction failure');spy.mockRestore();
  const d=await Submission.findById(c.doc._id).lean();expect(d.sourceTranscriptExact).toBe(c.doc.sourceTranscriptExact);expect(sf.eligible(d)).toBe(false);
  expect(await Snapshot.countDocuments({submissionId:c.doc._id})).toBe(before);expect((await Review.findById(c.review._id).select('+payload').lean()).revision).toBe(0);
  const session=jest.spyOn(mongoose,'startSession').mockResolvedValueOnce({withTransaction:async()=>{throw Error('Transactions require replica set');},endSession:async()=>{}});
  await expect(fullResolve(c)).rejects.toThrow('Transactions require replica set');session.mockRestore();expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});
test('concurrent final full-page requests are idempotent and schedule only once',async()=>{
  const c=await escalation(),b=fullBody(c.doc),results=await Promise.allSettled([fullResolve(c,b),fullResolve(c,b)]);
  expect(results.some(r=>r.status==='fulfilled')).toBe(true);expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  expect((await Review.findById(c.review._id).select('+payload').lean()).payload.history).toHaveLength(1);
});
test('supersession is strictly page scoped, including conservative legacy unavailable counts',async()=>{
  const c=await escalation(),p2={...c.doc.ocrPages[0],pageIndex:1,pageNumber:2},d={...c.doc,ocrPages:[...c.doc.ocrPages,p2]};Object.assign(d,sf.aggregate(d));
  c.review.payload.basePages.push(p2);c.review.payload.unavailableByPage[plan.key(p2)]=2;c.review.payload.unavailable=5;
  c.review.currentHash=d.sourceTranscriptSha256;
  let result=full.apply(d,c.review,0,fullBody(d),teacher);expect(result.pages[1]).toEqual(JSON.parse(JSON.stringify(p2)));expect(result.summary.required).toBe(true);expect(result.payload.unavailable).toBe(2);
  let next={...d,ocrPages:result.pages,sourceHumanReviewSummary:result.summary};Object.assign(next,sf.aggregate(next));expect(sf.eligible(next)).toBe(false);
  const r2={...c.review,payload:result.payload,revision:1,currentHash:next.sourceTranscriptSha256};
  result=full.apply(next,r2,1,{...fullBody(next,'literal page two'),pageHash:p2.sourceTextSha256,pageIdentity:full.identity(next,p2),revision:1},teacher);
  next={...next,ocrPages:result.pages,sourceHumanReviewSummary:result.summary};Object.assign(next,sf.aggregate(next));expect(sf.eligible(next)).toBe(true);
  delete c.review.payload.unavailableByPage;result=full.apply(d,c.review,0,fullBody(d),teacher);expect(result.payload.unavailable).toBe(5);expect(result.summary.required).toBe(true);
});
test('page token binds submission/job/file even when source text and hashes are identical',async()=>{
  const c=await escalation(),otherCase=await escalation();
  expect(c.doc.sourceTranscriptSha256).toBe(otherCase.doc.sourceTranscriptSha256);
  await expect(fullResolve(otherCase,fullBody(c.doc))).rejects.toMatchObject({code:'SOURCE_VERSION_CONFLICT'});
  const p=c.doc.ocrPages[0],d={...c.doc,ocrPages:[p,{...p,pageIndex:1}]};expect(()=>full.page(d,0)).toThrow('SOURCE_VERSION_CONFLICT');
});
test('multi-file full-page commits preserve other pages and resume only after final page',async()=>{
  const c=await escalation(),f2=await File.create({originalName:'second.png',filename:'second.png',path:path.join(directory,'test.png'),url:'/second.png',uploadedBy:student._id,role:'student',type:'submissions'});
  const p2={...c.doc.ocrPages[0],_id:new mongoose.Types.ObjectId(),fileId:f2._id,fileOrder:1},d={...c.doc,files:[file._id,f2._id],ocrPages:[c.doc.ocrPages[0],p2]};
  c.review.payload.basePages.push(p2);c.review.payload.unavailableByPage[plan.key(p2)]=2;c.review.payload.unavailable=5;
  d.sourceHumanReviewSummary=plan.summary(c.review.payload);Object.assign(d,sf.aggregate(d));
  await Submission.updateOne({_id:d._id},{$set:{files:d.files,ocrPages:d.ocrPages,...sf.aggregate(d),sourceHumanReviewSummary:d.sourceHumanReviewSummary}});
  await Review.updateOne({_id:c.review._id},{$set:{payload:c.review.payload,currentHash:d.sourceTranscriptSha256}});
  const first=await fullResolve(c,fullBody(d,'literal first page'));expect(first.sourceFidelity.assessmentAllowed).toBe(false);expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
  const current=await Submission.findById(d._id).lean();expect(current.ocrPages[1].sourceTextExact).toBe(p2.sourceTextExact);
  const secondBody={...fullBody(current,'literal second page'),revision:1,pageHash:current.ocrPages[1].sourceTextSha256,pageIdentity:full.identity(current,current.ocrPages[1])};
  const final=await service.resolve(d._id,1,secondBody,teacher,true);expect(final.sourceFidelity.assessmentAllowed).toBe(true);
  expect(final.sourceFidelity.transcriptExact).toBe('literal first page'+sf.PAGE_SEPARATOR+'literal second page');
  expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
});
test('full-page events exclude source text and count superseded blockers; runtime has no fixture text imports',async()=>{
  const logger=require('../src/utils/logger'),spy=jest.spyOn(logger,'info').mockImplementation(()=>{}),c=await escalation();
  try{await service.pageReview(c.doc._id,0,teacher);await fullResolve(c);
    const logs=spy.mock.calls.map(([entry])=>entry);expect(logs.some(v=>v.event==='source_full_page_review_opened')).toBe(true);
    expect(logs.some(v=>v.event==='source_full_page_review_confirmed'&&v.blockersSuperseded===5)).toBe(true);
    const serialized=JSON.stringify(logs);expect(serialized).not.toContain(golden.text.slice(0,40));expect(serialized).not.toContain(c.doc.sourceTranscriptExact);
    for(const filename of ['sourceFidelity/fullPageReview.js','sourceHumanReview.service.js']){
      const code=fs.readFileSync(path.join(__dirname,'../src/services',filename),'utf8');for(const text of ['golden-002','marrid','Judiment','HUMAN_GOLD'])expect(code).not.toContain(text);
    }
  }finally{spy.mockRestore();}
});
test('unresolved evidence generates bounded generic items; no runtime human-gold import or invented coordinates',()=>{
  const p={...page(historical.astra.activeTranscript),fileId:historical.fileId,sourceInputSha256:historical.inputSha256};
  const doc={_id:'s',ocrJobId:'j',sourceFidelityInputIdentity:'base',sourceTranscriptExact:p.sourceTextExact,sourceTranscriptSha256:sf.sha(p.sourceTextExact),ocrPages:[p]};
  const e={identity:{submissionId:'s',runId:'j',fileId:p.fileId,pageNumber:1,inputSha256:p.sourceInputSha256},payload:{primary:historical.astra,secondary:historical.fable,google:{nativePages:[{...historical.google,dimensionsMatch:true}]}}};
  const a=plan.build(doc,[e]),b=plan.build(doc,[e]);expect(a.items.length).toBeGreaterThan(0);expect(a.items.map(i=>i.id)).toEqual(b.items.map(i=>i.id));
  expect(new Set(a.items.map(i=>i.id)).size).toBe(a.items.length);expect(a.unavailable).toBeGreaterThan(0);
  expect(a.items[0].transform).toMatchObject({type:'native-pixel-translation',scaleX:1,scaleY:1});
  expect(plan.build(doc,[]).items).toEqual([]);expect(plan.build(doc,[]).unavailable).toBe(1);
  const code=fs.readFileSync(path.join(__dirname,'../src/services/sourceFidelity/humanReviewPlan.js'),'utf8');expect(code).not.toContain('golden-002');
});
test('authorized teacher opens existing review idempotently; API omits private readers, paths and offsets',async()=>{
  const {doc}=await make();const a=await service.ensure(doc._id,teacher),b=await service.ensure(doc._id,teacher);
  expect(a.items).toEqual(b.items);expect(await Review.countDocuments({submissionId:doc._id})).toBe(1);
  for(const secret of ['payload','mapping','sourceGeometryWordIds','Fable','google','path','originalMappedStart'])expect(JSON.stringify(a)).not.toContain('"'+secret+'"');
});
test('opening unresolved OCR creates durable items once from stored evidence without new OCR',async()=>{
  const {doc}=await make();await Review.deleteMany({submissionId:doc._id});await Submission.updateOne({_id:doc._id},{$unset:{sourceHumanReviewId:1,sourceHumanReviewSummary:1},$set:{sourceFidelityStatus:'OCR_UNCERTAIN'}});
  const text=doc.sourceTranscriptExact,read=t=>({activeTranscript:t,segments:t.split('\n').map(text=>({type:'ACTIVE_STUDENT_TEXT',text,confidence:.9,notes:''})),uncertainSpans:[]});
  const words=['start','sence','end','next','wemen','last'].map((text,i)=>({id:'g'+i,text,paragraphIndex:i<3?0:1,symbols:[],
    polygon:[{x:20+(i%3)*180,y:30+Math.floor(i/3)*100},{x:100+(i%3)*180,y:30+Math.floor(i/3)*100},{x:100+(i%3)*180,y:70+Math.floor(i/3)*100},{x:20+(i%3)*180,y:70+Math.floor(i/3)*100}]}));
  await Evidence.create({identity:{submissionId:String(doc._id),runId:doc.ocrJobId,fileId:String(file._id),pageNumber:1,inputSha256:sf.sha(png)},
    payload:{primary:read(text),secondary:read(text.replace('sence','sense')),google:{nativePages:[{width:600,height:240,dimensionsMatch:true,words}]}}});
  const first=await service.ensure(doc._id,teacher),again=await service.ensure(doc._id,teacher);
  expect(first.items).toHaveLength(1);expect(first.items).toEqual(again.items);expect(first.sourceFidelity.status).toBe('HUMAN_REVIEW_REQUIRED');
  expect(await Review.countDocuments({submissionId:doc._id})).toBe(1);expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});
test('crop requires auth and ownership; student, unrelated teacher, foreign item and arbitrary coordinates fail closed',async()=>{
  const {doc,items}=await make(),otherCase=await make(),url=`/${doc._id}/source-review/${items[0].id}/crop`;
  expect((await request(app).get(url)).status).toBe(401);
  for(const tok of [studentToken,otherToken])expect((await request(app).get(url).set('Authorization','Bearer '+tok)).status).toBe(403);
  expect((await request(app).get(`/${otherCase.doc._id}/source-review/${items[0].id}/crop`).set('Authorization','Bearer '+token)).status).toBe(404);
  expect((await request(app).get(url+'?left=0').set('Authorization','Bearer '+token)).status).toBe(400);
  const r=await request(app).get(url).set('Authorization','Bearer '+token);expect(r.status).toBe(200);expect(r.headers['cache-control']).toBe('no-store');
  const dimensions=await sharp(r.body).metadata();expect(dimensions.width).toBe(550);expect(dimensions.height).toBe(50);
});
test('partial then final literal review is atomic, audited, source-versioned and schedules existing assessment exactly once',async()=>{
  const {doc,review,items}=await make(),firstBody=body(doc,'start  sEnce, end');
  const first=await service.resolve(doc._id,items[0].id,firstBody,teacher);expect(first.sourceFidelity.transcriptExact).toBe('start  sEnce, end\nnext wemen last');
  expect(first.sourceFidelity.assessmentAllowed).toBe(false);expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
  const current=await Submission.findById(doc._id).lean(),lastBody=body(current,'next wemen last',1);
  let resumedAfterPersistence;
  resume.scheduleSubmissionAnalysis.mockImplementationOnce(id=>{resumedAfterPersistence=Submission.findById(id).lean().then(d=>{expect(sf.eligible(d)).toBe(true);});});
  const done=await service.resolve(doc._id,items[1].id,lastBody,teacher);expect(done.sourceFidelity.status).toBe('HUMAN_VERIFIED');expect(done.sourceFidelity.assessmentAllowed).toBe(true);
  await resumedAfterPersistence;
  expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  const committed=await Submission.findById(doc._id).lean();expect(committed.ocrStatus).toBe('completed');expect(committed.analysisNextRetryAt).toBeTruthy();
  expect(await service.resolve(doc._id,items[1].id,lastBody,teacher)).toMatchObject({sourceFidelity:{status:'HUMAN_VERIFIED'}});
  expect(resume.scheduleSubmissionAnalysis).toHaveBeenCalledTimes(1);
  const record=await Review.findById(review._id).select('+payload').lean();expect(record.payload.originalTranscriptExact).toBe(doc.sourceTranscriptExact);
  expect(record.payload.history).toHaveLength(2);expect(record.payload.history[0]).toMatchObject({beforeSpan:'start sence end',afterSpan:'start  sEnce, end',reviewedBy:String(teacher._id),reviewedByRole:'teacher',sourceBeforeHash:doc.sourceTranscriptSha256});
  expect(record.payload.history[0].sourceAfterHash).toBe(first.sourceFidelity.transcriptSha256);
  expect(sf.sha(JSON.stringify(record.payload.history[1]))).toBe(committed.ocrPages[0].sourceHumanReceiptHash);
});
test.each(['DELETED_STUDENT_TEXT','NON_STUDENT_ARTIFACT'])('%s is excluded, never appended to active transcript',async classification=>{
  const {doc,items}=await make();const r=await service.resolve(doc._id,items[0].id,body(doc,'deleted sence',0,classification),teacher);
  expect(r.sourceFidelity.transcriptExact).toBe('\nnext wemen last');expect(r.sourceFidelity.assessmentAllowed).toBe(false);
});
test('cannot determine stays blocked; stale and client offset tampering fail closed',async()=>{
  const {doc,items}=await make();const r=await service.resolve(doc._id,items[0].id,body(doc,'',0,'CANNOT_DETERMINE'),teacher);
  expect(r.sourceFidelity.transcriptExact).toBe(doc.sourceTranscriptExact);expect(r.sourceFidelity.assessmentAllowed).toBe(false);
  const audit=await Review.findOne({submissionId:doc._id}).select('+payload').lean();expect(audit.payload.history[0]).toMatchObject({classification:'CANNOT_DETERMINE',applied:false,sourceAfterHash:doc.sourceTranscriptSha256});
  await expect(service.resolve(doc._id,items[1].id,body(doc,'next wemen last'),teacher)).rejects.toMatchObject({code:'SOURCE_VERSION_CONFLICT'});
  await expect(service.resolve(doc._id,items[1].id,{...body(doc,'literal'),start:0},teacher)).rejects.toMatchObject({code:'HUMAN_REVIEW_INVALID'});
  expect(resume.scheduleSubmissionAnalysis).not.toHaveBeenCalled();
});
test('concurrent different resolutions cannot overwrite the newer version',async()=>{
  const {doc,items}=await make();const out=await Promise.allSettled(['start ONE end','start TWO end'].map(text=>service.resolve(doc._id,items[0].id,body(doc,text),teacher)));
  expect(out.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(out.filter(r=>r.status==='rejected')).toHaveLength(1);
});
test('ambiguous mapping, changed source hash, out-of-bounds crop and missing submissions are rejected',async()=>{
  const {doc,review,items}=await make();const r=JSON.parse(JSON.stringify(review));r.payload.items[0].mapping.state='MAPPING_WITHHELD';
  expect(()=>plan.apply(doc,r,items[0].id,body(doc,'literal'),teacher)).toThrow('HUMAN_REVIEW_REGION_UNAVAILABLE');
  expect(()=>plan.apply(doc,review,items[0].id,{...body(doc,'literal'),sourceHash:'a'.repeat(64)},teacher)).toThrow('SOURCE_VERSION_CONFLICT');
  await expect(service.imageBytes(doc,{...items[0],rect:{left:590,top:0,width:550,height:50}})).rejects.toMatchObject({code:'HUMAN_REVIEW_REGION_UNAVAILABLE'});
  await expect(service.ensure(new mongoose.Types.ObjectId(),teacher)).rejects.toMatchObject({code:'HUMAN_REVIEW_NOT_FOUND'});
});
test('source review remains blocked for unlocalized blockers and unsafe overlapping mappings',async()=>{
  const {doc,review,items}=await make();review.payload.unavailable=1;
  const next=plan.apply(doc,review,items[0].id,body(doc,'literal'),teacher);expect(next.summary.required).toBe(true);
  expect(next.summary.total).toBe(next.summary.resolved+next.summary.unresolved);
  const overlapping=JSON.parse(JSON.stringify(review));overlapping.payload.items[1].state='HUMAN_VERIFIED';overlapping.payload.items[1].mapping={...items[0].mapping};overlapping.payload.items[1].replacement='old';
  expect(()=>plan.apply(doc,overlapping,items[0].id,body(doc,'literal'),teacher)).toThrow('SOURCE_VERSION_CONFLICT');
});
test('logs exclude literal input and unauthorized review cannot mutate source',async()=>{
  const {doc,items}=await make(),logger=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{}),text='start <script>very-private-human-text</script> end';
  try{await expect(service.resolve(doc._id,items[0].id,body(doc,text),student)).rejects.toMatchObject({code:'HUMAN_REVIEW_FORBIDDEN'});
    expect((await Submission.findById(doc._id)).sourceTranscriptSha256).toBe(doc.sourceTranscriptSha256);
    await service.resolve(doc._id,items[0].id,body(doc,text),teacher);expect(JSON.stringify(logger.mock.calls)).not.toContain('very-private-human-text');
  }finally{logger.mockRestore();}
});
test('inactive class and stored path traversal fail closed without image access',async()=>{
  const {doc,items}=await make();await Class.updateOne({_id:cls._id},{$set:{isActive:false}});
  try{await expect(service.crop(doc._id,items[0].id,teacher)).rejects.toMatchObject({code:'HUMAN_REVIEW_FORBIDDEN'});}
  finally{await Class.updateOne({_id:cls._id},{$set:{isActive:true}});}
  await File.updateOne({_id:file._id},{$set:{path:path.resolve(directory,'../outside.png')}});
  try{await expect(service.crop(doc._id,items[0].id,teacher)).rejects.toMatchObject({code:'HUMAN_REVIEW_REGION_UNAVAILABLE'});}
  finally{await File.updateOne({_id:file._id},{$set:{path:path.join(directory,'test.png')}});}
});
test.each(['marrid','be','Judiment','them selves','MRS,',"husband's"])('frozen Golden 002 %s can be confirmed through generic unique whole-row structures',quote=>{
  const line=golden.text.split('\n').find(line=>quote==='be'?line.includes('to be divote'):line.includes(quote));
  const provisional='left '+line+' right',p=page(provisional),doc={sourceTranscriptExact:provisional,sourceTranscriptSha256:sf.sha(provisional),ocrPages:[p]};
  const item={id:'test',pageKey:plan.key(p),inputSha256:p.sourceInputSha256,originalTranscriptSha256:p.sourceTextSha256,state:'PENDING_HUMAN_REVIEW',
    mapping:{state:'UNIQUE_STRUCTURAL_SPAN',start:0,end:provisional.length,original:provisional,leftAnchor:'left',rightAnchor:'right',sourceTranscriptSha256:p.sourceTextSha256}};
  const review={revision:0,currentHash:doc.sourceTranscriptSha256,payload:{basePages:[p],items:[item],unavailable:0,history:[]}};
  const r=plan.apply(doc,review,'test',body(doc,line),teacher);expect(r.pages[0].sourceTextExact).toBe(line);expect(r.pages[0].sourceFidelityStatus).toBe('HUMAN_VERIFIED');
});
