'use strict';
const { generationSchema, VERSION } = require('../src/services/geminiRubricWireSchema.service');
const { semanticRubricAssessmentSchema } = require('../src/services/structuredOutputSchemas.service');
const rubric = require('../src/services/semanticRubricAssessment.service');
const { runRubricOnly } = require('../scripts/liveGeminiSemanticSmoke');
const env = { OPENROUTER_API_KEY:'mock-only', ASSESSMENT_AI_MODEL:'google/gemini-3.8-flash', GEMINI_RUBRIC_REASONING_EFFORT:'low' };
const line = (body, key) => body.messages[1].content.split('\n').find(s => s.startsWith(key+'=')).slice(key.length+1);
function fullSchema(body) {
  return semanticRubricAssessmentSchema(line(body,'sourceHash'), {
    categories:rubric.DEGRADED_CATEGORIES,
    transcriptEvidenceIds:JSON.parse(line(body,'evidenceCatalog')).map(e => e.evidenceId),
    correctionIds:JSON.parse(line(body,'allowedCorrectionIdsByCategory'))
  });
}
function response(body) {
  const evidence = JSON.parse(line(body,'evidenceCatalog'));
  const content = JSON.stringify({ sourceHash:line(body,'sourceHash'), categories:Object.fromEntries(rubric.DEGRADED_CATEGORIES.map(c => [c, {
    score:20,maxScore:20,comment:'A relevant supported benefit.',
    strengthEvidence:[{evidenceId:evidence[0].evidenceId,explanation:'The opening supports the task.'}],improvementEvidence:[]
  }])) });
  return {ok:true,status:200,headers:{get:()=>null},text:async()=>JSON.stringify({model:env.ASSESSMENT_AI_MODEL,choices:[{finish_reason:'stop',message:{content}}]})};
}
// This checks our conservative generation subset, NOT Google's private compiler.
function checkSubset(schema) {
  expect(Object.keys(schema).every(k => ['type','properties','required','additionalProperties','items','enum'].includes(k))).toBe(true);
  if(schema.properties) {
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(Object.keys(schema.properties));
    Object.values(schema.properties).forEach(checkSubset);
  }
  if(schema.items)checkSubset(schema.items);
  if(schema.enum)expect(schema.enum.every(v => typeof v==='string')).toBe(true);
}
test('original smoke fixture traverses real gateway with compact strict wire and unchanged request controls',async()=>{
  const fetchImpl=jest.fn(async(url,{body:raw})=>{
    const body=JSON.parse(raw), full=fullSchema(body), wire=body.response_format.json_schema.schema;
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(Object.keys(body).sort()).toEqual(['messages','model','max_tokens','response_format','reasoning','provider'].sort());
    expect(body).toMatchObject({model:env.ASSESSMENT_AI_MODEL,max_tokens:8000,reasoning:{effort:'low'},
      provider:{require_parameters:true,allow_fallbacks:false},response_format:{type:'json_schema',json_schema:{name:'semantic_rubric_assessment',strict:true}}});
    expect(JSON.parse(line(body,'evidenceCatalog'))).toHaveLength(3);
    expect(JSON.parse(line(body,'correctionCatalog'))).toHaveLength(0);
    const originalTranscript='Public transport can reduce traffic. Clear schedules help people choose buses. Reliable buses also help workers arrive on time.';
    expect(line(body,'sourceHash')).toBe(require('crypto').createHash('sha256').update(originalTranscript).digest('hex'));
    expect(JSON.stringify(full).length).toBe(6819);
    expect(body.messages[0].content).toContain('DEDUCTION_EVIDENCE_CONTRACT');
    expect(line(body,'schema')).toContain('prompt=gemini-rubric-v2-deduction-evidence');
    expect(wire).toEqual(generationSchema(full));checkSubset(wire);
    expect(JSON.stringify(wire).length).toBeLessThan(JSON.stringify(full).length);
    return response(body);
  });
  const result=await runRubricOnly({authorized:true,wireV2:true,env,consume:()=>{},fetchImpl});
  expect(result).toMatchObject({status:'completed',providerCallCount:1,wireVersion:VERSION});
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
test('custom levels and large catalogs do not expand the generation grammar; original schema is unchanged',()=>{
  const options={transcriptEvidenceIds:['source-1'],customCriteria:[{id:'criterion',levels:[{title:'Full',percentage:100},{title:'Partial',percentage:60}]}]};
  const small=semanticRubricAssessmentSchema('source',options), before=JSON.stringify(small);
  const large=semanticRubricAssessmentSchema('source',{...options,transcriptEvidenceIds:Array.from({length:512},(_,i)=>'source-'+i),
    customCriteria:Array.from({length:10},(_,i)=>({...options.customCriteria[0],id:'criterion-'+i}))});
  expect(generationSchema(large)).toEqual(generationSchema(small));
  checkSubset(generationSchema(large));expect(JSON.stringify(small)).toBe(before);
  expect(large.properties.customCriteria.items.anyOf).toHaveLength(20);
  expect(()=>generationSchema({anyOf:[{type:'string'},{type:'number'}]})).toThrow('GEMINI_RUBRIC_WIRE_SHAPE_UNSUPPORTED');
});
test('wire identity invalidates Gemini cache/runtime without changing Astra wire identity',()=>{
  const identity=require('../src/utils/assessmentInputIdentity');
  const spy=jest.spyOn(identity,'evaluationInputHash').mockImplementation(value=>value);
  const {analysisInputHash}=require('../src/services/canonicalEvaluation.service');
  const old=process.env.ASSESSMENT_AI_MODEL;
  try {
    process.env.ASSESSMENT_AI_MODEL=env.ASSESSMENT_AI_MODEL;
    expect(analysisInputHash({}).versions.rubricWireVersion).toBe(VERSION);
    process.env.ASSESSMENT_AI_MODEL='openai/gpt-6-astra';
    expect(analysisInputHash({}).versions).not.toHaveProperty('rubricWireVersion');
    expect(rubric.contractVersions('openai/gpt-6-astra')).not.toHaveProperty('wireVersion');
  } finally {spy.mockRestore();if(old===undefined)delete process.env.ASSESSMENT_AI_MODEL;else process.env.ASSESSMENT_AI_MODEL=old;}
});
test('new QA authorization has a separate exclusive marker; consumed marker blocks all transport',async()=>{
  const fs=require('fs'), original=fs.openSync;
  const markerPaths=[];
  const spy=jest.spyOn(fs,'openSync').mockImplementation((path,flags,...args)=>{
    if(String(path).endsWith('.consumed')) {markerPaths.push(String(path));expect(flags).toBe('wx');throw Object.assign(Error('consumed'),{code:'EEXIST'});}
    return original(path,flags,...args);
  });
  const fetchImpl=jest.fn();
  try {
    for(const selection of [{},{wireV2:true},{evidenceV2:true}]) {
      const result=await runRubricOnly({authorized:true,...selection,env,fetchImpl});
      expect(result).toMatchObject({status:'failed',providerCallCount:0});
    }
    expect(markerPaths[0]).toMatch(/gemini-rubric-v1-one-call\.consumed$/);
    expect(markerPaths[1]).toMatch(/gemini-rubric-wire-v2-6f1cb2b7-one-call\.consumed$/);
    expect(markerPaths[2]).toMatch(/gemini-rubric-evidence-v2-a2c19f48-one-call\.consumed$/);
    expect(fetchImpl).not.toHaveBeenCalled();
  }finally{spy.mockRestore();}
});
test('new QA keeps hard second-fetch guard, zero retries and disabled evidence repair',async()=>{
  let captured;
  const real=rubric.assess;
  const fetchImpl=jest.fn(async(url,options)=>{captured={url,options};return response(JSON.parse(options.body));});
  const consume=jest.fn();
  const spy=jest.spyOn(rubric,'assess').mockImplementation(async(input,deps)=>{
    expect(deps).toMatchObject({disableEvidenceRepair:true,config:{attemptTimeoutMs:90000,totalBudgetMs:95000,
      maxOutputTokens:8000,primaryRetries:0,fallbackRetries:0,retriesPerModel:0,maxRetries:0}});
    const result=await real(input,deps);
    expect(()=>deps.fetchImpl(captured.url,captured.options)).toThrow('RUBRIC_QA_SECOND_FETCH_BLOCKED');
    return result;
  });
  try {
    expect(await runRubricOnly({authorized:true,evidenceV2:true,env,consume,fetchImpl})).toMatchObject({status:'completed',providerCallCount:1});
    expect(fetchImpl).toHaveBeenCalledTimes(1);expect(consume).toHaveBeenCalledTimes(1);
  }finally{spy.mockRestore();}
});
