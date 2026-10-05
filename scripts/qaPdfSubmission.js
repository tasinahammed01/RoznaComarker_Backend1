'use strict';
// Explicit live-provider QA. All accounts, submissions and credits use isolated ephemeral Mongo.
if (!process.argv.includes('--live')) { console.error('Usage: node scripts/qaPdfSubmission.js --live'); process.exit(2); }
const path=require('path'),fs=require('fs'),assert=require('assert');
const root=path.resolve(__dirname,'..');
const req=name=>require(path.join(root,name));
req('node_modules/dotenv').config({path:path.join(root,'.env'),quiet:true});
process.env.NODE_ENV='test';process.env.MONGO_URI='mongodb://127.0.0.1/projectrozna_pdf_e2e_test';process.env.JWT_SECRET='pdf-e2e-disposable-test-secret';process.env.ENABLE_TEST_PDF_HTTP='true';
const out=path.resolve(root,'../output/pdf-submission-audit/replay');fs.mkdirSync(out,{recursive:true});
const logger=req('src/utils/logger');for(const key of ['info','debug','metric','warn','error'])logger[key]=()=>{};
const {connectInMemoryMongo,disconnectInMemoryMongo}=req('tests/helpers/testServer');
const {signTestJwt}=req('tests/helpers/auth');const request=req('node_modules/supertest');
const app=req('src/app');const User=req('src/models/user.model'),Class=req('src/models/class.model'),Assignment=req('src/models/assignment.model'),Membership=req('src/models/membership.model'),Submission=req('src/models/Submission'),File=req('src/models/File'),Feedback=req('src/models/SubmissionFeedback');
const {PDFDocument,StandardFonts}=req('node_modules/pdf-lib');
const measurements={ocr:[],raster:[]};
const Vision=req('node_modules/@google-cloud/vision').ImageAnnotatorClient;const originalDetect=Vision.prototype.documentTextDetection;
Vision.prototype.documentTextDetection=async function(...args){const started=Date.now();try{return await originalDetect.apply(this,args)}finally{measurements.ocr.push(Date.now()-started)}};
const pagesService=req('src/services/pdfSubmissionPages.service');const originalPrepare=pagesService.preparePdfPages;
pagesService.preparePdfPages=async(...args)=>{const started=Date.now();try{return await originalPrepare(...args)}finally{measurements.raster.push(Date.now()-started)}};
const results=[];
(async()=>{
 await connectInMemoryMongo({replicaSet:true});await req('tests/helpers/seedTestPlans').seedTestPlans();
 const [teacher,student]=await User.create([{firebaseUid:'pdf-e2e-teacher',email:'teacher@pdf-e2e.test',role:'teacher'},{firebaseUid:'pdf-e2e-student',email:'student@pdf-e2e.test',role:'student'}]);
 const tokens=[teacher,student].map(u=>signTestJwt({id:u._id,firebaseUid:u.firebaseUid,role:u.role}));
 const cl=await Class.create({name:'Disposable PDF QA',teacher:teacher._id,joinCode:'PDFE2E',qrCodeUrl:'data:,'});await Membership.create({student:student._id,class:cl._id,status:'active'});
 for(const count of [2]){
  const assignment=await Assignment.create({title:`PDF ${count} pages`,writingType:'essay',deadline:new Date(Date.now()+86400000),class:cl._id,teacher:teacher._id,qrToken:`pdf-e2e-${count}`});
  const pdf=await PDFDocument.create(),font=await pdf.embedFont(StandardFonts.Helvetica);
  for(let n=1;n<=count;n++){const page=pdf.addPage([595,842]);let lines=[`Reading and learning - page ${n}`,'Students was ready to learn in the classroom every morning.','Reading books helps people understand the world and develop new ideas.','For example, I read a story about a village that planted a community garden.','The neighbours worked together and shared the vegetables with families.','This example shows that cooperation can make a real difference.','However, some people does not have enough time to read each day.','Schools should provide quiet places and useful books for every student.','In conclusion, reading develops knowledge and helps us care for others.'];if(n===2)lines=['A different experience at the library','My sister enjoy visiting the public library after school.','Last Saturday she go there to research the history of our town.','She found an old newspaper that described a terrible storm.','The librarian explained how neighbours had rebuilt their damaged homes.','This historical example taught her that ordinary people can achieve great things.','She also learned that careful research requires comparing several sources.','We should preserve libraries because they provide reliable information.','In conclusion, a library helps young people explore their community.'];const canvas=req('node_modules/canvas').createCanvas(1190,1684),ctx=canvas.getContext('2d');ctx.fillStyle='white';ctx.fillRect(0,0,1190,1684);ctx.fillStyle='black';ctx.font='24px Arial';for(let i=0;i<lines.length;i++)ctx.fillText(lines[i],80,144+i*56);page.drawImage(await pdf.embedPng(canvas.toBuffer('image/png')),{x:0,y:0,width:595,height:842});}
  const bytes=Buffer.from(await pdf.save());fs.writeFileSync(path.join(out,`live-source-${count}.pdf`),bytes);
  const start=Date.now();const upload=await request(app).post(`/api/submissions/${assignment._id}`).set('Authorization',`Bearer ${tokens[1]}`).attach('file',bytes,{filename:`essay-${count}.pdf`,contentType:'application/pdf'});
  const result={pages:count,bytes:bytes.length,mime:'application/pdf',upload:upload.status};results.push(result);console.log(JSON.stringify({stage:'upload',...result}));
  if(upload.status!==200){result.failureCode=upload.body.code;result.message=upload.body.message;break;}
  const id=upload.body.data._id;let doc;let last='';
  for(let attempt=0;attempt<150;attempt++){doc=await Submission.findById(id).lean();const state=JSON.stringify({ocr:doc.ocrStatus,corrections:doc.correctionStatus,semantic:doc.semanticStatus,evaluation:doc.evaluationStatus,assessment:doc.assessmentStatus});if(state!==last){console.log(JSON.stringify({stage:'processing',pages:count,state:JSON.parse(state)}));last=state;}
    if(doc.ocrStatus==='failed'||doc.assessmentStatus==='complete'||doc.evaluationStatus==='completed'||(doc.correctionStatus==='failed'&&!doc.analysisLeaseOwner))break;
    await new Promise(r=>setTimeout(r,4000));
  }
  Object.assign(result,{durationMs:Date.now()-start,ocr:doc.ocrStatus,ocrErrorCode:doc.ocrErrorCode,corrections:doc.correctionStatus,semantic:doc.semanticStatus,evaluation:doc.evaluationStatus,assessment:doc.assessmentStatus,ocrPages:doc.ocrPages?.length||0,correctionCount:doc.writingCorrections?.length||0,feedback:!!await Feedback.exists({submissionId:id})});
  result.timings={rasterAndPersistMs:measurements.raster,ocrPerPageMs:measurements.ocr,totalOcrMs:measurements.ocr.reduce((a,b)=>a+b,0)};
  if(doc.assessmentStatus==='complete'){
   const Transaction=req('src/models/CreditTransaction');const before=await Transaction.countDocuments({submissionId:id,type:'ASSESSMENT_DEBIT'});
   await req('src/services/assessmentCreditRouter.service').consumeAssessmentCredit({teacherUserId:teacher._id,submissionId:id,assignmentId:assignment._id,assessmentId:doc.assessmentRunId,reason:'PDF QA replay'});
   const after=await Transaction.countDocuments({submissionId:id,type:'ASSESSMENT_DEBIT'});assert.equal(before,1);assert.equal(after,1);result.creditDebitsBeforeReplay=before;result.creditDebitsAfterReplay=after;
  }
  if(doc.ocrStatus==='completed'){
    assert.equal(doc.ocrPages.length,count);const web=await request(app).get(`/api/submissions/${id}/ocr-corrections`).set('Authorization',`Bearer ${tokens[1]}`);result.reviewStatus=web.status;
    fs.writeFileSync(path.join(out,`live-web-${count}.json`),JSON.stringify(web.body,null,2));
    result.assets=[];for(const p of doc.ocrPages){const studentAsset=await request(app).get(p.pageImageUrl).set('Authorization',`Bearer ${tokens[1]}`);const teacherAsset=await request(app).get(p.pageImageUrl).set('Authorization',`Bearer ${tokens[0]}`);const denied=await request(app).get(p.pageImageUrl);const hash=req('src/services/pdfSubmissionPages.service').digest(studentAsset.body);result.assets.push({page:p.pageNumber,width:p.width,height:p.height,ocrHash:p.rasterHash,displayHash:hash,student:studentAsset.status,teacher:teacherAsset.status,unauthenticated:denied.status});assert.equal(hash,p.rasterHash);fs.writeFileSync(path.join(out,`live-page-${count}-${p.pageNumber}.jpg`),studentAsset.body);}
    const report=await request(app).get(`/api/pdf/download/${id}`).set('Authorization',`Bearer ${tokens[1]}`);result.reportStatus=report.status;if(report.status===200)fs.writeFileSync(path.join(out,`live-feedback-${count}.pdf`),report.body);
  }
  console.log(JSON.stringify({stage:'result',...result}));fs.writeFileSync(path.join(out,'live-results.json'),JSON.stringify(results,null,2));
  if(doc.ocrStatus==='failed')break;
 }
})().catch(e=>{console.log(JSON.stringify({stage:'error',name:e.name,code:e.code,message:String(e.message).replace(/[A-Za-z]:\\[^ ]+/g,'[path]').slice(0,250)}));process.exitCode=1}).finally(async()=>{try{const files=await File.find({uploadedBy:{$exists:true}}).lean();for(const f of files){const p=path.isAbsolute(f.path)?f.path:path.resolve(root,f.path);if(p.startsWith(path.join(root,'uploads')+path.sep))await fs.promises.unlink(p).catch(()=>{});}}catch{}fs.writeFileSync(path.join(out,'live-results.json'),JSON.stringify(results,null,2));await req('src/services/pdfBrowserManager.service').closeBrowser();await disconnectInMemoryMongo();});
