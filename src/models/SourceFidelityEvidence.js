'use strict';
const mongoose=require('mongoose');
const schema=new mongoose.Schema({identity:{type:mongoose.Schema.Types.Mixed,required:true},
  status:String,payload:{type:mongoose.Schema.Types.Mixed,select:false},
  leaseOwner:String,leaseUntil:Date,providerStartedAt:Date,attempts:{type:Number,default:0},nextAttemptAt:Date,
  expiresAt:{type:Date,default:()=>new Date(Date.now()+30*86400000)}},{timestamps:true});
schema.index({expiresAt:1},{expireAfterSeconds:0});
module.exports=mongoose.model('SourceFidelityEvidence',schema);
