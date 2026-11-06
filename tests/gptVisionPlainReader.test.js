'use strict';
// Plain-first Qwen source reader (OCR_GPT_VISION_READER=plain_text). Offline: every provider call is a fetch mock.
const c=require('../src/services/gptVisionExact/contract');
const source=require('../src/services/gptVisionExact.service');
const preflight=require('../src/services/gptVisionExact/preflight');
const gateway=require('../src/services/aiGateway.service');
const plain=()=>require('../src/services/gptVisionExact/plainReader');
const model=c.QWEN_MODEL;
const env={NODE_ENV:'test',OCR_SOURCE_MODE:'gpt_vision_exact',OCR_GPT_VISION_MODEL:model,OPENROUTER_API_KEY:'mock-only',OCR_GPT_VISION_READER:'plain_text'};
const jsonEnv={...env,OCR_GPT_VISION_READER:'json_contract'};
const assignment={title:'My favourite place',instructions:'Describe your favourite place and explain why you like it.'};
const ref=()=>source.reference(assignment);
const active=text=>({classification:'STUDENT_ACTIVE_TEXT',text,confidence:1});
const toCanonical=(text,reference=ref())=>c.validateWire(plain().toWire(text,reference));
function response(content,returnedModel=model,finish='stop'){return {ok:true,status:200,text:async()=>JSON.stringify({model:returnedModel,
  choices:[{finish_reason:finish,message:{content}}],usage:{prompt_tokens:1200,completion_tokens:40,cost:.0009}})};}
function options(fetchImpl,e=env){
  const reservation={acquire:jest.fn(async()=>({_id:'source',cached:false})),complete:jest.fn(async()=>{})};
  return {bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',identity:{submissionId:'s',fileId:'f',pageNumber:1,sourceSha256:c.sha('crop')},
    assignment,env:e,reservation,read:args=>source.reader({...args,fetchImpl}),fetchImpl};
}

describe('reader flag',()=>{
  test('defaults to json_contract and rejects unknown values',()=>{
    expect(c.readerMode({})).toBe('json_contract');
    expect(c.readerMode({OCR_GPT_VISION_READER:''})).toBe('json_contract');
    expect(c.readerMode({OCR_GPT_VISION_READER:'json_contract'})).toBe('json_contract');
    expect(c.readerMode({OCR_GPT_VISION_READER:'plain_text'})).toBe('plain_text');
    for(const bad of ['plain','PLAIN_TEXT','json',' plain_text','text'])
      expect(()=>c.readerMode({OCR_GPT_VISION_READER:bad})).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  });
  test('plain_text is approved for Qwen only; config output is unchanged',()=>{
    expect(c.config(env)).toEqual({model});
    for(const other of ['openai/gpt-6-astra',c.DEEPSEEK_MODEL])
      expect(()=>c.config({...env,OCR_GPT_VISION_MODEL:other})).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
    expect(c.config({...jsonEnv,OCR_GPT_VISION_MODEL:'openai/gpt-6-astra'})).toEqual({model:'openai/gpt-6-astra'});
    expect(()=>c.config({...env,OCR_GPT_VISION_READER:'bogus'})).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
  });
  test('startup configuration reports the reader and fails closed on a bad value',()=>{
    const ocr=require('../src/config/ocr');
    expect(ocr.validateOcrConfiguration(env)).toMatchObject({mode:'gpt_vision_exact',gptVisionModel:model,gptVisionReader:'plain_text',sourceCallsPerPage:1});
    expect(ocr.validateOcrConfiguration({...env,OCR_GPT_VISION_READER:undefined})).toMatchObject({gptVisionReader:'json_contract'});
    expect(()=>ocr.validateOcrConfiguration({...env,OCR_GPT_VISION_READER:'bogus'})).toThrow('OCR_GPT_SOURCE_CONFIGURATION_INVALID');
    expect(JSON.stringify(ocr.validateOcrConfiguration(env))).not.toContain('mock-only');
  });
});

describe('prompt',()=>{
  test('is exactly the prompt the acceptance gate measured (harness plain-first)',()=>{
    const spec=require('../scripts/ocr-eval/lib/prompts.cjs').promptSpec('plain-first');
    expect(plain().PROMPT).toBe(spec.system);
    expect(plain().USER_TEXT).toBe(spec.userText);
    expect(plain().PROMPT).toContain('write [?] in its place');
  });
});

describe('text to canonical evidence',()=>{
  test('one STUDENT_ACTIVE_TEXT segment per non-empty line; canonical cache re-validation accepts it',()=>{
    const v=toCanonical('Society always expect\r\n\r\n  powerfull Say ,  society  \n',{});
    expect(v.activeTranscript).toBe('Society always expect\npowerfull Say ,  society');
    expect(v.physicalLines).toEqual([{segments:[active('Society always expect')]},{segments:[active('powerfull Say ,  society')]}]);
    expect(v.uncertainties).toEqual([]);
    expect(v.version).toBe(c.VERSION);
    expect(c.validateCanonical(JSON.stringify(v))).toEqual(v);
  });
  test('a single wrapping code fence is removed; other text is untouched',()=>{
    expect(toCanonical('```\nHello there\n```',{}).activeTranscript).toBe('Hello there');
    expect(toCanonical('Hello ``` there',{}).activeTranscript).toBe('Hello ``` there');
  });
  test('[?] splits the line into an UNCERTAIN segment with a matching uncertainty, which blocks the page',()=>{
    const wire=JSON.parse(plain().toWire('I like [?] very much\nok',{}));
    expect(wire.version).toBe(c.QWEN_WIRE_VERSION);
    expect(wire.physicalLines[0].segments).toEqual([active('I like'),{classification:'UNCERTAIN',text:null,confidence:0},active(' very much')]);
    expect(wire.uncertainties).toEqual([{lineIndex:0,segmentIndex:1,kind:'ACTIVE_TEXT_UNCERTAIN',reason:expect.any(String)}]);
    try{c.validateWire(JSON.stringify(wire));throw Error('accepted');}catch(error){
      expect(error.code).toBe('OCR_GPT_SOURCE_UNCERTAIN');
      expect(error.sourceDiagnostic.blockingUncertaintyDetails).toEqual([expect.objectContaining({uncertaintyKind:'ACTIVE_TEXT_UNCERTAIN',physicalLineIndex:0,segmentIndex:1})]);
    }
  });
  test('[?] attached to letters keeps the readable letters in the uncertain segment (spacing as measured by the gate)',()=>{
    const wire=JSON.parse(plain().toWire('wor[?]d end',{}));
    expect(wire.physicalLines[0].segments).toEqual([{classification:'UNCERTAIN',text:'word',confidence:0},active('end')]);
    expect(plain().toWire('one wor[?]d end',{})).toBe(require('../scripts/ocr-eval/lib/candidates.cjs').plainTextToWire('one wor[?]d end'));
  });
  test('without assignment text the converter is byte-identical to the one the gate measured',()=>{
    const measured=require('../scripts/ocr-eval/lib/candidates.cjs').plainTextToWire;
    for(const text of ['Society always expect\npowerfull Say','a [?] b [?]\n\n  c  ','[?]','x'.repeat(4100),'naïve 😀 বাংলা\r\nend'])
      expect(plain().toWire(text,{})).toBe(measured(text));
  });
  test.each(['','   \n\n ','```\n\n```'])('empty reply %j is rejected as empty',text=>{
    expect(()=>toCanonical(text,{})).toThrow('OCR_GPT_SOURCE_EMPTY');
  });
  test('long lines are split at 2000 code units without cutting a surrogate pair',()=>{
    const line='a'.repeat(1999)+'😀'+'b'.repeat(2500);
    const v=toCanonical(line,{});
    expect(v.activeTranscript).toBe(line);
    expect(v.physicalLines[0].segments.every(s=>s.text.length<=2000&&s.text.isWellFormed())).toBe(true);
  });
});

describe('handwritten copy of the question (code-side match against the stored assignment text)',()=>{
  test('leading copied lines are excluded as PROMPT_OR_INSTRUCTION, misspellings included; the answer is kept',()=>{
    const v=toCanonical('Describe your favourit place and explain why\nyou like it.\nMy favourite place is the park near my house.\nI play there.');
    expect(v.activeTranscript).toBe('My favourite place is the park near my house.\nI play there.');
    expect(v.physicalLines.slice(0,2).map(l=>l.segments.map(s=>s.classification))).toEqual([['PROMPT_OR_INSTRUCTION'],['PROMPT_OR_INSTRUCTION']]);
    expect(v.physicalLines[0].segments[0].text).toBe('Describe your favourit place and explain why');
  });
  test('a one- or two-word tail of the copied question is excluded only when it continues the question',()=>{
    expect(toCanonical('Describe your favourite place and explain why you like\nit.\nThe park is quiet.').activeTranscript).toBe('The park is quiet.');
    expect(toCanonical('Describe your favourite place and explain why you like it.\nYes.\nThe park.').activeTranscript).toBe('Yes.\nThe park.');
  });
  test('a copied title is excluded',()=>{
    expect(toCanonical('My Favourite Place\nThe park is quiet.').activeTranscript).toBe('The park is quiet.');
    expect(toCanonical('Summer holidays\nWe went to the sea.',source.reference({title:'Summer Holidays'})).activeTranscript).toBe('We went to the sea.');
  });
  test('the same words later in the answer are student writing and stay',()=>{
    const text='The park is quiet.\nDescribe your favourite place and explain why you like it.';
    expect(toCanonical(text).activeTranscript).toBe(text);
  });
  test('short or partial overlaps stay: one word, unrelated sentence, no reference',()=>{
    for(const text of ['Place\nThe park is quiet.','My place is the park and I like it a lot.\nOk.'])expect(toCanonical(text).activeTranscript).toBe(text);
    const copy='Describe your favourite place and explain why you like it.\nThe park.';
    expect(toCanonical(copy,{}).activeTranscript).toBe(copy);
  });
  test('an unreadable word inside the copied question does not block the answer',()=>{
    const v=toCanonical('Describe your [?] place and explain why you like it.\nThe park is quiet.');
    expect(v.activeTranscript).toBe('The park is quiet.');
    expect(v.uncertainties).toEqual([expect.objectContaining({lineIndex:0,segmentIndex:0,kind:'NON_ACTIVE_PROMPT_UNCERTAIN'})]);
  });
  test('a page that is only the copied question is rejected as empty, as today',()=>{
    expect(()=>toCanonical('Describe your favourite place and explain why you like it.')).toThrow('OCR_GPT_SOURCE_EMPTY');
  });
});

describe('readPage with OCR_GPT_VISION_READER=plain_text',()=>{
  test('one call: measured prompt, temperature 0, plain text, reasoning none, sort latency; canonical evidence persisted',async()=>{
    const o=options(jest.fn(async()=>response('Describe your favourite place and explain why you like it.\nMy favourite place is the park.')));
    const result=await source.readPage(o);
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    const [url,request]=o.fetchImpl.mock.calls[0],body=JSON.parse(request.body);
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');expect(request.redirect).toBe('error');
    expect(body.model).toBe(model);expect(body.temperature).toBe(0);expect(body.max_tokens).toBe(16000);
    expect(body.reasoning).toEqual({effort:'none'});
    expect(body.provider).toEqual({require_parameters:true,allow_fallbacks:false,sort:'latency'});
    for(const key of ['response_format','max_completion_tokens','top_p','seed','models','transforms'])expect(body).not.toHaveProperty(key);
    expect(body.messages[0]).toEqual({role:'system',content:plain().PROMPT});
    expect(body.messages[1].content[0]).toEqual({type:'text',text:plain().USER_TEXT});
    expect(body.messages[1].content[1].image_url.url).toBe('data:image/jpeg;base64,/9j/');
    expect(JSON.stringify(body.messages)).not.toContain('favourite place and explain');
    expect(result.fullText).toBe('My favourite place is the park.');
    expect(result.source).toMatchObject({sourceFidelityMode:'gpt_vision_exact',sourcePrimaryModel:model,sourceFidelityVersion:c.VERSION});
    const bound=o.reservation.acquire.mock.calls[0][0];
    expect(bound).toMatchObject({readerMode:'plain_text',readerVersion:plain().VERSION,wireVersion:c.QWEN_WIRE_VERSION,
      promptSha256:plain().promptSha256(ref())});
    const [,saved]=o.reservation.complete.mock.calls[0];
    expect(saved.status).toBe('GPT_SOURCE_ACCEPTED');
    expect(c.validateCanonical(JSON.stringify(saved.payload.primary))).toEqual(saved.payload.primary);
    expect(saved.payload.primary.physicalLines[0].segments[0].classification).toBe('PROMPT_OR_INSTRUCTION');
    expect(saved.payload.sourceProfile).toMatchObject({readerMode:'plain_text',readerVersion:plain().VERSION,wireVersion:c.QWEN_WIRE_VERSION});
  });
  test('[?] reply is rejected as unreadable after one call, with content-free diagnostics',async()=>{
    const o=options(jest.fn(async()=>response('I like [?] very much')));
    await expect(source.readPage(o)).rejects.toMatchObject({code:'OCR_GPT_SOURCE_UNCERTAIN'});
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);
    const [,saved]=o.reservation.complete.mock.calls[0];
    expect(saved).toMatchObject({status:'GPT_SOURCE_FAILED',payload:{safeFailureCode:'OCR_GPT_SOURCE_UNCERTAIN',validationStage:'SOURCE_AMBIGUITY_VALIDATION'}});
    expect(JSON.stringify(o.reservation.complete.mock.calls)).not.toContain('very much');
  });
  test.each([
    ['truncated',()=>response('partial text',model,'length'),'OCR_GPT_PROVIDER_FAILED'],
    ['wrong model',()=>response('text','openai/gpt-6-astra'),'OCR_SOURCE_MODEL_IDENTITY']
  ])('%s reply fails safely after one call',async(_name,reply,code)=>{
    const o=options(jest.fn(async()=>reply()));
    await expect(source.readPage(o)).rejects.toMatchObject({code});
    expect(o.fetchImpl).toHaveBeenCalledTimes(1);expect(o.reservation.complete.mock.calls[0][1].status).toBe('GPT_SOURCE_FAILED');
  });
  test('default reader is unchanged: same JSON-contract request, now labelled json_contract in the binding',async()=>{
    const wire={version:c.QWEN_WIRE_VERSION,physicalLines:[{segments:[active('The park is quiet.')]}],uncertainties:[]};
    const o=options(jest.fn(async()=>response(JSON.stringify(wire))),{...env,OCR_GPT_VISION_READER:undefined});
    expect((await source.readPage(o)).fullText).toBe('The park is quiet.');
    const body=JSON.parse(o.fetchImpl.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe(c.wireContract(model).prompt);
    expect(body.response_format.json_schema.name).toBe('qwen_physical_source_v1');expect(body).not.toHaveProperty('temperature');
    expect(o.reservation.acquire.mock.calls[0][0]).toMatchObject({readerMode:'json_contract',readerVersion:c.QWEN_PROMPT_VERSION,
      promptSha256:c.sha(c.wireContract(model).prompt+JSON.stringify(ref()))});
  });
});

describe('gateway profile gpt_vision_exact_plain_v1',()=>{
  test.each([
    ['non-Qwen model',{entry:{provider:'openrouter',model:'openai/gpt-6-astra'},temperature:0}],
    ['JSON response format',{temperature:0,responseFormat:'json'}],
    ['temperature other than 0',{temperature:.2}],
    ['temperature missing',{}]
  ])('refuses %s before any transport',async(_name,override)=>{
    const fetchImpl=jest.fn();
    await expect(gateway.providerAttempt({entry:{provider:'openrouter',model},messages:[{role:'user',content:'x'}],maxOutputTokens:16000,
      attemptTimeoutMs:120000,env,now:Date.now,requestProfile:'gpt_vision_exact_plain_v1',fetchImpl,...override}))
      .rejects.toMatchObject({code:'OCR_SOURCE_PROFILE_INVALID'});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('cache binding across readers',()=>{
  const context={ownerId:'s',uploaderId:'s',assignment:{_id:'a',...assignment}};
  const page={bytes:Buffer.from('page'),sourceSha256:c.sha('page'),pageNumber:1};
  test('both readers share the durable key and accept each other\'s evidence, but only for the same assignment text',()=>{
    const json=preflight.binding(context,page,jsonEnv),text=preflight.binding(context,page,env);
    expect(text.key).toBe(json.key);
    expect(json).toMatchObject({readerMode:'json_contract',readerVersion:c.QWEN_PROMPT_VERSION});
    expect(text).toMatchObject({readerMode:'plain_text',readerVersion:plain().VERSION,promptSha256:plain().promptSha256(source.reference(context.assignment))});
    expect(text.promptSha256).not.toBe(json.promptSha256);
    expect(c.sameSourcePrompt(text,json)).toBe(true);
    expect(c.sameSourcePrompt(json,text)).toBe(true);
    const other=preflight.binding({...context,assignment:{_id:'a',title:'Another task'}},page,env);
    expect(c.sameSourcePrompt(other,json)).toBe(false);expect(c.sameSourcePrompt(other,text)).toBe(false);
  });
  test('a reader label that does not match its prompt hash is never accepted',()=>{
    const json=preflight.binding(context,page,jsonEnv),text=preflight.binding(context,page,env);
    expect(c.sameSourcePrompt({...text,readerMode:'json_contract'},json)).toBe(false);
    expect(c.sameSourcePrompt({...json,readerMode:'plain_text'},text)).toBe(false);
    expect(c.sameSourcePrompt({...text,readerMode:undefined},json)).toBe(false);
  });
  test('older Qwen evidence stays reusable under the plain reader',()=>{
    const text=preflight.binding(context,page,env);
    expect(c.sameSourcePrompt({model,promptSha256:text.legacyPromptSha256},text)).toBe(true);
    expect(c.sameSourcePrompt({model,promptSha256:text.previousPromptSha256,wireVersion:c.QWEN_WIRE_VERSION},text)).toBe(true);
  });
  test('the durable key and prompt hash of the default reader are unchanged',()=>{
    const pinned=preflight.binding({ownerId:'s',assignment:{_id:'a',title:'T',prompt:'Describe your favourite place.'}},page,
      {OCR_GPT_VISION_MODEL:model,OPENROUTER_API_KEY:'mock-only'});
    expect(pinned.key).toBe('2a6c5e8bad990da27e391a63');
    expect(pinned.promptSha256).toBe('ac9a6fa81a3ab29ac340e8e0249b02132c0721efad2b2a596aef35d271536bd7');
  });
  test('non-Qwen bindings carry no reader fields',()=>{
    const astra=preflight.binding(context,page,{...jsonEnv,OCR_GPT_VISION_MODEL:'openai/gpt-6-astra'});
    for(const key of ['readerMode','readerVersion','plainPromptSha256','jsonPromptSha256'])expect(astra).not.toHaveProperty(key);
  });
});

describe('runtime contract fingerprint',()=>{
  const {runtimeContractFingerprint}=require('../src/services/runtimeContractFingerprint.service');
  const {compareRuntime}=require('../scripts/verify-runtime-contract');
  test('default and explicit json_contract are identical and carry no reader fields',()=>{
    const base=runtimeContractFingerprint({NODE_ENV:'test'});
    expect(runtimeContractFingerprint({NODE_ENV:'test',OCR_GPT_VISION_READER:'json_contract'})).toEqual(base);
    expect(base.contracts).not.toHaveProperty('qwenSourceReader');
  });
  test('plain_text adds reader mode and version and changes the hash, so a mixed deployment is detected',()=>{
    const base=runtimeContractFingerprint({NODE_ENV:'test'}),p=runtimeContractFingerprint({NODE_ENV:'test',OCR_GPT_VISION_READER:'plain_text'});
    expect(p.contracts).toMatchObject({qwenSourceReader:'plain_text',qwenSourceReaderVersion:plain().VERSION});
    expect(p.contractHash).not.toBe(base.contractHash);
    expect(compareRuntime(base,{success:true,runtime:p})).toMatchObject({ok:false,code:'CONTRACT_MISMATCH'});
    expect(compareRuntime(p,{success:true,runtime:base})).toMatchObject({ok:false,code:'CONTRACT_MISMATCH'});
  });
  test('an invalid flag is reported, not thrown, so health stays available',()=>{
    expect(runtimeContractFingerprint({NODE_ENV:'test',OCR_GPT_VISION_READER:'bogus'}).contracts.qwenSourceReader).toBe('invalid');
  });
});
