'use strict';
const mongoose=require('mongoose');
module.exports=mongoose.model('SubmissionUploadLease',new mongoose.Schema({
  _id:String,owner:String,until:Date
},{timestamps:true}));
