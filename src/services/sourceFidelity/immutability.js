'use strict';
const {isExact,sha,assertUnchanged,aggregate}=require('../../utils/sourceFidelity');
async function receipt(doc,session) {
  if(!isExact(doc)||!doc.sourceFidelityInputIdentity)return;
  if(typeof doc.sourceTranscriptExact!=='string'||!doc.sourceTranscriptExact.isWellFormed())throw Error('OCR_SOURCE_UNICODE_INVALID');
  if(sha(doc.sourceTranscriptExact??'')!==doc.sourceTranscriptSha256)throw Error('OCR_SOURCE_HASH_MISMATCH');
  if(aggregate(doc).sourceFidelityInputIdentity!==doc.sourceFidelityInputIdentity)throw Error('OCR_SOURCE_INPUT_IDENTITY_MISMATCH');
  const pages=(doc.ocrPages||[]).map(p=>({sourceTextExact:p.sourceTextExact,sourceTextSha256:p.sourceTextSha256}));
  if(pages.some(p=>sha(p.sourceTextExact??'')!==p.sourceTextSha256))throw Error('OCR_SOURCE_HASH_MISMATCH');
  const Snapshot=require('../../models/SourceFidelitySnapshot');
  const _id=sha(String(doc._id)+':'+doc.sourceFidelityInputIdentity);
  const old=await Snapshot.findOneAndUpdate({_id},{$setOnInsert:{submissionId:doc._id,sourceTranscriptExact:doc.sourceTranscriptExact,
    sourceTranscriptSha256:doc.sourceTranscriptSha256,pages}},{upsert:true,returnDocument:'after',...(session?{session}:{})}).select('+pages').lean();
  assertUnchanged({sourceFidelityInputIdentity:doc.sourceFidelityInputIdentity,...old,ocrPages:old.pages},
    {...doc,ocrPages:pages});
}
function install(schema) {
  schema.pre('save',async function(){
    const touched=['sourceFidelityMode','sourceFidelityInputIdentity','sourceTranscriptExact','sourceTranscriptSha256','ocrPages']
      .some(k=>this.isModified(k));
    if(!isExact(this)&&!touched)return;
    const next=this.toObject();
    if(!this.isNew){const old=await this.constructor.findById(this._id).lean();
      if(isExact(old)&&(!isExact(next)||!next.sourceFidelityInputIdentity)&&next.ocrJobId===old.ocrJobId)throw Error('OCR_SOURCE_IDENTITY_MUTATION');
      assertUnchanged(old,next);
    }
    if(isExact(next))await receipt(next,this.$session());
  });
  for(const op of ['updateOne','findOneAndUpdate','replaceOne'])schema.pre(op,async function(){
    const update=this.getUpdate();
    if(Array.isArray(update))throw Error('OCR_SOURCE_PIPELINE_UPDATE_UNSUPPORTED');
    const set=update?.$set||update||{};
    const sourcePath=k=>k.startsWith('source')||k.startsWith('ocrPages');
    const touched=Object.keys(set).some(sourcePath)||Object.entries(update||{}).some(([op,value])=>op.startsWith('$')
      &&value&&typeof value==='object'&&Object.keys(value).some(sourcePath));
    if(!touched)return;
    const session=this.getOptions().session;
    const old=await this.model.findOne(this.getFilter()).session(session||null).lean();if(!old)return;
    if(isExact(old)&&Object.entries(update).some(([op,value])=>op.startsWith('$')&&!['$set','$unset'].includes(op)
      &&value&&typeof value==='object'&&Object.keys(value).some(sourcePath)))throw Error('OCR_SOURCE_OPERATOR_MUTATION_REJECTED');
    const next={...old,...set};for(const key of Object.keys(update?.$unset||{}))delete next[key];
    const nested=Object.keys(set).some(k=>k.startsWith('source')&&k.includes('.')||k.startsWith('ocrPages.'));
    if(isExact(old)&&nested)throw Error('OCR_SOURCE_NESTED_MUTATION_REJECTED');
    // Clearing a source is permitted only as part of a genuinely new lifecycle/job.
    if(isExact(old)&&!next.sourceFidelityInputIdentity&&next.ocrJobId===old.ocrJobId)throw Error('OCR_SOURCE_IDENTITY_MUTATION');
    if(isExact(old)&&!isExact(next)&&next.ocrJobId===old.ocrJobId)throw Error('OCR_SOURCE_IDENTITY_MUTATION');
    assertUnchanged(old,next);
    if(isExact(next))await receipt(next,session);
  });
}
module.exports={install,receipt};
