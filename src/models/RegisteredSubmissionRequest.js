'use strict';
const mongoose=require('mongoose');
module.exports=mongoose.model('RegisteredSubmissionRequest',new mongoose.Schema({
  _id:String,contentHash:{type:String,required:true},submissionId:mongoose.Schema.Types.ObjectId,
  status:{type:String,enum:['pending','complete'],default:'pending'}
},{timestamps:true}));
