'use strict';
// Offline developer fixture audit. The generic generator completes before gold is loaded.
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const visual=require('../src/services/sourceFidelity/visualContextV3'),targeted=require('../src/services/sourceFidelity/targetedVerification');
async function audit(){
  const history=require('../tests/fixtures/source-fidelity/targeted-failed-run.cjs'),p=history.pages[0],region=p.targeted.results[7].region,g=p.google.nativePages[0];
  const input=path.resolve(__dirname,'../uploads/submissions/fc053052-3442-4825-ae29-382fb708e579.jpg');
  const bytes=await sharp(await fs.promises.readFile(input),{failOn:'error',limitInputPixels:40000000}).rotate().toBuffer();
  const plan=targeted.discover({astra:p.astra,fable:p.fable,google:g,identity:{fileId:p.fileId,pageNumber:p.pageNumber,inputSha256:p.inputSha256}});
  const bundle=await visual.bundle(bytes,region,g,plan.signals),old=await targeted.crop(bytes,region,g);
  const manifest=require('./lib/targetedV3Manifest.cjs');
  if(bundle.audit.contextCropSha256!==manifest.contextSha256||bundle.audit.focusCropSha256!==manifest.focusSha256
    ||bundle.audit.inputSha256!==manifest.inputSha256)throw Error('V3_AUDIT_MANIFEST_SHA');
  const candidateAudits=[];
  for(const candidate of plan.regions){try{const c=await visual.bundle(bytes,candidate,g,plan.signals);candidateAudits.push({regionId:candidate.id,status:'CROPS_VERIFIED',audit:c.audit});}
    catch(e){candidateAudits.push({regionId:candidate.id,status:'REFUSED',safeFailureCode:/^OCR_[A-Z0-9_]+$/.test(e.code||'')?e.code:'OCR_V3_CROP_REFUSED'});}}
  if(old.cropSha256!==region.cropSha256)throw Error('V3_AUDIT_HISTORICAL_SHA');
  const gold=require('../tests/fixtures/source-fidelity/golden-002.cjs');
  if(gold.inputSha256!==visual.sha(bytes)||!gold.humanReviewed)throw Error('V3_AUDIT_GOLD_IDENTITY');
  const map=targeted.tokenMap(gold.text,targeted.geometryWords(g)).filter(w=>region.sourceGeometryWordIds.includes(w.id));
  const expected=gold.text.slice(Math.min(...map.map(w=>w.start)),Math.max(...map.map(w=>w.end)));
  const originalEdge=await visual.edgeMetrics(bytes,region.nativeCoordinates,bundle.audit.medianWordHeight);
  const a=bundle.audit;
  return {bundle,historical:old,result:{status:'OFFLINE_VISUAL_AUDIT',providerCalls:0,sourceMutation:false,inputSha256:p.inputSha256,
    historical:{rect:region.nativeCoordinates,sha256:old.cropSha256,dimensions:old.cropDimensions,edge:originalEdge,
      topMarginPixels:Math.min(...visual.words(g).filter(w=>region.sourceGeometryWordIds.includes(w.id)).map(w=>w.top))-region.nativeCoordinates.top,
      bottomMarginPixels:region.nativeCoordinates.top+region.nativeCoordinates.height-Math.max(...visual.words(g).filter(w=>region.sourceGeometryWordIds.includes(w.id)).map(w=>w.bottom))},
    v3:a,candidateAudits,humanGoldComparison:{authority:'TEST_ONLY_AFTER_CROP_GENERATION',expectedRow:expected,ocrAccuracyEvaluated:false},
    edgeClippingRiskReduced:(!a.contextEdge.topBoundaryInkRisk&&!a.contextEdge.bottomBoundaryInkRisk)&&(originalEdge.topBoundaryInkRisk||originalEdge.bottomBoundaryInkRisk),
    interpretation:'Target box margins increase; edge ink and neighboring rows remain risks. No semantic or OCR accuracy claim.'}};
}
async function main(){
  if(process.argv.length!==2)throw Error('V3_AUDIT_USAGE');
  const {result,bundle,historical}=await audit(),dir=path.resolve(__dirname,'../tmp/targeted-v3');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.realpathSync(dir)!==dir)throw Error('V3_AUDIT_OUTPUT_REDIRECT');
  for(const i of [...bundle.images,{name:'HISTORICAL_V2',bytes:historical.bytes}])fs.writeFileSync(path.join(dir,i.name+'.png'),i.bytes,{mode:0o600});
  fs.writeFileSync(path.join(dir,'visual-audit.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:result.status,providerCalls:0,context:result.v3.contextCropDimensions,focus:result.v3.focusCropDimensions,edgeClippingRiskReduced:result.edgeClippingRiskReduced}));
}
if(require.main===module)main().catch(()=>{console.error('V3_AUDIT_FAILED');process.exitCode=1;});
module.exports={audit};
