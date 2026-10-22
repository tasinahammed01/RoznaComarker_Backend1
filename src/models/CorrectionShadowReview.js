'use strict';
const mongoose=require('mongoose');
// Private payload; no controller, endpoint, Submission relation or student serializer.
const schema=new mongoose.Schema({_id:{type:String,required:true},submissionId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},runId:{type:String,required:true},status:{type:String,required:true},payload:{type:mongoose.Schema.Types.Mixed,select:false},expiresAt:{type:Date,required:true,expires:0}},{timestamps:true,strict:'throw',bufferCommands:false});
module.exports=mongoose.models.CorrectionShadowReview||mongoose.model('CorrectionShadowReview',schema);
