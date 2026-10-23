'use strict';
const {AsyncLocalStorage}=require('async_hooks');
const context=new AsyncLocalStorage();
const bucket=feature=>feature==='google_geometry'?'geometryProviderCalls':feature==='google_source'||/^gpt_vision_exact|^source_fidelity/.test(feature)?'sourceProviderCalls'
  :/^semantic_corrections/.test(feature)?'correctionProviderAttempts':/^semantic_rubric/.test(feature)?'rubricAssessmentCalls'
    :/^rubric_completion/.test(feature)?'rubricDesignerCalls':'otherProviderAttempts';
function run(work,{worker=false}={}){return context.getStore()?work():context.run({attempts:[],worker,id:require('crypto').randomUUID()},work);}
function begin(feature,model,now=Date.now){
  const store=context.getStore();if(!store)return ()=>{};
  const attempt={bucket:bucket(feature),model,role:store.role,startedAt:now(),durationMs:0,outcome:'pending'};store.attempts.push(attempt);
  return outcome=>{attempt.durationMs=Math.max(0,now()-attempt.startedAt);attempt.outcome=outcome;};
}
function snapshot(){
  const counts=Object.fromEntries(['sourceProviderCalls','geometryProviderCalls','correctionProviderAttempts','rubricAssessmentCalls','rubricDesignerCalls','otherProviderAttempts'].map(k=>[k,0]));
  const attempts=context.getStore()?.attempts||[];for(const a of attempts)counts[a.bucket]++;
  return {...counts,providerAttemptExecutionId:context.getStore()?.id||null,
    correctionProviderMs:attempts.filter(a=>a.bucket==='correctionProviderAttempts').reduce((n,a)=>n+a.durationMs,0),
    rubricProviderMs:attempts.filter(a=>a.bucket==='rubricAssessmentCalls').reduce((n,a)=>n+a.durationMs,0),
    correctionRecoveryCalls:attempts.filter(a=>a.bucket==='correctionProviderAttempts'&&a.role==='recovery').length,
    totalProviderAttempts:attempts.length,rubricDesignerMs:attempts.filter(a=>a.bucket==='rubricDesignerCalls').reduce((n,a)=>n+a.durationMs,0)};
}
function withRole(role,work){const store=context.getStore();return store?context.run({...store,role},work):work();}
module.exports={run,begin,snapshot,withRole,active:()=>!!context.getStore(),worker:()=>context.getStore()?.worker===true};
