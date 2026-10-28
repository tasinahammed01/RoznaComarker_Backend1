'use strict';

const VERSION = 'gemini-rubric-wire-v2-structural';
// Generation-only projection. The original complete schema MUST validate every
// response before canonical evidence validation. Never use this as an acceptor.
// Google documents constrained-array/enum/branch complexity as a 400 risk.
function generationSchema(schema, property = '') {
  if (schema.anyOf) {
    const branches = schema.anyOf.map(option => generationSchema(option, property));
    // Custom criterion/level alternatives differ only in server-owned values.
    // Fail closed if a later contract introduces structurally different branches.
    if (!branches.length || branches.some(b => JSON.stringify(b) !== JSON.stringify(branches[0]))) {
      throw new Error('GEMINI_RUBRIC_WIRE_SHAPE_UNSUPPORTED');
    }
    return branches[0];
  }
  const result = { type: schema.type };
  if (schema.properties) {
    result.additionalProperties = false;
    result.properties = Object.fromEntries(Object.entries(schema.properties)
      .map(([key, value]) => [key, generationSchema(value, key)]));
    result.required = [...schema.required];
  }
  if (schema.items) result.items = generationSchema(schema.items);
  // Keep the two small, static string vocabularies. Identity enums, nullable
  // enums, consts, bounds and custom-level combinations stay server-side.
  if (['findingScope', 'evidenceType'].includes(property) && schema.enum) result.enum = [...schema.enum];
  return result;
}

module.exports = { VERSION, generationSchema };
