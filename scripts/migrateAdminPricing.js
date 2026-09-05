'use strict';
require('dotenv').config();
const mongoose=require('mongoose');const connectDB=require('../src/config/db');const Plan=require('../src/models/Plan');
const ORDER=new Map([['free',0],['essential_monthly',1],['essential_annual',2],['essential',1],['pro_monthly',3],['pro_annual',4],['pro',3],['institution',5],['custom',5]]);
async function migrate(){await connectDB();const plans=await Plan.collection.find({}).sort({_id:1}).toArray();let changed=0;
 for(let index=0;index<plans.length;index+=1){const plan=plans[index],slug=String(plan.slug||'').trim().toLowerCase(),set={};
  if(plan.assessmentCreditNudges?.softThresholdPercent==null)set['assessmentCreditNudges.softThresholdPercent']=50;
  if(plan.assessmentCreditNudges?.warningThresholdPercent==null)set['assessmentCreditNudges.warningThresholdPercent']=80;
  if(!Number.isInteger(plan.displayOrder))set.displayOrder=ORDER.get(slug)??1000+index;
  if(Object.keys(set).length){await Plan.collection.updateOne({_id:plan._id},{$set:set});changed+=1;console.log(`Updated ${slug||plan._id}: ${Object.keys(set).join(', ')}`);}
 }
 console.log(`Admin pricing migration complete. ${changed} of ${plans.length} plan records changed.`);return{changed,total:plans.length};}
if(require.main===module)migrate().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>mongoose.disconnect());
module.exports={migrate,ORDER};
