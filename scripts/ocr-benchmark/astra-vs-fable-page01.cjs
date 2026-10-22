'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./benchmark-core.cjs');
function isolateEnvironment() {
  const osKeys=/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|USERPROFILE|HOME|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS)$/i;
  for(const key of Object.keys(process.env)) if(!osKeys.test(key)) delete process.env[key];
  require('dotenv').config=()=>({parsed:{}});
}
async function main() {
  const command=process.argv[2] || '--preflight';
  if(command==='--review') return require('./comparison.cjs').report();
  if(!['--preflight','--run-once'].includes(command)) throw Error('EXPECTED_PREFLIGHT_OR_RUN_ONCE');
  const ready=core.preflight();
  console.log(JSON.stringify(ready.summary,null,2));
  if(command==='--preflight') return ready.summary;
  core.save(core.DIRECTORY,'run-once.lock',{sourceSha256:ready.image.sha256,promptSha256:core.PROMPT_SHA,startedAt:new Date().toISOString()});
  core.save(core.DIRECTORY,'benchmark-identity.json',{...ready.summary,createdAt:new Date().toISOString(),preprocessing:'NONE',
    humanGoldStatus:'PENDING',accuracyWinner:'UNDETERMINED_PENDING_HUMAN_REVIEW',authorizedEnvironmentChange:'Operator added exact model IDs to backend/.env before this benchmark baseline.'});
  console.log('GPT calls remaining: 1\nClaude calls remaining: 1\nOther provider calls: 0');
  isolateEnvironment();
  const network=require('../local-shadow/network.cjs');
  let currentSlot=null;
  network.install({realOne:true,imageHash:ready.image.sha256,ledger:{
    reserve:kind=>{
      if(kind!=='shadow-http'||!core.SLOTS.includes(currentSlot)) throw Error('BENCHMARK_NON_OPENROUTER_FORBIDDEN');
      ready.budget.reserve(currentSlot,'network',{sourceSha256:ready.image.sha256,requestedModel:ready.config.models[currentSlot]});
    },
    auth:()=>{throw Error('BENCHMARK_GOOGLE_FORBIDDEN');}
  }});
  const gateway=require('../../src/services/aiGateway.service');
  const states=[];
  try {
    for(const spec of ready.specs) {
      currentSlot=spec.slot;
      const state=await core.runModel({spec,image:ready.image,key:ready.config.key,attempt:gateway.providerAttempt,
        fetchImpl:global.fetch,scope:fn=>network.scope('shadow',spec.slot,fn),checkSource:()=>core.source()});
      states.push(state);
      console.log(JSON.stringify({slot:spec.slot,...state}));
    }
  } finally {
    currentSlot=null;network.disable();
    core.assertSnapshot(core.read(core.DIRECTORY,'protected-baseline.json'));
    require('./comparison.cjs').report();
  }
  if(states.some(s=>s.status!=='COMPLETE')) process.exitCode=1;
}
if(require.main===module) main().catch(error=>{
  console.error(JSON.stringify({status:'BLOCKED_OR_FAILED',errorCode:/^[A-Z0-9_]{1,100}$/.test(error.message||'')?error.message:'BENCHMARK_LOCAL_FAILURE',
    ...(error.missing?{missing:error.missing}:{})}));
  process.exitCode=1;
});
module.exports={main,isolateEnvironment};
