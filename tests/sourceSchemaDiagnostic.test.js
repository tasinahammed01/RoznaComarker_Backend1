'use strict';
const c=require('../src/services/gptVisionExact/contract');
const source=require('../src/services/gptVisionExact.service');
const segment=(text,classification='STUDENT_ACTIVE_TEXT')=>({classification,text,confidence:1});
const fixture=()=>({version:c.VERSION,activeTranscript:'Keep powerfull, wrong wrong.',
  physicalLines:[{segments:[segment('Keep powerfull, wrong wrong.')]}],uncertainties:[]});
function rejected(value){
  try{c.validate(typeof value==='string'?value:JSON.stringify(value));}catch(error){expect(error.code).toBe('OCR_GPT_SOURCE_SCHEMA');return error;}
  throw Error('Invalid source accepted');
}
test.each([
  ['missing transcript',v=>{delete v.activeTranscript;},{schemaErrorKeyword:'required',instancePath:'',requiredFieldName:'activeTranscript'}],
  ['root extra',v=>{v.grade=100;},{schemaErrorKeyword:'additionalProperties',instancePath:'',unexpectedFieldName:'grade'}],
  ['wrong version',v=>{v.version='other-version';},{schemaErrorKeyword:'enum',instancePath:'/version',enumField:'version',enumValueCategory:'STRING_NOT_ALLOWED'}],
  ['transcript type',v=>{v.activeTranscript=null;},{schemaErrorKeyword:'type',instancePath:'/activeTranscript',expectedType:'string',actualType:'null'}],
  ['lines type',v=>{v.physicalLines={};},{schemaErrorKeyword:'type',instancePath:'/physicalLines',expectedType:'array',actualType:'object'}],
  ['line shape',v=>{v.physicalLines[0]={text:'PRIVATE'};},{schemaErrorKeyword:'required',instancePath:'/physicalLines/0',requiredFieldName:'segments',physicalLineIndex:0}],
  ['empty segments',v=>{v.physicalLines[0].segments=[];},{schemaErrorKeyword:'minItems',instancePath:'/physicalLines/0/segments'}],
  ['segment extra',v=>{v.physicalLines[0].segments[0].reason='PRIVATE';},{schemaErrorKeyword:'additionalProperties',instancePath:'/physicalLines/0/segments/0',unexpectedFieldName:'reason',segmentIndex:0}],
  ['missing confidence',v=>{delete v.physicalLines[0].segments[0].confidence;},{schemaErrorKeyword:'required',instancePath:'/physicalLines/0/segments/0',requiredFieldName:'confidence'}],
  ['confidence type',v=>{v.physicalLines[0].segments[0].confidence='1';},{schemaErrorKeyword:'type',instancePath:'/physicalLines/0/segments/0/confidence',expectedType:'number',actualType:'string'}],
  ['confidence range',v=>{v.physicalLines[0].segments[0].confidence=2;},{schemaErrorKeyword:'maximum',instancePath:'/physicalLines/0/segments/0/confidence'}],
  ['classification enum',v=>{v.physicalLines[0].segments[0].classification='PRIVATE';},{schemaErrorKeyword:'enum',instancePath:'/physicalLines/0/segments/0/classification',enumField:'classification'}],
  ['text type',v=>{v.physicalLines[0].segments[0].text=10;},{schemaErrorKeyword:'type',instancePath:'/physicalLines/0/segments/0/text',expectedType:'string|null',actualType:'number'}],
  ['active null',v=>{v.physicalLines[0].segments[0].text=null;},{schemaErrorKeyword:'activeTextRequired',instancePath:'/physicalLines/0/segments/0/text',expectedType:'string',actualType:'null'}],
  ['active empty',v=>{v.physicalLines[0].segments[0].text='';},{schemaErrorKeyword:'activeTextRequired',instancePath:'/physicalLines/0/segments/0/text'}],
  ['line break',v=>{v.physicalLines[0].segments[0].text='PRIVATE\nPRIVATE';},{schemaErrorKeyword:'singlePhysicalLine',instancePath:'/physicalLines/0/segments/0/text'}],
  ['Unicode',v=>{v.physicalLines[0].segments[0].text='\ud800';},{schemaErrorKeyword:'wellFormedUnicode',instancePath:'/physicalLines/0/segments/0/text'}],
  ['text length',v=>{v.physicalLines[0].segments[0].text='x'.repeat(2001);},{schemaErrorKeyword:'maxLength',instancePath:'/physicalLines/0/segments/0/text'}],
  ['uncertainty enum',v=>{v.uncertainties=[{lineIndex:0,segmentIndex:0,kind:'PRIVATE',reason:'PRIVATE'}];},{schemaErrorKeyword:'enum',instancePath:'/uncertainties/0/kind',uncertaintyIndex:0}],
  ['uncertainty reference',v=>{v.uncertainties=[{lineIndex:5,segmentIndex:0,kind:'ACTIVE_TEXT_UNCERTAIN',reason:'PRIVATE'}];},{schemaErrorKeyword:'uncertaintyReference',instancePath:'/uncertainties/0'}],
  ['uncertainty role',v=>{v.uncertainties=[{lineIndex:0,segmentIndex:0,kind:'NON_ACTIVE_DELETED_UNCERTAIN',reason:'PRIVATE'}];},{schemaErrorKeyword:'uncertaintyRole',instancePath:'/uncertainties/0/kind'}]
])('%s has an exact content-free rejection path',(_name,mutate,expected)=>{
  const v=fixture();mutate(v);const error=rejected(v);
  expect(error.sourceDiagnostic).toMatchObject(expected);
  const safe=source.safeSourceDiagnostic(error.sourceDiagnostic);expect(safe).toMatchObject(expected);
  expect(safe.schemaPath).toMatch(/^#\//);expect(safe.responseTopLevelShape).toBe('object');
  expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|powerfull|wrong wrong|other-version/);
});
test.each(['{invalid','```json\n{}\n```'])('invalid JSON reports only the parser rule',content=>{
  expect(rejected(content).sourceDiagnostic).toMatchObject({schemaErrorKeyword:'jsonParse',instancePath:'',schemaPath:'#/semantic/jsonParse',responseTopLevelShape:'unparsed'});
});
test.each([null,[],true,5,'"PRIVATE"'])('root type %j fails closed',value=>{
  const input=typeof value==='string'?value:JSON.stringify(value);
  expect(rejected(input).sourceDiagnostic).toMatchObject({schemaErrorKeyword:'type',instancePath:'',expectedType:'object'});
});
test('source-looking envelopes are rejected rather than silently unwrapped',()=>{
  const error=rejected({choices:[{message:{content:JSON.stringify(fixture())}}],model:'PRIVATE'});
  expect(error.sourceDiagnostic).toMatchObject({schemaErrorKeyword:'required',requiredFieldName:'version',rootFieldNames:['choices','model']});
  expect(JSON.stringify(error.sourceDiagnostic)).not.toContain('PRIVATE');
});
test('unknown property names cannot leak text through paths or root field names',()=>{
  const value=fixture();value['PRIVATE student text\nbase64']=true;
  const safe=source.safeSourceDiagnostic(rejected(value).sourceDiagnostic);
  expect(safe.unexpectedFieldName).toBe('REDACTED_UNKNOWN_FIELD');expect(safe.unknownRootFieldCount).toBe(1);
  expect(JSON.stringify(safe)).not.toMatch(/PRIVATE|student|base64/);
  expect(source.safeSourceDiagnostic({schemaErrorKeyword:'PRIVATE',instancePath:'/PRIVATE',schemaPath:'#/PRIVATE',requiredFieldName:'PRIVATE',
    rootFieldNames:['PRIVATE'],enumValueCategory:'PRIVATE'})).toEqual({rootFieldNames:['REDACTED_UNKNOWN_FIELD']});
});
test('valid excluded null text remains valid and genuine active ambiguity/mismatch remain rejected',()=>{
  const value=fixture();value.physicalLines[0].segments.push(segment(null,'STUDENT_CROSSED_OUT'));
  expect(c.validate(JSON.stringify(value)).activeTranscript).toBe(value.activeTranscript);
  value.activeTranscript='Edited source.';expect(()=>c.validate(JSON.stringify(value))).toThrow('OCR_GPT_SOURCE_TRANSCRIPT_MISMATCH');
  value.activeTranscript=fixture().activeTranscript;value.physicalLines[0].segments.push(segment(null,'UNCERTAIN'));
  expect(()=>c.validate(JSON.stringify(value))).toThrow('OCR_GPT_SOURCE_UNCERTAIN');
});
test.each(['deepseek/deepseek-v4.1-flash-1017','openai/gpt-6-astra'])('reader %s propagates schema diagnostics with one mocked call and no acceptance',async model=>{
  const value=fixture();value.physicalLines[0].segments[0].confidence='PRIVATE';
  const read=jest.fn(async()=>({returnedModel:model,content:JSON.stringify(value)}));
  const reservation={acquire:jest.fn(async()=>({_id:'source',cached:false})),complete:jest.fn(async()=>{})};
  const spy=jest.spyOn(require('../src/utils/logger'),'info').mockImplementation(()=>{});
  try{
    await expect(source.readPage({bytes:Buffer.from([255,216,255]),mimeType:'image/jpeg',read,reservation,
      identity:{pageNumber:1,fileId:'crop',sourceSha256:c.sha('crop')},env:{NODE_ENV:'test',OCR_GPT_VISION_MODEL:model,OPENROUTER_API_KEY:'mock-only'}}))
      .rejects.toMatchObject({code:'OCR_GPT_SOURCE_SCHEMA',sourceDiagnostic:{schemaErrorKeyword:'type',instancePath:'/physicalLines/0/segments/0/confidence'}});
    expect(read).toHaveBeenCalledTimes(1);expect(reservation.complete.mock.calls[0][1]).toMatchObject({status:'GPT_SOURCE_FAILED',payload:{actualType:'string'}});
    expect(JSON.stringify([...spy.mock.calls,...reservation.complete.mock.calls])).not.toMatch(/PRIVATE|powerfull|wrong wrong|mock-only|base64/);
  }finally{spy.mockRestore();}
});
test('valid DeepSeek and Astra response contract has not changed',()=>{
  expect(c.validate(JSON.stringify(fixture()))).toEqual(fixture());
  expect(c.schema.additionalProperties).toBe(false);expect(c.schema.required).toEqual(['version','activeTranscript','physicalLines','uncertainties']);
  expect(c.VERSION).toBe('gpt-vision-exact-v2');
});
