'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..');
const {exportEvidence,audit,sha}=require('./lib/ocrSourceAudit.cjs');
async function retrieve(connection,id){
  // Raw projected reads avoid model middleware, index creation and recovery workers.
  const {ObjectId}=require('mongoose').Types;
  const projection={_id:1,ocrJobId:1,sourceFidelityMode:1,sourceFidelityStatus:1,sourceFidelityVersion:1,
    sourceTranscriptExact:1,sourceTranscriptSha256:1,ocrPages:1};
  const submission=await connection.collection('submissions').findOne({_id:new ObjectId(id)},{projection});
  if(!submission)throw Error('AUDIT_SUBMISSION_NOT_FOUND');
  const evidence=await connection.collection('sourcefidelityevidences').find({'identity.submissionId':id,'identity.runId':String(submission.ocrJobId)},
    {projection:{_id:0,identity:1,status:1,payload:1}}).limit(21).toArray();
  if(evidence.length>20)throw Error('AUDIT_EVIDENCE_LIMIT');
  // Confirm currentness after reading the evidence; never silently audit an old job as current.
  const current=await connection.collection('submissions').findOne({_id:submission._id,ocrJobId:submission.ocrJobId},{projection:{_id:1}});
  if(!current)throw Error('AUDIT_JOB_CHANGED');
  return exportEvidence(submission,evidence);
}
async function main(){
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--submission'||!/^[a-f\d]{24}$/i.test(args[1]))throw Error('AUDIT_USAGE_SUBMISSION_ID_REQUIRED');
  const id=args[1];require('../src/config/env');
  const mongoose=require('mongoose');let connection;
  try{
    connection=await mongoose.createConnection(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000,
      connectTimeoutMS:15000,socketTimeoutMS:20000,maxPoolSize:1}).asPromise();
    const evidence=await retrieve(connection,id);
    const gold=require('../tests/fixtures/source-fidelity/golden-002.cjs');
    const page=evidence.pages.find(p=>p.inputSha256===gold.inputSha256&&p.pageNumber===gold.pageNumber);
    const analysis=page?audit(page,gold):null;
    const directory=path.join(root,'tmp','ocr-source-audit');fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(fs.realpathSync(directory)!==directory)throw Error('AUDIT_OUTPUT_REDIRECTED');
    const output=path.join(directory,id+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    fs.writeFileSync(output,JSON.stringify({evidence,analysis},null,2)+'\n',{flag:'wx',mode:0o600});
    // Re-read only source/job projection and verify no source mutation during the audit.
    const after=await connection.collection('submissions').findOne({_id:new mongoose.Types.ObjectId(id)},
      {projection:{_id:1,ocrJobId:1,sourceTranscriptExact:1,sourceTranscriptSha256:1}});
    if(String(after?.ocrJobId)!==evidence.ocrJobId||sha(after?.sourceTranscriptExact||'')!==sha(evidence.sourceTranscriptExact||''))throw Error('AUDIT_SOURCE_CHANGED_EXTERNALLY');
    console.log(JSON.stringify({status:'AUDIT_EXPORTED',output:path.relative(path.resolve(root,'..'),output),submissionId:id,
      pages:evidence.pages.length,existingDisagreements:page?.existingDiagnostics.length??null,
      humanVsAstra:analysis?.humanVsAstra.character.differenceCount??null,humanVsFable:analysis?.humanVsFable.character.differenceCount??null,
      findings:analysis?.humanFindings.counts??null,geometryGaps:analysis?analysis.geometry.astra.gaps.length+analysis.geometry.fable.gaps.length:null,
      sourceTextMutated:false,providerCalls:0}));
  }finally{await connection?.close();}
}
if(require.main===module)main().catch(error=>{const code=/^AUDIT_[A-Z0-9_]+$/.test(error?.message||'')?error.message:'AUDIT_READ_FAILED';console.error(code);process.exitCode=1;});
module.exports={retrieve,main};
