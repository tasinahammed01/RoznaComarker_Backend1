'use strict';
// Offline exact-image validation only. No gold, provider, database or assessment.
const fs=require('fs'),path=require('path'),sharp=require('sharp');
const v3=require('./targeted-v3-live-smoke.cjs'),v4=require('../src/services/sourceFidelity/magnifiedFocusV4');
async function audit(){
  const history=require('../tests/fixtures/source-fidelity/targeted-failed-run.cjs'),p=history.pages[0];
  const evidence={...history,sourceTranscriptExact:p.exactText,sourceTranscriptSha256:p.exactTextSha256,
    localFiles:[{fileId:p.fileId,path:'uploads/submissions/fc053052-3442-4825-ae29-382fb708e579.jpg'}]};
  const original=await v3.prepare(evidence),crop=await v4.fromV3(original.crop),m=crop.audit.magnification;
  const reference=await sharp(original.crop.images[1].bytes,{limitInputPixels:40000000})
    .resize({width:m.originalFocusDimensions.width*3,height:m.originalFocusDimensions.height*3,fit:'fill',kernel:sharp.kernel.cubic})
    .png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  if(!reference.equals(crop.images[1].bytes)||!crop.images[0].bytes.equals(original.crop.images[0].bytes))throw Error('V4_AUDIT_PIXEL_IDENTITY');
  const again=await v4.fromV3(original.crop);if(!again.images[1].bytes.equals(reference))throw Error('V4_AUDIT_NONDETERMINISTIC');
  return {crop,original,result:{status:'OFFLINE_V4_MAGNIFICATION_VERIFIED',providerCalls:0,sourceMutation:false,
    inputSha256:crop.audit.inputSha256,contextSha256:crop.audit.contextCropSha256,contextDimensions:crop.audit.contextCropDimensions,
    ...m,deterministicReferenceMatched:true,originalContextUnchanged:true,originalFocusUnchanged:true,transcriptionImprovementEvaluated:false}};
}
async function main(){
  if(process.argv.length!==2)throw Error('V4_AUDIT_USAGE');
  const {crop,original,result}=await audit(),manifest=require('./lib/targetedV4Manifest.cjs');
  if(result.magnifiedFocusSha256!==manifest.magnifiedFocusSha256||result.originalFocusSha256!==manifest.focusSha256||result.contextSha256!==manifest.contextSha256)throw Error('V4_AUDIT_MANIFEST_SHA');
  const dir=path.resolve(__dirname,'../tmp/targeted-v4');fs.mkdirSync(dir,{recursive:true,mode:0o700});
  if(fs.realpathSync(dir)!==dir)throw Error('V4_AUDIT_OUTPUT_REDIRECT');
  for(const image of [...crop.images,original.crop.images[1]])fs.writeFileSync(path.join(dir,image.name+'.png'),image.bytes,{mode:0o600});
  fs.writeFileSync(path.join(dir,'visual-audit.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({status:result.status,providerCalls:0,scaleFactor:result.scaleFactor,resizeKernel:result.resizeKernel,originalFocusDimensions:result.originalFocusDimensions,magnifiedFocusDimensions:result.magnifiedFocusDimensions}));
}
if(require.main===module)main().catch(()=>{console.error('V4_AUDIT_FAILED');process.exitCode=1;});
module.exports={audit};
