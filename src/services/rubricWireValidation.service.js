'use strict';
// Validate the closed rubric schema before compatibility normalization.
// No coercion, repair, new scores, or source text in failure diagnostics.
const invalid = () => Object.assign(new Error('Rubric response violates its strict wire schema.'),
  {code:'SEMANTIC_RUBRIC_SCHEMA_INVALID',validationStage:'schema_validation'});
function parseStrict(content) {
  let value;
  try { value=JSON.parse(content); } catch { throw invalid(); }
  const stack=[];
  const tokens=String(content).match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu)||[];
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i];
    if(token==='{')stack.push(new Set());
    else if(token==='[')stack.push(null);
    else if(token==='}'||token===']')stack.pop();
    else if(token.startsWith('"')&&tokens[i+1]===':') {
      const key=JSON.parse(token),seen=stack.at(-1);
      if(!seen||seen.has(key))throw invalid();
      seen.add(key);
    }
  }
  return value;
}
function matches(value,schema) {
  if(schema.anyOf)return schema.anyOf.some(option=>matches(value,option));
  const type=value===null?'null':Array.isArray(value)?'array':typeof value;
  if(schema.type&&![schema.type].flat().some(t=>t===type||t==='integer'&&Number.isInteger(value)))return false;
  if(Object.hasOwn(schema,'const')&&value!==schema.const)return false;
  if(schema.enum&&!schema.enum.includes(value))return false;
  if(type==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)))return false;
  if(type==='string'&&(!value.isWellFormed()||value.length<(schema.minLength??0)||value.length>(schema.maxLength??Infinity)))return false;
  if(type==='array'&&(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity)||value.some(item=>!matches(item,schema.items))))return false;
  if(type==='object') {
    if((schema.required||[]).some(key=>!Object.hasOwn(value,key)))return false;
    if(schema.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(schema.properties,key)))return false;
    if(Object.entries(value).some(([key,item])=>schema.properties?.[key]&&!matches(item,schema.properties[key])))return false;
  }
  return true;
}
function validateWire(content,schema) {
  const value=parseStrict(content);
  if(!matches(value,schema))throw invalid();
  return value;
}
module.exports={validateWire};
