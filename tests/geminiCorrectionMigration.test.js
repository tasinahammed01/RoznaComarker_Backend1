'use strict';
const gateway=require('../src/services/aiGateway.service');
const client=require('../src/services/semanticAIClient.service');
const semantic=require('../src/services/semanticWritingCorrections.service');
const pipeline=require('../src/services/canonicalCorrectionsPipeline.service');
const fixture=require('./helpers/claudeQualityFixtures.cjs');
const env={CORRECTION_DETECTION_MODEL:'google/gemini-3.8-flash',OPENROUTER_API_KEY:'mock-only',ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
test('exact Gemini historical selector, explicit rollback only, no wildcard or preview authority',()=>{
 expect(gateway.correctionModel(env)).toBe('google/gemini-3.8-flash');
 expect(gateway.CORRECTION_MODELS).toEqual([gateway.CORRECTION_MODEL,gateway.DEEPSEEK_CORRECTION_MODEL,gateway.GPT54_MINI_CORRECTION_MODEL,gateway.GEMINI_CORRECTION_MODEL,gateway.CLAUDE_CORRECTION_MODEL,gateway.ASSESSMENT_MODEL]);
 for(const model of gateway.CORRECTION_MODELS){const config=client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:model});expect(config.chain).toHaveLength(1);expect(config.model).toBe(model);}
 for(const model of ['google/*','google/gemini-3.7-flash','google/gemini-3.8-flash-preview','gemini-3.8-flash'])expect(()=>gateway.correctionModel({CORRECTION_DETECTION_MODEL:model})).toThrow();
});
test('Gemini low default is independent of Claude effort configuration',()=>{
 expect(client.getCorrectionAIConfig({...env,CORRECTION_REASONING_EFFORT:'high'}).thinkingLevel).toBe('low');
 expect(client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:gateway.CLAUDE_CORRECTION_MODEL,GEMINI_CORRECTION_REASONING_EFFORT:'high',CORRECTION_REASONING_EFFORT:'low'}).thinkingLevel).toBe('low');
 expect(gateway.geminiCorrectionReasoningEffort({GEMINI_CORRECTION_REASONING_EFFORT:'high'})).toBe('high');
 expect(()=>gateway.geminiCorrectionReasoningEffort({GEMINI_CORRECTION_REASONING_EFFORT:'none'})).toThrow();
});
test('actual model, strictness, effort, source and assignment remain independent cache dimensions',()=>{
 const keys=gateway.CORRECTION_MODELS.map(model=>semantic.semanticSourceKey({correctionSourceHash:'same',config:client.getCorrectionAIConfig({...env,CORRECTION_DETECTION_MODEL:model})}));expect(new Set(keys).size).toBe(gateway.CORRECTION_MODELS.length);
 const identities=gateway.CORRECTION_MODELS.map(model=>pipeline.buildCorrectionReviewIdentity({model,policy:{strictness:'balanced'}}));expect(new Set(identities).size).toBe(gateway.CORRECTION_MODELS.length);
 expect(pipeline.buildCorrectionReviewIdentity({model:gateway.CORRECTION_MODEL,policy:{strictness:'friendly'}})).not.toBe(identities[0]);
 expect(pipeline.buildCorrectionReviewIdentity({model:gateway.CORRECTION_MODEL,assignment:{title:'changed'}})).not.toBe(identities[0]);
 expect(semantic.semanticSourceKey({correctionSourceHash:'changed',config:client.getCorrectionAIConfig(env)})).not.toBe(keys[0]);
});
test('teacher comments remain explicitly Claude; Gemini is rejected before transport',async()=>{
 expect(gateway.getTeacherCommentAIConfig({...env,CORRECTION_DETECTION_MODEL:gateway.CORRECTION_MODEL}).chain[0].model).toBe(gateway.CLAUDE_CORRECTION_MODEL);
 const fetchImpl=jest.fn();await expect(gateway.generate({feature:'teacher_comment_draft',messages:[],config:gateway.getCorrectionAIConfig(env),fetchImpl,env})).rejects.toMatchObject({code:'AI_CORRECTION_AUTHORITY_INVALID'});expect(fetchImpl).not.toHaveBeenCalled();
});
test('scoring refuses Gemini and remains sole Astra, independently from source/OCR',async()=>{
 const fetchImpl=jest.fn();await expect(gateway.generate({feature:'semantic_rubric_assessment',messages:[],config:gateway.getCorrectionAIConfig(env),fetchImpl,env})).rejects.toMatchObject({code:'AI_ASSESSMENT_AUTHORITY_INVALID'});expect(fetchImpl).not.toHaveBeenCalled();
 expect(gateway.getAssessmentAIConfig(env).chain.map(e=>e.model)).toEqual(['openai/gpt-6-astra']);
 expect(require('../src/services/gptVisionExact/contract').config({...env,OCR_GPT_VISION_MODEL:'qwen/qwen3.8-27b'}).model).toBe('qwen/qwen3.8-27b');
});
test('frozen quality fixture has seven separate expected symbols and unchanged prompt identity',()=>{
 expect(fixture.defects.map(f=>f.symbol)).toEqual(['AGR','SP','P','SPC','COL','REL','CONC']);
 expect(semantic.SEMANTIC_PROMPT_VERSION).toBe('semantic-corrections-v14-symbol-review-map');
 expect(semantic.contractVersions(gateway.GEMINI_CORRECTION_MODEL)).toMatchObject({promptVersion:'gemini-corrections-v1-expert-explanations',schemaVersion:'semantic-corrections-v16-compact-explanations'});
 expect(fixture.negativeControls.filter(c=>fixture.mixed.transcript.includes(c))).toHaveLength(4);
});
test('Gemini and Claude share the four-slot correction gate without job contamination',async()=>{
 let active=0,peak=0;
 const results=await Promise.all(Array.from({length:12},(_,index)=>{
  const model=index%2?gateway.CLAUDE_CORRECTION_MODEL:gateway.CORRECTION_MODEL;
  return gateway.providerAttempt({feature:'semantic_corrections',entry:{provider:'openrouter',model},messages:[{role:'user',content:String(index)}],
   maxOutputTokens:1000,responseFormat:'json',responseSchema:{type:'object'},attemptTimeoutMs:5000,env,now:Date.now,
   fetchImpl:async(_url,options)=>{const body=JSON.parse(options.body);active++;peak=Math.max(peak,active);await new Promise(resolve=>setTimeout(resolve,2));active--;
    return {ok:true,status:200,text:async()=>JSON.stringify({model:body.model,choices:[{message:{content:JSON.stringify({job:body.messages[0].content})}}]})};}
  });
 }));
 expect(peak).toBe(4);results.forEach((result,index)=>expect(JSON.parse(result.content).job).toBe(String(index)));
 expect(require('../src/services/correctionAdmission.service').shared.snapshot()).toMatchObject({active:0,queued:0,limit:4,queueLimit:64});
});
