'use strict';
const sharp=require('sharp');
// Shared preparation for preview and final source reading. No OCR preprocessing.
async function orientImage(bytes){
  const metadata=await sharp(bytes,{failOn:'error'}).metadata();
  if(!metadata.orientation||metadata.orientation===1)return {data:bytes,info:{width:metadata.width,height:metadata.height,format:metadata.format}};
  return sharp(bytes,{failOn:'error'}).rotate().png().toBuffer({resolveWithObject:true});
}
module.exports={orientImage};
