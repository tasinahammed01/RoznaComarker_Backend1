'use strict';
const fs=require('fs'),path=require('path');
const {sha}=require('../src/services/sourceFidelityOcr.service');
const {exportEvidence}=require('./lib/ocrSourceAudit.cjs');
const pick=(v,keys)=>Object.fromEntries(keys.filter(k=>v?.[k]!==undefined).map(k=>[k,v[k]]));
function sanitizeTargeted(v){if(!v)return null;
  const region=r=>({...pick(r,['id','fileId','pageNumber','inputSha256','reasons','lineIds','nativeCoordinates','displayCoordinates','sourceGeometryWordIds','leftAnchorId','rightAnchorId','cropSha256','cropDimensions','transform']),
    mapping:pick(r.mapping,['state','start','end','original','leftAnchor','rightAnchor','leftAnchorId','rightAnchorId','sourceTranscriptSha256'])});
  const reading=r=>({...pick(r,['model','returnedModel','outcome','promptSha256','cropSha256','durationMs','validationStatus','failureCode']),
    value:r.value?{activeTranscript:r.value.activeTranscript,segments:r.value.segments.map(s=>pick(s,['type','text','confidence','notes'])),
      uncertainSpans:r.value.uncertainSpans.map(s=>pick(s,['visibleContext','candidateReading','reason']))}:null,
    usage:pick(r.usage,['prompt_tokens','completion_tokens','total_tokens','cost','thoughts_tokens'])});
  return {...pick(v,['version','firstPassStatus','status','stage','text','failureCode']),
    plan:v.plan?{...pick(v.plan,['candidateRegionCount','omittedRegionCount','unlocalizedSignalCount','reasonCodes']),
      signals:v.plan.signals?.map(s=>({reason:s.reason,ids:s.ids,origin:pick(s.origin,['reader','start','end','type'])})),regions:v.plan.regions?.map(region)}:null,
    results:(v.results||[]).map(r=>({status:r.status,failureCode:r.failureCode,region:region(r.region),readers:(r.readers||[]).map(reading),
      reconciliation:r.reconciliation?{...pick(r.reconciliation,['regionId','originalFirstPassSpan','targetedTranscript','alignmentState','beforeOffsets','afterOffsets','replacement']),
        provenance:pick(r.reconciliation.provenance,['stage','models','cropSha256'])}:null})),
    summary:v.summary?{...pick(v.summary,['firstPassStatus','candidateRegionCount','candidateReasons','targetedRegionCount','resolvedTargetedCount','unresolvedTargetedCount','finalSourceStatus']),
      readers:v.summary.readers?.map(r=>({role:r.role,calls:r.calls,usage:pick(r.usage,['prompt_tokens','completion_tokens','total_tokens','cost','thoughts_tokens'])}))}:null};
}
async function retrieve(connection,id){
  const {ObjectId}=require('mongoose').Types;
  const submission=await connection.collection('submissions').findOne({_id:new ObjectId(id)},{projection:{_id:1,ocrJobId:1,sourceFidelityMode:1,
    sourceFidelityStatus:1,sourceFidelityVersion:1,sourceTranscriptExact:1,sourceTranscriptSha256:1,ocrPages:1}});
  if(!submission)throw Error('AUDIT_SUBMISSION_NOT_FOUND');
  const rows=await connection.collection('sourcefidelityevidences').find({'identity.submissionId':id,'identity.runId':String(submission.ocrJobId)},
    {projection:{_id:0,identity:1,status:1,payload:1}}).limit(21).toArray();
  if(rows.length>20)throw Error('AUDIT_EVIDENCE_LIMIT');
  const evidence=exportEvidence(submission,rows);
  const pages=evidence.pages.map(p=>{
    const row=rows.find(r=>r.identity.fileId===p.fileId&&r.identity.pageNumber===p.pageNumber&&r.identity.inputSha256===p.inputSha256);
    return {...p,targeted:sanitizeTargeted(row?.payload?.targeted)};
  });
  const after=await connection.collection('submissions').findOne({_id:submission._id},{projection:{ocrJobId:1,sourceTranscriptExact:1,sourceFidelityStatus:1,sourceTranscriptSha256:1}});
  if(String(after?.ocrJobId)!==String(submission.ocrJobId)||after.sourceTranscriptExact!==submission.sourceTranscriptExact
    ||after.sourceFidelityStatus!==submission.sourceFidelityStatus||after.sourceTranscriptSha256!==submission.sourceTranscriptSha256)throw Error('AUDIT_SOURCE_CHANGED_EXTERNALLY');
  const fileIds=[...new Set(pages.map(p=>p.fileId))];const localFiles=[];
  for(const fid of fileIds){if(!/^[a-f\d]{24}$/i.test(fid))continue;
    const f=await connection.collection('files').findOne({_id:new ObjectId(fid)},{projection:{_id:1,path:1}});if(f)localFiles.push({fileId:String(f._id),path:f.path});}
  return {...evidence,pages,localFiles,sourceTextMutated:false,providerCalls:0};
}
async function main(){
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--submission'||!/^[a-f\d]{24}$/i.test(args[1]))throw Error('AUDIT_USAGE');
  require('../src/config/env');const mongoose=require('mongoose');let c;
  try{c=await mongoose.createConnection(process.env.MONGO_URI,{autoIndex:false,autoCreate:false,serverSelectionTimeoutMS:15000,connectTimeoutMS:15000,socketTimeoutMS:20000,maxPoolSize:1}).asPromise();
    const evidence=await retrieve(c,args[1]);const dir=path.resolve(__dirname,'../tmp/targeted-v2-failure');fs.mkdirSync(dir,{recursive:true,mode:0o700});
    if(fs.realpathSync(dir)!==dir)throw Error('AUDIT_OUTPUT_REDIRECTED');
    const output=path.join(dir,args[1]+'-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');
    const analysis=require('./lib/targetedFailureAnalysis.cjs').analyze(evidence);
    analysis.cropInspection=await inspectCrops(evidence,dir);
    fs.writeFileSync(output,JSON.stringify({evidence,analysis},null,2)+'\n',{flag:'wx',mode:0o600});
    console.log(JSON.stringify({output,submissionId:evidence.submissionId,ocrJobId:evidence.ocrJobId,pages:evidence.pages.length,
      targetedRegions:evidence.pages.reduce((n,p)=>n+(p.targeted?.results||[]).filter(r=>r.readers.length).length,0),providerCalls:0,sourceTextMutated:false}));
  }finally{await c?.close();}
}
async function inspectCrops(evidence,dir){
  const results=[],root=path.resolve(__dirname,'..'),uploadRoot=path.join(root,'uploads')+path.sep;
  const sharp=require('sharp'),target=require('../src/services/sourceFidelity/targetedVerification');
  for(const page of evidence.pages){
    const stored=evidence.localFiles?.find(f=>f.fileId===page.fileId)?.path;
    const filename=stored?path.resolve(root,stored):null;
    if(!filename||!filename.startsWith(uploadRoot)||!fs.existsSync(filename)){results.push({pageNumber:page.pageNumber,available:false});continue;}
    const normalized=await sharp(await fs.promises.readFile(filename),{failOn:'error',limitInputPixels:40000000}).rotate().toBuffer();
    if(sha(normalized)!==page.inputSha256){results.push({pageNumber:page.pageNumber,inputHashMatch:false});continue;}
    for(const [i,r] of (page.targeted?.results||[]).entries()){
      if(!r.readers.length)continue;
      const c=await target.crop(normalized,r.region,page.google.nativePages[0]);
      const matches=c.cropSha256===r.region.cropSha256;
      const output=path.join(dir,'crop-'+(i+1)+'-'+c.cropSha256+'.png');
      if(matches&&!fs.existsSync(output))fs.writeFileSync(output,c.bytes,{flag:'wx',mode:0o600});
      results.push({regionIndex:i+1,pageNumber:page.pageNumber,inputHashMatch:true,cropHashMatch:matches,
        cropDimensions:c.cropDimensions,transform:c.transform,quality:'MANUAL_INSPECTION_REQUIRED',output:matches?path.basename(output):null});
    }
  }
  return results;
}
if(require.main===module)main().catch(e=>{console.error(/^AUDIT_[A-Z_]+$/.test(e.message)?e.message:'AUDIT_READ_FAILED');process.exitCode=1;});
module.exports={sanitizeTargeted,retrieve,inspectCrops};
