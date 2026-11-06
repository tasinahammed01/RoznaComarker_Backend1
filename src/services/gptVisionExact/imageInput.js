'use strict';
const sharp=require('sharp');
// Shared preparation for preview and final source reading. No OCR preprocessing.
async function orientImage(bytes){
  const metadata=await sharp(bytes,{failOn:'error'}).metadata();
  if(!metadata.orientation||metadata.orientation===1)return {data:bytes,info:{width:metadata.width,height:metadata.height,format:metadata.format}};
  // Measured on a real rotated page: lossless PNG is 5-9x the size of the JPEG (a 1.3 MB phone-size JPEG becomes about 12 MB,
  // and anything over about 2.2 MB passes the 20 MB source limit). A rotated JPEG stays a JPEG: quality 92, full-resolution colour.
  if(metadata.format==='jpeg')return sharp(bytes,{failOn:'error'}).rotate().jpeg({quality:92,chromaSubsampling:'4:4:4'}).toBuffer({resolveWithObject:true});
  return sharp(bytes,{failOn:'error'}).rotate().png().toBuffer({resolveWithObject:true});
}
module.exports={orientImage};
