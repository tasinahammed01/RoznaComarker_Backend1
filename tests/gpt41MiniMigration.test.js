'use strict';
const gateway=require('../src/services/aiGateway.service');
const client=require('../src/services/semanticAIClient.service');
const env={OPENROUTER_API_KEY:'mock-only',AI_PRIMARY_PROVIDER:'openrouter',AI_PRIMARY_MODEL:'openai/gpt-4.1-mini'};
test('correction-specific default is exact GPT-4.1 Mini and cannot repoint scoring/comments',()=>{
 expect(gateway.correctionModel(env)).toBe('openai/gpt-4.1-mini');
 expect(gateway.correctionModel({...env,AI_PRIMARY_MODEL:'unrelated'})).toBe('openai/gpt-4.1-mini');
 expect(client.getCorrectionAIConfig(env).chain.map(e=>e.model)).toEqual(['openai/gpt-4.1-mini']);
 expect(gateway.getAssessmentAIConfig(env).chain[0].model).toBe('openai/gpt-6-astra');
 expect(gateway.getTeacherCommentAIConfig(env).chain[0].model).toBe('anthropic/claude-haiku-5.5');
 for(const model of ['openai/gpt-4.1','openai/gpt-4.1-mini-2025-04-14','openai/*'])expect(()=>gateway.correctionModel({...env,CORRECTION_DETECTION_MODEL:model})).toThrow();
});
test('no reasoning profile or cache dimension is inherited from other correction models',()=>{
 const altered={...env,GPT54_MINI_CORRECTION_REASONING_EFFORT:'invalid',GEMINI_CORRECTION_REASONING_EFFORT:'invalid',CORRECTION_REASONING_EFFORT:'invalid'};
 expect(client.getCorrectionAIConfig(altered).thinkingLevel).toBeNull();
 expect(gateway.correctionRequestPolicy({provider:'openrouter',model:'openai/gpt-4.1-mini',feature:'semantic_corrections',env:altered}).reasoning).toBeNull();
});
test('Mini cannot be used for scoring or teacher comments at generation boundary',async()=>{
 const config=gateway.getCorrectionAIConfig(env),fetchImpl=jest.fn();
 for(const [feature,code] of [['semantic_rubric_assessment','AI_ASSESSMENT_AUTHORITY_INVALID'],['teacher_comment_draft','AI_CORRECTION_AUTHORITY_INVALID']])await expect(gateway.generate({feature,config,env,fetchImpl,messages:[]})).rejects.toMatchObject({code});
 expect(fetchImpl).not.toHaveBeenCalled();
});
test('startup requires global provider/model even when the dedicated correction selector is valid',()=>{
 const {validateAIConfig}=require('../src/services/aiGeneration.service');
 const configured={OPENROUTER_API_KEY:'mock-only',CORRECTION_DETECTION_MODEL:'openai/gpt-4.1-mini'};
 expect(validateAIConfig(configured)).toMatchObject({isValid:false,errors:['AI_PRIMARY_PROVIDER and AI_PRIMARY_MODEL are required.']});
 expect(validateAIConfig({...configured,AI_PRIMARY_PROVIDER:'openrouter',AI_PRIMARY_MODEL:'openai/gpt-4.1-mini'})).toMatchObject({isValid:true,errors:[],chain:[{provider:'openrouter',model:'openai/gpt-4.1-mini',fallbackIndex:0}]});
 expect(validateAIConfig({...configured,AI_PRIMARY_PROVIDER:'openrouter',AI_PRIMARY_MODEL:'openai/gpt-4.1-mini',OPENROUTER_API_KEY:''})).toMatchObject({isValid:false,errors:['OPENROUTER_API_KEY is required for primary.']});
});
