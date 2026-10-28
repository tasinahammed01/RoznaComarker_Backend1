'use strict';
const semantic=require('../src/services/semanticWritingCorrections.service');
const wire=require('../src/services/compactCorrectionWire.service');
const {reviewPayload}=require('./helpers/astraAssessmentFixtures.cjs');
const invalidReviews=[['T','VF','AGR','AGR','AGR','ART','PREP','PREP'],['T','VF','PREP','PREP','PREP','PREP','PREP','ART']];
test.each(invalidReviews.map(symbols=>[symbols]))('eight entries can omit required grammar symbols: %j',symbols=>{
 const payload=reviewPayload('synthetic');payload.categories.GRAMMAR.reviewedSymbols=symbols;
 try{semantic.parseJson(JSON.stringify(payload),'synthetic');throw Error('INVALID_REVIEW_ACCEPTED');}
 catch(e){expect(e.code).toBe('SEMANTIC_SYMBOL_REVIEW_INCOMPLETE');expect(e.expectedSymbolCount).toBe(8);expect(e.receivedSymbolCount).toBe(8);expect(e.missingSymbols).toEqual(expect.arrayContaining(['FRAG','RO','WO']));expect(e.duplicateSymbols).toContain('PREP');}
});
test('wire schema structurally requires one true attestation per enabled symbol',()=>{
 const catalog=semantic.categorySymbolCatalog(semantic.compactSemanticLegend(require('../src/services/writingCorrections.service').defaultLegend()));
 const root=wire.schema('synthetic',Object.keys(catalog),catalog),schema=root.properties.categories.properties.GRAMMAR.properties.reviewedSymbols;
 expect(schema.type).toBe('object');expect(schema.additionalProperties).toBe(false);
 expect(schema.required).toEqual(catalog.GRAMMAR);expect(Object.keys(schema.properties)).toHaveLength(8);
 for(const symbol of catalog.GRAMMAR)expect(schema.properties[symbol]).toEqual({$ref:'#/$defs/r'});
 expect(root.$defs.r).toEqual({type:'boolean',const:true});
});
test.each(['array','missing','false','extra'])('invalid compact review %s is never expanded as complete',mode=>{
 const legend=semantic.compactSemanticLegend(require('../src/services/writingCorrections.service').defaultLegend());
 const categories=Object.fromEntries(legend.map(g=>[g.category,{reviewed:true,reviewedSymbols:Object.fromEntries(g.symbols.map(s=>[s.symbol,true])),corrections:[]}]));
 if(mode==='array')categories.GRAMMAR.reviewedSymbols=invalidReviews[0];
 if(mode==='missing')delete categories.GRAMMAR.reviewedSymbols.FRAG;
 if(mode==='false')categories.GRAMMAR.reviewedSymbols.FRAG=false;
 if(mode==='extra')categories.GRAMMAR.reviewedSymbols.UNKNOWN=true;
 expect(()=>semantic.parseJson(JSON.stringify({reviewContract:wire.VERSION,transcriptHash:'synthetic',categories}),'synthetic')).toThrow('Invalid compact correction response');
});
test('invalid primary plus invalid bounded recovery cannot report complete review',async()=>{
 const coordinator=require('../src/services/semanticCorrectionCoordinator.service');
 const env={OPENROUTER_API_KEY:'mock-only',CORRECTION_DETECTION_MODEL:'openai/gpt-4.1-mini',ASSESSMENT_AI_PRIMARY_RETRIES:'0'};
 const legend=semantic.compactSemanticLegend(require('../src/services/writingCorrections.service').defaultLegend());
 const runCompletion=jest.fn(async request=>{
  const categories=Object.fromEntries(legend.map(g=>[g.category,{reviewed:true,reviewedSymbols:Object.fromEntries(g.symbols.map(s=>[s.symbol,true])),corrections:[]}]));
  categories.GRAMMAR.reviewedSymbols=Object.fromEntries(invalidReviews[Math.min(runCompletion.mock.calls.length-1,1)].map(s=>[s,true]));
  try{return {value:request.validate(JSON.stringify({reviewContract:wire.VERSION,transcriptHash:'synthetic',categories}))};}
  catch(e){throw Object.assign(e,{code:'AI_CHAIN_EXHAUSTED',finalFailureCode:'AI_OUTPUT_VALIDATION_FAILED'});}
 });
 await expect(coordinator.analyze({transcript:'A synthetic complete explanation. '.repeat(25),transcriptHash:'synthetic',transcriptComplete:true},{env,runCompletion})).rejects.toMatchObject({code:'AI_CHAIN_EXHAUSTED'});
 expect(runCompletion).toHaveBeenCalledTimes(2);
});
