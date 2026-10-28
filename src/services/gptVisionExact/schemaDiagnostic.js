'use strict';
// Rejection-only explanation. The existing validator remains the sole authority.
// Unknown property names and all source values are redacted, not interpolated.
const FIELDS = ['version','activeTranscript','physicalLines','uncertainties','segments','classification','text','confidence',
  'lineIndex','segmentIndex','kind','reason','choices','model','message','content','usage','id','label','score','grade','explanation'];
const KEYWORDS = ['type','required','additionalProperties','enum','maxLength','maxItems','minItems','minimum','maximum',
  'jsonParse','maxBytes','wellFormedUnicode','singlePhysicalLine','activeTextRequired','totalSegments','uncertaintyReference','uncertaintyRole','unidentified'];
const TYPES = ['object','array','string','number','integer','boolean','null','undefined','string|null','unparsed'];
const CATEGORIES = ['STRING_NOT_ALLOWED','NUMBER_NOT_ALLOWED','NULL_NOT_ALLOWED','OTHER_TYPE_NOT_ALLOWED'];
const field = name => FIELDS.includes(name) ? name : 'REDACTED_UNKNOWN_FIELD';
const type = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function safePath(value, schema = false) {
  if(typeof value !== 'string' || value.length > 1000 || schema && !value.startsWith('#/'))return false;
  const parts = (schema ? value.slice(2) : value.slice(1)).split('/');
  return (!schema && value === '') || (schema || value.startsWith('/')) && parts.every(p =>
    FIELDS.includes(p) || /^(0|[1-9]\d{0,4})$/u.test(p) || schema && ['properties','items','semantic',...KEYWORDS].includes(p));
}
function safe(value) {
  const out = {};
  if(KEYWORDS.includes(value?.schemaErrorKeyword))out.schemaErrorKeyword=value.schemaErrorKeyword;
  if(safePath(value?.instancePath))out.instancePath=value.instancePath;
  if(safePath(value?.schemaPath,true))out.schemaPath=value.schemaPath;
  for(const key of ['expectedType','actualType','responseTopLevelShape'])if(TYPES.includes(value?.[key]))out[key]=value[key];
  for(const key of ['requiredFieldName','unexpectedFieldName','enumField'])if(FIELDS.includes(value?.[key])||value?.[key]==='REDACTED_UNKNOWN_FIELD')out[key]=value[key];
  if(CATEGORIES.includes(value?.enumValueCategory))out.enumValueCategory=value.enumValueCategory;
  for(const key of ['arrayIndex','physicalLineIndex','segmentIndex','uncertaintyIndex','unknownRootFieldCount'])
    if(Number.isInteger(value?.[key])&&value[key]>=0&&value[key]<=30000)out[key]=value[key];
  if(Array.isArray(value?.rootFieldNames))out.rootFieldNames=value.rootFieldNames.slice(0,16).map(field);
  return out;
}
function diagnose(content, policy) {
  let context={responseTopLevelShape:'unparsed'};
  const issue=(schemaErrorKeyword,instancePath,schemaPath,extra={})=>{
    const out={...context,schemaErrorKeyword,instancePath,schemaPath,...extra};
    const line=instancePath.match(/^\/physicalLines\/(\d+)/u),segment=instancePath.match(/\/segments\/(\d+)/u),uncertainty=instancePath.match(/^\/uncertainties\/(\d+)/u);
    if(line)out.physicalLineIndex=Number(line[1]);if(segment)out.segmentIndex=Number(segment[1]);if(uncertainty)out.uncertaintyIndex=Number(uncertainty[1]);
    const index=instancePath.match(/\/(\d+)(?:\/[^/]+)?$/u);if(index)out.arrayIndex=Number(index[1]);
    return safe(out);
  };
  if(typeof content!=='string')return issue('type','','#/type',{expectedType:'string',actualType:type(content)});
  if(Buffer.byteLength(content)>250000)return issue('maxBytes','','#/semantic/maxBytes');
  let value;try{value=JSON.parse(content);}catch{return issue('jsonParse','','#/semantic/jsonParse');}
  context={responseTopLevelShape:type(value)};
  if(type(value)==='object'){
    context.rootFieldNames=Object.keys(value).slice(0,16).map(field);
    context.unknownRootFieldCount=Object.keys(value).filter(k=>!FIELDS.includes(k)).length;
  }
  const category=value=>typeof value==='string'?'STRING_NOT_ALLOWED':typeof value==='number'?'NUMBER_NOT_ALLOWED':value===null?'NULL_NOT_ALLOWED':'OTHER_TYPE_NOT_ALLOWED';
  function walk(v,s,path='',sp='#'){
    const types=Array.isArray(s.type)?s.type:[s.type];
    if(!types.some(t=>t==='integer'?Number.isInteger(v):t==='number'?typeof v==='number'&&Number.isFinite(v):type(v)===t))
      return issue('type',path,sp+'/type',{expectedType:types.join('|'),actualType:type(v)});
    if(s.enum&&!s.enum.includes(v))return issue('enum',path,sp+'/enum',{enumField:field(path.split('/').at(-1)),enumValueCategory:category(v)});
    if(type(v)==='object'){
      for(const name of s.required||[])if(!Object.hasOwn(v,name))return issue('required',path,sp+'/required',{requiredFieldName:name});
      for(const name of Object.keys(v))if(s.additionalProperties===false&&!Object.hasOwn(s.properties||{},name))return issue('additionalProperties',path,sp+'/additionalProperties',{unexpectedFieldName:field(name)});
      for(const [name,child] of Object.entries(s.properties||{})){const found=walk(v[name],child,path+'/'+name,sp+'/properties/'+name);if(found)return found;}
    }else if(Array.isArray(v)){
      if(s.minItems!==undefined&&v.length<s.minItems)return issue('minItems',path,sp+'/minItems');
      if(s.maxItems!==undefined&&v.length>s.maxItems)return issue('maxItems',path,sp+'/maxItems');
      for(let i=0;i<v.length;i++){const found=walk(v[i],s.items,path+'/'+i,sp+'/items');if(found)return found;}
    }else if(typeof v==='string'&&s.maxLength!==undefined&&v.length>s.maxLength)return issue('maxLength',path,sp+'/maxLength');
    else if(typeof v==='number'){
      if(s.minimum!==undefined&&v<s.minimum)return issue('minimum',path,sp+'/minimum');
      if(s.maximum!==undefined&&v>s.maximum)return issue('maximum',path,sp+'/maximum');
    }
    return null;
  }
  const found=walk(value,policy.schema);if(found)return found;
  if(!value.activeTranscript.isWellFormed())return issue('wellFormedUnicode','/activeTranscript','#/semantic/activeTranscript/wellFormedUnicode');
  let count=0;
  for(let li=0;li<value.physicalLines.length;li++)for(let si=0;si<value.physicalLines[li].segments.length;si++){
    const s=value.physicalLines[li].segments[si],p=`/physicalLines/${li}/segments/${si}`;
    if(++count>3000)return issue('totalSegments',p,'#/semantic/totalSegments');
    if(typeof s.text==='string'&&!s.text.isWellFormed())return issue('wellFormedUnicode',p+'/text','#/semantic/text/wellFormedUnicode');
    if(typeof s.text==='string'&&['\r','\n','\f','\u0000'].some(char=>s.text.includes(char)))return issue('singlePhysicalLine',p+'/text','#/semantic/text/singlePhysicalLine');
    if(s.classification==='STUDENT_ACTIVE_TEXT'&&(typeof s.text!=='string'||!s.text.length))return issue('activeTextRequired',p+'/text','#/semantic/text/activeTextRequired',{expectedType:'string',actualType:type(s.text)});
  }
  for(let i=0;i<value.uncertainties.length;i++){
    const u=value.uncertainties[i],target=value.physicalLines[u.lineIndex]?.segments[u.segmentIndex],p='/uncertainties/'+i;
    if(!target)return issue('uncertaintyReference',p,'#/semantic/uncertainties/uncertaintyReference');
    if(policy.nonActiveRoles[u.kind]&&!policy.nonActiveRoles[u.kind].includes(target.classification))return issue('uncertaintyRole',p+'/kind','#/semantic/uncertainties/uncertaintyRole');
  }
  return issue('unidentified','','#/semantic/unidentified');
}
module.exports={diagnose,safe};
