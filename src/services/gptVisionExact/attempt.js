'use strict';
const {sha,fail,VERSION}=require('./contract');
const Evidence=require('../../models/SourceFidelityEvidence');
// Deliberately excludes job/run ID: recovering/restarting the same upload cannot
// buy another read. No TTL: terminal/reserved attempts remain durable.
async function acquire(identity,store=Evidence){
  if(!['submissionId','fileId','inputSha256','sourceSha256','promptSha256','model'].every(k=>typeof identity[k]==='string'&&identity[k].length)||!Number.isInteger(identity.pageNumber)||identity.pageNumber<1)throw fail('OCR_GPT_SOURCE_IDENTITY_REQUIRED');
  const _id=sha(JSON.stringify([VERSION,identity.submissionId,identity.fileId,identity.pageNumber,identity.inputSha256])).slice(0,24);
  try{await store.create({_id,identity,status:'GPT_SOURCE_RESERVED',expiresAt:null});return {_id,cached:false};}catch(e){if(e.code!==11000)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');}
  const old=await store.findById(_id).select('+payload').lean();
  if(old?.status==='GPT_SOURCE_ACCEPTED'&&old.identity.model===identity.model
    &&require('./contract').sameSourcePrompt(old.identity,identity)
    &&old.identity.sourceSha256===identity.sourceSha256&&old.payload?.primary)return {_id,cached:true,evidence:old};
  throw fail('OCR_GPT_SOURCE_ATTEMPT_RESERVED');
}
async function complete(_id,evidence,store=Evidence){
  const result=await store.updateOne({_id,status:'GPT_SOURCE_RESERVED'},{$set:evidence});
  if(!result.matchedCount)throw fail('OCR_GPT_SOURCE_RESERVATION_FAILED');
}
module.exports={acquire,complete};
