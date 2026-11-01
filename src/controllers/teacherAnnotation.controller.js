'use strict';
const mongoose = require('mongoose');
const Submission = require('../models/Submission');
const Class = require('../models/class.model');
const Assignment = require('../models/assignment.model');
const policy = require('../services/teacherAnnotation.service');
const { defaultLegend } = require('../services/writingCorrections.service');
const { buildCanonicalCorrectionRenderModels } = require('../services/canonicalCorrectionRender.service');
async function authorized(req) {
  if (req.user?.role !== 'teacher' || req.guestAccessContext) throw Object.assign(new Error('ANNOTATION_FORBIDDEN'),{statusCode:403});
  if (!mongoose.isValidObjectId(req.params.submissionId)) throw Object.assign(new Error('ANNOTATION_INVALID_ID'),{statusCode:400});
  const doc = await Submission.findById(req.params.submissionId).select('+teacherAnnotations').lean();
  if (!doc || !await Class.exists({_id:doc.class,teacher:req.user._id,isActive:true})
      || !await Assignment.exists({_id:doc.assignment,class:doc.class,teacher:req.user._id,isActive:true})) throw Object.assign(new Error('ANNOTATION_FORBIDDEN'),{statusCode:403});
  return doc;
}
async function snapshot(doc) {
  const {canonical,sourceHash}=policy.source(doc), state=policy.stateOf(doc);
  const pages = await Promise.all(canonical.pages.map(async page => {
    const stored = doc.ocrPages.find(p => String(p.fileId) === page.fileId && p.pageNumber === page.pageNumber);
    const separators = new Map(page.words.map(w => [w.id,w.separatorBefore]));
    const words = require('../services/ocrCorrections.service').normalizeOcrWordsFromStored(page.words,
      {fileId:page.fileId,preserveSourceTokens:doc.sourceFidelityMode === 'gpt_vision_exact'})
      .map(w => ({...w,separatorBefore:separators.get(w.id) || ''}));
    const sourceGeometry = await require('../services/annotationImageGeometry.service').annotationImageGeometry(stored,
      id => require('../models/File').findById(id).select('path').lean());
    return {...page,words,sourceGeometry,pageImageUrl:stored?.pageImageUrl};
  }));
  return { revision:state.revision,sourceHash,scoringReviewRequired:Boolean(state.scoringReviewRequired),
    pages,legend:defaultLegend(), corrections:policy.effective(doc.writingCorrections,canonical,doc,true),
    effective:buildCanonicalCorrectionRenderModels(policy.effective(doc.writingCorrections,canonical,doc),canonical,doc.ocrPages,{submission:doc}),
    publication:'saved-effective', scorePolicy:'Annotation changes do not change grades. Review substantive changes using the existing teacher grading controls.' };
}
const endpoint = fn => async(req,res)=>{try {res.set('Cache-Control','private, no-store');await fn(req,res);} catch(error) {
  const code=/^ANNOTATION_[A-Z_]+$/.test(error.message)?error.message:'ANNOTATION_OPERATION_FAILED';
  res.status(error.statusCode||500).json({success:false,code,message:code});
}};
const get=endpoint(async(req,res)=>res.json({success:true,data:await snapshot(await authorized(req))}));
const history=endpoint(async(req,res)=>{
  const doc=await authorized(req);const offset=Number(req.query.offset||0);
  if(!Number.isInteger(offset)||offset<0||offset>250)throw Object.assign(new Error('ANNOTATION_INVALID_REQUEST'),{statusCode:400});
  const rows=[...policy.stateOf(doc).audit].reverse();
  res.json({success:true,data:{items:rows.slice(offset,offset+20).map(({requestHash,...row})=>row),nextOffset:offset+20<rows.length?offset+20:null}});
});
const mutate=endpoint(async(req,res)=>{
  const doc=await authorized(req);
  const result=policy.prepare(doc,req.user._id,req.body);
  if(result.replay)return res.json({success:true,data:{revision:result.revision,replay:true}});
  if(['pending','processing'].includes(doc.ocrStatus)||['started','processing','queued','pending'].includes(doc.assessmentStatus)
    || ['pending','processing'].includes(doc.correctionStatus) || ['pending','processing'].includes(doc.evaluationStatus)) throw Object.assign(new Error('ANNOTATION_ASSESSMENT_BUSY'),{statusCode:409});
  const match={_id:doc._id,class:doc.class,assignment:doc.assignment};
  for(const key of ['ocrJobId','ocrUpdatedAt','correctionUpdatedAt','draftNumber','ocrPages','writingCorrections',
    'files','file','fileOrder','sourceFidelityMode','sourceReviewStatus','ocrStatus','assessmentStatus','correctionStatus','evaluationStatus']) match[key]=doc[key]===undefined?{$exists:false}:doc[key];
  match['teacherAnnotations.revision']=doc.teacherAnnotations?.revision===undefined?{$exists:false}:doc.teacherAnnotations.revision;
  const saved=await Submission.updateOne(match,{$set:{teacherAnnotations:result.state}});
  if(saved.modifiedCount!==1)throw Object.assign(new Error('ANNOTATION_REVISION_CONFLICT'),{statusCode:409});
  res.json({success:true,data:{revision:result.revision}});
});
module.exports={get,history,mutate};
