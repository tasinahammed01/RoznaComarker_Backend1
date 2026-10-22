'use strict';
const mongoose=require('mongoose');
// Private durable per-source review/version receipt; never returned as a raw document.
const schema=new mongoose.Schema({_id:String,submissionId:{type:mongoose.Schema.Types.ObjectId,required:true,index:true},jobId:String,
  revision:{type:Number,default:0},currentHash:String,payload:{type:mongoose.Schema.Types.Mixed,required:true,select:false}},
{timestamps:true});
module.exports=mongoose.model('SourceHumanReview',schema);
