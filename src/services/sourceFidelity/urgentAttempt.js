'use strict';
// Durable admission before spending. A crash with an outstanding intent never
// causes a second paid read. Completed evidence can be reused by job recovery.
const Evidence=require('../../models/SourceFidelityEvidence'),{createHash}=require('crypto');
const failure=()=>Object.assign(Error('OCR_SOURCE_ATTEMPT_RESERVED'),{code:'OCR_SOURCE_ATTEMPT_RESERVED',retryable:false});
async function acquire(identity){
  if(!['submissionId','runId','fileId','inputSha256'].every(k=>typeof identity[k]==='string'&&identity[k].length)||!Number.isInteger(identity.pageNumber))throw failure();
  const _id=createHash('sha256').update(JSON.stringify(['astra-human-confirm-v1',identity.submissionId,identity.runId,identity.fileId,identity.pageNumber,identity.inputSha256])).digest('hex').slice(0,24);
  try{await Evidence.create({_id,identity,status:'ASTRA_ATTEMPT_RESERVED'});return {_id,cached:false};}
  catch(e){if(e.code!==11000)throw e;}
  const old=await Evidence.findById(_id).select('+payload').lean();
  if(old?.status==='ASTRA_PROVISIONAL'&&old.payload?.primary)return {_id,cached:true,evidence:old};
  throw failure();
}
async function complete(_id,evidence){
  const r=await Evidence.updateOne({_id,status:'ASTRA_ATTEMPT_RESERVED'},{$set:evidence});
  if(!r.matchedCount)throw failure();
}
module.exports={acquire,complete};
