'use strict';
// Offline only. Gold admission and durable freeze precede reading model evidence.
const fs=require('fs'),path=require('path');
const {sha,requireHumanGold,evaluate}=require('./lib/benchmark003Fidelity.cjs');
const manifest=require('./lib/ocrBenchmark003Manifest.cjs');
const ROOT=path.resolve(__dirname,'../..');
const PIN=Object.freeze({artifact:'backend/tmp/ocr-benchmark-results/benchmark-003-2026-10-21T16-37-57-152Z-1dfc2079-ee46-4c5f-a2e0-0957ed596291.json',sha256:'b84c516be71870bd5f57fe1b5418321ab75a88f035bcb094ce005953e71d80ea'});
function parseArtifact(bytes,pin=PIN){
  if(sha(bytes)!==pin.sha256)throw Error('ASTRA_ARTIFACT_HASH_INVALID');
  const p=JSON.parse(bytes),a=p.readers?.filter(r=>r.requestedModel==='openai/gpt-6-astra');
  if(p.benchmarkId!=='003'||p.normalizedSha256!==manifest.normalizedSha256||a?.length!==1)throw Error('ASTRA_ARTIFACT_IDENTITY_INVALID');
  const r=a[0];
  if(r.returnedModel!=='openai/gpt-6-astra'||r.outcome!=='SUCCESS'||r.schemaValid!==true||typeof r.activeTranscript!=='string'||!Array.isArray(r.segments)||!Array.isArray(r.uncertainSpans))throw Error('ASTRA_READER_INVALID');
  if(r.segments.some(s=>!['ACTIVE_STUDENT_TEXT','CROSSED_OUT_OR_DELETED','NON_STUDENT_ARTIFACT','UNCERTAIN'].includes(s.type)||(s.text!==null&&typeof s.text!=='string')||(s.type==='ACTIVE_STUDENT_TEXT'&&typeof s.text!=='string'))||r.segments.filter(s=>s.type==='ACTIVE_STUDENT_TEXT').map(s=>s.text).join('\n')!==r.activeTranscript)throw Error('ASTRA_READER_INVALID');
  return r;
}
async function run(gold,{readImage,freeze,readArtifact,readAudit=()=>null}={}){
  requireHumanGold(gold);
  if(gold.benchmarkId!=='003'||gold.inputSha256!==manifest.normalizedSha256)throw Error('HUMAN_GOLD_IMAGE_IDENTITY_INVALID');
  const events=['HUMAN_GOLD_VALIDATED'];
  const image=await readImage();
  if(image.originalSha256!==manifest.originalSha256||image.normalizedSha256!==manifest.normalizedSha256||image.width!==1200||image.height!==1600)throw Error('IMAGE_IDENTITY_INVALID');
  events.push('IMAGE_HASH_VALIDATED');
  await freeze({benchmarkId:'003',text:gold.text,textSha256:gold.textSha256,inputSha256:gold.inputSha256});
  events.push('HUMAN_GOLD_FROZEN');
  const astra=parseArtifact(await readArtifact());events.push('ASTRA_ARTIFACT_LOADED');
  const audit=await readAudit();
  if(audit&&(audit.textSha256!==gold.textSha256||audit.artifactSha256!==PIN.sha256))throw Error('AUDIT_IDENTITY_INVALID');
  return {benchmarkId:'003',status:'EVALUATED',providerCalls:0,fableUsed:false,events,artifactSha256:PIN.sha256,textSha256:gold.textSha256,auditSha256:audit?sha(JSON.stringify(audit)):null,...evaluate(gold,astra,audit||{})};
}
async function main(){
  if(process.argv.length!==2)throw Error('OFFLINE_EVALUATOR_ACCEPTS_NO_FLAGS');
  const gold=require('../tests/fixtures/source-fidelity/benchmark-003-human-gold.cjs');
  const result=await run(gold,{
    readImage:async()=>{const sharp=require('sharp'),bytes=await fs.promises.readFile(path.resolve(ROOT,manifest.imagePathRelative));const normalized=await sharp(bytes).rotate().toBuffer();const metadata=await sharp(normalized).metadata();return {originalSha256:sha(bytes),normalizedSha256:sha(normalized),width:metadata.width,height:metadata.height};},
    freeze:async record=>{const filename=path.resolve(ROOT,'backend/tmp/benchmark003-gold-preparation/gold-freeze-'+record.textSha256+'.json');const bytes=JSON.stringify(record,null,2)+'\n';await fs.promises.mkdir(path.dirname(filename),{recursive:true});try{await fs.promises.writeFile(filename,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.promises.readFile(filename,'utf8')!==bytes)throw e;}},
    readArtifact:()=>fs.promises.readFile(path.resolve(ROOT,PIN.artifact)),
    readAudit:()=>require('../tests/fixtures/source-fidelity/benchmark-003-fidelity-audit.cjs')
  });
  const filename=path.resolve(ROOT,'backend/tmp/benchmark003-gold-preparation/astra-fidelity-'+gold.textSha256+'-'+result.auditSha256+'.json');
  const bytes=JSON.stringify(result,null,2)+'\n';
  try{await fs.promises.writeFile(filename,bytes,{flag:'wx'});}catch(e){if(e.code!=='EEXIST'||await fs.promises.readFile(filename,'utf8')!==bytes)throw e;}
  console.log(JSON.stringify({status:result.status,providerCalls:0,result:filename}));
}
if(require.main===module)main().catch(e=>{console.error(JSON.stringify({status:e.code||e.message,providerCalls:0}));process.exitCode=1;});
module.exports={PIN,parseArtifact,run};
