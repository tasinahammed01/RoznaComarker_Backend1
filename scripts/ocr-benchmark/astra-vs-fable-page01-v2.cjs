'use strict';
const fs=require('fs'),path=require('path');
const v2=require('./benchmark-v2.cjs');
async function main() {
  const command=process.argv[2]||'--preflight';
  if(command==='--review')return require('./comparison-v2.cjs').report();
  if(!['--preflight','--run-once'].includes(command))throw Error('V2_COMMAND_INVALID');
  const ready=v2.preflight();console.log(JSON.stringify(ready.summary,null,2));
  if(command==='--preflight')return ready.summary;
  v2.save(v2.DIRECTORY,'run-once.lock',{sourceSha256:ready.image.sha256,promptSha256:v2.EXPECTED_PROMPT_SHA,startedAt:new Date().toISOString()});
  v2.save(v2.DIRECTORY,'benchmark-identity.json',{version:2,requestedModels:ready.config.models,sourceSha256:ready.image.sha256,promptSha256:v2.EXPECTED_PROMPT_SHA,
    createdAt:new Date().toISOString(),maxNewGenerationRequests:2,maxPerModel:1,retries:0,fallbacks:0});
  console.log('GPT calls remaining: 1\nClaude calls remaining: 1\nOther provider calls: 0');
  require('./astra-vs-fable-page01.cjs').isolateEnvironment();
  const network=require('../local-shadow/network.cjs');let slot=null;
  network.install({realOne:true,imageHash:ready.image.sha256,ledger:{reserve:kind=>{
    if(kind!=='shadow-http'||!v2.SLOTS.includes(slot))throw Error('V2_NETWORK_FORBIDDEN');
    ready.budget.reserve(slot,'network',{sourceSha256:ready.image.sha256,requestedModel:ready.config.models[slot]});
  },auth:()=>{throw Error('V2_GOOGLE_FORBIDDEN');}}});
  const gateway=require('../../src/services/aiGateway.service');let states=[];
  try {
    states=await v2.runSlots(ready.specs,async request=>{
      slot=request.slot;
      const state=await v2.runModel({request,image:ready.image,key:ready.config.key,attempt:gateway.providerAttempt,fetchImpl:global.fetch,
        scope:fn=>network.scope('shadow',slot,fn),checkSource:()=>v2.source()});
      console.log(JSON.stringify({slot,...state}));return state;
    });
    if(states.at(-1)?.routingCompatibilityFailure) {
      for(const request of ready.specs.slice(states.length))v2.save(path.join(v2.DIRECTORY,request.slot),'result.json',{
        requestedModel:request.model,returnedModel:null,status:'SKIPPED_COMPATIBILITY_FAILURE',providerCalls:0,usage:null,
        reason:'Stopped after another V2 slot returned Filter by Parameters. No generation attempted.'});
    }
  } finally {
    slot=null;network.disable();v2.assertSnapshot(v2.read(v2.DIRECTORY,'protected-baseline.json'));
    require('./comparison-v2.cjs').report();
  }
  if(states.length!==2||states.some(s=>s.status!=='COMPLETE'))process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(/^[A-Z0-9_]{1,100}$/.test(e.message||'')?e.message:'V2_LOCAL_FAILURE');process.exitCode=1;});
module.exports={main};
