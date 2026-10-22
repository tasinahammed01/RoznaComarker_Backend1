'use strict';
const mongoose=require('mongoose');
// Private write-once source receipt. Survives ordinary resubmission resets.
const schema=new mongoose.Schema({_id:String,submissionId:{type:mongoose.Schema.Types.ObjectId,index:true},sourceTranscriptExact:String,sourceTranscriptSha256:String,
  pages:{type:mongoose.Schema.Types.Mixed,select:false}},{timestamps:true});
module.exports=mongoose.model('SourceFidelitySnapshot',schema);
