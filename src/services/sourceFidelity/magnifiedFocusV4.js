'use strict';
// Non-generative rendering of the exact V3 focus, never a new source authority.
const v3=require('./visualContextV3');
const SCALE=3,KERNEL='cubic';
const PROMPT=v3.PROMPT.replace(
  'The first image is complete handwriting-line context. The second is a closer original-pixel view of the same suspicious region, provided only to inspect letter shapes. Original handwriting is authoritative; neither view supplies missing pixels.',
  'The first image is handwriting-line context. The second is a deterministically enlarged view of the same target handwriting region, provided only to inspect visible letter shapes exactly. Enlargement contains no new or corrected information. The original normalized handwriting remains authoritative.');
const fail=code=>Object.assign(Error(code),{code,retryable:false});
async function fromV3(original){
  const sharp=require('sharp'),[context,focus]=original.images||[];
  if(original.images?.length!==2||context?.name!=='LINE_CONTEXT_IMAGE'||focus?.name!=='FOCUS_DETAIL_IMAGE'
    ||!Buffer.isBuffer(context.bytes)||!Buffer.isBuffer(focus.bytes)||!context.bytes.equals(original.bytes)
    ||v3.sha(context.bytes)!==context.sha256||context.sha256!==original.audit?.contextCropSha256
    ||v3.sha(focus.bytes)!==focus.sha256||focus.sha256!==original.audit?.focusCropSha256)throw fail('OCR_V4_FOCUS_IDENTITY');
  const meta=await sharp(focus.bytes,{failOn:'error',limitInputPixels:40000000}).metadata();
  if(meta.format!=='png'||meta.width!==focus.dimensions.width||meta.height!==focus.dimensions.height
    ||meta.width!==original.audit.focusCropDimensions.width||meta.height!==original.audit.focusCropDimensions.height)throw fail('OCR_V4_FOCUS_DIMENSIONS');
  const width=meta.width*SCALE,height=meta.height*SCALE;
  if(width*height>40000000)throw fail('OCR_V4_MAGNIFICATION_LIMIT');
  // Sharp's documented upsampling interpolators are nearest/linear/cubic. Select
  // cubic explicitly rather than naming a downsampling kernel with inferred behavior.
  const bytes=await sharp(focus.bytes,{failOn:'error',limitInputPixels:40000000})
    .resize({width,height,fit:'fill',kernel:sharp.kernel.cubic})
    .png({compressionLevel:9,adaptiveFiltering:false}).toBuffer();
  if(bytes.length>20*1024*1024)throw fail('OCR_V4_MAGNIFICATION_LIMIT');
  const evidence={originalFocusSha256:focus.sha256,originalFocusDimensions:{...focus.dimensions},
    magnifiedFocusSha256:v3.sha(bytes),magnifiedFocusDimensions:{width,height},scaleFactor:SCALE,resizeKernel:KERNEL,
    effectiveInterpolator:'cubic',sharpVersion:sharp.versions.sharp,vipsVersion:sharp.versions.vips,
    supplementaryOnly:true,generativeEnhancementUsed:false,brightnessContrastChanged:false,sourceAuthority:'ORIGINAL_NORMALIZED_PAGE'};
  return {...original,images:[context,{name:'MAGNIFIED_FOCUS_IMAGE',bytes,mimeType:'image/png',sha256:evidence.magnifiedFocusSha256,
    dimensions:{width,height},sourceRect:{...focus.rect},transform:{type:'native-pixel-magnification',offsetX:focus.rect.left,offsetY:focus.rect.top,scaleX:SCALE,scaleY:SCALE}}],
    audit:{...original.audit,originalPixelsOnly:false,originalContextPixelsUnchanged:true,magnificationApplied:true,magnification:evidence}};
}
async function bundle(bytes,region,page,signals=[]){return fromV3(await v3.bundle(bytes,region,page,signals));}
module.exports={SCALE,KERNEL,PROMPT,bundle,fromV3};
